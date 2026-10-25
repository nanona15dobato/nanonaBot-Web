'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createPushService, getConfig, validateSubscription, validateEvents, validEndpoint, hash, sendHttp, safePath } = require('../src/services/push');

function keys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: Buffer.from(ecdh.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString('base64url') };
}
const vapid = { ...keys(), subject: 'mailto:dummy@example.org' };
const recipient = keys();
const subscription = { endpoint: 'https://fcm.googleapis.com/wp/dummy-test-endpoint', expirationTime: null,
  keys: { p256dh: recipient.publicKey, auth: crypto.randomBytes(16).toString('base64url') } };

function row(overrides = {}) {
  return { endpoint_hash: hash(subscription.endpoint), endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh, auth: subscription.keys.auth,
    session_id: 'dummy-session', username: 'Owner', events_json: JSON.stringify(['failed']),
    session_data: JSON.stringify({ username: 'Owner', role: 'owner' }),
    expires_at: new Date(Date.now() + 60000), session_expires: Math.floor(Date.now() / 1000) + 60,
    vapid_key: hash(vapid.publicKey), ...overrides };
}
function fixture(rows = []) {
  const queries = [];
  const sent = [];
  let code = 201;
  const db = { query: async (sql, args) => {
    queries.push({ sql, args });
    if (sql.includes('SELECT p.*')) return [rows];
    if (sql.includes('SELECT COUNT')) return [[{ total: 0 }]];
    if (sql.includes('SELECT events_json')) return [rows];
    return [{ affectedRows: 1 }];
  } };
  const service = createPushService({ db, readConfig: () => vapid, isOwner: (username) => username === 'Owner',
    send: async (...args) => { sent.push(args); if (code instanceof Error) throw code; return code; } });
  return { service, queries, sent, setCode: (value) => { code = value; } };
}

test('push config: disabled/incomplete/invalid keys stay optional; valid pair exposes only expected configuration', () => {
  const saved = Object.fromEntries(['VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'].map((name) => [name, process.env[name]]));
  try {
    for (const name of Object.keys(saved)) delete process.env[name];
    assert.equal(getConfig(), null);
    process.env.VAPID_SUBJECT = vapid.subject;
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
    assert.equal(getConfig(), null);
    process.env.VAPID_PRIVATE_KEY = keys().privateKey;
    assert.equal(getConfig(), null);
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    assert.deepEqual(getConfig(), vapid);
    process.env.VAPID_SUBJECT = 'file:///etc/passwd';
    assert.equal(getConfig(), null);
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('push endpoints: accepts browser providers and rejects private/arbitrary destinations, credentials and alternate ports', () => {
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/token', 'https://fcm.googleapis.com/wp/token',
    'https://updates.push.services.mozilla.com/wpush/v2/token', 'https://web.push.apple.com/token',
    'https://wns2-example.notify.windows.com/w/?token=dummy']) assert.equal(validEndpoint(endpoint), true, endpoint);
  for (const endpoint of ['http://fcm.googleapis.com/wp/token', 'https://127.0.0.1/', 'https://169.254.169.254/',
    'https://internal.toolforge.org/', 'https://fcm.googleapis.com.evil.invalid/wp/token', 'https://fcm.googleapis.com:444/wp/token',
    'https://user:secret@fcm.googleapis.com/wp/token', 'https://fcm.googleapis.com/wp/token#fragment',
    'https://fcm.googleapis.com/other-api', 'file:///etc/passwd', null]) assert.equal(validEndpoint(endpoint), false);
});

test('push validation: validates curve keys, auth length, expiration and event choices; empty means none', () => {
  assert.deepEqual(validateSubscription(subscription), subscription);
  for (const input of [null, {}, { ...subscription, keys: {} }, { ...subscription, expirationTime: 1 },
    { ...subscription, keys: { ...subscription.keys, p256dh: Buffer.alloc(65).toString('base64url') } },
    { ...subscription, keys: { ...subscription.keys, auth: 'abcd' } }]) assert.throws(() => validateSubscription(input), { status: 400 });
  assert.equal(safePath({ toString: null }), '/');
  assert.deepEqual(validateEvents([]), []);
  assert.deepEqual(validateEvents(['failed', 'failed']), ['failed']);
  assert.throws(() => validateEvents(['unknown']), { status: 400 });
  assert.throws(() => validateEvents('failed'), { status: 400 });
});

test('push registration: binds to current session and limits expiry; returns no endpoint, auth key or session ID', async () => {
  const f = fixture();
  await assert.rejects(f.service.subscribe('dummy-session', 'Owner', new Date(Date.now() + 60000), subscription, [], 'old-key'), { status: 409 });
  assert.equal(f.queries.length, 0);
  const expires = new Date(Date.now() + 60000);
  const result = await f.service.subscribe('dummy-session', 'owner', expires, subscription, ['failed'], vapid.publicKey);
  assert.equal(result.expiresAt.getTime(), expires.getTime());
  const insert = f.queries.find((query) => query.sql.startsWith('INSERT'));
  assert.equal(insert.args[4], 'dummy-session');
  assert.equal(insert.args[5], 'Owner');
  assert.equal(insert.args[7].getTime(), expires.getTime());
  for (const secret of [subscription.endpoint, subscription.keys.auth, 'dummy-session']) assert.ok(!JSON.stringify(result).includes(secret));
  await assert.rejects(f.service.subscribe('dummy-session', 'Owner', new Date(0), subscription, [], vapid.publicKey), { status: 400 });
});

test('push status and preferences: query binds both current user and session; supports mysql JSON arrays', async () => {
  const f = fixture([{ events_json: ['failed'], expires_at: new Date(Date.now() + 60000) }]);
  const endpointHash = hash(subscription.endpoint);
  await assert.rejects(f.service.status('current-session', 'Owner', [endpointHash]), { status: 400 });
  assert.equal((await f.service.status('current-session', 'Owner', endpointHash)).registered, true);
  const statusQuery = f.queries[0];
  assert.deepEqual(statusQuery.args.slice(0, 3), [endpointHash, 'current-session', 'Owner']);
  assert.match(statusQuery.sql, /session_id = \? AND username = \?/);
  assert.deepEqual((await f.service.update('current-session', 'Owner', endpointHash, [])).events, []);
  await f.service.unsubscribe('current-session', 'Owner', endpointHash);
  assert.deepEqual(f.queries.at(-1).args, [endpointHash, 'current-session', 'Owner']);
});

test('push delivery: requires a live matching owner session and selected event', async () => {
  const f = fixture([
    row(), row({ events_json: [] }), row({ session_data: JSON.stringify({ username: 'Owner', role: 'denied' }) }),
    row({ session_data: JSON.stringify({ username: 'Other', role: 'owner' }) }),
    row({ session_expires: 1 }), row({ expires_at: new Date(0) }), row({ vapid_key: 'old-key' }),
    row({ endpoint: 'https://internal.invalid/' }),
  ]);
  assert.deepEqual(await f.service.sendEvent('failed', '/tasks/12'), { sent: 1, failed: 0 });
  assert.equal(f.sent.length, 1);
  const payload = f.sent[0][1];
  assert.equal(payload.url, '/tasks/12');
  assert.equal(payload.version, 2);
  assert.equal(payload.event, 'failed');
  assert.equal(payload.title, undefined);
  assert.equal(payload.message, undefined);
  assert.match(payload.tag, /^nanona-[a-f0-9]{24}$/);
});

test('push delivery: removed owners and disabled config never receive notifications', async () => {
  let calls = 0;
  const service = createPushService({ db: { query: async () => { calls++; throw new Error('must not query'); } }, readConfig: () => null });
  assert.deepEqual(await service.sendEvent('failed', '/'), { sent: 0, failed: 0 });
  assert.equal(calls, 0);
  const f = fixture([row({ username: 'Other', session_data: JSON.stringify({ username: 'Other', role: 'owner' }) })]);
  assert.equal((await f.service.sendEvent('failed', '/')).sent, 0);
  assert.equal(f.sent.length, 0);
});

test('push delivery: deletes expired provider subscriptions, retains transient failures, never propagates transport errors', async () => {
  for (const code of [404, 410, 503, new Error('do not print sensitive endpoint')]) {
    const f = fixture([row()]);
    f.setCode(code);
    assert.deepEqual(await f.service.sendEvent('failed', 'https://evil.invalid/'), { sent: 0, failed: 1 });
    assert.equal(f.sent[0][1].url, '/');
    const deletes = f.queries.filter((query) => query.sql.startsWith('DELETE FROM push_subscriptions'));
    assert.equal(deletes.length, code === 404 || code === 410 ? 1 : 0);
    if (deletes.length) assert.deepEqual(deletes[0].args, [row().endpoint_hash, 'dummy-session', subscription.keys.p256dh, subscription.keys.auth]);
  }
});

test('push test delivery: bypasses event selection only for a specific current session and endpoint', async () => {
  const f = fixture([row({ events_json: [] })]);
  const endpointHash = hash(subscription.endpoint);
  assert.equal((await f.service.sendEvent('test', '/settings', { sessionId: 'current', endpointHash })).sent, 1);
  const select = f.queries.find((query) => query.sql.includes('SELECT p.*'));
  assert.match(select.sql, /p.session_id = \? AND p.endpoint_hash = \?/);
  assert.deepEqual(select.args.slice(-2), ['current', endpointHash]);
  await assert.rejects(f.service.sendEvent('test', '/', {}), { status: 400 });
});

test('push transport: encrypts payload, signs VAPID, sets short TTL and passes a total-time abort signal', async () => {
  let captured;
  const signal = AbortSignal.timeout(1000);
  const result = await sendHttp(subscription, { url: '/tasks/1' }, vapid, signal, (url, options, callback) => {
    const request = new EventEmitter();
    request.end = (body) => {
      captured = { url, options, body };
      const response = new EventEmitter();
      response.statusCode = 201;
      response.resume = () => {};
      callback(response);
      queueMicrotask(() => response.emit('end'));
    };
    return request;
  });
  assert.equal(result, 201);
  assert.equal(captured.url, subscription.endpoint);
  assert.equal(captured.options.signal, signal);
  assert.equal(Number(captured.options.headers.TTL), 60);
  assert.match(captured.options.headers.Authorization, /^vapid /);
  assert.equal(captured.options.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(Buffer.isBuffer(captured.body));
  assert.ok(!captured.body.includes(Buffer.from('/tasks/1')));
});

test('push logout cleanup: missing optional table is tolerated, other database failures remain detectable', async () => {
  const service = createPushService({ db: { query: async () => { throw Object.assign(new Error('table'), { code: 'ER_NO_SUCH_TABLE' }); } } });
  await service.revokeSession('dummy-session');
  const broken = createPushService({ db: { query: async () => { throw new Error('database'); } } });
  await assert.rejects(broken.revokeSession('dummy-session'));
});

test('notify: device selection is independent of mail filtering and failures do not suppress the other channel', async () => {
  const push = require('../src/services/push');
  const { notify } = require('../src/services/notify');
  const previous = push.sendEvent;
  const settings = { webhookUrl: '', mailTo: '', mailFrom: '', events: 'completed' };
  try {
    push.sendEvent = async () => ({ sent: 1, failed: 0 });
    assert.equal(await notify({ event: 'failed', title: 'dummy', settings }), true);
    push.sendEvent = async () => { throw new Error('dummy database failure'); };
    assert.equal(await notify({ event: 'failed', title: 'dummy', settings: { ...settings, webhookUrl: 'https://example.invalid/', events: 'failed' }, fetchFn: async () => ({ ok: true }) }), true);
  } finally { push.sendEvent = previous; }
});

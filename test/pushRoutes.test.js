'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Duplex } = require('node:stream');
const { createRequire } = require('node:module');
const signature = createRequire(require.resolve('express-session'))('cookie-signature');
const push = require('../src/services/push');

function fixture() {
  const files = [require.resolve('../src/db'), require.resolve('express-mysql-session'), require.resolve('../src/app')];
  const previous = files.map((file) => require.cache[file]);
  const oldSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'dummy-push-route-test';
  require.cache[files[0]] = { id: files[0], filename: files[0], loaded: true, exports: { pool: { query: async () => { throw new Error('unexpected DB query'); } } } };
  require.cache[files[1]] = { id: files[1], filename: files[1], loaded: true, exports: (session) => class extends session.MemoryStore {
    constructor() {
      super();
      for (const [id, username] of [['owner-a', 'Nanona15dobato'], ['owner-b', 'Nanona15dobato'], ['emergency', 'nanona15']]) {
        this.set(id, { cookie: { path: '/', httpOnly: true, originalMaxAge: 60000, expires: new Date(Date.now() + 60000) }, username, role: 'owner' });
      }
    }
  } };
  delete require.cache[files[2]];
  const app = require('../src/app')();
  const methods = ['configured', 'status', 'subscribe', 'update', 'unsubscribe', 'revokeSession', 'sendEvent'];
  const saved = Object.fromEntries(methods.map((name) => [name, push[name]]));
  const calls = [];
  for (const method of methods) push[method] = async (...args) => { calls.push({ method, args }); return { registered: true }; };
  push.configured = () => ({ publicKey: 'dummy-public', privateKey: 'must-not-leak' });
  return { app, calls,
    cookie(id = 'owner-a') { return 'nanona_bot_sid=' + encodeURIComponent('s:' + signature.sign(id, process.env.SESSION_SECRET)); },
    restore() {
      Object.assign(push, saved);
      files.forEach((file, index) => { delete require.cache[file]; if (previous[index]) require.cache[file] = previous[index]; });
      if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
    },
  };
}

function request(app, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    socket.remoteAddress = '127.0.0.1';
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost:8000', ...headers };
    if (body !== undefined) {
      const text = JSON.stringify(body);
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = String(Buffer.byteLength(text));
      req.push(Buffer.from(text));
    }
    req.push(null);
    req.complete = true;
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('error', reject);
    socket.on('error', reject);
    res.on('finish', () => {
      resolve({ status: res.statusCode, headers: res.getHeaders(), wire: Buffer.concat(chunks).toString() });
      socket.destroy();
    });
    app.handle(req, res);
  });
}

test('push routes: guests and emergency-only users cannot configure or send notifications', async () => {
  const f = fixture();
  try {
    for (const cookie of [undefined, f.cookie('emergency')]) {
      for (const [url, method] of [['/api/push/config', 'GET'], ['/api/push/subscription', 'POST'], ['/api/push/test', 'POST']]) {
        const response = await request(f.app, url, { method, headers: cookie ? { cookie } : {}, body: method === 'POST' ? {} : undefined });
        assert.equal(response.status, 403);
        assert.equal(response.headers['cache-control'], 'no-store');
      }
    }
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('push routes: public VAPID key is owner-only and never exposes the private key', async () => {
  const f = fixture();
  try {
    const response = await request(f.app, '/api/push/config', { headers: { cookie: f.cookie() } });
    assert.equal(response.status, 200);
    assert.match(response.wire, /dummy-public/);
    assert.ok(!response.wire.includes('must-not-leak'));
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally { f.restore(); }
});

test('push routes: registration ignores user-supplied session/user identity and retains origin protection', async () => {
  const f = fixture();
  try {
    const body = { subscription: { dummy: true }, events: [], publicKey: 'dummy-current-key', sessionId: 'owner-b', username: 'Other' };
    const blocked = await request(f.app, '/api/push/subscription', { method: 'POST', headers: { cookie: f.cookie(), origin: 'https://other.invalid' }, body });
    assert.equal(blocked.status, 403);
    assert.equal(f.calls.length, 0);
    const response = await request(f.app, '/api/push/subscription', { method: 'POST', headers: { cookie: f.cookie() }, body });
    assert.equal(response.status, 200);
    const call = f.calls.find((item) => item.method === 'subscribe');
    assert.equal(call.args[0], 'owner-a');
    assert.equal(call.args[1], 'Nanona15dobato');
    assert.ok(new Date(call.args[2]).getTime() > Date.now());
    assert.deepEqual(call.args[3], { dummy: true });
    assert.equal(call.args[5], 'dummy-current-key');
  } finally { f.restore(); }
});

test('push routes: test targets only the current session, and rejects an unregistered endpoint', async () => {
  const f = fixture();
  try {
    push.status = async (id) => ({ registered: id === 'owner-a' });
    push.sendEvent = async (...args) => { f.calls.push({ method: 'sendEvent', args }); return { sent: 1 }; };
    const endpointHash = 'a'.repeat(64);
    const body = { endpointHash, sessionId: 'owner-a' };
    assert.equal((await request(f.app, '/api/push/test', { method: 'POST', headers: { cookie: f.cookie('owner-b') }, body })).status, 404);
    assert.equal(f.calls.length, 0);
    assert.equal((await request(f.app, '/api/push/test', { method: 'POST', headers: { cookie: f.cookie('owner-a') }, body })).status, 200);
    assert.deepEqual(f.calls[0].args, ['test', '/settings', { sessionId: 'owner-a', endpointHash }]);
  } finally { f.restore(); }
});

test('push logout: removes session subscriptions and destroys session even when push cleanup fails', async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    try {
      push.revokeSession = async (id) => { f.calls.push({ method: 'revokeSession', args: [id] }); if (fail) throw new Error('dummy failure'); };
      const cookie = f.cookie();
      const response = await request(f.app, '/oauth/logout', { method: 'POST', headers: { cookie } });
      assert.equal(response.status, 302);
      assert.deepEqual(f.calls[0], { method: 'revokeSession', args: ['owner-a'] });
      assert.match([].concat(response.headers['set-cookie']).join(';'), /nanona_bot_sid=;/);
      assert.equal((await request(f.app, '/api/push/config', { headers: { cookie } })).status, 403);
    } finally { f.restore(); }
  }
});

test('push routes: missing migration gives a bounded error without dumping subscription details', async () => {
  const f = fixture();
  try {
    push.subscribe = async () => { throw Object.assign(new Error('secret endpoint and keys'), { code: 'ER_NO_SUCH_TABLE' }); };
    const response = await request(f.app, '/api/push/subscription', { method: 'POST', headers: { cookie: f.cookie() }, body: {} });
    assert.equal(response.status, 503);
    assert.ok(!response.wire.includes('secret endpoint'));
  } finally { f.restore(); }
});

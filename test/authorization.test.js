'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// 実際のresolverとmiddlewareを使い、配備設定と公開Wiki APIだけをモックする。
async function withAuthorization(fn) {
  const files = ['../src/config', '../src/services/mediawiki', '../src/services/authorization', '../src/middleware/auth'];
  const paths = files.map((file) => require.resolve(file));
  const previous = paths.map((file) => require.cache[file]);
  const permissions = { ownerUsernames: ['Owner'], emergencyStopUsernames: ['Emergency'] };
  let groups = [];
  let groupError = false;
  let queries = 0;
  try {
    paths.forEach((file) => { delete require.cache[file]; });
    for (const [index, exports] of [
      [0, { permissions }],
      [1, { getUserGroups: async () => {
        queries++;
        if (groupError) throw new Error('dummy upstream failure');
        return [...groups];
      } }],
    ]) require.cache[paths[index]] = { id: paths[index], filename: paths[index], loaded: true, exports };
    const middleware = require('../src/middleware/auth');
    await fn({
      ...middleware, permissions,
      setGroups(value) { groups = value; },
      setFailure(value) { groupError = value; },
      queryCount: () => queries,
    });
  } finally {
    paths.forEach((file, index) => {
      delete require.cache[file];
      if (previous[index]) require.cache[file] = previous[index];
    });
  }
}

function response() {
  return {
    locals: {}, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

async function authorize(middleware, session, allowedRoles = ['owner'], path = '/api/tasks', method = 'GET') {
  const req = { session, path, method };
  const res = response();
  let reachedHandler = false;
  await middleware.attachUser(req, res, () => {
    middleware.requireRole(...allowedRoles)(req, res, () => { reachedHandler = true; });
  });
  return { res, reachedHandler };
}

test('authorization: explicit owner/emergency grants do not depend on the group API', async () => {
  await withAuthorization(async (auth) => {
    auth.setFailure(true);
    assert.equal((await authorize(auth, { username: 'owner', role: 'denied' })).reachedHandler, true);
    const emergency = await authorize(auth, { username: 'Emergency', role: 'owner' }, ['owner', 'admin_emergency_only']);
    assert.equal(emergency.reachedHandler, true);
    assert.equal(emergency.res.locals.role, 'admin_emergency_only');
    assert.equal(auth.queryCount(), 0);
  });
});

test('authorization: removing an owner rejects the same existing session on its next request', async () => {
  await withAuthorization(async (auth) => {
    const session = { username: 'Owner', role: 'owner' };
    assert.equal((await authorize(auth, session)).reachedHandler, true);
    auth.permissions.ownerUsernames = [];
    const result = await authorize(auth, session);
    assert.equal(result.reachedHandler, false);
    assert.equal(result.res.statusCode, 403);
    assert.equal(session.role, 'denied');
    assert.equal(result.res.locals.role, 'denied');
  });
});

test('authorization: removed owner retains only an independently valid emergency grant', async () => {
  await withAuthorization(async (auth) => {
    const session = { username: 'Owner', role: 'owner' };
    auth.permissions.ownerUsernames = [];
    auth.setGroups(['sysop']);
    assert.equal((await authorize(auth, session)).res.statusCode, 403);
    assert.equal(session.role, 'admin_emergency_only');
    assert.equal((await authorize(auth, session, ['owner', 'admin_emergency_only'])).reachedHandler, true);
  });
});

test('authorization: removal from explicit emergency list applies to an existing session', async () => {
  await withAuthorization(async (auth) => {
    const session = { username: 'Emergency', role: 'admin_emergency_only' };
    auth.permissions.emergencyStopUsernames = [];
    const result = await authorize(auth, session, ['owner', 'admin_emergency_only']);
    assert.equal(result.res.statusCode, 403);
    assert.equal(result.reachedHandler, false);
  });
});

test('authorization: Wiki group removal is checked without a role cache', async () => {
  for (const group of ['sysop', 'extendedconfirmed']) {
    await withAuthorization(async (auth) => {
      const session = { username: 'WikiUser', role: 'admin_emergency_only' };
      auth.setGroups([group]);
      assert.equal((await authorize(auth, session, ['admin_emergency_only'])).reachedHandler, true);
      auth.setGroups(['user']);
      const revoked = await authorize(auth, session, ['admin_emergency_only']);
      assert.equal(revoked.reachedHandler, false);
      assert.equal(revoked.res.statusCode, 403);
      assert.equal(session.role, 'denied');
      assert.equal(auth.queryCount(), 2);
    });
  }
});

test('authorization: failed revalidation blocks old privileges, and recovery rechecks the same session', async () => {
  await withAuthorization(async (auth) => {
    const session = { username: 'WikiUser', role: 'owner' };
    auth.setFailure(true);
    const failed = await authorize(auth, session, ['owner', 'admin_emergency_only']);
    assert.equal(failed.reachedHandler, false);
    assert.equal(failed.res.statusCode, 503);
    assert.equal(failed.res.body.error, 'authorization_unavailable');
    assert.equal(failed.res.locals.role, null);
    assert.equal(session.role, 'denied');
    auth.setFailure(false);
    auth.setGroups(['sysop']);
    assert.equal((await authorize(auth, session, ['admin_emergency_only'])).reachedHandler, true);
  });
});

test('authorization: page handlers also stop on failed revalidation', async () => {
  await withAuthorization(async (auth) => {
    auth.setFailure(true);
    const result = await authorize(auth, { username: 'WikiUser', role: 'owner' }, ['owner'], '/settings');
    assert.equal(result.reachedHandler, false);
    assert.equal(result.res.statusCode, 503);
    assert.equal(typeof result.res.body, 'string');
  });
});

test('authorization: a legacy role without an authenticated username cannot authorize', async () => {
  await withAuthorization(async (auth) => {
    const session = { role: 'owner' };
    assert.equal((await authorize(auth, session)).res.statusCode, 403);
    assert.equal(session.role, undefined);
    assert.equal(auth.queryCount(), 0);
  });
});

test('authorization: login, callback and logout remain reachable during Wiki API failure', async () => {
  await withAuthorization(async (auth) => {
    auth.setFailure(true);
    for (const [method, path] of [['GET', '/oauth/login'], ['GET', '/oauth/callback'], ['POST', '/oauth/logout']]) {
      let continued = false;
      const res = response();
      await auth.attachUser({ method, path, session: { username: 'WikiUser', role: 'owner' } }, res, () => { continued = true; });
      assert.equal(continued, true);
      assert.equal(res.locals.role, null);
    }
    assert.equal(auth.queryCount(), 0);
  });
});

test('getUserGroups: enforces a deadline and rejects API errors/malformed responses', async () => {
  const configPath = require.resolve('../src/config');
  const apiPath = require.resolve('../src/services/mediawiki');
  const previousConfig = require.cache[configPath];
  const previousApi = require.cache[apiPath];
  const previousFetch = global.fetch;
  try {
    require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: {
      permissions: { adminCheckWikiHost: 'wiki.invalid' }, userAgent: 'dummy-test',
    } };
    delete require.cache[apiPath];
    const { getUserGroups } = require('../src/services/mediawiki');
    let payload = { query: { users: [{ groups: ['user', 'sysop'] }] } };
    global.fetch = async (url, options) => {
      assert.equal(url.hostname, 'wiki.invalid');
      assert.equal(url.searchParams.get('ususers'), 'WikiUser');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => payload };
    };
    assert.deepEqual(await getUserGroups('WikiUser'), ['user', 'sysop']);
    for (const invalid of [{ error: { code: 'maxlag' } }, {}, { query: { users: [{ groups: 'sysop' }] } }, { query: { users: [{ groups: [1] }] } }]) {
      payload = invalid;
      await assert.rejects(getUserGroups('WikiUser'));
    }
    payload = { query: { users: [{ missing: true }] } };
    assert.deepEqual(await getUserGroups('WikiUser'), []);
  } finally {
    global.fetch = previousFetch;
    for (const [file, previous] of [[configPath, previousConfig], [apiPath, previousApi]]) {
      delete require.cache[file];
      if (previous) require.cache[file] = previous;
    }
  }
});

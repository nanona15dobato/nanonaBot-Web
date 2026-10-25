'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Duplex } = require('node:stream');
const { createRequire } = require('node:module');
const signature = createRequire(require.resolve('express-session'))('cookie-signature');

// 実際のExpressアプリとセッション処理を通す。DBのみインメモリに差し替え、
// HTTPはメモリ上のソケットへ直列化するため、待受ポートや外部接続は不要。
function createTestApp() {
  const dbPath = require.resolve('../src/db');
  const storePath = require.resolve('express-mysql-session');
  const appPath = require.resolve('../src/app');
  const previous = [dbPath, storePath, appPath].map((file) => require.cache[file]);
  const previousSecret = process.env.SESSION_SECRET;
  const previousClientId = process.env.OAUTH_CLIENT_ID;
  process.env.SESSION_SECRET = 'dummy-security-header-test-only';
  process.env.OAUTH_CLIENT_ID = 'dummy-security-header-client';
  let storeReads = 0;
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    pool: { query: async () => { throw new Error('unexpected database access'); } },
  } };
  require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: (session) => class extends session.MemoryStore {
    constructor() {
      super();
      this.set('dummy-owner-session', {
        cookie: { path: '/', httpOnly: true, originalMaxAge: 60000, expires: new Date(Date.now() + 60000) },
        username: 'Nanona15dobato', role: 'owner',
      });
    }
    get(id, callback) {
      storeReads++;
      return super.get(id, callback);
    }
  } };
  delete require.cache[appPath];
  const app = require('../src/app')();
  return {
    app,
    ownerCookie: `nanona_bot_sid=${encodeURIComponent(`s:${signature.sign('dummy-owner-session', process.env.SESSION_SECRET)}`)}`,
    storeReads: () => storeReads,
    restore() {
      [dbPath, storePath, appPath].forEach((file, index) => {
        delete require.cache[file];
        if (previous[index]) require.cache[file] = previous[index];
      });
      if (previousSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSecret;
      if (previousClientId === undefined) delete process.env.OAUTH_CLIENT_ID;
      else process.env.OAUTH_CLIENT_ID = previousClientId;
    },
  };
}

function request(app, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({
      read() {},
      write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    });
    socket.remoteAddress = '127.0.0.1';
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost:8000', ...headers };
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

function assertProtected(response) {
  assert.equal(response.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(response.wire, /Content-Security-Policy: frame-ancestors 'none'/i);
  assert.match(response.wire, /X-Frame-Options: DENY/i);
}

test('framing policy: login and authenticated HTML/JSON responses carry enforcing headers', { timeout: 10000 }, async () => {
  const fixture = createTestApp();
  try {
    for (const [path, headers] of [
      ['/', {}],
      ['/', { cookie: fixture.ownerCookie }],
      ['/settings', { cookie: fixture.ownerCookie }],
      ['/api/whoami', { cookie: fixture.ownerCookie }],
    ]) {
      const result = await request(fixture.app, path, { headers });
      assert.equal(result.status, 200, path);
      assertProtected(result);
      if (path === '/api/whoami') assert.match(result.wire, /"role":"owner"/);
    }
  } finally { fixture.restore(); }
});

test('framing policy: authorization/origin refusals and error responses retain headers', { timeout: 10000 }, async () => {
  const fixture = createTestApp();
  try {
    for (const [path, options, expected] of [
      ['/api/tasks', {}, 403],
      ['/api/tasks', { method: 'POST', headers: { origin: 'https://other.invalid' } }, 403],
      ['/not-found', {}, 404],
      ['/api/not-found', {}, 404],
      ['/api/tasks', { headers: { cookie: fixture.ownerCookie } }, 500],
    ]) {
      const result = await request(fixture.app, path, options);
      assert.equal(result.status, expected, path);
      assertProtected(result);
    }
  } finally { fixture.restore(); }
});

test('framing policy: static files receive headers before session-store access', { timeout: 10000 }, async () => {
  const fixture = createTestApp();
  try {
    const result = await request(fixture.app, '/static/css/app.css', { headers: { cookie: fixture.ownerCookie } });
    assert.equal(result.status, 200);
    assertProtected(result);
    assert.equal(fixture.storeReads(), 0);
    assert.match(result.headers['content-type'], /text\/css/);
  } finally { fixture.restore(); }
});

test('PWA: root worker, manifest and public offline assets work without session-store reads', { timeout: 10000 }, async () => {
  const fixture = createTestApp();
  try {
    for (const [path, mime] of [
      ['/sw.js', /javascript/], ['/manifest.webmanifest', /manifest\+json/],
      ['/static/offline.html', /text\/html/], ['/static/icons/icon-192.png', /image\/png/],
    ]) {
      const result = await request(fixture.app, path, { headers: { cookie: fixture.ownerCookie } });
      assert.equal(result.status, 200, path);
      assert.match(result.headers['content-type'], mime);
      assertProtected(result);
      assert.equal(result.headers['set-cookie'], undefined);
      if (path === '/sw.js' || path === '/manifest.webmanifest') assert.equal(result.headers['cache-control'], 'no-cache');
    }
    assert.equal(fixture.storeReads(), 0);
  } finally { fixture.restore(); }
});

test('PWA: login, authenticated HTML/API and authentication redirects prohibit HTTP caching', { timeout: 10000 }, async () => {
  const fixture = createTestApp();
  try {
    for (const [path, headers, status] of [
      ['/', {}, 200], ['/', { cookie: fixture.ownerCookie }, 200],
      ['/api/whoami', { cookie: fixture.ownerCookie }, 200], ['/api/tasks', {}, 403], ['/oauth/login', {}, 302],
    ]) {
      const result = await request(fixture.app, path, { headers });
      assert.equal(result.status, status, path);
      assert.equal(result.headers['cache-control'], 'no-store', path);
      assertProtected(result);
    }
  } finally { fixture.restore(); }
});

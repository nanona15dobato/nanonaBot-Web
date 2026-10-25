'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { renderShell, renderStaticPage } = require('../src/views/shell');
const publicDir = path.join(__dirname, '..', 'public');
const source = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8');

function events(target = {}) {
  const handlers = new Map();
  target.addEventListener = (type, fn) => {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(fn);
  };
  target.dispatchEvent = (event) => {
    for (const fn of handlers.get(event.type) || []) fn(event);
  };
  target.emit = async (type, event = {}) => {
    for (const fn of handlers.get(type) || []) await fn(event);
  };
  return target;
}

function element(tag) {
  return events({
    tag, hidden: false, disabled: false, children: [], textContent: '',
    setAttribute() {},
    append(...children) { this.children.push(...children); },
    prepend(...children) { this.children.unshift(...children); },
    querySelector(name) {
      for (const child of this.children) {
        if (child.tag === name) return child;
        const found = child.querySelector && child.querySelector(name);
        if (found) return found;
      }
      return null;
    },
  });
}

function client(fetch) {
  let reloads = 0;
  const messages = [];
  const registration = events({ waiting: { postMessage: (data) => messages.push(data) } });
  const navigator = { onLine: true, serviceWorker: events({ controller: {}, register: async (...args) => {
    registration.args = args;
    return registration;
  } }) };
  const document = events({ hidden: false, body: element('body'), createElement: element, querySelectorAll: () => [] });
  const window = events({
    NANONA_BOT: { username: 'Owner', role: 'owner' },
    isSecureContext: true,
    location: { reload: () => reloads++ },
    confirm: () => true,
    matchMedia: () => ({ matches: false }),
    fetch,
  });
  const context = vm.createContext({ window, document, navigator, Event, Date, console, fetch });
  vm.runInContext(source('js/pwa.js'), context);
  return { window, document, navigator, context, registration, messages, reloads: () => reloads,
    request: (...args) => window.NanonaPwa.request(...args),
    boot: () => document.emit('DOMContentLoaded'),
  };
}

const authorized = () => ({ ok: true, status: 200, json: async () => ({ username: 'Owner', role: 'owner' }) });

test('PWA metadata: both shells expose the same manifest, icons and client', () => {
  for (const html of [renderShell({ title: 'Home', script: 'dashboard.js' }), renderStaticPage({ title: 'Login', bodyHtml: '' })]) {
    assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
    assert.match(html, /rel="apple-touch-icon"/);
    assert.match(html, /src="\/static\/js\/pwa.js"/);
    assert.match(html, /viewport-fit=cover/);
  }
  const manifest = JSON.parse(source('manifest.webmanifest'));
  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
  for (const icon of [...manifest.icons, { src: '/static/icons/favicon-180.png', sizes: '180x180' }]) {
    const data = fs.readFileSync(path.join(publicDir, icon.src.replace('/static/', '')));
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(data.readUInt32BE(16), size);
    assert.equal(data.readUInt32BE(20), size);
    let offset = 8;
    const compressed = [];
    while (offset < data.length) {
      const length = data.readUInt32BE(offset);
      if (data.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(data.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    assert.ok([2, 6].includes(data[25]), 'RGB or RGBA PNG');
    assert.equal(data[24], 8, '8-bit PNG');
    const channels = data[25] === 6 ? 4 : 3;
    assert.equal(zlib.inflateSync(Buffer.concat(compressed)).length, size * (1 + size * channels));
  }
});

test('PWA requests: offline writes are never sent or marked as possibly executed', async () => {
  let calls = 0;
  const c = client(async () => { calls++; });
  c.navigator.onLine = false;
  await assert.rejects(c.request('/api/tasks', { method: 'POST' }), (error) => {
    assert.match(error.message, /送信しませんでした/);
    assert.equal(error.resultUnknown, undefined);
    return true;
  });
  assert.equal(calls, 0);
});

test('PWA requests: a lost write response is sent once and is never automatically replayed', async () => {
  const calls = [];
  const c = client(async (url, options) => {
    calls.push([url, options]);
    if (url === '/api/whoami') return authorized();
    throw new TypeError('network disconnected');
  });
  await assert.rejects(c.request('/api/tasks', { method: 'POST' }), (error) => error.resultUnknown === true);
  await c.window.emit('online');
  assert.deepEqual(calls.map(([url]) => url), ['/api/whoami', '/api/tasks', '/api/whoami']);
  assert.ok(calls.every(([, options]) => options.cache === 'no-store'));
});

test('PWA requests: user/role changes prevent writes from an old screen', async () => {
  for (const user of [null, { username: 'Other', role: 'owner' }, { username: 'Owner', role: 'denied' }, { username: 'Owner', role: 'admin_emergency_only' }]) {
    const calls = [];
    const c = client(async (url) => { calls.push(url); return { ok: true, json: async () => user }; });
    await assert.rejects(c.request('/api/tasks', { method: 'POST' }), /画面を開き直して/);
    assert.deepEqual(calls, ['/api/whoami']);
  }
});

test('PWA requests: hidden/visible and restored pages require fresh authorization before writing', async () => {
  const calls = [];
  const c = client(async (url) => { calls.push(url); return authorized(); });
  await c.request('/api/tasks', { method: 'POST' });
  await c.request('/api/tasks', { method: 'POST' });
  c.document.hidden = true;
  await c.document.emit('visibilitychange');
  await c.request('/api/tasks', { method: 'POST' });
  await c.window.emit('pageshow', { persisted: true });
  await c.request('/api/tasks', { method: 'POST' });
  assert.equal(calls.filter((url) => url === '/api/whoami').length, 3);
  assert.equal(calls.filter((url) => url === '/api/tasks').length, 4);
});

test('PWA requests: read-only traffic stays online-only without a preliminary authorization request', async () => {
  const calls = [];
  const c = client(async (...args) => { calls.push(args); return authorized(); });
  await c.request('/api/tasks');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/tasks');
  assert.equal(calls[0][1].cache, 'no-store');
});

test('PWA update: registration has root scope; updates wait for the user and the entire write response', async () => {
  const c = client(async () => authorized());
  await c.boot();
  assert.equal(c.registration.args[0], '/sw.js');
  assert.equal(c.registration.args[1].scope, '/');
  assert.equal(c.registration.args[1].updateViaCache, 'none');
  const updateButton = c.document.body.children[1].querySelector('button');
  assert.equal(updateButton.disabled, false);
  assert.equal(c.messages.length, 0);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const write = c.request('/api/tasks', { method: 'POST' }, async () => held);
  await new Promise(setImmediate);
  assert.equal(updateButton.disabled, true);
  await updateButton.emit('click');
  assert.equal(c.messages.length, 0);
  release({ id: 1 });
  await write;
  assert.equal(updateButton.disabled, false);
  await updateButton.emit('click');
  assert.equal(c.messages[0].type, 'ACTIVATE_UPDATE');
  await c.navigator.serviceWorker.emit('controllerchange');
  assert.equal(c.reloads(), 1);
});

test('PWA update: initial control and declined updates never force a reload', async () => {
  const c = client(async () => authorized());
  await c.boot();
  await c.navigator.serviceWorker.emit('controllerchange');
  c.window.confirm = () => false;
  await c.document.body.children[1].querySelector('button').emit('click');
  assert.equal(c.reloads(), 0);
  assert.equal(c.messages.length, 0);
});

test('PWA install: prompts only after an explicit install button click', async () => {
  const c = client(async () => authorized());
  const panel = c.window.NanonaPwa.createInstallPanel();
  const install = panel.querySelector('button');
  let prompts = 0;
  assert.equal(install.hidden, true);
  await c.window.emit('beforeinstallprompt', { preventDefault() {}, prompt: async () => prompts++, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(install.hidden, false);
  assert.equal(prompts, 0);
  await install.emit('click');
  assert.equal(prompts, 1);
  assert.equal(install.hidden, true);
});

test('PWA common API: a truncated successful write body remains an unknown result', async () => {
  const calls = [];
  const c = client(async (url) => {
    calls.push(url);
    if (url === '/api/whoami') return authorized();
    return { ok: true, status: 200, json: async () => { throw new Error('truncated body'); } };
  });
  vm.runInContext(source('js/common.js'), c.context);
  await assert.rejects(c.window.NanonaCommon.postJson('/api/tasks', {}), (error) => error.resultUnknown === true);
  assert.deepEqual(calls, ['/api/whoami', '/api/tasks']);
});

function worker() {
  const origin = 'https://nanonabot01.toolforge.org';
  const stored = new Map();
  const deleted = [];
  const requests = [];
  let fetcher = async (request) => ({ source: 'network', request });
  let skipped = 0;
  const self = events({ location: { origin }, clients: { claim: async () => {} }, skipWaiting: () => skipped++ });
  const cache = {
    addAll: async (items) => { for (const item of items) { requests.push(item); stored.set(new URL(item.url).pathname, { source: 'cache', url: item.url }); } },
    match: async (url) => stored.get(url),
  };
  const caches = {
    open: async () => cache,
    keys: async () => ['nanonabot-pwa-v2', 'nanonabot-pwa-v3', 'other-application'],
    delete: async (key) => deleted.push(key),
  };
  class RelativeRequest extends Request {
    constructor(url, options) { super(new URL(url, origin), options); }
  }
  vm.runInNewContext(source('sw.js'), { self, caches, URL, Request: RelativeRequest, Response, fetch: (...args) => fetcher(...args) });
  async function lifecycle(name) {
    let pending;
    await self.emit(name, { waitUntil: (promise) => { pending = promise; } });
    await pending;
  }
  async function get(url, options = {}) {
    let response;
    const request = { url: new URL(url, origin).href, method: 'GET', mode: 'cors', ...options };
    await self.emit('fetch', { request, respondWith: (promise) => { response = promise; } });
    return response;
  }
  return { self, stored, deleted, requests, lifecycle, get, skipped: () => skipped,
    fetch: (fn) => { fetcher = fn; },
  };
}

test('Service Worker: precaches only public files without credentials and cleans only its own old caches', async () => {
  const w = worker();
  await w.lifecycle('install');
  assert.equal(w.requests.length, 5);
  assert.ok(w.requests.every((request) => request.credentials === 'omit'));
  assert.deepEqual([...w.stored.keys()].sort(), [
    '/static/offline.html', '/static/icons/favicon-192.png', '/static/icons/bot-favicon.png',
    '/static/icons/icon-maskable-512.png', '/static/icons/favicon-180.png',
  ].sort());
  assert.equal(w.skipped(), 0);
  await w.lifecycle('activate');
  assert.deepEqual(w.deleted, ['nanonabot-pwa-v2']);
});

test('Service Worker: API, OAuth, writes, external requests and application JS/CSS bypass interception', async () => {
  const w = worker();
  for (const [url, options] of [
    ['/api/tasks', {}], ['/api/tasks', { mode: 'navigate' }],
    ['/oauth/callback?code=dummy', { mode: 'navigate' }], ['/oauth/login', { mode: 'navigate' }],
    ['/api/tasks', { method: 'POST' }], ['/static/js/common.js', {}], ['/static/css/app.css', {}],
    ['https://other.invalid/', { mode: 'navigate' }],
  ]) assert.equal(await w.get(url, options), undefined, url);
});

test('Service Worker: online navigation is never cached; HTTP errors retain their original response', async () => {
  const w = worker();
  await w.lifecycle('install');
  const forbidden = { status: 403, body: 'denied' };
  w.fetch(async () => forbidden);
  assert.equal(await w.get('/tasks/1', { mode: 'navigate' }), forbidden);
  assert.equal(w.stored.has('/tasks/1'), false);
  assert.equal(w.stored.size, 5);
});

test('Service Worker: a network failure returns the generic offline page with no private task data', async () => {
  const w = worker();
  await w.lifecycle('install');
  w.fetch(async () => { throw new Error('offline'); });
  const response = await w.get('/tasks/123', { mode: 'navigate' });
  assert.equal(response.source, 'cache');
  assert.match(response.url, /\/static\/offline.html$/);
  await w.self.emit('message', { data: { type: 'ACTIVATE_UPDATE' } });
  assert.equal(w.skipped(), 1);
});

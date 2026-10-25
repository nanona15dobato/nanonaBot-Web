'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const handlers = new Map();
  const notices = [];
  const opened = [];
  const messages = [];
  const self = {
    location: { origin: 'https://nanonabot01.toolforge.org' },
    registration: { showNotification: async (...args) => notices.push(args) },
    clients: { openWindow: async (url) => opened.push(url), matchAll: async () => [{ postMessage: (message) => messages.push(message) }] },
    addEventListener: (type, fn) => handlers.set(type, fn),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'), { self, URL });
  return { notices, opened, messages, async emit(type, data = {}) {
    let pending;
    handlers.get(type)({ ...data, waitUntil: (promise) => { pending = promise; } });
    await pending;
  } };
}

test('push worker: always shows generic text, even if payload supplies sensitive details or malformed JSON', async () => {
  const f = fixture();
  await f.emit('push', { data: { json: () => ({ title: 'secret page', body: 'secret failure', url: '/tasks/12', tag: 'nanona-' + 'a'.repeat(24) }) } });
  await f.emit('push', { data: { json: () => { throw new Error('bad json'); } } });
  await f.emit('push', { data: { json: () => ({ url: { toString: null } }) } });
  assert.equal(f.notices.length, 3);
  for (const [title, options] of f.notices) {
    assert.equal(title, 'nanonaBot Web');
    assert.ok(!options.body.includes('secret'));
    assert.equal(options.actions, undefined);
  }
  assert.equal(f.notices[0][1].data.url, '/tasks/12');
  assert.equal(f.notices[1][1].data.url, '/');
});

test('push worker: notification clicks open only an allowed same-origin page and never execute an action', async () => {
  const f = fixture();
  let closed = 0;
  for (const url of ['https://evil.invalid/', '//evil.invalid/', '/oauth/login', '/api/tasks', '/tasks/1?execute=1', '/tasks/1', '/settings']) {
    await f.emit('notificationclick', { notification: { data: { url }, close: () => closed++ } });
  }
  assert.equal(closed, 7);
  assert.deepEqual(f.opened, Array(5).fill('https://nanonabot01.toolforge.org/').concat([
    'https://nanonabot01.toolforge.org/tasks/1', 'https://nanonabot01.toolforge.org/settings',
  ]));
});

test('push worker: advertises capability and asks open pages to recheck an expired subscription without auto-subscribing', async () => {
  const f = fixture();
  let version;
  await f.emit('message', { data: { type: 'PUSH_CAPABILITIES' }, ports: [{ postMessage: (data) => { version = data.version; } }] });
  assert.equal(version, 2);
  await f.emit('pushsubscriptionchange');
  assert.equal(f.messages[0].type, 'PUSH_SUBSCRIPTION_CHANGED');
  assert.equal(f.notices.length, 0);
});

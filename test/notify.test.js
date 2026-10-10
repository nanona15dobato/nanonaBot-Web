'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { notify, notifyTaskStatus } = require('../src/services/notify');

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('notify: NOTIFY_WEBHOOK_URL未設定なら何もしない', () =>
  withEnv({ NOTIFY_WEBHOOK_URL: undefined }, async () => {
    const sent = await notify({
      event: 'completed',
      title: 'x',
      fetchFn: async () => {
        throw new Error('呼ばれない想定');
      },
    });
    assert.equal(sent, false);
  }));

test('notify: SlackとDiscordの両方が読める形式でWebhookへ送る', () =>
  withEnv({ NOTIFY_WEBHOOK_URL: 'https://hooks.example/abc', NOTIFY_EVENTS: undefined }, async () => {
    let request;
    const sent = await notify({
      event: 'emergency_stop',
      title: '緊急停止が実行されました',
      path: '/',
      fetchFn: async (url, init) => {
        request = { url, body: JSON.parse(init.body) };
        return { ok: true, status: 204 };
      },
    });
    assert.equal(sent, true);
    assert.equal(request.url, 'https://hooks.example/abc');
    assert.equal(request.body.text, request.body.content);
    assert.ok(request.body.text.startsWith('[NanonaBot Tool] 緊急停止が実行されました'));
  }));

test('notify: NOTIFY_EVENTSに含まれない種類は送らず、送信失敗でも例外を投げない', () =>
  withEnv({ NOTIFY_WEBHOOK_URL: 'https://hooks.example/abc', NOTIFY_EVENTS: 'failed, paused' }, async () => {
    const calls = [];
    const fetchFn = async () => {
      calls.push(1);
      throw new Error('network down');
    };
    assert.equal(await notify({ event: 'completed', title: 'x', fetchFn }), false);
    assert.equal(calls.length, 0);
    assert.equal(await notify({ event: 'failed', title: 'x', fetchFn }), false);
    assert.equal(calls.length, 1);
  }));

test('notifyTaskStatus: 通知対象の状態だけ送り、タスクへのリンクを付ける', () =>
  withEnv({ NOTIFY_WEBHOOK_URL: 'https://hooks.example/abc', NOTIFY_EVENTS: undefined }, async () => {
    const bodies = [];
    const fetchFn = async (url, init) => {
      bodies.push(JSON.parse(init.body).text);
      return { ok: true, status: 200 };
    };
    assert.equal(await notifyTaskStatus({ id: 7, account: 'NanonaBot' }, 'cancelled', { fetchFn }), false);
    assert.equal(await notifyTaskStatus({ id: 7, account: 'NanonaBot' }, 'paused', { fetchFn, detail: '原因' }), true);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /タスク #7 が失敗により一時停止しました/);
    assert.match(bodies[0], /原因/);
    assert.match(bodies[0], /\/tasks\/7$/);
  }));

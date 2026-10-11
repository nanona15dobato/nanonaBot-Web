'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateNotifySettings } = require('../src/routes/settings');
const { getNotifySettings, saveNotifySettings, clearSettingsCache } = require('../src/services/settings');
const { ALL_EVENTS } = require('../src/services/notify');

test('validateNotifySettings: 正しい値はそのまま、全種類を選んだ通知は空（＝すべて）にする', () => {
  const { values, errors } = validateNotifySettings({
    webhookUrl: ' https://hooks.example/abc ',
    mailTo: 'nanona15dobato@toolforge.org, other@toolforge.org',
    mailFrom: '"nanonaBotWeb:Error" <nanonabot01.weberror@toolforge.org>',
    events: ALL_EVENTS,
  });
  assert.deepEqual(errors, []);
  assert.equal(values.webhookUrl, 'https://hooks.example/abc');
  assert.equal(values.events, '');
  assert.equal(validateNotifySettings({ events: ['failed', 'paused'] }).values.events, 'failed,paused');
});

test('validateNotifySettings: http のWebhook・不正な宛先・toolforge.org以外の送信元・未知の種類はエラー', () => {
  const { errors } = validateNotifySettings({
    webhookUrl: 'http://hooks.example/abc',
    mailTo: 'not-an-address',
    mailFrom: 'someone@example.com',
    events: ['unknown'],
  });
  assert.equal(errors.length, 4);
});

test('validateNotifySettings: null は環境変数の値に戻す指定としてそのまま渡す', () => {
  const { values, errors } = validateNotifySettings({ webhookUrl: null, mailTo: null, mailFrom: null, events: null });
  assert.deepEqual(errors, []);
  assert.deepEqual(values, { webhookUrl: null, mailTo: null, mailFrom: null, events: null });
});

test('getNotifySettings/saveNotifySettings: DBの値を環境変数より優先し、null で消すと環境変数に戻る', async () => {
  const rows = new Map();
  const pool = {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT setting_key')) {
        return [[...rows.entries()].filter(([k]) => params[0].includes(k)).map(([k, v]) => ({ setting_key: k, setting_value: v }))];
      }
      if (s.startsWith('INSERT INTO app_settings')) {
        rows.set(params[0], params[1]);
        return [{}];
      }
      if (s.startsWith('DELETE FROM app_settings')) {
        rows.delete(params[0]);
        return [{}];
      }
      throw new Error('想定外のSQL: ' + s);
    },
  };
  const savedEnv = process.env.NOTIFY_WEBHOOK_URL;
  process.env.NOTIFY_WEBHOOK_URL = 'https://env.example/hook';
  try {
    clearSettingsCache();
    let settings = await getNotifySettings({ fresh: true, pool });
    assert.equal(settings.webhookUrl, 'https://env.example/hook');
    assert.equal(settings.sources.webhookUrl, 'env');

    await saveNotifySettings({ webhookUrl: 'https://db.example/hook' }, 'Nanona15dobato', pool);
    settings = await getNotifySettings({ fresh: true, pool });
    assert.equal(settings.webhookUrl, 'https://db.example/hook');
    assert.equal(settings.sources.webhookUrl, 'db');

    await saveNotifySettings({ webhookUrl: null }, 'Nanona15dobato', pool);
    settings = await getNotifySettings({ fresh: true, pool });
    assert.equal(settings.webhookUrl, 'https://env.example/hook');
  } finally {
    if (savedEnv === undefined) delete process.env.NOTIFY_WEBHOOK_URL;
    else process.env.NOTIFY_WEBHOOK_URL = savedEnv;
    clearSettingsCache();
  }
});

test('getNotifySettings: app_settingsテーブルが無い環境では環境変数だけで動く', async () => {
  const pool = {
    async query() {
      throw Object.assign(new Error("Table 'app_settings' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    },
  };
  clearSettingsCache();
  const settings = await getNotifySettings({ fresh: true, pool });
  assert.equal(typeof settings.webhookUrl, 'string');
  clearSettingsCache();
});

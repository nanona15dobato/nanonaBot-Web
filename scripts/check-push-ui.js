'use strict';
// Pushサービスへの接続・実際の通知許可を伴わない、設定画面の操作検証。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { renderShell } = require('../src/views/shell');
const { EVENTS, DEFAULT_EVENTS } = require('../src/services/push');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const origin = 'https://push-preview.invalid';
const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const key = ecdh.getPublicKey().toString('base64url');
const sub = { endpoint: 'https://fcm.googleapis.com/wp/dummy-ui-test', expirationTime: null,
  keys: { p256dh: key, auth: Buffer.alloc(16, 1).toString('base64url') } };

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=2'] });
  const results = [];
  try {
    for (const scenario of ['normal', 'logout-stalled', 'old-worker', 'unsupported', 'denied', 'permission-dismissed']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(10000);
      console.error('push-ui scenario:', scenario);
      const errors = [];
      const calls = [];
      let registered = false;
      let events = DEFAULT_EVENTS;
      page.on('pageerror', (error) => errors.push(error.message));
      await context.addInitScript(({ scenario, key, sub }) => {
        Object.defineProperty(navigator, 'onLine', { get: () => true });
        const state = { prompts: 0, subscriptions: 0, unsubscribes: 0, permission: scenario === 'denied' ? 'denied' : 'default', current: null };
        window.pushPreview = state;
        Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
        Object.defineProperty(window, 'Notification', { configurable: true, value: scenario === 'unsupported' ? undefined : {
          get permission() { return state.permission; },
          async requestPermission() { state.prompts++; state.permission = scenario === 'permission-dismissed' ? 'default' : 'granted'; return state.permission; },
        } });
        const registration = Object.assign(new EventTarget(), {
          active: { postMessage(data, ports) { if (scenario !== 'old-worker') ports[0].postMessage({ version: 2 }); } },
          waiting: null,
          update: async () => {},
          getNotifications: async () => [],
          pushManager: {
            getSubscription: async () => state.current,
            subscribe: async (options) => {
              state.subscriptions++;
              if (!options.userVisibleOnly) throw new Error('must be visible');
              state.current = { ...sub, options, toJSON: () => sub, unsubscribe: async () => {
                state.unsubscribes++; if (state.stallOnUnsubscribe) return new Promise(() => {}); state.current = null; return true;
              } };
              return state.current;
            },
          },
        });
        const worker = Object.assign(new EventTarget(), {
          ready: Promise.resolve(registration), controller: {},
          register: async () => registration, getRegistration: async () => registration,
        });
        Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
      }, { scenario, key, sub });
      await context.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.origin !== origin) return route.abort();
        if (req.method() === 'POST' && url.pathname === '/oauth/logout') {
          calls.push({ method: 'POST', path: '/oauth/logout' });
          registered = false;
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p>ログアウト確認</p>' });
        }
        if (url.pathname.startsWith('/api/')) {
          calls.push({ method: req.method(), path: url.pathname });
          const body = req.postDataJSON();
          let data = {};
          if (url.pathname === '/api/whoami') data = { username: 'Nanona15dobato', role: 'owner' };
          if (url.pathname === '/api/emergency-stop/status') data = { emergency_stopped: false };
          if (url.pathname === '/api/settings/notify') data = { allEvents: EVENTS, events: EVENTS, sources: {} };
          if (url.pathname === '/api/settings/worker') {
            const names = ['reviewPollMs', 'editRetryCount', 'editRetryBaseMs', 'nullEditIntervalMs', 'taskPagesRetentionDays'];
            data = { sources: {}, values: Object.fromEntries(names.map((name) => [name, 1])),
              limits: Object.fromEntries(names.map((name) => [name, { min: 0, max: 100000, def: 1, env: 'DUMMY' }])) };
          }
          if (url.pathname === '/api/push/config') data = { configured: true, publicKey: key, events: EVENTS, defaultEvents: DEFAULT_EVENTS };
          if (url.pathname === '/api/push/subscription') {
            if (req.method() === 'POST') { assert.equal(body.publicKey, key); registered = true; events = body.events; }
            if (req.method() === 'PUT') events = body.events;
            if (req.method() === 'DELETE') registered = false;
            data = { registered, events, expiresAt: new Date(Date.now() + 60000).toISOString() };
          }
          if (url.pathname === '/api/push/test') data = { accepted: registered };
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
        }
        if (url.pathname === '/settings') return route.fulfill({ contentType: 'text/html',
          body: renderShell({ title: '設定', script: 'settings.js', initialData: { username: 'Nanona15dobato', role: 'owner' } }) });
        for (const [prefix, folder] of [['/static/', 'public'], ['/vendor/jquery/', 'node_modules/jquery/dist'],
          ['/vendor/oojs/', 'node_modules/oojs/dist'], ['/vendor/oojs-ui/', 'node_modules/oojs-ui/dist']]) {
          if (!url.pathname.startsWith(prefix)) continue;
          const base = path.resolve(root, folder);
          const file = path.join(base, url.pathname.slice(prefix.length));
          if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) break;
          return route.fulfill({ contentType: ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
        }
        return route.fulfill({ status: 404, body: 'not found' });
      });
      await page.goto(origin + '/settings');
      console.error('push-ui loaded:', scenario);
      const enable = page.locator('.nb-push-enable');
      await enable.waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => pushPreview.prompts), 0);
      if (scenario === 'normal' || scenario === 'logout-stalled' || scenario === 'permission-dismissed') {
        await page.waitForFunction(() => !document.querySelector('.nb-push-enable').disabled);
        await enable.click();
        if (scenario === 'normal' || scenario === 'logout-stalled') {
          await page.waitForFunction(() => !document.querySelector('.nb-push-test').disabled);
          console.error('push-ui subscribed:', scenario);
          assert.equal(registered, true);
          assert.equal(await page.evaluate(() => pushPreview.prompts), 1);
          assert.equal(await page.evaluate(() => pushPreview.subscriptions), 1);
          for (const input of await page.locator('.nb-push-events input').all()) await input.uncheck();
          await page.locator('.nb-push-save').click();
          await page.waitForFunction(() => !document.querySelector('.nb-push-save').disabled);
          assert.deepEqual(events, []);
          await page.locator('.nb-push-test').click();
          await page.getByText('通知サービスへ送信しました。端末の表示をご確認ください。', { exact: true }).waitFor();
          console.error('push-ui tested:', scenario);
          await page.locator('.nb-push-disable').click();
          await page.getByText('この端末の通知を停止しました。送信済みの通知が遅れて届く場合があります。', { exact: true }).waitFor();
          assert.equal(registered, false);
          assert.equal(await page.evaluate(() => pushPreview.unsubscribes), 1);
          await enable.click();
          await page.waitForFunction(() => !document.querySelector('.nb-push-test').disabled);
          await page.getByRole('button', { name: '利用者メニュー: Nanona15dobato', exact: true }).click();
          if (scenario === 'logout-stalled') await page.evaluate(() => { pushPreview.stallOnUnsubscribe = true; });
          console.error('push-ui logout:', scenario);
          await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
          await page.getByText('ログアウト確認', { exact: true }).waitFor().catch((error) => { throw new Error(error.message + ' browser errors: ' + errors.join('; ') + ' URL: ' + page.url() + ' calls: ' + JSON.stringify(calls.slice(-5))); });
          assert.equal(registered, false);
          assert.ok(calls.some((call) => call.path === '/oauth/logout'));
        } else {
          await page.getByText('通知は許可されていません。', { exact: true }).waitFor();
          assert.equal(await page.evaluate(() => pushPreview.subscriptions), 0);
          assert.equal(registered, false);
        }
      } else {
        const text = scenario === 'old-worker' ? '端末通知を使うにはアプリの更新が必要です。' : scenario === 'denied' ? 'ブラウザで通知が拒否されています。' : 'このブラウザでは端末通知を利用できません。';
        await page.getByText(text, { exact: false }).waitFor();
        assert.equal(await enable.isDisabled(), true);
        assert.equal(await page.evaluate(() => pushPreview.prompts), 0);
      }
      assert.deepEqual(errors, [], scenario);
      results.push({ scenario, passed: true });
      await context.close();
    }
    console.log(JSON.stringify({ browser: browser.version(), results }));
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

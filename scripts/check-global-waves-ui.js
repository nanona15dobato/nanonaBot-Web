'use strict';
// Optional developer check. All application/API responses are local fixtures; no live wiki or DB.
// PLAYWRIGHT_MODULE_PATH=/path/to/playwright node scripts/check-global-waves-ui.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { renderShell } = require('../src/views/shell');
const root = path.join(__dirname, '..');
const origin = 'https://global-waves-preview.invalid';
const initialLabel = 'Template編集後、その呼び出し先のリンク表・カテゴリ所属を更新する';
const finalLabel = '編集後も残る参照候補をもう一度purgeする';
const sample = { account: 'NanonaBot', replacements: [{ templateType: 'linkRename', from: '旧', to: '新', namespaces: [0] }, { templateType: 'templateRename', from: '旧T', to: '新T', namespaces: [0] }], editSettings: { botFlag: true, minorEdit: true, editSummary: 'test', editIntervalSeconds: 5 }, reviewSettings: { mode: 'auto', autoWaitSeconds: 0 }, onFailure: 'pause' };
async function waitDisabled(locator, disabled) {
  const deadline = Date.now() + 5000;
  while (await locator.isDisabled() !== disabled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await locator.isDisabled(), disabled);
}
async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const results = [];
  try {
    for (const width of [390, 1280]) {
      for (const copied of [false, true]) {
        const context = await browser.newContext({ viewport: { width, height: 950 }, serviceWorkers: 'block' });
        const page = await context.newPage(), errors = [], requests = [];
        page.on('pageerror', e => errors.push(e.message));
        await context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => true }));
        await context.route('**/*', async route => {
          const req = route.request(), url = new URL(req.url());
          if (url.origin !== origin) throw new Error('Unexpected external request: '+url.origin);
          if (url.pathname.startsWith('/api/')) {
            let body = {};
            if (req.method() !== 'GET') { requests.push({ path: url.pathname, body: req.postDataJSON() }); body = { id: 42, ok: true }; }
            else if (url.pathname === '/api/whoami') body = { username: 'Nanona15dobato', role: 'owner' };
            else if (url.pathname === '/api/tasks/1') body = { config_json: copied ? { ...sample, editSettings: { ...sample.editSettings, refreshTemplateTransclusions: false, purgeRemainingTargets: true, linkUpdateMethod: 'nullEdit' } } : sample };
            else if (url.pathname === '/api/bot-accounts/defaults') body = ['NanonaBot','NanonaBot3','Nanona15dobato'].map(account => ({ account, editSettings: sample.editSettings, reviewSettings: sample.reviewSettings }));
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
          }
          if (url.pathname === '/tasks/new') return route.fulfill({ contentType: 'text/html', body: renderShell({ title: '新規タスク作成', script: 'taskNew.js', initialData: { username: 'Nanona15dobato', role: 'owner' } }) });
          if (url.pathname === '/tasks/42') return route.fulfill({ contentType: 'text/html', body: '<p>模擬タスクの作成結果</p>' });
          for (const [prefix, folder] of [['/static/','public/'],['/vendor/jquery/','node_modules/jquery/dist/'],['/vendor/oojs/','node_modules/oojs/dist/'],['/vendor/oojs-ui/','node_modules/oojs-ui/dist/']]) {
            if (!url.pathname.startsWith(prefix)) continue;
            const base = path.resolve(root, folder), file = path.resolve(base, url.pathname.slice(prefix.length));
            if (!file.startsWith(base+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) break;
            return route.fulfill({ contentType: ({'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
          }
          return route.fulfill({ status: 404, body: '' });
        });
        await page.goto(origin+'/tasks/new?from=1');
        await page.locator('.nb-rule-card').nth(1).waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Form overflow at '+width);
        const initial = page.getByLabel(initialLabel, { exact: true }), final = page.getByLabel(finalLabel, { exact: true }), method = page.getByLabel('Template呼び出し先の更新方法', { exact: true });
        assert.equal(await initial.isChecked(), !copied); assert.equal(await final.isChecked(), copied);
        assert.equal(await method.isDisabled(), copied);
        await initial.uncheck(); await waitDisabled(method, true);
        await initial.check(); await waitDisabled(method, false);
        await method.click(); await page.getByRole('option', { name: 'purge＋forcelinkupdate（呼び出し先を50件ずつ・既定）', exact: true }).click(); await final.check();
        const saved = page.waitForResponse(r => r.url().includes('/api/bot-accounts/') && r.request().method() === 'PUT');
        await page.getByRole('button',{name:'このアカウントのデフォルトとして保存',exact:true}).click();
        await saved;
        const account = page.getByLabel('アカウント', { exact: true });
        await account.click(); await page.getByRole('option', { name: 'NanonaBot3', exact: true }).click();
        assert.equal(await final.isChecked(), false);
        await account.click(); await page.getByRole('option', { name: 'NanonaBot（既定）', exact: true }).click();
        assert.equal(await final.isChecked(), true);
        assert.equal(await initial.isChecked(), true);
        await page.getByRole('button',{name:'タスクを作成してキューに投入',exact:true}).click();
        await page.getByRole('button',{name:'作成してキューに投入',exact:true}).click();
        await page.waitForURL('**/tasks/42');
        for (const request of requests.filter(r => r.path === '/api/tasks' || r.path.startsWith('/api/bot-accounts/'))) {
          assert.equal(request.body.editSettings.refreshTemplateTransclusions,true);
          assert.equal(request.body.editSettings.purgeRemainingTargets,true);
          assert.equal(request.body.editSettings.linkUpdateMethod,'purge');
        }
        assert.ok(requests.some(r => r.path === '/api/tasks'));
        assert.ok(requests.some(r => r.path.startsWith('/api/bot-accounts/')));
        assert.deepEqual(errors,[]); results.push({ width, copied, ok:true }); await context.close();
      }
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify(results));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// Standalone HTML checks. All requests are intercepted; no wiki/server is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const origin = 'https://workflow-docs-preview.invalid';
const html = fs.readFileSync(path.join(__dirname, '../docs/bot-workflows.html'), 'utf8');
async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const results = [];
  try {
    for (const width of [320, 390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', async route => {
        const url = new URL(route.request().url()); requests.push(url.pathname);
        assert.equal(url.origin, origin); assert.equal(url.pathname, '/');
        await route.fulfill({ contentType: 'text/html', body: html });
      });
      const rule = id => page.locator('#combine-choices input[value="' + id + '"]');
      const phases = () => page.locator('#combine-result > li').evaluateAll(rows => rows.map(row => row.dataset.phase));
      const selectedRules = phase => page.locator(`[data-phase="${phase}"] ul li`).allTextContents();
      await page.goto(origin + '/#combine');
      assert.equal(await page.locator('#composer').isVisible(), true);
      assert.deepEqual(await phases(), ['template', 'refresh', 'main']);
      assert.equal((await selectedRules('main')).length, 2);
      assert.match(await page.locator('[data-phase="main"] .merge-example').textContent(), /保存は1回/);
      await page.getByLabel('同じページに複数ルールが該当する例で見る', { exact: true }).uncheck();
      assert.match(await page.locator('[data-phase="main"] .merge-example').textContent(), /2ページをそれぞれ1回/);
      await rule('categoryRename').check();
      await page.getByLabel('最後に残る参照候補を再取得してpurge', { exact: true }).check();
      assert.deepEqual(await phases(), ['template', 'refresh', 'main', 'residual']);
      await page.getByRole('button', { name: 'Category置換を上へ', exact: true }).click();
      assert.match((await page.locator('#combine-order li').allTextContents())[1], /Category置換/);
      await page.getByLabel('Template呼び出し先の更新方法', { exact: true }).selectOption('nullEdit');
      assert.match(await page.locator('[data-phase="refresh"]').textContent(), /null edit（1件ずつ）/);
      await page.getByRole('button', { name: '次の区間', exact: true }).click();
      assert.match(await page.locator('#combine-current').textContent(), /2 \/ 4/);
      await page.getByRole('button', { name: '順番に再生', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#combine-current').textContent.includes('3 / 4'));
      await page.getByRole('button', { name: '構文・対象抽出', exact: true }).click();
      assert.equal(await page.locator('#combine-play').getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('#catalog .catalog-grid > article').count(), 10);
      await page.locator('#syntax-linkRename details').first().locator('summary').click();
      assert.match(await page.locator('#syntax-linkRename details').first().textContent(), /replacement/);
      assert.equal(await page.locator('#extraction-sources').isVisible(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'catalog overflow ' + width);
      await page.getByRole('button', { name: '種別を組み合わせる', exact: true }).click();
      for (const checkbox of await page.locator('#combine-choices input').all()) await checkbox.check();
      await page.getByLabel('通常名前空間の選択', { exact: true }).selectOption('main');
      await page.getByLabel('カスタムの対象取得方法', { exact: true }).selectOption('regexSearch');
      assert.equal((await selectedRules('template')).length, 6);
      await page.getByLabel('通常名前空間の選択', { exact: true }).selectOption('template');
      assert.equal((await selectedRules('main')).length, 2, 'Category special references survive Template-only scope');
      await page.getByLabel('カスタムの対象取得方法', { exact: true }).selectOption('manualList');
      assert.equal((await selectedRules('main')).length, 3, 'explicit article remains a target');
      await page.getByLabel('Template編集後、その呼び出し先を更新', { exact: true }).uncheck();
      assert.deepEqual(await phases(), ['template', 'main', 'residual']);
      assert.equal(await page.getByLabel('Template呼び出し先の更新方法', { exact: true }).isDisabled(), true);
      assert.equal((await selectedRules('residual')).length, 9);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'composer overflow ' + width);
      if (process.env.DOCS_SCREENSHOT_DIR) {
        await page.locator('#composer').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(process.env.DOCS_SCREENSHOT_DIR, `composer-${width}.png`), fullPage: true });
      }
      await page.getByRole('button', { name: '作業の手順', exact: true }).click();
      await page.locator('nav [data-flow="category"]').click();
      assert.equal(await page.locator('#category').isVisible(), true);
      await page.locator('#category').getByRole('button', { name: '次の手順', exact: true }).click();
      assert.equal(await page.locator('#category .step-dots [aria-current]').textContent(), '2');
      await page.getByRole('button', { name: '動きで見る', exact: true }).click();
      assert.equal(await page.locator('#simulation').isVisible(), true);
      await page.getByRole('button', { name: '次のコマ', exact: true }).click();
      assert.match(await page.locator('#sim-frame-count').textContent(), /^2 \/ /);
      await page.getByRole('button', { name: '種別を組み合わせる', exact: true }).click();
      await page.emulateMedia({ media: 'print' });
      assert.equal(await page.locator('#catalog').isVisible(), true);
      assert.equal(await page.locator('#reference').isVisible(), true);
      assert.equal(await page.locator('#combine-result').isVisible(), true);
      await page.emulateMedia({ media: 'screen' });
      for (const checkbox of await page.locator('#combine-choices input').all()) await checkbox.uncheck();
      assert.equal(await page.locator('#combine-result > li').count(), 0);
      assert.equal(await page.getByRole('button', { name: '順番に再生', exact: true }).isDisabled(), true);
      assert.deepEqual(errors, []); assert.equal(requests.length, 1);
      results.push({ width, composition: true, catalog: true, print: true }); await context.close();
    }
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(origin);
    assert.equal(await page.locator('.workflow').count(), 25);
    assert.equal(await page.locator('#catalog').isVisible(), true);
    assert.equal(await page.locator('#syntax-custom').isVisible(), true);
    assert.equal(await page.locator('#combine-form').isVisible(), false);
    await context.close(); results.push({ javaScriptDisabled: true, staticReference: true });
    const offline = await browser.newContext({ offline: true });
    const local = await offline.newPage(), localErrors = [];
    local.on('pageerror', error => localErrors.push(error.message));
    await local.goto(pathToFileURL(path.join(__dirname, '../docs/bot-workflows.html')).href + '#combine');
    assert.equal(await local.locator('#composer').isVisible(), true);
    assert.equal(await local.locator('#combine-choices input').count(), 10);
    await local.locator('#combine-choices input[value="categoryRename"]').check();
    assert.equal(await local.locator('[data-phase="main"] ul li').count(), 3);
    assert.deepEqual(localErrors, []);
    await offline.close(); results.push({ localFile: true, offline: true });

  } finally { await browser.close(); }
  console.log(JSON.stringify(results));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

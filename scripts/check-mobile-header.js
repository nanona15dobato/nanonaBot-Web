'use strict';

// 任意の検証用Playwrightで実行する。本番サーバー・DB・実アカウントへ接続しない。
// PLAYWRIGHT_MODULE_PATH=/path/to/playwright node scripts/check-mobile-header.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { renderShell } = require('../src/views/shell');
const root = path.join(__dirname, '..');
const origin = 'https://header-preview.invalid';
const results = [];
const screenshots = {};

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=2'],
  });
  try {
    for (const role of ['owner', 'admin_emergency_only']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      await context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => true }));
      const page = await context.newPage();
      const errors = [];
      const writes = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const username = 'HeaderPreviewWithAVeryLongUsername';
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (request.method() !== 'GET') {
          writes.push(url.pathname);
          return route.fulfill({ status: 405, body: 'No writes in preview' });
        }
        if (url.pathname.startsWith('/api/')) {
          const body = url.pathname === '/api/whoami' ? { username, role } : { emergency_stopped: false };
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        }
        if (url.pathname === '/static/js/header-preview.js') return route.fulfill({
          contentType: 'application/javascript',
          body: `const preview = NanonaCommon.initPage({ title: 'ダッシュボード', active: 'dashboard' });
            preview.$main.append('<p>表示確認用の画面です。</p>');`,
        });
        if (url.pathname === '/' || url.pathname === '/settings') return route.fulfill({
          contentType: 'text/html', body: renderShell({ title: '表示確認', script: 'header-preview.js', initialData: { username, role } }),
        });
        const mounts = [
          ['/static/', 'public/'], ['/vendor/jquery/', 'node_modules/jquery/dist/'],
          ['/vendor/oojs/', 'node_modules/oojs/dist/'], ['/vendor/oojs-ui/', 'node_modules/oojs-ui/dist/'],
        ];
        for (const [prefix, folder] of mounts) {
          if (!url.pathname.startsWith(prefix)) continue;
          const base = path.resolve(root, folder);
          const file = path.join(base, url.pathname.slice(prefix.length));
          if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) break;
          const mime = { '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
          return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
        }
        return route.fulfill({ status: 404, body: 'Not found' });
      });

      await page.goto(origin);
      await page.locator('.nb-appbar').waitFor({ timeout: 10000 }).catch((error) => { throw new Error(error.message + ' JavaScript: ' + errors.join('; ')); });
      const menu = page.locator('.nb-appbar__menu-button');
      const nav = page.locator('#nb-primary-nav');
      for (const width of [280, 320, 350, 360, 390, 430, 640, 720, 721, 844, 1024, 1100, 1101, 1280, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const measurements = await page.locator('.nb-appbar').evaluate((header) => {
          const box = (element) => {
            const r = element.getBoundingClientRect();
            return { x: r.x, right: r.right, width: r.width, height: r.height };
          };
          const icons = [...header.querySelectorAll('.nb-appbar__tools > .oo-ui-buttonElement > .oo-ui-buttonElement-button > .oo-ui-iconElement-icon, .nb-appbar__nav > .oo-ui-buttonElement > .oo-ui-buttonElement-button > .oo-ui-iconElement-icon')];
          return {
            layout: header.dataset.layout, header: box(header),
            controls: [...header.querySelectorAll('.nb-appbar__brand, .nb-appbar__tools > .oo-ui-buttonElement > .oo-ui-buttonElement-button, .nb-appbar__nav .oo-ui-buttonElement-button, .nb-appbar__menu-button')]
              .filter((element) => element.getBoundingClientRect().width > 0).map(box),
            iconOffsets: icons.filter((icon) => icon.getBoundingClientRect().width > 0).map((icon) => {
              const r = icon.getBoundingClientRect();
              const b = icon.parentElement.getBoundingClientRect();
              return { x: r.x + r.width / 2 - b.x - b.width / 2, y: r.y + r.height / 2 - b.y - b.height / 2 };
            }),
          };
        });
        const mode = measurements.layout;
        assert.ok(['labels', 'icons', 'menu'].includes(mode));
        assert.ok(measurements.controls.every((box) => box.x >= -1 && box.right <= width + 1), `${role} ${width}: horizontal overflow`);
        assert.ok(measurements.header.height <= 64, `${role} ${width}: header wrapped`);
        const controls = [...measurements.controls].sort((a, b) => a.x - b.x);
        assert.ok(controls.every((box, i) => i === 0 || box.x >= controls[i - 1].right - 1), `${role} ${width} ${mode}: controls overlap: ${JSON.stringify(controls)}`);
        if (mode !== 'labels') {
          assert.ok(measurements.controls.every((box) => box.width >= 44 && box.height >= 44), `${role} ${width}: touch target too small`);
          assert.ok(measurements.iconOffsets.every((offset) => Math.abs(offset.x) <= .5 && Math.abs(offset.y) <= .5),
            `${role} ${width}: icon is not centered: ${JSON.stringify(measurements.iconOffsets)}`);
        }
        if (role === 'owner' && width === 320) assert.equal(mode, 'menu');
        if (role === 'owner' && width === 390) assert.equal(mode, 'icons');
        if (role === 'owner' && width === 1440) assert.equal(mode, 'labels');
        if (mode === 'menu') {
          assert.equal(await nav.isVisible(), false);
          assert.equal(await menu.isVisible(), true);
          await menu.click();
          assert.equal(await menu.getAttribute('aria-expanded'), 'true');
          assert.equal(await nav.isVisible(), true);
          assert.equal(await nav.locator('a').count(), 5);
          for (const link of await nav.locator('a').all()) assert.equal(await link.isVisible(), true);
          const navBox = await nav.boundingBox();
          assert.ok(navBox.x >= 0 && navBox.x + navBox.width <= width + 1);
          if (width === 320 && process.env.HEADER_SCREENSHOTS_BASE64 === '1') screenshots.mobileMenu = (await page.screenshot()).toString('base64');
          await page.keyboard.press('Escape');
          assert.equal(await menu.getAttribute('aria-expanded'), 'false');
          assert.equal(await menu.evaluate((element) => element === document.activeElement), true);
          await menu.click();
          await page.mouse.click(12, 800);
          assert.equal(await nav.isVisible(), false);
        } else {
          assert.equal(await menu.isVisible(), false);
          assert.equal(await nav.isVisible(), role === 'owner');
          if (role === 'owner') {
            const links = await nav.locator('a').all();
            const visible = await Promise.all(links.map((link) => link.isVisible()));
            assert.equal(visible.filter(Boolean).length, mode === 'icons' ? 4 : 5);
          }
        }
        if (role === 'owner' && process.env.HEADER_SCREENSHOTS_BASE64 === '1' && [390, 1440].includes(width)) {
          screenshots[width === 390 ? 'mobileInline' : 'desktop'] = (await page.screenshot()).toString('base64');
        }
        if (width === 390) {
          const account = page.getByRole('button', { name: '利用者メニュー: ' + username, exact: true });
          await account.click();
          assert.equal(await page.locator('.nb-user-menu').isVisible(), true);
          const popup = await page.locator('.nb-user-menu').boundingBox();
          assert.ok(popup.x >= -1 && popup.x + popup.width <= width + 1, role + ': user menu overflow');
          await page.mouse.click(12, 800);
        }
        results.push({ role, width, layout: mode, headerHeight: measurements.header.height, passed: true });
      }
      // 開いたメニューからアイコン列へ切り替わった後、再び狭くすると閉じている。
      if (role === 'owner') {
        await page.setViewportSize({ width: 320, height: 844 });
        await menu.click();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => document.querySelector('.nb-appbar').dataset.layout === 'icons');
        await page.setViewportSize({ width: 320, height: 844 });
        await page.waitForFunction(() => document.querySelector('#nb-primary-nav').hidden);
        assert.equal(await menu.getAttribute('aria-expanded'), 'false');
      }
      assert.deepEqual(errors, [], role + ': browser errors');
      assert.deepEqual(writes, [], role + ': preview must not issue writes');
      await context.close();
    }
    console.log(JSON.stringify({ browser: browser.version(), results, screenshots }));
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

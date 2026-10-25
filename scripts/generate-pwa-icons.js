'use strict';

// 指定されたロゴキットをコピーし、maskableだけ余白付きでPNGへ書き出す。
// PLAYWRIGHT_MODULE_PATH=/path/to/playwright node scripts/generate-pwa-icons.js /path/to/bot-logo-kit
const fs = require('node:fs');
const path = require('node:path');

function maskableSvg(source) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#ffff7f"/>
<g transform="translate(51.2 51.2) scale(0.8)">${source.replace(/<\?xml[^>]*\?>/g, '')}</g>
</svg>`;
}

async function renderMaskable(svg) {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
    await page.route('**/*', (route) => route.abort());
    await page.setContent('<style>body{margin:0;background:#ffff7f}img{display:block;width:512px;height:512px}</style>' +
      '<img alt="" src="data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') + '">');
    await page.locator('img').evaluate((image) => image.decode());
    return await page.screenshot({ omitBackground: false });
  } finally { await browser.close(); }
}

async function generate(kit) {
  const root = path.join(__dirname, '..', 'public');
  const svg = maskableSvg(fs.readFileSync(path.join(kit, 'bot-favicon.svg'), 'utf8'));
  const png = await renderMaskable(svg);
  for (const dir of ['icons', 'branding']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const name of ['favicon.ico', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'favicon-180.png', 'favicon-192.png', 'bot-favicon.svg', 'bot-favicon.png']) {
    fs.copyFileSync(path.join(kit, name), path.join(root, 'icons', name));
  }
  for (const name of ['bot-logo.svg', 'bot-logo.png']) fs.copyFileSync(path.join(kit, name), path.join(root, 'branding', name));
  // 以前のアプリが参照するURLも新しい素材へ揃える。
  for (const [input, output] of [['favicon-192.png', 'icon-192.png'], ['bot-favicon.png', 'icon-512.png'], ['favicon-180.png', 'apple-touch-icon.png']]) {
    fs.copyFileSync(path.join(kit, input), path.join(root, 'icons', output));
  }
  fs.writeFileSync(path.join(root, 'icons', 'icon-maskable-512.svg'), svg);
  fs.writeFileSync(path.join(root, 'icons', 'icon-maskable-512.png'), png);
}

module.exports = { maskableSvg, renderMaskable };
if (require.main === module) {
  if (!process.argv[2]) throw new Error('ロゴキットのフォルダを指定してください。');
  generate(path.resolve(process.argv[2])).catch((error) => { console.error(error); process.exitCode = 1; });
}

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

/** 画面で使うOOUIアイコンのパック（アイコン名→パックは node_modules/oojs-ui/dist の各CSSで確認済み） */
const ICON_PACKS = ['alerts', 'content', 'editing-core', 'editing-advanced', 'interactions', 'media', 'moderation', 'movement', 'user', 'accessibility'];

/** JSONを<script>内に安全に埋め込める文字列にする（</script> 等で閉じられないよう < をエスケープ）。 */
function toScriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * OOUI同梱の日本語メッセージ（ダイアログの「OK」「キャンセル」等）。起動時に1回だけ読み込み、
 * 各ページに埋め込む（読み込めない環境では英語の既定メッセージのまま動く）。
 */
const OOUI_JA_MESSAGES_JSON = (() => {
  try {
    const file = path.join(__dirname, '..', '..', 'node_modules', 'oojs-ui', 'dist', 'i18n', 'ja.json');
    const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete messages['@metadata'];
    return toScriptJson(messages);
  } catch (e) {
    return '{}';
  }
})();

/** 全ページ共通の<head>内（OOUIのスタイル・アイコン・自作CSS）。 */
function headLinks() {
  const iconLinks = ICON_PACKS.map(
    (pack) => `<link rel="stylesheet" href="/vendor/oojs-ui/oojs-ui-wikimediaui-icons-${pack}.min.css">`
  );
  return [
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<meta name="theme-color" content="#3366cc">',
    '<meta name="application-name" content="nanonaBot Web">',
    '<meta name="apple-mobile-web-app-title" content="nanonaBot">',
    '<link rel="icon" type="image/png" sizes="192x192" href="/static/icons/icon-192.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/static/icons/apple-touch-icon.png">',
    '<link rel="stylesheet" href="/vendor/oojs-ui/oojs-ui-wikimediaui.min.css">',
    ...iconLinks,
    '<link rel="stylesheet" href="/static/css/app.css">',
  ].join('\n');
}

/**
 * 全ページ共通のHTMLシェルを生成する。
 * OOUI本体（jQuery/OOjs/OOUI）は /vendor/ 配下で静的配信しているものを読み込む
 * （npmjs.com/package/oojs-ui に記載の標準的な組み込み方法に準拠）。
 * 実際の画面構築は各ページのクライアントサイドJS（/static/js/*.js）が行う。
 *
 * @param {object} params
 * @param {string} params.title
 * @param {string} params.script - /static/js/ 以下のエントリファイル名（例: "dashboard.js"）
 * @param {object} [params.initialData] - window.NANONA_BOTとして埋め込む初期データ
 *   （ログインユーザー情報など。ページ読み込み直後に1往復減らすためのもの）。
 *   wikiHost（ページ名からウィキへのリンクを作るため）は常に追加する。
 */
function renderShell({ title, script, initialData = {} }) {
  const safeTitle = escapeHtml(title);
  const initialDataJson = toScriptJson({ wikiHost: config.wiki.host, ...initialData });

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${safeTitle} - nanonaBot Web</title>
${headLinks()}
</head>
<body>
<div id="app"></div>
<script>window.NANONA_BOT = ${initialDataJson};</script>
<script src="/static/js/pwa.js"></script>
<script src="/vendor/jquery/jquery.min.js"></script>
<script src="/vendor/oojs/oojs.min.js"></script>
<script src="/vendor/oojs-ui/oojs-ui.min.js"></script>
<script src="/vendor/oojs-ui/oojs-ui-wikimediaui.min.js"></script>
<script>Object.assign(OO.ui.msg.messages, ${OOUI_JA_MESSAGES_JSON});</script>
<script src="/static/js/common.js"></script>
<script src="/static/js/push.js"></script>
<script src="/static/js/${script}"></script>
</body>
</html>`;
}

/**
 * JavaScriptを使わない簡単なページ（ログイン・権限なし）。OOUIのスタイルだけを使う。
 * @param {object} params
 * @param {string} params.title
 * @param {string} params.bodyHtml - エスケープ済みのHTML
 */
function renderStaticPage({ title, bodyHtml }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)} - nanonaBot Web</title>
${headLinks()}
</head>
<body>
<main class="nb-login">
  <h1 class="nb-login__title">nanonaBot Web</h1>
  ${bodyHtml}
  <div data-pwa-install></div>
</main>
<script src="/static/js/pwa.js"></script>
<script src="/static/js/push.js"></script>
</body>
</html>`;
}

/**
 * OOUIのボタンと同じ見た目のリンク・送信ボタン（JavaScript無しで使う静的ページ用）。
 * @param {object} params
 * @param {string} params.label
 * @param {string} [params.href] - 指定時は<a>、未指定時は<button type="submit">
 * @param {boolean} [params.primary]
 */
function staticButtonHtml({ label, href, primary = false }) {
  const flags = primary ? ' oo-ui-flaggedElement-primary oo-ui-flaggedElement-progressive' : '';
  const inner = href
    ? `<a class="oo-ui-buttonElement-button" role="button" href="${escapeHtml(href)}"><span class="oo-ui-labelElement-label">${escapeHtml(label)}</span></a>`
    : `<button type="submit" class="oo-ui-buttonElement-button"><span class="oo-ui-labelElement-label">${escapeHtml(label)}</span></button>`;
  return `<span class="oo-ui-widget oo-ui-widget-enabled oo-ui-buttonElement oo-ui-buttonElement-framed oo-ui-labelElement${flags} oo-ui-buttonWidget">${inner}</span>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = { renderShell, renderStaticPage, staticButtonHtml, escapeHtml };

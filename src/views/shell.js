'use strict';

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
 *   （ログインユーザー情報など。ページ読み込み直後に1往復減らすためのもの）
 */
function renderShell({ title, script, initialData = {} }) {
  const safeTitle = escapeHtml(title);
  const initialDataJson = JSON.stringify(initialData).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} - NanonaBot Tool</title>
<link rel="stylesheet" href="/vendor/oojs-ui/oojs-ui-wikimediaui.min.css">
<link rel="stylesheet" href="/vendor/oojs-ui/oojs-ui-wikimediaui-icons-alerts.min.css">
<link rel="stylesheet" href="/vendor/oojs-ui/oojs-ui-wikimediaui-icons-moderation.min.css">
<link rel="stylesheet" href="/vendor/oojs-ui/oojs-ui-wikimediaui-icons-movement.min.css">
<link rel="stylesheet" href="/static/css/app.css">
</head>
<body>
<div id="app" class="nb-app"></div>
<script>window.NANONA_BOT = ${initialDataJson};</script>
<script src="/vendor/jquery/jquery.min.js"></script>
<script src="/vendor/oojs/oojs.min.js"></script>
<script src="/vendor/oojs-ui/oojs-ui.min.js"></script>
<script src="/vendor/oojs-ui/oojs-ui-wikimediaui.min.js"></script>
<script src="/static/js/common.js"></script>
<script src="/static/js/${script}"></script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = { renderShell, escapeHtml };

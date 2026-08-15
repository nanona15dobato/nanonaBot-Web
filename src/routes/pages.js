'use strict';

const express = require('express');
const router = express.Router();

const { renderShell, escapeHtml } = require('../views/shell');

function loginPageHtml() {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ログイン - NanonaBot Tool</title>
<link rel="stylesheet" href="/vendor/oojs-ui/oojs-ui-wikimediaui.min.css">
<link rel="stylesheet" href="/static/css/app.css">
</head>
<body>
  <div class="nb-login">
    <h1>NanonaBot Tool</h1>
    <p><a class="oo-ui-buttonElement-button" href="/oauth/login">Wikimediaアカウントでログイン</a></p>
  </div>
</body></html>`;
}

function deniedPageHtml(username) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>権限がありません - NanonaBot Tool</title>
<link rel="stylesheet" href="/static/css/app.css"></head>
<body>
  <div class="nb-login">
    <h1>NanonaBot Tool</h1>
    <p>${escapeHtml(username)} さんはこのツールの利用権限がありません。</p>
    <form method="post" action="/oauth/logout"><button type="submit">ログアウト</button></form>
  </div>
</body></html>`;
}

// ダッシュボード（owner/admin_emergency_onlyともに閲覧可。中身の出し分けはクライアントJS側で行う）
router.get('/', (req, res) => {
  const role = req.session && req.session.role;
  const username = req.session && req.session.username;

  if (!role) return res.send(loginPageHtml());
  if (role === 'denied') return res.status(403).send(deniedPageHtml(username));

  res.send(renderShell({ title: 'ダッシュボード', script: 'dashboard.js', initialData: { username, role } }));
});

// タスク作成画面（owner専用。denied/admin_emergency_onlyはクライアント側で弾く前にサーバー側でも弾く）
router.get('/tasks/new', (req, res) => {
  const role = req.session && req.session.role;
  const username = req.session && req.session.username;

  if (!role) return res.send(loginPageHtml());
  if (role !== 'owner') return res.status(403).send(deniedPageHtml(username));

  res.send(renderShell({ title: '新規タスク作成', script: 'taskNew.js', initialData: { username, role } }));
});

// タスク詳細/Diff確認画面（owner専用。仕様書2章）
router.get('/tasks/:id', (req, res) => {
  const role = req.session && req.session.role;
  const username = req.session && req.session.username;

  if (!role) return res.send(loginPageHtml());
  if (role !== 'owner') return res.status(403).send(deniedPageHtml(username));

  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return res.status(400).send('不正なタスクIDです。');
  }

  res.send(
    renderShell({
      title: `タスク #${taskId}`,
      script: 'taskDetail.js',
      initialData: { username, role, taskId },
    })
  );
});

module.exports = router;

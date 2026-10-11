'use strict';

const express = require('express');
const router = express.Router();

const { renderShell, renderStaticPage, staticButtonHtml, escapeHtml } = require('../views/shell');

function loginPageHtml() {
  return renderStaticPage({
    title: 'ログイン',
    bodyHtml: `<p class="nb-login__lead">Jawp編集支援Botの操作画面です。Wikimediaアカウントでログインしてください。</p>
  ${staticButtonHtml({ label: 'Wikimediaアカウントでログイン', href: '/oauth/login', primary: true })}`,
  });
}

function deniedPageHtml(username) {
  return renderStaticPage({
    title: '権限がありません',
    bodyHtml: `<p class="nb-login__lead">${escapeHtml(username)} さんはこのツールの利用権限がありません。</p>
  <form method="post" action="/oauth/logout">${staticButtonHtml({ label: 'ログアウト' })}</form>`,
  });
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

// Bot作業依頼の着手・完了・解決（owner専用。フェーズ13）
router.get('/botreq', (req, res) => {
  const role = req.session && req.session.role;
  const username = req.session && req.session.username;

  if (!role) return res.send(loginPageHtml());
  if (role !== 'owner') return res.status(403).send(deniedPageHtml(username));

  res.send(renderShell({ title: 'Bot作業依頼', script: 'botreq.js', initialData: { username, role } }));
});

// 設定画面（owner専用。フェーズ10: 通知先の設定・テスト送信）
router.get('/settings', (req, res) => {
  const role = req.session && req.session.role;
  const username = req.session && req.session.username;

  if (!role) return res.send(loginPageHtml());
  if (role !== 'owner') return res.status(403).send(deniedPageHtml(username));

  res.send(renderShell({ title: '設定', script: 'settings.js', initialData: { username, role } }));
});

// 編集ログ画面（owner専用。フェーズ6）
router.get('/edit-log', (req, res) => {
  const role = req.session && req.session.role;
  const username = req.session && req.session.username;

  if (!role) return res.send(loginPageHtml());
  if (role !== 'owner') return res.status(403).send(deniedPageHtml(username));

  res.send(renderShell({ title: '編集ログ', script: 'editLog.js', initialData: { username, role } }));
});

module.exports = router;

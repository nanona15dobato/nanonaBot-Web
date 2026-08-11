'use strict';

const express = require('express');
const router = express.Router();

const { pool } = require('../db');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// フェーズ1時点では素のHTMLのみ。OOUIを使った本実装はフェーズ3で行う（仕様書13章）。
router.get('/', async (req, res, next) => {
  try {
    const role = req.session && req.session.role;
    const username = req.session && req.session.username;

    if (!role) {
      return res.send(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>NanonaBot Tool</title></head>
<body>
  <h1>NanonaBot Tool</h1>
  <p><a href="/oauth/login">Wikimediaアカウントでログイン</a></p>
</body></html>`);
    }

    const [rows] = await pool.query(
      'SELECT emergency_stopped, emergency_stopped_by, emergency_stopped_at FROM system_status WHERE id = 1'
    );
    const status = rows[0] || { emergency_stopped: false };

    res.send(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>NanonaBot Tool</title></head>
<body>
  <h1>NanonaBot Tool</h1>
  <p>ログイン中: ${escapeHtml(username)}（権限: ${escapeHtml(role)}）</p>
  <form method="post" action="/oauth/logout"><button type="submit">ログアウト</button></form>

  <h2>緊急停止</h2>
  <p>現在の状態: ${status.emergency_stopped
    ? `<strong style="color:red">停止中</strong>（${escapeHtml(status.emergency_stopped_by)} が ${status.emergency_stopped_at} に実行）`
    : '稼働中'}</p>
  <form method="post" action="/api/emergency-stop">
    <button type="submit" style="background:#c00;color:#fff;padding:8px 16px;">緊急停止</button>
  </form>
  ${role === 'owner' ? `
  <form method="post" action="/api/emergency-stop/clear">
    <button type="submit">緊急停止を解除（Nanona15dobatoのみ）</button>
  </form>` : ''}

  ${role === 'owner' ? '<p>（フェーズ2以降でタスク作成・キュー管理UIをここに実装予定）</p>' : ''}
</body></html>`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

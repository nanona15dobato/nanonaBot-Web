'use strict';

const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const { pool } = require('../db');

// 素のHTMLフォーム送信（フェーズ1のダッシュボード）とJSON API呼び出し
// （フェーズ3以降のOOUIフロントエンド）の両方に対応するため、
// Acceptヘッダに応じてリダイレクトかJSONかを切り替える。
function respondOkOrRedirect(req, res, payload) {
  if (req.accepts(['json', 'html']) === 'html') {
    return res.redirect('/');
  }
  res.json(payload);
}

router.get('/api/emergency-stop/status', requireRole('owner', 'admin_emergency_only'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT emergency_stopped, emergency_stopped_by, emergency_stopped_at FROM system_status WHERE id = 1'
    );
    res.json(rows[0] || { emergency_stopped: false, emergency_stopped_by: null, emergency_stopped_at: null });
  } catch (err) {
    next(err);
  }
});

// owner・admin_emergency_onlyどちらでも「止める」ことはできる（仕様書2.2節）
router.post('/api/emergency-stop', requireRole('owner', 'admin_emergency_only'), async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE system_status SET emergency_stopped = 1, emergency_stopped_by = ?, emergency_stopped_at = NOW() WHERE id = 1',
      [req.session.username]
    );
    console.warn(`[EMERGENCY STOP] triggered by ${req.session.username}`);
    respondOkOrRedirect(req, res, { ok: true });
  } catch (err) {
    next(err);
  }
});

// 解除はowner（Nanona15dobato）のみ（仕様書2.2節、誤操作防止）
router.post('/api/emergency-stop/clear', requireRole('owner'), async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE system_status SET emergency_stopped = 0, emergency_stopped_by = NULL, emergency_stopped_at = NULL WHERE id = 1'
    );
    console.warn(`[EMERGENCY STOP CLEARED] by ${req.session.username}`);
    respondOkOrRedirect(req, res, { ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

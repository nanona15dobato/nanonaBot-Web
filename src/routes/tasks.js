'use strict';

const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const { pool } = require('../db');
const { validateTaskConfig } = require('../worker/taskConfig');
const { toJsonColumn, parseJsonColumn } = require('../dbJson');
const mediawiki = require('../services/mediawiki');

// ログイン中ユーザー情報（クライアントJSがUI出し分けに使う）
router.get('/api/whoami', (req, res) => {
  res.json({
    username: (req.session && req.session.username) || null,
    role: (req.session && req.session.role) || null,
  });
});

// タスク作成はowner（Nanona15dobato）のみ（仕様書2章）
router.post('/api/tasks', requireRole('owner'), async (req, res, next) => {
  try {
    const config = req.body;
    const { valid, errors } = validateTaskConfig(config);
    if (!valid) {
      return res.status(400).json({ error: 'invalid_config', errors });
    }
    const [result] = await pool.query(
      `INSERT INTO tasks (created_by, account, mode, status, config_json)
       VALUES (?, ?, ?, 'queued', ?)`,
      [req.session.username, config.account, config.reviewSettings.mode, toJsonColumn(config)]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

// タスク一覧・詳細・ページ一覧はowner専用（仕様書2章: admin_emergency_onlyは緊急停止以外閲覧不可）
router.get('/api/tasks', requireRole('owner'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, created_by, account, mode, status, progress_current, progress_total, created_at, updated_at
       FROM tasks ORDER BY id DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/api/tasks/:id', requireRole('owner'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    const task = rows[0];
    task.config_json = parseJsonColumn(task.config_json);
    task.target_titles_json = parseJsonColumn(task.target_titles_json);
    res.json(task);
  } catch (err) {
    next(err);
  }
});

router.get('/api/tasks/:id/pages', requireRole('owner'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, stage, order_index, page_title, namespace, status, base_revid, error_message,
              prepared_at, reviewed_at, edited_at
       FROM task_pages WHERE task_id = ? ORDER BY stage, order_index`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// 個別ページのDiff確認用（本文込み。フェーズ3のOOUI Diff画面はこれを叩く想定）
router.get('/api/tasks/:id/pages/:pageId/diff', requireRole('owner'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, task_id, page_title, status, original_wikitext, new_wikitext, error_message
       FROM task_pages WHERE id = ? AND task_id = ?`,
      [req.params.pageId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// 本家同様の差分HTML（仕様書9章）。action=compareで取得し、そのままDiff表示に埋め込む。
router.get('/api/tasks/:id/pages/:pageId/compare', requireRole('owner'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT base_revid, new_wikitext, status FROM task_pages WHERE id = ? AND task_id = ?`,
      [req.params.pageId, req.params.id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (!row.base_revid || row.new_wikitext === null) {
      return res.status(409).json({ error: 'not_ready', message: 'まだ準備が完了していません' });
    }
    const html = await mediawiki.compareRevisions({ fromRevId: row.base_revid, toText: row.new_wikitext });
    res.json({ html });
  } catch (err) {
    next(err);
  }
});

router.post('/api/tasks/:id/pages/:pageId/approve', requireRole('owner'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `UPDATE task_pages SET status = 'approved', reviewed_at = NOW()
       WHERE id = ? AND task_id = ? AND status = 'awaiting_review'`,
      [req.params.pageId, req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'not_awaiting_review' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/api/tasks/:id/pages/:pageId/reject', requireRole('owner'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `UPDATE task_pages SET status = 'rejected', reviewed_at = NOW()
       WHERE id = ? AND task_id = ? AND status = 'awaiting_review'`,
      [req.params.pageId, req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'not_awaiting_review' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// onFailure="pause" で止まったタスクの再開（9.3節）。
// task_pagesは既に列挙済みなので、taskRunner側は残りのpendingだけを処理する。
router.post('/api/tasks/:id/resume', requireRole('owner'), async (req, res, next) => {
  try {
    const [result] = await pool.query(`UPDATE tasks SET status = 'queued' WHERE id = ? AND status = 'paused'`, [
      req.params.id,
    ]);
    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'not_paused' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

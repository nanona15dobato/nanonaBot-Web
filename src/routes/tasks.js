'use strict';

const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const { pool } = require('../db');
const { validateTaskConfig } = require('../worker/taskConfig');
const { toJsonColumn, parseJsonColumn } = require('../dbJson');
const mediawiki = require('../services/mediawiki');
const config = require('../config');

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
              prepared_at, reviewed_at, review_deadline_at, edited_at
       FROM task_pages WHERE task_id = ? ORDER BY stage, order_index`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// タスク実行ログ。編集結果だけでなく、対象取得・ウェーブ遷移・停止理由をWeb上で確認できる。
router.get('/api/tasks/:id/logs', requireRole('owner'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const [rows] = await pool.query(
      `SELECT id, stage, page_title, level, message, created_at
       FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
      [req.params.id, limit]
    );
    res.json(rows.reverse());
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

// Category系の付随警告一覧（仕様書6.3/6.4節・8章。検出のみで編集対象ではない）
router.get('/api/tasks/:id/warnings', requireRole('owner'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, rule_index, page_title, namespace, snippet, created_at
       FROM task_warnings WHERE task_id = ? ORDER BY id`,
      [req.params.id]
    );
    res.json(rows);
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

// 実行中タスクのレビュー方式を切り替える。waitForApprovalはこの設定をポーリングで読むため、
// 現在awaiting_reviewのページにも直ちに反映される。
router.post('/api/tasks/:id/review-settings', requireRole('owner'), async (req, res, next) => {
  try {
    const settings = req.body && req.body.reviewSettings;
    if (!settings || !['auto', 'manual'].includes(settings.mode)) {
      return res.status(400).json({ error: 'invalid_review_settings' });
    }
    if (settings.mode === 'auto' && (!Number.isFinite(settings.autoWaitSeconds) || settings.autoWaitSeconds < 0)) {
      return res.status(400).json({ error: 'invalid_auto_wait_seconds' });
    }
    if (settings.mode === 'manual' && (!Number.isFinite(settings.manualTimeoutHours) || settings.manualTimeoutHours <= 0)) {
      return res.status(400).json({ error: 'invalid_manual_timeout_hours' });
    }

    const [rows] = await pool.query('SELECT config_json FROM tasks WHERE id = ? AND status IN (\'queued\', \'running\')', [req.params.id]);
    if (!rows[0]) return res.status(409).json({ error: 'not_running' });

    const config = parseJsonColumn(rows[0].config_json, {});
    config.reviewSettings = settings;
    const timeoutAt =
      settings.mode === 'manual' ? new Date(Date.now() + settings.manualTimeoutHours * 3600 * 1000) : null;
    await pool.query(
      `UPDATE tasks SET mode = ?, config_json = ?, review_timeout_at = ?, updated_at = NOW() WHERE id = ?`,
      [settings.mode, toJsonColumn(config), timeoutAt, req.params.id]
    );
    res.json({ ok: true, reviewSettings: settings, reviewTimeoutAt: timeoutAt });
  } catch (err) {
    next(err);
  }
});

// queued/running/pausedのタスクを中止する。ワーカーは次の安全な確認地点で中止を検知する。
router.post('/api/tasks/:id/cancel', requireRole('owner'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `UPDATE tasks SET status = 'cancelled', updated_at = NOW()
       WHERE id = ? AND status IN ('queued', 'running', 'paused')`,
      [req.params.id]
    );
    if (result.affectedRows === 0) return res.status(409).json({ error: 'not_cancellable' });
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

// 失敗ページのみを対象にした再試行タスクを作成する（仕様書9.3節・フェーズ6）。
// edit_logを基準にする（task_pagesは9.4節のクリーンアップ対象で消えている場合があるため）。
// 元タスクの置換ルールをそのまま引き継ぎ、対象だけをforceTargetsで失敗ページに絞る。
router.post('/api/tasks/:id/retry-failed', requireRole('owner'), async (req, res, next) => {
  try {
    const [taskRows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    const originalTask = taskRows[0];
    if (!originalTask) return res.status(404).json({ error: 'not_found' });

    const [failedRows] = await pool.query(
      `SELECT DISTINCT page_title FROM edit_log WHERE task_id = ? AND status = 'failed'`,
      [req.params.id]
    );
    const failedTitles = failedRows.map((r) => r.page_title);
    if (failedTitles.length === 0) {
      return res.status(409).json({ error: 'no_failed_pages', message: 'このタスクに失敗ページはありません' });
    }

    const originalConfig = parseJsonColumn(originalTask.config_json, {});
    const retryReplacements = (originalConfig.replacements || []).map((r) => ({ ...r, forceTargets: failedTitles }));
    const retryConfig = { ...originalConfig, replacements: retryReplacements };

    const [result] = await pool.query(
      `INSERT INTO tasks (created_by, account, mode, status, config_json, retry_of_task_id)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
      [req.session.username, originalTask.account, originalTask.mode, toJsonColumn(retryConfig), originalTask.id]
    );
    res.status(201).json({ id: result.insertId, retriedPageCount: failedTitles.length });
  } catch (err) {
    next(err);
  }
});

// 編集ログの検索・閲覧（仕様書9.4節・フェーズ6）。task_pagesが削除された後も参照できる恒久ログ。
router.get('/api/edit-log', requireRole('owner'), async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];
    if (req.query.task_id) {
      conditions.push('task_id = ?');
      params.push(Number(req.query.task_id));
    }
    if (req.query.page_title) {
      conditions.push('page_title LIKE ?');
      params.push(`%${req.query.page_title}%`);
    }
    if (req.query.status && ['edited', 'failed'].includes(req.query.status)) {
      conditions.push('status = ?');
      params.push(req.query.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const [rows] = await pool.query(`SELECT * FROM edit_log ${where} ORDER BY id DESC LIMIT ?`, [...params, limit]);

    const withDiffUrl = rows.map((r) => ({
      ...r,
      diffUrl: r.revid ? `https://${config.wiki.host}/w/index.php?diff=${r.revid}&oldid=prev` : null,
    }));
    res.json(withDiffUrl);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

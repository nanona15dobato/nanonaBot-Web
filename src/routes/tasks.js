'use strict';

const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const { pool } = require('../db');
const { validateTaskConfig } = require('../worker/taskConfig');
const { toJsonColumn, parseJsonColumn } = require('../dbJson');
const mediawiki = require('../services/mediawiki');
const config = require('../config');
const { writeTaskLogSafely } = require('../worker/taskLog');

/** 操作者による操作を、誰が行ったかとともにタスクログへ残す（監査用。フェーズ9）。 */
function auditLog(req, taskId, message, extra = {}) {
  return writeTaskLogSafely({ taskId, level: 'info', ...extra, message: `${message}（操作: ${req.session.username}）` });
}

/** 承認・却下したページの情報（ログ用）。 */
async function reviewedPage(pageId) {
  const [rows] = await pool.query('SELECT stage, page_title FROM task_pages WHERE id = ?', [pageId]);
  return rows[0] || {};
}

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
    const taskConfig = req.body;
    const { valid, errors } = validateTaskConfig(taskConfig);
    if (!valid) {
      return res.status(400).json({ error: 'invalid_config', errors });
    }
    const [result] = await pool.query(
      `INSERT INTO tasks (created_by, account, mode, status, config_json)
       VALUES (?, ?, ?, 'queued', ?)`,
      [req.session.username, taskConfig.account, taskConfig.reviewSettings.mode, toJsonColumn(taskConfig)]
    );
    await auditLog(req, result.insertId, 'タスクを作成しました');
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

// タスク一覧・詳細・ページ一覧はowner専用（仕様書2章: admin_emergency_onlyは緊急停止以外閲覧不可）
const TASK_LIST_COLUMNS = `id, created_by, account, mode, status, progress_current, progress_total, created_at, updated_at,
  (SELECT COUNT(*) FROM task_pages tp WHERE tp.task_id = tasks.id AND tp.status = 'awaiting_review') AS awaiting_review_count`;

router.get('/api/tasks', requireRole('owner'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(`SELECT ${TASK_LIST_COLUMNS} FROM tasks ORDER BY id DESC LIMIT 50`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ダッシュボードの「要対応」一覧（フェーズ8）。古いタスクでも、操作者の対応を待っているものは載せる:
// - 確認待ちのページがある実行中/待機中タスク
// - 一時停止・緊急停止・期限切れ（再開できる）
// - 失敗ページがあり、まだ再試行タスクを作っていないもの（直近14日以内）
router.get('/api/tasks/attention', requireRole('owner'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT ${TASK_LIST_COLUMNS} FROM tasks
       WHERE status IN ('paused', 'emergency_stopped', 'expired')
          OR (status IN ('queued', 'running') AND EXISTS (
                SELECT 1 FROM task_pages tp WHERE tp.task_id = tasks.id AND tp.status = 'awaiting_review'))
          OR (status IN ('completed_with_failures', 'failed')
              AND updated_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
              AND NOT EXISTS (SELECT 1 FROM tasks r WHERE r.retry_of_task_id = tasks.id))
       ORDER BY updated_at DESC LIMIT 50`
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
    // 画面が自動承認・次の編集の予定時刻に合わせて更新するとき、端末の時計のずれを補正するのに使う
    task.server_time = new Date().toISOString();
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

// タスク実行ログ。編集結果だけでなく、対象取得・ウェーブ遷移・停止理由をWeb上で確認できる。
router.get('/api/tasks/:id/logs', requireRole('owner'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 100, 1), 500);
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
      // 先読み済み（prepared）のページも、前のページの編集中に前もって承認できる。
      // 表示している差分がそのまま編集内容になる（編集時はbasetimestampで競合を検出する）。
      `UPDATE task_pages SET status = 'approved', reviewed_at = NOW()
       WHERE id = ? AND task_id = ? AND status IN ('awaiting_review', 'prepared')`,
      [req.params.pageId, req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'not_awaiting_review' });
    }
    const page = await reviewedPage(req.params.pageId);
    await auditLog(req, req.params.id, '承認しました', { stage: page.stage, pageTitle: page.page_title });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/api/tasks/:id/pages/:pageId/reject', requireRole('owner'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `UPDATE task_pages SET status = 'rejected', reviewed_at = NOW()
       WHERE id = ? AND task_id = ? AND status IN ('awaiting_review', 'prepared')`,
      [req.params.pageId, req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'not_awaiting_review' });
    }
    const page = await reviewedPage(req.params.pageId);
    await auditLog(req, req.params.id, '却下しました', { stage: page.stage, pageTitle: page.page_title });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// 確認モードは待機中のタスクでも切り替えられる。設定はJSONと一覧用modeを同時に更新する。
router.post('/api/tasks/:id/review-mode', requireRole('owner'), async (req, res, next) => {
  try {
    const mode = req.body && req.body.mode;
    if (mode !== 'auto' && mode !== 'manual') {
      return res.status(400).json({ error: 'invalid_mode' });
    }
    const [rows] = await pool.query('SELECT status, config_json FROM tasks WHERE id = ?', [req.params.id]);
    const task = rows[0];
    if (!task) return res.status(404).json({ error: 'not_found' });
    if (!['queued', 'running'].includes(task.status)) {
      return res.status(409).json({ error: 'not_running' });
    }

    const taskConfig = parseJsonColumn(task.config_json, {});
    const reviewSettings = { ...(taskConfig.reviewSettings || {}), mode };
    taskConfig.reviewSettings = reviewSettings;
    if (mode === 'manual') {
      const hours = Math.max(1, Number(reviewSettings.manualTimeoutHours) || 72);
      await pool.query(
        'UPDATE tasks SET mode = ?, config_json = ?, review_timeout_at = DATE_ADD(NOW(), INTERVAL ? HOUR), updated_at = NOW() WHERE id = ?',
        [mode, toJsonColumn(taskConfig), hours, req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE tasks SET mode = ?, config_json = ?, review_timeout_at = NULL, updated_at = NOW() WHERE id = ?',
        [mode, toJsonColumn(taskConfig), req.params.id]
      );
    }
    await auditLog(req, req.params.id, `確認モードを${mode === 'auto' ? '自動更新' : '手動確認'}に切り替えました`);
    res.json({ ok: true, mode });
  } catch (err) {
    next(err);
  }
});

// queued/running/pausedのタスクを中止する。実行中のワーカーは次の監視周期で停止する。
router.post('/api/tasks/:id/cancel', requireRole('owner'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `UPDATE tasks SET status = 'cancelled', updated_at = NOW()
       WHERE id = ? AND status IN ('queued', 'running', 'paused')`,
      [req.params.id]
    );
    if (result.affectedRows === 0) return res.status(409).json({ error: 'not_cancellable' });
    await auditLog(req, req.params.id, 'タスクを中止しました');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// onFailure="pause" で止まったタスク・緊急停止で中断したタスク・期限切れのタスクの再開（9.3節）。
// task_pagesは既に列挙済みなので、taskRunner側は残りのpendingだけを処理する
// （中断時に準備中・確認待ちだったページはpipeline側でpendingに戻してから再処理する）。
// 期限切れからの再開ではタイムアウトを取り直すため review_timeout_at をクリアする。
router.post('/api/tasks/:id/resume', requireRole('owner'), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `UPDATE tasks SET status = 'queued', review_timeout_at = NULL, updated_at = NOW()
       WHERE id = ? AND status IN ('paused', 'emergency_stopped', 'expired')`,
      [req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'not_resumable', message: 'このタスクは再開できる状態ではありません' });
    }
    await auditLog(req, req.params.id, 'タスクの再開を要求しました');
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

    // 編集段階の失敗はedit_logに、準備段階の失敗（本文取得エラー等）はtask_pagesにだけ残るため両方を見る
    const [failedRows] = await pool.query(
      `SELECT page_title FROM edit_log WHERE task_id = ? AND status = 'failed'
       UNION
       SELECT page_title FROM task_pages WHERE task_id = ? AND status = 'failed'`,
      [req.params.id, req.params.id]
    );
    const failedTitles = [...new Set(failedRows.map((r) => r.page_title))];
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
    await auditLog(req, originalTask.id, `失敗ページ${failedTitles.length}件の再試行タスク #${result.insertId} を作成しました`);
    await auditLog(req, result.insertId, `タスク #${originalTask.id} の失敗ページ${failedTitles.length}件の再試行として作成しました`);
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
      const taskId = Number(req.query.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        return res.status(400).json({ error: 'invalid_task_id', message: 'タスクIDは正の整数で指定してください' });
      }
      conditions.push('task_id = ?');
      params.push(taskId);
    }
    if (req.query.page_title) {
      conditions.push('page_title LIKE ?');
      // ページ名に含まれる % や _ をワイルドカードとして解釈させない
      params.push(`%${String(req.query.page_title).replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (req.query.status && ['edited', 'failed'].includes(req.query.status)) {
      conditions.push('status = ?');
      params.push(req.query.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 50, 1), 200);

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

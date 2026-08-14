'use strict';

const { pool } = require('../db');
const { getClient } = require('../bot/accounts');
const { parseJsonColumn, toJsonColumn } = require('../dbJson');
const { runStagePipeline } = require('./pipeline');

/**
 * 対象ページタイトルを列挙し、task_pagesへ投入する（初回実行時のみ。
 * resumeの場合は既に行があるのでスキップする＝冪等）。
 * フェーズ2時点では config.replacements[].targetSource.type === "manualList" のみ対応。
 */
async function enumerateAndInsertPagesIfNeeded(task, config) {
  const [existingCountRows] = await pool.query('SELECT COUNT(*) AS cnt FROM task_pages WHERE task_id = ?', [
    task.id,
  ]);
  if (existingCountRows[0].cnt > 0) {
    // 既に列挙済み（一時停止からの再開等）。何もしない。
    return;
  }

  const titleToRuleIndices = new Map();
  (config.replacements || []).forEach((rule, idx) => {
    if (rule.targetSource && rule.targetSource.type === 'manualList') {
      for (const rawTitle of rule.targetSource.titles || []) {
        const title = String(rawTitle).trim();
        if (!title) continue;
        if (!titleToRuleIndices.has(title)) titleToRuleIndices.set(title, new Set());
        titleToRuleIndices.get(title).add(idx);
      }
    }
  });

  const titles = [...titleToRuleIndices.keys()];
  if (titles.length === 0) {
    throw new Error('対象ページが1件もありません（manualListのtitlesが空です）');
  }

  await pool.query(
    'UPDATE tasks SET target_titles_json = ?, progress_total = ?, progress_current = 0, stage_count = 1, current_stage = 1 WHERE id = ?',
    [toJsonColumn(titles), titles.length, task.id]
  );

  const values = titles.map((title, i) => [
    task.id,
    1, // stage（フェーズ2は常に1）
    i,
    title,
    0, // namespace: フェーズ2では標準名前空間前提。フェーズ4で実名前空間の判定を追加する
    toJsonColumn([...titleToRuleIndices.get(title)]),
    'pending',
  ]);

  await pool.query(
    `INSERT INTO task_pages
       (task_id, stage, order_index, page_title, namespace, matched_rule_indices, status)
     VALUES ?`,
    [values]
  );

  if (config.reviewSettings && config.reviewSettings.mode === 'manual') {
    const timeoutAt = new Date(Date.now() + config.reviewSettings.manualTimeoutHours * 3600 * 1000);
    await pool.query('UPDATE tasks SET review_timeout_at = ? WHERE id = ?', [timeoutAt, task.id]);
  }
}

/**
 * タスクを1件処理する（新規実行・一時停止からの再開いずれもこの関数を通る）。
 * ワーカーのメインループ（worker.js）から呼ばれる。
 * @param {object} task - tasksテーブルの1行
 */
async function runTask(task) {
  const config = parseJsonColumn(task.config_json, {});

  await enumerateAndInsertPagesIfNeeded(task, config);

  const mwClient = await getClient(task.account);

  const result = await runStagePipeline({
    taskId: task.id,
    stage: 1,
    mwClient,
    account: task.account,
    replacements: config.replacements || [],
    editSettings: config.editSettings,
    reviewSettings: config.reviewSettings,
    onFailure: config.onFailure,
  });

  if (result.emergencyStopped) {
    await pool.query(`UPDATE tasks SET status = 'emergency_stopped', updated_at = NOW() WHERE id = ?`, [task.id]);
    return;
  }
  if (result.expired || result.paused) {
    // runStagePipeline / waitForApproval が既にステータスを確定させている
    return;
  }
  if (result.completed) {
    const finalStatus = result.hadFailures ? 'completed_with_failures' : 'completed';
    await pool.query(`UPDATE tasks SET status = ?, updated_at = NOW() WHERE id = ?`, [finalStatus, task.id]);
  }
}

module.exports = { runTask };

'use strict';

const { pool } = require('../db');
const { writeTaskLogSafely } = require('./taskLog');

/**
 * 終わったタスクの作業データ（task_pages）を保持期間が過ぎたら削除する（仕様書9.4節）。
 *
 * task_pages は準備した本文（original_wikitext/new_wikitext）を含む作業用のデータで、
 * 放置するとタスクを重ねるほどDBが大きくなる。編集の結果は edit_log（恒久ログ）に残るため、
 * 終わったタスクの task_pages は一定期間後に消してよい。
 *
 * - 対象: 完了・完了（一部失敗）・失敗・中止のタスクで、最終更新から retentionDays 日が過ぎたもの
 * - 再開できる状態（一時停止・緊急停止・期限切れ）のタスクは、再開に必要なので消さない
 * - edit_log・task_logs・task_warnings は消さない
 * - 大量の行を一度に消してDBを長くロックしないよう、batchSize 行ずつ消す
 */
const FINISHED_STATUSES = ['completed', 'completed_with_failures', 'failed', 'cancelled'];
const TASKS_PER_RUN = 100;
const DELETE_BATCH_SIZE = 1000;

/**
 * @param {object} params
 * @param {number} params.retentionDays - 0以下なら何もしない
 * @param {number} [params.batchSize]
 * @returns {Promise<{tasks: number, pages: number}>} 作業データを消したタスク数と削除した行数
 */
async function cleanupOldTaskPages({ retentionDays, batchSize = DELETE_BATCH_SIZE }) {
  if (!(retentionDays > 0)) return { tasks: 0, pages: 0 };

  const [tasks] = await pool.query(
    `SELECT id FROM tasks
     WHERE status IN (?) AND updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)
       AND EXISTS (SELECT 1 FROM task_pages tp WHERE tp.task_id = tasks.id)
     ORDER BY id LIMIT ?`,
    [FINISHED_STATUSES, retentionDays, TASKS_PER_RUN]
  );

  let totalPages = 0;
  for (const { id } of tasks) {
    let deleted = 0;
    for (;;) {
      const [result] = await pool.query('DELETE FROM task_pages WHERE task_id = ? LIMIT ?', [id, batchSize]);
      deleted += result.affectedRows;
      if (result.affectedRows < batchSize) break;
    }
    totalPages += deleted;
    await writeTaskLogSafely({
      taskId: id,
      level: 'info',
      message: `作業データ（ページ${deleted}件分）を保持期間（${retentionDays}日）を過ぎたため削除しました。編集結果は編集ログに残っています。`,
    });
  }
  return { tasks: tasks.length, pages: totalPages };
}

module.exports = { cleanupOldTaskPages, FINISHED_STATUSES };

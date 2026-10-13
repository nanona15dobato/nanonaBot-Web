'use strict';

/**
 * ワーカー起動時の復旧（フェーズ13）。
 * 実行中のまま残ったタスク（ワーカーの再起動で中断されたもの）をキューに戻す。
 * ただし、同じタスクで再起動が続いている場合は、そのタスクがワーカーを落としている（メモリ不足等）とみなし、
 * キューに戻さずに失敗にする。戻し続けると、起動のたびに同じタスクで落ち、後のタスクがいつまでも実行されないため。
 */

const REQUEUE_MESSAGE = 'ワーカーの再起動により中断されていたため、キューに戻しました。';
// 同じタスクで、この時間内にこの回数だけ再起動が続いたら、ワーカーを落としているとみなして失敗にする
const CRASH_LOOP_WINDOW_MINUTES = 60;
const CRASH_LOOP_LIMIT = 2;

/**
 * @param {object} deps
 * @param {{query: Function}} deps.pool
 * @param {(entry: object) => Promise<void>} deps.writeTaskLog
 * @param {(task: object, status: string, extra?: object) => Promise<void>} [deps.notifyTaskStatus]
 * @param {{warn: Function, error: Function}} [deps.logger]
 * @returns {Promise<{requeued: number[], failed: number[]}>}
 */
async function requeueInterruptedTasks({ pool, writeTaskLog, notifyTaskStatus, logger = console }) {
  const requeued = [];
  const failed = [];
  const [rows] = await pool.query(`SELECT id FROM tasks WHERE status = 'running'`);
  for (const { id } of rows) {
    let recentRequeues = 0;
    try {
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM task_logs
          WHERE task_id = ? AND message = ? AND created_at > (NOW() - INTERVAL ? MINUTE)`,
        [id, REQUEUE_MESSAGE, CRASH_LOOP_WINDOW_MINUTES]
      );
      recentRequeues = Number(countRows[0] && countRows[0].cnt) || 0;
    } catch (err) {
      logger.error(`[worker] タスク ${id} の再起動回数を確認できません:`, err.message);
    }

    if (recentRequeues >= CRASH_LOOP_LIMIT) {
      const detail =
        `このタスクの実行中にワーカーが${recentRequeues + 1}回続けて停止したため（メモリ不足などが考えられます）、` +
        '後のタスクを止めないよう失敗にしました。置換ルール（空の文字列に一致する正規表現など）と対象を確認してください。';
      await pool.query(`UPDATE tasks SET status = 'failed', updated_at = NOW() WHERE id = ? AND status = 'running'`, [id]);
      await writeTaskLog({ taskId: id, level: 'error', message: detail });
      logger.error(`[worker] タスク ${id} は再起動が続いたため失敗にしました`);
      if (notifyTaskStatus) {
        try {
          const [taskRows] = await pool.query(`SELECT * FROM tasks WHERE id = ?`, [id]);
          if (taskRows[0]) await notifyTaskStatus(taskRows[0], 'failed', { detail });
        } catch (err) {
          logger.error('[worker] 通知に失敗しました:', err.message);
        }
      }
      failed.push(id);
      continue;
    }

    await pool.query(`UPDATE tasks SET status = 'queued', updated_at = NOW() WHERE id = ? AND status = 'running'`, [id]);
    await writeTaskLog({ taskId: id, level: 'warning', message: REQUEUE_MESSAGE });
    logger.warn(`[worker] 中断されていたタスク ${id} をキューに戻しました`);
    requeued.push(id);
  }
  return { requeued, failed };
}

module.exports = { requeueInterruptedTasks, REQUEUE_MESSAGE, CRASH_LOOP_LIMIT, CRASH_LOOP_WINDOW_MINUTES };

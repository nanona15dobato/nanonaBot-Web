'use strict';

const config = require('./src/config');
const { pool } = require('./src/db');
const { claimNextQueuedTask } = require('./src/worker/queue');
const { runTask } = require('./src/worker/taskRunner');
const { isEmergencyStopped } = require('./src/worker/emergencyStop');
const { writeTaskLogSafely } = require('./src/worker/taskLog');

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ワーカーのメインループ。1キュー1タスクの原則により、
 * 常に「queuedの先頭を1件claimして完了までしっかり処理」を繰り返す
 * （並行実行はしない。仕様書1章）。
 */
/**
 * ワーカーが処理中に再起動（デプロイ・ジョブ再起動・クラッシュ）すると、
 * タスクが running のまま残り二度と取り出されなくなる。ワーカーは常に1つだけ動かす
 * 前提（仕様書1章）なので、起動時点で running のものは前回の実行の取り残しとして
 * キューに戻す（途中だったページはpipeline側で再処理できる状態に戻される）。
 */
async function requeueInterruptedTasks() {
  const [rows] = await pool.query(`SELECT id FROM tasks WHERE status = 'running'`);
  for (const { id } of rows) {
    await pool.query(`UPDATE tasks SET status = 'queued', updated_at = NOW() WHERE id = ? AND status = 'running'`, [id]);
    await writeTaskLogSafely({
      taskId: id,
      level: 'warning',
      message: 'ワーカーの再起動により中断されていたため、キューに戻しました。',
    });
    console.warn(`[worker] 中断されていたタスク ${id} をキューに戻しました`);
  }
}

async function mainLoop() {
  console.log(`NanonaBot Tool worker starting (poll interval ${POLL_INTERVAL_MS}ms)`);

  try {
    await requeueInterruptedTasks();
  } catch (err) {
    console.error('[worker] 中断タスクの復旧に失敗しました:', err);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (await isEmergencyStopped()) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const task = await claimNextQueuedTask();
      if (!task) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(`[worker] タスク ${task.id} の処理を開始します（account=${task.account}, mode=${task.mode}）`);
      try {
        await runTask(task);
        console.log(`[worker] タスク ${task.id} の処理が一区切りしました`);
      } catch (err) {
        console.error(`[worker] タスク ${task.id} の処理中に予期しないエラーが発生しました:`, err);
        await writeTaskLogSafely({
          taskId: task.id,
          level: 'error',
          message: `予期しないエラーによりタスクを終了しました: ${String((err && err.message) || err)}`,
        });
        // 処理中に中止された場合はcancelledのまま残す
        await pool.query(`UPDATE tasks SET status = 'failed', updated_at = NOW() WHERE id = ? AND status = 'running'`, [
          task.id,
        ]);
      }
    } catch (outerErr) {
      // DB接続断など、タスク単位より外側のエラー。ループ自体は止めない。
      console.error('[worker] ワーカーループでエラーが発生しました:', outerErr);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

console.log(`NanonaBot Tool worker: wiki=${config.wiki.apiUrl}`);
mainLoop();

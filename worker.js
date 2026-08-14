'use strict';

const config = require('./src/config');
const { pool } = require('./src/db');
const { claimNextQueuedTask } = require('./src/worker/queue');
const { runTask } = require('./src/worker/taskRunner');
const { isEmergencyStopped } = require('./src/worker/emergencyStop');

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 10000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ワーカーのメインループ。1キュー1タスクの原則により、
 * 常に「queuedの先頭を1件claimして完了までしっかり処理」を繰り返す
 * （並行実行はしない。仕様書1章）。
 */
async function mainLoop() {
  console.log(`NanonaBot Tool worker starting (poll interval ${POLL_INTERVAL_MS}ms)`);

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
        await pool.query(`UPDATE tasks SET status = 'failed', updated_at = NOW() WHERE id = ?`, [task.id]);
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

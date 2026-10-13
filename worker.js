'use strict';

const config = require('./src/config');
const { pool } = require('./src/db');
const { claimNextQueuedTask } = require('./src/worker/queue');
const { runTask } = require('./src/worker/taskRunner');
const { isEmergencyStopped } = require('./src/worker/emergencyStop');
const { writeTaskLogSafely } = require('./src/worker/taskLog');
const { notifyTaskStatus } = require('./src/services/notify');
const { cleanupOldTaskPages } = require('./src/worker/cleanup');
const { getWorkerSettings, setSetting, WORKER_HEARTBEAT_KEY } = require('./src/services/settings');

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 終わったタスクの作業データ（task_pages）を消す処理の実行間隔（タスクとタスクの合間に実行する）
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
let lastCleanupAt = 0;

async function cleanupIfDue() {
  if (Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = Date.now();
  try {
    const { taskPagesRetentionDays } = await getWorkerSettings();
    const { tasks, pages } = await cleanupOldTaskPages({ retentionDays: taskPagesRetentionDays });
    if (tasks > 0) console.log(`[worker] 保持期間を過ぎた作業データを削除しました（タスク${tasks}件、ページ${pages}件）`);
  } catch (err) {
    // 掃除の失敗でタスクの処理は止めない（次の周期でやり直す）
    console.error('[worker] 作業データの削除に失敗しました:', err.message || err);
  }
}

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
const { requeueInterruptedTasks: requeueTasks } = require('./src/worker/recovery');

/** 実行中のまま残ったタスクをキューに戻す（再起動が続いているタスクは失敗にする。src/worker/recovery.js）。 */
function requeueInterruptedTasks() {
  return requeueTasks({ pool, writeTaskLog: writeTaskLogSafely, notifyTaskStatus });
}

// ===== 稼働状況（ハートビート） =====
// ワーカーが動いていることと、今何をしているかを10秒ごとにDBへ記録する（フェーズ11）。
// メインループとは別のタイマーで書くので、長いタスクの処理中も記録が途切れない。
// ダッシュボードはこの記録が古いと「ワーカーが応答していません」と表示する。
const HEARTBEAT_INTERVAL_MS = 10 * 1000;
const workerState = { startedAt: new Date().toISOString(), state: 'idle', taskId: null };

async function writeHeartbeat() {
  try {
    await setSetting(
      WORKER_HEARTBEAT_KEY,
      JSON.stringify({ ...workerState, pid: process.pid, at: new Date().toISOString() }),
      'worker'
    );
  } catch (err) {
    // app_settings テーブルが無い環境では記録しない（処理には影響しない）
  }
}

function setWorkerState(state, taskId = null) {
  workerState.state = state;
  workerState.taskId = taskId;
  writeHeartbeat();
}

async function mainLoop() {
  writeHeartbeat();
  setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS).unref();

  console.log(`NanonaBot Tool worker starting (poll interval ${POLL_INTERVAL_MS}ms)`);

  try {
    await requeueInterruptedTasks();
  } catch (err) {
    console.error('[worker] 中断タスクの復旧に失敗しました:', err);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await cleanupIfDue();

      if (await isEmergencyStopped()) {
        if (workerState.state !== 'emergency_stopped') setWorkerState('emergency_stopped');
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const task = await claimNextQueuedTask();
      if (!task) {
        if (workerState.state !== 'idle') setWorkerState('idle');
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      setWorkerState('running', task.id);

      console.log(`[worker] タスク ${task.id} の処理を開始します（account=${task.account}, mode=${task.mode}）`);
      let errorDetail = null;
      try {
        await runTask(task);
        console.log(`[worker] タスク ${task.id} の処理が一区切りしました`);
      } catch (err) {
        errorDetail = String((err && err.message) || err);
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

      // 処理が止まった/終わった理由を通知する（一時停止・失敗・期限切れ・緊急停止・完了）
      const [statusRows] = await pool.query('SELECT status FROM tasks WHERE id = ?', [task.id]);
      if (statusRows[0]) await notifyTaskStatus(task, statusRows[0].status, { detail: errorDetail });
    } catch (outerErr) {
      // DB接続断など、タスク単位より外側のエラー。ループ自体は止めない。
      console.error('[worker] ワーカーループでエラーが発生しました:', outerErr);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

console.log(`NanonaBot Tool worker: wiki=${config.wiki.apiUrl}`);
mainLoop();

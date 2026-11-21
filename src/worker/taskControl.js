'use strict';
const { pool } = require('../db');
const { isEmergencyStopped } = require('./emergencyStop');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stopReason(taskId) {
  if (await isEmergencyStopped()) return 'emergency';
  const [rows] = await pool.query('SELECT status, pause_requested FROM tasks WHERE id = ?', [taskId]);
  const task = rows[0];
  if (!task || task.status === 'cancelled') return 'cancelled';
  if (task.pause_requested || task.status === 'paused') return 'paused';
  if (task.status === 'emergency_stopped') return 'emergency';
  return null;
}
async function wait(ms, taskId) {
  const until = Date.now() + ms;
  for (;;) {
    const reason = await stopReason(taskId);
    if (reason) return reason;
    const remaining = until - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(1000, remaining));
  }
}
// Called only after runTask's pending work has settled. A paused status alone is not an acknowledgement.
async function releaseTask(taskId) {
  await pool.query(`UPDATE tasks SET
    status = CASE WHEN status = 'running' AND pause_requested = 1 THEN 'paused' ELSE status END,
    worker_active = 0, pause_requested = 0, updated_at = NOW() WHERE id = ?`, [taskId]);
}
function result(reason, hadFailures = false) {
  return { completed: false, paused: reason === 'paused', manualPause: reason === 'paused',
    emergencyStopped: reason === 'emergency', cancelled: reason === 'cancelled', hadFailures };
}
module.exports = { stopReason, wait, releaseTask, result };

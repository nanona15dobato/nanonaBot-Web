'use strict';

const { pool } = require('../db');

/**
 * 最も古い "queued" タスクを1件だけアトミックに "running" にして取得する。
 * トランザクション + SELECT ... FOR UPDATE で、複数ワーカーが万一同時に動いても
 * 同じタスクを二重に掴まないようにする（1キュー1タスクの原則。仕様書1章）。
 *
 * @returns {Promise<object|null>} タスク行（idなど）。無ければnull。
 */
async function claimNextQueuedTask() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE`
    );
    if (rows.length === 0) {
      await conn.commit();
      return null;
    }
    const task = rows[0];
    await conn.query(`UPDATE tasks SET status = 'running', updated_at = NOW() WHERE id = ?`, [task.id]);
    await conn.commit();
    task.status = 'running';
    return task;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { claimNextQueuedTask };

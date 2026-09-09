'use strict';

const { pool } = require('../db');

/**
 * タスクの実行経過をWeb UIで追跡できるよう恒久保存する。
 * ログ記録自体の失敗で編集処理を止めないよう、呼び出し側では安全に扱う。
 */
async function writeTaskLog({ taskId, stage = null, pageTitle = null, level = 'info', message }) {
  await pool.query(
    `INSERT INTO task_logs (task_id, stage, page_title, level, message, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [taskId, stage, pageTitle, level, String(message)]
  );
}

async function writeTaskLogSafely(entry) {
  try {
    await writeTaskLog(entry);
  } catch (err) {
    // 旧DBでtask_logsテーブルがまだ作られていない場合も、既存の編集処理は継続する。
    console.error('[taskLog] タスクログの保存に失敗しました:', err.message || err);
  }
}

module.exports = { writeTaskLog, writeTaskLogSafely };

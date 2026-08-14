'use strict';

const { pool } = require('../db');

/**
 * edit_logに1行書き込む（仕様書4章・9.2節）。task_pagesのライフサイクルとは独立に、
 * 編集の成否が確定した瞬間に呼ぶ。
 *
 * @param {object} entry
 * @param {number} entry.taskId
 * @param {number} entry.stage
 * @param {string} entry.pageTitle
 * @param {number} entry.namespace
 * @param {string} entry.account
 * @param {'edited'|'failed'} entry.status
 * @param {number|null} [entry.revid]
 * @param {number|null} [entry.baseRevid]
 * @param {string|null} [entry.editSummary]
 * @param {string|null} [entry.errorMessage]
 */
async function writeEditLog(entry) {
  await pool.query(
    `INSERT INTO edit_log
      (task_id, stage, page_title, namespace, account, status, revid, base_revid, edit_summary, error_message, edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      entry.taskId,
      entry.stage,
      entry.pageTitle,
      entry.namespace,
      entry.account,
      entry.status,
      entry.revid ?? null,
      entry.baseRevid ?? null,
      entry.editSummary ?? null,
      entry.errorMessage ?? null,
    ]
  );
}

module.exports = { writeEditLog };

'use strict';

const { pool } = require('../db');

/**
 * 現在システム全体が緊急停止中かどうかを返す。
 * ワーカーは各ページ処理前・編集直前に必ずこれを呼ぶ（仕様書9.2節）。
 * @returns {Promise<boolean>}
 */
async function isEmergencyStopped() {
  const [rows] = await pool.query('SELECT emergency_stopped FROM system_status WHERE id = 1');
  return !!(rows[0] && rows[0].emergency_stopped);
}

module.exports = { isEmergencyStopped };

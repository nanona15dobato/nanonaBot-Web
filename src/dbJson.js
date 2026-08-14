'use strict';

/**
 * mysql2はドライバ設定によってJSON型カラムを文字列のまま返すことも
 * パース済みオブジェクトとして返すこともあるため、両対応で安全にパースする。
 * @param {any} value
 * @param {any} [fallback]
 */
function parseJsonColumn(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value; // 既にオブジェクト/配列
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

/** JSON列に書き込む前に確実に文字列化する。 */
function toJsonColumn(value) {
  return JSON.stringify(value);
}

module.exports = { parseJsonColumn, toJsonColumn };

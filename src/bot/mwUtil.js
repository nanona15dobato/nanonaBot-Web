'use strict';

/**
 * MediaWiki APIのISO8601タイムスタンプ（例: "2026-08-11T12:34:56Z"）をJSのDateにする。
 * @param {string} mwTimestamp
 * @returns {Date}
 */
function parseMwTimestamp(mwTimestamp) {
  return new Date(mwTimestamp);
}

/**
 * JSのDateをMediaWiki APIが受け付けるISO8601形式（ミリ秒なし・Z終端）に整形する。
 * basetimestamp/starttimestampの送信、DBのDATETIME往復で精度がずれても
 * MediaWiki側は「基準時刻以降に編集されたか」の比較しかしないため、
 * 秒精度で揃っていれば問題ない。
 * @param {Date} date
 * @returns {string}
 */
function toMwTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * オブジェクトからundefined/nullのキーを取り除いたコピーを返す。
 * URLSearchParamsに渡す前の下ごしらえ用（"undefined"という文字列が
 * パラメータ値に紛れ込むのを防ぐ）。
 * @param {object} params
 */
function cleanParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

module.exports = { parseMwTimestamp, toMwTimestamp, cleanParams };

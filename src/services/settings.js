'use strict';

/**
 * 画面から変更できる運用設定（フェーズ10: 通知先）。
 * DBの app_settings テーブルに保存した値を、環境変数の値より優先して使う。
 * テーブルが無い（schema.sql 未適用）・DBに接続できない環境では環境変数だけで動く。
 */

/** 設定項目 → 対応する環境変数（DBに値が無いときの既定値） */
const NOTIFY_KEYS = {
  webhookUrl: { db: 'notify.webhookUrl', env: 'NOTIFY_WEBHOOK_URL' },
  mailTo: { db: 'notify.mailTo', env: 'NOTIFY_MAIL_TO' },
  mailFrom: { db: 'notify.mailFrom', env: 'NOTIFY_MAIL_FROM' },
  events: { db: 'notify.events', env: 'NOTIFY_EVENTS' },
};

const CACHE_MS = 30 * 1000; // ワーカーが通知のたびにDBを読まないよう、DBの値を短時間キャッシュする
let cache = null; // { at, dbValues }

function getPool() {
  try {
    // eslint-disable-next-line global-require
    return require('../db').pool;
  } catch (e) {
    return null; // DB接続情報が無い環境（テスト等）
  }
}

/** DBに保存された通知設定（キー→値）。読めなければ空。 */
async function loadDbNotifySettings(pool = getPool()) {
  if (!pool) return {};
  try {
    const [rows] = await pool.query(
      `SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?)`,
      [Object.values(NOTIFY_KEYS).map((k) => k.db)]
    );
    return Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  } catch (e) {
    return {}; // app_settings テーブル未作成など
  }
}

/**
 * 実際に使う通知設定（DB > 環境変数）と、それぞれの値の出どころ。
 * @param {object} [options]
 * @param {boolean} [options.fresh] - キャッシュを使わない（設定画面での表示・保存直後）
 * @returns {Promise<{webhookUrl:string, mailTo:string, mailFrom:string, events:string, sources: object}>}
 */
async function getNotifySettings({ fresh = false, pool } = {}) {
  let dbValues;
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) {
    dbValues = cache.dbValues;
  } else {
    dbValues = await loadDbNotifySettings(pool);
    cache = { at: Date.now(), dbValues };
  }
  const values = { sources: {} };
  for (const [name, key] of Object.entries(NOTIFY_KEYS)) {
    if (dbValues[key.db] !== undefined && dbValues[key.db] !== null) {
      values[name] = dbValues[key.db];
      values.sources[name] = 'db';
    } else {
      values[name] = process.env[key.env] || '';
      values.sources[name] = process.env[key.env] ? 'env' : 'none';
    }
  }
  return values;
}

/**
 * 通知設定をDBに保存する。値が null の項目はDBから消し、環境変数の値に戻す。
 * @param {{webhookUrl?:string|null, mailTo?:string|null, mailFrom?:string|null, events?:string|null}} values
 * @param {string} username
 */
async function saveNotifySettings(values, username, pool = getPool()) {
  for (const [name, key] of Object.entries(NOTIFY_KEYS)) {
    if (!(name in values)) continue;
    if (values[name] === null) {
      await pool.query('DELETE FROM app_settings WHERE setting_key = ?', [key.db]);
    } else {
      await pool.query(
        `INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
        [key.db, String(values[name]), username]
      );
    }
  }
  cache = null;
}

function clearSettingsCache() {
  cache = null;
}

module.exports = { NOTIFY_KEYS, getNotifySettings, saveNotifySettings, clearSettingsCache };

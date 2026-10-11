'use strict';

/**
 * 画面から変更できる運用設定（フェーズ10: 通知先、フェーズ11: ワーカーの動作）。
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

/**
 * ワーカーの動作設定（フェーズ11）。実環境で動かしながら、再デプロイせずに調整できるようにする。
 * min/max は画面から保存するときの範囲（環境変数の値はそのまま使う）。
 */
const WORKER_KEYS = {
  reviewPollMs: { db: 'worker.reviewPollMs', env: 'REVIEW_POLL_INTERVAL_MS', def: 500, min: 100, max: 10000, label: '承認待ちの確認間隔' },
  editRetryCount: { db: 'worker.editRetryCount', env: 'EDIT_RETRY_COUNT', def: 3, min: 0, max: 10, label: '再試行回数' },
  editRetryBaseMs: { db: 'worker.editRetryBaseMs', env: 'EDIT_RETRY_BASE_MS', def: 10000, min: 1000, max: 600000, label: '1回目の再試行までの待ち時間' },
  nullEditIntervalMs: { db: 'worker.nullEditIntervalMs', env: 'NULL_EDIT_INTERVAL_MS', def: 1000, min: 0, max: 60000, label: 'null edit / purge の間隔' },
  taskPagesRetentionDays: { db: 'worker.taskPagesRetentionDays', env: 'TASK_PAGES_RETENTION_DAYS', def: 14, min: 0, max: 3650, label: '作業データの保持日数' },
};

/** ワーカーの稼働状況（ハートビート）を記録するキー */
const WORKER_HEARTBEAT_KEY = 'worker.heartbeat';

const ALL_DB_KEYS = [...Object.values(NOTIFY_KEYS), ...Object.values(WORKER_KEYS)].map((k) => k.db);

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

/** DBに保存された設定（キー→値）。読めなければ空。 */
async function loadDbSettings(pool = getPool()) {
  if (!pool) return {};
  try {
    const [rows] = await pool.query(`SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?)`, [
      ALL_DB_KEYS,
    ]);
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
async function cachedDbValues({ fresh, pool }) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.dbValues;
  const dbValues = await loadDbSettings(pool);
  cache = { at: Date.now(), dbValues };
  return dbValues;
}

async function getNotifySettings({ fresh = false, pool } = {}) {
  const dbValues = await cachedDbValues({ fresh, pool });
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
 * 実際に使うワーカーの動作設定（DB > 環境変数 > 既定値。すべて数値）と、それぞれの値の出どころ。
 * @returns {Promise<{reviewPollMs:number, editRetryCount:number, editRetryBaseMs:number,
 *   nullEditIntervalMs:number, taskPagesRetentionDays:number, sources: object}>}
 */
async function getWorkerSettings({ fresh = false, pool } = {}) {
  const dbValues = await cachedDbValues({ fresh, pool });
  const values = { sources: {} };
  for (const [name, key] of Object.entries(WORKER_KEYS)) {
    const fromDb = dbValues[key.db];
    const fromEnv = process.env[key.env];
    if (fromDb !== undefined && fromDb !== null && Number.isFinite(Number(fromDb))) {
      values[name] = Number(fromDb);
      values.sources[name] = 'db';
    } else if (fromEnv !== undefined && fromEnv !== '' && Number.isFinite(Number(fromEnv))) {
      values[name] = Number(fromEnv);
      values.sources[name] = 'env';
    } else {
      values[name] = key.def;
      values.sources[name] = 'default';
    }
  }
  return values;
}

/** 設定をDBに保存する（null はDBから消して環境変数・既定値に戻す）。 */
async function saveSettings(keyMap, values, username, pool = getPool()) {
  for (const [name, key] of Object.entries(keyMap)) {
    if (!(name in values)) continue;
    if (values[name] === null) {
      await pool.query('DELETE FROM app_settings WHERE setting_key = ?', [key.db]);
    } else {
      await setSetting(key.db, String(values[name]), username, pool);
    }
  }
  cache = null;
}

/** 1つの設定を保存する（ハートビート等にも使う）。 */
async function setSetting(settingKey, value, username, pool = getPool()) {
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by), updated_at = NOW()`,
    [settingKey, value, username]
  );
}

async function saveWorkerSettings(values, username, pool) {
  return saveSettings(WORKER_KEYS, values, username, pool);
}

/**
 * 通知設定をDBに保存する。値が null の項目はDBから消し、環境変数の値に戻す。
 * @param {{webhookUrl?:string|null, mailTo?:string|null, mailFrom?:string|null, events?:string|null}} values
 * @param {string} username
 */
async function saveNotifySettings(values, username, pool) {
  return saveSettings(NOTIFY_KEYS, values, username, pool);
}

function clearSettingsCache() {
  cache = null;
}

module.exports = {
  NOTIFY_KEYS,
  WORKER_KEYS,
  WORKER_HEARTBEAT_KEY,
  getNotifySettings,
  saveNotifySettings,
  getWorkerSettings,
  saveWorkerSettings,
  setSetting,
  clearSettingsCache,
};

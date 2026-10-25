'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const config = require('../config');
const { determineRole, normalizeUsername } = require('../permissions');

const EVENTS = ['emergency_stop', 'emergency_clear', 'paused', 'failed', 'expired', 'emergency_stopped', 'completed_with_failures', 'completed'];
const DEFAULT_EVENTS = EVENTS.filter((event) => event !== 'completed');
const parseJson = (value) => typeof value === 'string' ? JSON.parse(value) : value;
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

class PushError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function decodeKey(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error('invalid key');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== value.replace(/=+$/, '')) throw new Error('invalid key');
  return decoded;
}

function getConfig() {
  try {
    const subject = process.env.VAPID_SUBJECT;
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!subject || !publicKey || !privateKey) return null;
    const uri = new URL(subject);
    if (!['mailto:', 'https:'].includes(uri.protocol) || uri.username || uri.password || uri.hash) return null;
    if (uri.protocol === 'mailto:' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(uri.pathname)) return null;
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(decodeKey(privateKey, 32));
    if (!ecdh.getPublicKey().equals(decodeKey(publicKey, 65))) return null;
    return { subject, publicKey, privateKey };
  } catch { return null; }
}

function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || /\s/.test(endpoint)) return false;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443')) return false;
    if (u.hostname === 'fcm.googleapis.com') return /^\/(fcm\/send|wp)\/.+/.test(u.pathname);
    if (u.hostname === 'updates.push.services.mozilla.com') return /^\/wpush\/v[12]\/.+/.test(u.pathname);
    if (u.hostname === 'web.push.apple.com') return u.pathname.length > 1;
    return /^[a-z0-9-]+\.notify\.windows\.com$/.test(u.hostname) && (u.pathname.length > 1 || Boolean(u.search));
  } catch { return false; }
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length > EVENTS.length || events.some((event) => !EVENTS.includes(event))) {
    throw new PushError(400, '通知する種類の指定が不正です。');
  }
  return [...new Set(events)]; // 空配列は「通知なし」。既存メール設定とは独立。
}

function validateSubscription(input) {
  try {
    if (!input || !validEndpoint(input.endpoint)) throw new Error('endpoint');
    const publicKey = decodeKey(input.keys && input.keys.p256dh, 65);
    crypto.ECDH.convertKey(publicKey, 'prime256v1');
    const auth = decodeKey(input.keys && input.keys.auth, 16);
    if (input.expirationTime != null && (!Number.isFinite(input.expirationTime) || input.expirationTime <= Date.now())) throw new Error('expiration');
    return { endpoint: input.endpoint, expirationTime: input.expirationTime ?? null,
      keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') } };
  } catch { throw new PushError(400, 'この端末の通知購読情報が不正です。'); }
}

function safePath(value) { return typeof value === 'string' && (value === '/settings' || /^\/tasks\/[1-9]\d*$/.test(value)) ? value : '/'; }

function sendHttp(subscription, payload, vapidDetails, signal, requestFn = https.request) {
  // ライブラリには暗号化・署名を任せ、通信は総時間上限付きのHTTPSで行う。
  // リダイレクトには追従せず、エラー本文や購読URLをログへ出さない。
  const details = require('web-push').generateRequestDetails(subscription, JSON.stringify(payload), {
    vapidDetails, TTL: 60, urgency: 'high', contentEncoding: 'aes128gcm',
  });
  return new Promise((resolve, reject) => {
    const request = requestFn(details.endpoint, { method: details.method, headers: details.headers, signal }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(details.body);
  });
}

function createPushService({ db = { query: (...args) => require('../db').pool.query(...args) }, readConfig = getConfig,
  send = sendHttp, now = Date.now,
  isOwner = (username) => determineRole({ username, ...config.permissions, groups: [] }) === 'owner',
} = {}) {
  function configured() { return readConfig(); }
  function requireConfig() {
    const value = configured();
    if (!value) throw new PushError(503, 'サーバーの端末通知はまだ設定されていません。');
    return value;
  }
  async function cleanup(vapid) {
    await db.query(`DELETE p FROM push_subscriptions p LEFT JOIN sessions s ON s.session_id = p.session_id
      WHERE s.session_id IS NULL OR s.expires <= ? OR p.expires_at <= ? OR p.vapid_key <> ?`,
    [Math.floor(now() / 1000), new Date(now()), hash(vapid.publicKey)]);
  }
  async function status(sessionId, username, endpointHash) {
    if (!validHash(endpointHash)) throw new PushError(400, '端末の指定が不正です。');
    const vapid = requireConfig();
    const [rows] = await db.query(`SELECT events_json, expires_at FROM push_subscriptions
      WHERE endpoint_hash = ? AND session_id = ? AND username = ? AND expires_at > ? AND vapid_key = ?`,
    [endpointHash, sessionId, normalizeUsername(username), new Date(now()), hash(vapid.publicKey)]);
    if (!rows[0]) return { registered: false };
    return { registered: true, events: validateEvents(parseJson(rows[0].events_json)), expiresAt: rows[0].expires_at };
  }
  async function subscribe(sessionId, username, sessionExpiry, input, events, applicationKey) {
    const vapid = requireConfig();
    if (applicationKey !== vapid.publicKey) throw new PushError(409, '通知の鍵が変わりました。「状態を確認」してから、もう一度有効化してください。');
    const subscription = validateSubscription(input);
    const selected = validateEvents(events);
    const expires = Math.min(new Date(sessionExpiry).getTime(), subscription.expirationTime ?? Infinity);
    if (!Number.isFinite(expires) || expires <= now()) throw new PushError(400, 'ログイン期限が切れています。ログインし直してください。');
    const endpointHash = hash(subscription.endpoint);
    await cleanup(vapid);
    const [counts] = await db.query('SELECT COUNT(*) AS total FROM push_subscriptions WHERE username = ? AND endpoint_hash <> ?',
      [normalizeUsername(username), endpointHash]);
    if (Number(counts[0].total) >= 20) throw new PushError(409, '登録端末が上限に達しました。使っていない端末で通知を停止してください。');
    await db.query(`INSERT INTO push_subscriptions
      (endpoint_hash, endpoint, p256dh, auth, session_id, username, events_json, expires_at, vapid_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE endpoint = VALUES(endpoint), p256dh = VALUES(p256dh), auth = VALUES(auth),
      session_id = VALUES(session_id), username = VALUES(username), events_json = VALUES(events_json),
      expires_at = VALUES(expires_at), vapid_key = VALUES(vapid_key)`,
    [endpointHash, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth,
      sessionId, normalizeUsername(username), JSON.stringify(selected), new Date(expires), hash(vapid.publicKey)]);
    return { registered: true, events: selected, expiresAt: new Date(expires) };
  }
  async function update(sessionId, username, endpointHash, events) {
    const current = await status(sessionId, username, endpointHash);
    if (!current.registered) throw new PushError(404, 'このログインでは端末通知が有効になっていません。');
    const selected = validateEvents(events);
    await db.query('UPDATE push_subscriptions SET events_json = ? WHERE endpoint_hash = ? AND session_id = ? AND username = ?',
      [JSON.stringify(selected), endpointHash, sessionId, normalizeUsername(username)]);
    return { ...current, events: selected };
  }
  async function unsubscribe(sessionId, username, endpointHash) {
    if (!validHash(endpointHash)) throw new PushError(400, '端末の指定が不正です。');
    await db.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND session_id = ? AND username = ?',
      [endpointHash, sessionId, normalizeUsername(username)]);
  }
  async function revokeSession(sessionId) {
    try { await db.query('DELETE FROM push_subscriptions WHERE session_id = ?', [sessionId]); }
    catch (error) { if (error.code !== 'ER_NO_SUCH_TABLE') throw error; }
  }
  async function sendEvent(event, path, { sessionId, endpointHash } = {}) {
    const vapid = configured();
    if (!vapid || (!EVENTS.includes(event) && event !== 'test')) return { sent: 0, failed: 0 };
    await cleanup(vapid);
    const args = [new Date(now()), Math.floor(now() / 1000), hash(vapid.publicKey)];
    let filter = '';
    if (event === 'test') {
      if (!sessionId || !validHash(endpointHash)) throw new PushError(400, '端末の指定が不正です。');
      filter = ' AND p.session_id = ? AND p.endpoint_hash = ?';
      args.push(sessionId, endpointHash);
    }
    const [rows] = await db.query(`SELECT p.*, s.data AS session_data, s.expires AS session_expires
      FROM push_subscriptions p JOIN sessions s ON s.session_id = p.session_id
      WHERE p.expires_at > ? AND s.expires > ? AND p.vapid_key = ?${filter}
      ORDER BY p.updated_at DESC LIMIT 100`, args);
    const candidates = rows.filter((row) => {
      try {
        const user = JSON.parse(row.session_data);
        return user.role === 'owner' && isOwner(user.username) && normalizeUsername(user.username) === row.username &&
          new Date(row.expires_at).getTime() > now() && row.session_expires * 1000 > now() &&
          row.vapid_key === hash(vapid.publicKey) && validEndpoint(row.endpoint) &&
          (event === 'test' || validateEvents(parseJson(row.events_json)).includes(event));
      } catch { return false; }
    });
    const result = { sent: 0, failed: 0 };
    const signal = AbortSignal.timeout(5000);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (!signal.aborted && cursor < candidates.length) {
        const row = candidates[cursor++];
        try {
          const subscription = validateSubscription({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } });
          const code = await send(subscription, { version: 2, event, url: safePath(path), tag: 'nanona-' + hash(event + safePath(path)).slice(0, 24) }, vapid, signal);
          if (code >= 200 && code < 300) result.sent++;
          else {
            result.failed++;
            console.warn('[push] Pushサービスが通知を受け付けませんでした (HTTP ' + code + ')');
            if (code === 404 || code === 410) await db.query(`DELETE FROM push_subscriptions
              WHERE endpoint_hash = ? AND session_id = ? AND p256dh = ? AND auth = ?`, [row.endpoint_hash, row.session_id, row.p256dh, row.auth]);
          }
        } catch (error) {
          result.failed++;
          const reason = typeof error.code === 'string' && /^[A-Z_0-9]{1,40}$/.test(error.code) ? error.code : 'send_error';
          console.warn('[push] 通知送信を完了できませんでした (' + reason + ')');
        }
      }
    }));
    result.failed += candidates.length - cursor;
    return result;
  }
  return { configured, status, subscribe, update, unsubscribe, revokeSession, sendEvent };
}

module.exports = { ...createPushService(), createPushService, getConfig, validateSubscription, validateEvents, validEndpoint,
  safePath, hash, PushError, EVENTS, DEFAULT_EVENTS, sendHttp };

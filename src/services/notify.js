'use strict';

const config = require('../config');

/**
 * 運用上の重要な出来事（緊急停止・タスクの停止/失敗/完了）を外部へ通知する（フェーズ9）。
 *
 * 環境変数 NOTIFY_WEBHOOK_URL に Slack の Incoming Webhook または Discord の Webhook の
 * URLを設定すると、そこへJSONをPOSTする（`text` はSlack、`content` はDiscordが読む）。
 * 未設定なら何もしない。通知の失敗で本来の処理（緊急停止・タスク処理）を止めないよう、
 * この関数は例外を投げない。
 *
 * NOTIFY_EVENTS（カンマ区切り）で通知する種類を絞れる。既定はすべて:
 *   emergency_stop, emergency_clear, paused, failed, expired, emergency_stopped,
 *   completed_with_failures, completed
 */
const ALL_EVENTS = [
  'emergency_stop',
  'emergency_clear',
  'paused',
  'failed',
  'expired',
  'emergency_stopped',
  'completed_with_failures',
  'completed',
];
const MAX_MESSAGE_LENGTH = 1900; // Discordの上限（2000文字）に余裕を持たせる
const TIMEOUT_MS = 5000;

function enabledEvents() {
  const raw = process.env.NOTIFY_EVENTS;
  if (!raw) return new Set(ALL_EVENTS);
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
  );
}

/**
 * @param {object} params
 * @param {string} params.event - ALL_EVENTS のいずれか
 * @param {string} params.title - 1行目に出す見出し
 * @param {string} [params.message] - 詳細
 * @param {string} [params.path] - ツール内のパス（例: "/tasks/12"）。TOOL_BASE_URLと連結してリンクにする
 * @param {typeof fetch} [params.fetchFn] - テスト用
 * @returns {Promise<boolean>} 送信したらtrue
 */
async function notify({ event, title, message, path, fetchFn = fetch }) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url || !enabledEvents().has(event)) return false;

  const lines = [`[NanonaBot Tool] ${title}`];
  if (message) lines.push(message);
  if (path) lines.push(`${config.server.baseUrl}${path}`);
  let text = lines.join('\n');
  if (text.length > MAX_MESSAGE_LENGTH) text = `${text.slice(0, MAX_MESSAGE_LENGTH)}…`;

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': config.userAgent },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[notify] 通知の送信に失敗しました (${res.status})`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[notify] 通知の送信に失敗しました:', (err && err.message) || err);
    return false;
  }
}

const TASK_STATUS_NOTICES = {
  paused: '失敗により一時停止しました',
  failed: 'エラーで終了しました',
  expired: '無操作タイムアウトで期限切れになりました',
  emergency_stopped: '緊急停止により中断しました',
  completed_with_failures: '完了しました（失敗したページがあります）',
  completed: '完了しました',
};

/**
 * ワーカーがタスクの処理を終えた（または止めた）ときの状態を通知する。
 * @param {{id:number, account:string}} task
 * @param {string} status - 処理後の tasks.status
 * @param {object} [extra]
 * @param {string} [extra.detail]
 * @param {typeof fetch} [extra.fetchFn]
 */
async function notifyTaskStatus(task, status, { detail, fetchFn } = {}) {
  const notice = TASK_STATUS_NOTICES[status];
  if (!notice) return false; // running/queued/cancelled 等は通知しない
  return notify({
    event: status,
    title: `タスク #${task.id} が${notice}`,
    message: [`アカウント: ${task.account}`, detail].filter(Boolean).join('\n'),
    path: `/tasks/${task.id}`,
    fetchFn,
  });
}

module.exports = { notify, notifyTaskStatus, ALL_EVENTS };

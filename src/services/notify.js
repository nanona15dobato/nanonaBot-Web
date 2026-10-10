'use strict';

const config = require('../config');

/**
 * 運用上の重要な出来事（緊急停止・タスクの停止/失敗/完了）を外部へ通知する（フェーズ9）。
 * 通知先は次の2種類で、設定されたものすべてに送る（どちらも未設定なら何もしない）。
 *
 * - Webhook: NOTIFY_WEBHOOK_URL に Slack の Incoming Webhook または Discord の Webhook の
 *   URLを設定すると、そこへJSONをPOSTする（`text` はSlack、`content` はDiscordが読む）。
 * - メール: NOTIFY_MAIL_TO（カンマ区切り）と NOTIFY_MAIL_FROM を設定すると、Toolforgeの
 *   SMTPサーバー（既定 mail.tools.wmcloud.org:25。Help:Toolforge/Email）経由で送る。
 *   From は「ツール名.任意の文字列@toolforge.org」形式にする必要がある
 *   （例: "nanonaBotWeb:Error" <nanonabot01.weberror@toolforge.org>）。
 *   宛先の「利用者名@toolforge.org」は開発者アカウントに登録したメールアドレスへ転送される。
 *   Toolforgeのメールサーバーにはアドレスごとのレート制限があるため、大量送信には使わない。
 *
 * 通知の失敗で本来の処理（緊急停止・タスク処理）を止めないよう、この関数は例外を投げない。
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
const DEFAULT_SMTP_HOST = 'mail.tools.wmcloud.org';
const DEFAULT_SMTP_PORT = 25;

/** @type {import('nodemailer').Transporter|null} */
let defaultMailTransport = null;

function getMailTransport() {
  if (!defaultMailTransport) {
    // eslint-disable-next-line global-require
    const nodemailer = require('nodemailer');
    defaultMailTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || DEFAULT_SMTP_HOST,
      port: Number(process.env.SMTP_PORT || DEFAULT_SMTP_PORT),
      secure: false, // Cloud VPS内部向けのSMTP（認証なし）。サーバーが対応していればSTARTTLSを使う
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
    });
  }
  return defaultMailTransport;
}

function mailRecipients() {
  return (process.env.NOTIFY_MAIL_TO || '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
}

async function sendWebhook(url, text, fetchFn) {
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': config.userAgent },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[notify] Webhook通知の送信に失敗しました (${res.status})`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[notify] Webhook通知の送信に失敗しました:', (err && err.message) || err);
    return false;
  }
}

async function sendMail({ from, to, subject, text, transport }) {
  try {
    await transport.sendMail({ from, to: to.join(', '), subject, text });
    return true;
  } catch (err) {
    console.error('[notify] メール通知の送信に失敗しました:', (err && err.message) || err);
    return false;
  }
}

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
 * @param {string} params.title - 1行目（メールでは件名）に出す見出し
 * @param {string} [params.message] - 詳細
 * @param {string} [params.path] - ツール内のパス（例: "/tasks/12"）。TOOL_BASE_URLと連結してリンクにする
 * @param {typeof fetch} [params.fetchFn] - テスト用
 * @param {{sendMail: Function}} [params.mailTransport] - テスト用
 * @returns {Promise<boolean>} いずれかの通知先へ送れたらtrue
 */
async function notify({ event, title, message, path, fetchFn = fetch, mailTransport }) {
  const webhookUrl = process.env.NOTIFY_WEBHOOK_URL;
  const mailTo = mailRecipients();
  const mailFrom = process.env.NOTIFY_MAIL_FROM;
  const useMail = mailTo.length > 0 && Boolean(mailFrom);
  if ((!webhookUrl && !useMail) || !enabledEvents().has(event)) return false;

  const lines = [`[NanonaBot Tool] ${title}`];
  if (message) lines.push(message);
  if (path) lines.push(`${config.server.baseUrl}${path}`);
  let text = lines.join('\n');
  if (text.length > MAX_MESSAGE_LENGTH) text = `${text.slice(0, MAX_MESSAGE_LENGTH)}…`;

  const sends = [];
  if (webhookUrl) sends.push(sendWebhook(webhookUrl, text, fetchFn));
  if (useMail) {
    sends.push(
      sendMail({
        from: mailFrom,
        to: mailTo,
        subject: `[NanonaBot Tool] ${title}`,
        text,
        transport: mailTransport || getMailTransport(),
      })
    );
  }
  const results = await Promise.all(sends);
  return results.some(Boolean);
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
async function notifyTaskStatus(task, status, { detail, fetchFn, mailTransport } = {}) {
  const notice = TASK_STATUS_NOTICES[status];
  if (!notice) return false; // running/queued/cancelled 等は通知しない
  return notify({
    event: status,
    title: `タスク #${task.id} が${notice}`,
    message: [`アカウント: ${task.account}`, detail].filter(Boolean).join('\n'),
    path: `/tasks/${task.id}`,
    fetchFn,
    mailTransport,
  });
}

module.exports = { notify, notifyTaskStatus, ALL_EVENTS };

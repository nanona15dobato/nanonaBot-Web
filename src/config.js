'use strict';

require('dotenv').config();

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(
      `環境変数 ${name} が設定されていません。.env（ローカル開発）または ` +
      `\`toolforge envvars create ${name}\`（Toolforge本番）で設定してください。`
    );
  }
  return v;
}

const port = Number(process.env.PORT || 8000);
const baseUrl = process.env.TOOL_BASE_URL || `http://localhost:${port}`;

const config = {
  server: { port, baseUrl },

  // OAuth・セッション秘密鍵はWebサーバーでしか使わないため、参照時に検証する
  // （ワーカーやテストがこれらの環境変数なしでも config を読み込めるようにするため）。
  // Webサーバーは起動時に assertWebEnv() を呼んで早期に失敗させる。
  oauth: {
    get clientId() {
      return requireEnv('OAUTH_CLIENT_ID');
    },
    get clientSecret() {
      return requireEnv('OAUTH_CLIENT_SECRET');
    },
    callbackUrl: process.env.OAUTH_CALLBACK_URL || `${baseUrl}/oauth/callback`,
    wikiHost: process.env.OAUTH_WIKI_HOST || 'meta.wikimedia.org',
  },

  permissions: {
    ownerUsername: process.env.OWNER_USERNAME || 'Nanona15dobato',
    ownerUsernames: (process.env.OWNER_USERNAMES || `${process.env.OWNER_USERNAME || 'Nanona15dobato'},なのな`)
      .split(',')
      .map((username) => username.trim())
      .filter(Boolean),
    emergencyStopUsernames: (process.env.EMERGENCY_STOP_USERNAMES || 'nanona15')
      .split(',')
      .map((username) => username.trim())
      .filter(Boolean),
    adminCheckWikiHost: process.env.ADMIN_CHECK_WIKI_HOST || 'ja.wikipedia.org',
  },

  wiki: {
    // Bot編集の対象となるウィキ本体のAPIエンドポイント（フェーズ2以降のワーカーで使用）
    apiUrl: process.env.WIKI_API_URL || 'https://ja.wikipedia.org/w/api.php',
    // 編集ログ画面（フェーズ6）でrevidから差分ページへのリンクを組み立てるのに使う
    host: new URL(process.env.WIKI_API_URL || 'https://ja.wikipedia.org/w/api.php').host,
  },

  session: {
    get secret() {
      return requireEnv('SESSION_SECRET');
    },
  },

  db: {
    toolsdbSuffix: process.env.TOOLSDB_DATABASE_SUFFIX || 'nanona_bot',
    // ローカル開発用フォールバック（Toolforge本番ではreplica.my.cnfが優先される。src/db.js参照）
    localHost: process.env.DB_HOST || null,
    localPort: Number(process.env.DB_PORT || 3306),
    localUser: process.env.DB_USER || null,
    localPassword: process.env.DB_PASSWORD || null,
    localDatabase: process.env.DB_NAME || null,
  },

  // Bot作業依頼の「着手・完了・解決」（フェーズ13）。作業記録・依頼への返信は運用者のアカウントで編集する
  botreq: {
    account: process.env.BOTREQ_ACCOUNT || 'Nanona15dobato', // 編集に使うアカウント（src/bot/accountNames.js の名前）
    botUser: process.env.BOTREQ_BOT_USER || 'nanonaBot', // 作業の編集回数・投稿記録を数える Bot
    operator: process.env.BOTREQ_OPERATOR || 'nanona15dobato', // 作業記録の {{../head|運用者=}}
    logPrefix: process.env.BOTREQ_LOG_PREFIX || '利用者:nanonaBot/依頼/', // 作業記録のページ名（後ろに「YYYY年」）
    // 作業記録の編集に使うアカウント。未設定なら作業記録のページがある利用者空間の持ち主（利用者:nanonaBot/… なら NanonaBot）。
    // jawiki では他人の利用者ページの編集に editalluserpages が要り、BotPassword ではこの権限を付けられないため、持ち主のアカウントで編集する
    logAccount: process.env.BOTREQ_LOG_ACCOUNT || null,
  },

  taskPagesRetentionDays:Number(process.env.TASK_PAGES_RETENTION_DAYS || 14),

  userAgent:
    process.env.WIKI_USER_AGENT ||
    'NanonaBotTool/0.1 (Toolforge; https://ja.wikipedia.org/wiki/User:Nanona15dobato)',
};

/** Webサーバー起動時に必須の環境変数がそろっているか検証する（未設定なら例外）。 */
function assertWebEnv() {
  requireEnv('OAUTH_CLIENT_ID');
  requireEnv('OAUTH_CLIENT_SECRET');
  requireEnv('SESSION_SECRET');
}

Object.defineProperty(config, 'assertWebEnv', { value: assertWebEnv, enumerable: false });

module.exports = config;

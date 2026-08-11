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

  oauth: {
    clientId: requireEnv('OAUTH_CLIENT_ID'),
    clientSecret: requireEnv('OAUTH_CLIENT_SECRET'),
    callbackUrl: process.env.OAUTH_CALLBACK_URL || `${baseUrl}/oauth/callback`,
    wikiHost: process.env.OAUTH_WIKI_HOST || 'meta.wikimedia.org',
  },

  permissions: {
    ownerUsername: process.env.OWNER_USERNAME || 'Nanona15dobato',
    adminCheckWikiHost: process.env.ADMIN_CHECK_WIKI_HOST || 'ja.wikipedia.org',
  },

  session: {
    secret: requireEnv('SESSION_SECRET'),
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

  taskPagesRetentionDays: Number(process.env.TASK_PAGES_RETENTION_DAYS || 14),

  userAgent:
    process.env.WIKI_USER_AGENT ||
    'NanonaBotTool/0.1 (Toolforge; https://ja.wikipedia.org/wiki/User:Nanona15dobato)',
};

module.exports = config;

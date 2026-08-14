'use strict';


/**
 * Botアカウント名 → 認証情報を格納した環境変数名。
 * ここは「どのアカウント名が有効か」という静的な定義のみを持ち、
 * config.js（dotenv読み込み）やmwClient.jsには依存しない。
 * taskConfig.js（純粋なバリデータ）から安全にimportできるようにするため分離している。
 */
const ACCOUNT_ENV_MAP = {
  Nanona15dobato: { user: 'BOT_NANONA15DOBATO_USER', pass: 'BOT_NANONA15DOBATO_PASS' },
  NanonaBot: { user: 'BOT_NANONABOT_USER', pass: 'BOT_NANONABOT_PASS' },
  NanonaBot3: { user: 'BOT_NANONABOT3_USER', pass: 'BOT_NANONABOT3_PASS' },
};

/** @param {string} accountName */
function isKnownAccount(accountName) {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_ENV_MAP, accountName);
}

module.exports = { ACCOUNT_ENV_MAP, isKnownAccount };

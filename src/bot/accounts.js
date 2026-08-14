'use strict';

const { MediaWikiBotClient } = require('./mwClient');
const config = require('../config');
const { ACCOUNT_ENV_MAP, isKnownAccount } = require('./accountNames');

/** @type {Map<string, MediaWikiBotClient>} プロセス内でアカウントごとに1つだけログインセッションを使い回す */
const clientCache = new Map();

/**
 * 指定アカウントでログイン済みのMediaWikiBotClientを返す（無ければ新規ログインしてキャッシュ）。
 * @param {string} accountName - "Nanona15dobato" | "NanonaBot" | "NanonaBot3"
 * @returns {Promise<MediaWikiBotClient>}
 */
async function getClient(accountName) {
  if (!isKnownAccount(accountName)) {
    throw new Error(`未知のBotアカウントです: ${accountName}`);
  }
  const cached = clientCache.get(accountName);
  if (cached) return cached;

  const envNames = ACCOUNT_ENV_MAP[accountName];
  const username = process.env[envNames.user];
  const password = process.env[envNames.pass];
  if (!username || !password) {
    throw new Error(
      `アカウント ${accountName} の認証情報が未設定です（環境変数 ${envNames.user} / ${envNames.pass}）`
    );
  }

  const client = new MediaWikiBotClient({
    apiUrl: config.wiki.apiUrl,
    username,
    password,
    userAgent: config.userAgent,
  });
  await client.login();
  clientCache.set(accountName, client);
  return client;
}

/** テスト・緊急停止解除後の再ログイン等で使う、キャッシュ破棄用。 */
function clearCache(accountName) {
  if (accountName) clientCache.delete(accountName);
  else clientCache.clear();
}

module.exports = { getClient, isKnownAccount, clearCache, ACCOUNT_ENV_MAP };

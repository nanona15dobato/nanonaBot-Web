'use strict';

const config = require('../config');

/**
 * 指定ユーザーの所属グループ一覧をMediaWiki APIから取得する。
 * 認証不要（公開情報）。config.permissions.adminCheckWikiHost に対して問い合わせる。
 *
 * @param {string} username
 * @returns {Promise<string[]>}
 */
async function getUserGroups(username) {
  const url = new URL(`https://${config.permissions.adminCheckWikiHost}/w/api.php`);
  url.search = new URLSearchParams({
    action: 'query',
    list: 'users',
    ususers: username,
    usprop: 'groups',
    format: 'json',
    formatversion: '2',
  }).toString();

  const res = await fetch(url, {
    headers: { 'User-Agent': config.userAgent },
  });
  if (!res.ok) {
    throw new Error(`MediaWiki APIエラー (${res.status}): ユーザー情報を取得できませんでした`);
  }
  const data = await res.json();
  const user = data && data.query && data.query.users && data.query.users[0];
  if (!user || user.missing) return [];
  return user.groups || [];
}

/**
 * 指定ユーザーがsysop（管理者）グループに所属しているか。
 * @param {string} username
 * @returns {Promise<boolean>}
 */
async function isSysop(username) {
  const groups = await getUserGroups(username);
  return groups.includes('sysop');
}

module.exports = { getUserGroups, isSysop };

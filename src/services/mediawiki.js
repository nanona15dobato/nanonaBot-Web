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

/**
 * 既存リビジョン(fromrev)と、まだ保存していない任意のテキスト(toText)とのDiff HTMLを取得する。
 * MCR(Multi-Content Revisions)対応のため、totext単独ではなく toslots=main + totext-main を使う
 * （2018年のaction=compare仕様変更に対応した現行の正しい書き方）。
 * 認証不要（公開情報の読み取りのみ）。
 *
 * @param {object} params
 * @param {number} params.fromRevId
 * @param {string} params.toText
 * @returns {Promise<string>} 差分HTML（MediaWikiの通常の差分テーブルと同じマークアップ）
 */
async function compareRevisions({ fromRevId, toText }) {
  const body = new URLSearchParams({
    action: 'compare',
    fromrev: String(fromRevId),
    toslots: 'main',
    'totext-main': toText,
    prop: 'diff',
    format: 'json',
    formatversion: '2',
  });

  const res = await fetch(config.wiki.apiUrl, {
    method: 'POST', // totextが長くなり得るためGETではなくPOSTで送る（MediaWiki APIはPOSTも受け付ける）
    headers: {
      'User-Agent': config.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`MediaWiki APIエラー (${res.status}): Diffを取得できませんでした`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`MediaWiki APIエラー [${data.error.code}]: ${data.error.info}`);
  }
  return (data.compare && data.compare.body) || '';
}

module.exports = { getUserGroups, isSysop, compareRevisions };

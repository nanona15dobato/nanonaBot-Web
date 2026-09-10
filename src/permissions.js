'use strict';

/**
 * ログインユーザーの役割を判定する（仕様書2章）。
 * 副作用なしの純粋関数にしてあるので、ネットワーク/DBアクセスなしでテストできる。
 *
 * @param {object} params
 * @param {string} params.username - OAuthで取得したユーザー名
 * @param {string} [params.ownerUsername] - 後方互換用のオーナー名
 * @param {string[]} [params.ownerUsernames] - フル操作権限を持つユーザー名一覧
 * @param {string[]} [params.emergencyStopUsernames] - 緊急停止だけ許可するユーザー名一覧
 * @param {string[]} params.groups - ユーザーの所属グループ一覧（MediaWiki API由来）
 * @returns {'owner'|'admin_emergency_only'|'denied'}
 */
function determineRole({ username, ownerUsername, ownerUsernames, emergencyStopUsernames, groups }) {
  if (!username) return 'denied';
  const normalizedUsername = normalizeUsername(username);
  const owners = Array.isArray(ownerUsernames) ? ownerUsernames : [ownerUsername];
  if (owners.some((owner) => normalizeUsername(owner) === normalizedUsername)) return 'owner';
  if (
    (Array.isArray(emergencyStopUsernames) &&
      emergencyStopUsernames.some((user) => normalizeUsername(user) === normalizedUsername)) ||
    (Array.isArray(groups) && (groups.includes('sysop') || groups.includes('extendedconfirmed')))
  ) {
    return 'admin_emergency_only';
  }
  return 'denied';
}

/**
 * MediaWikiのユーザー名正規化（先頭ASCII文字の大文字化）に合わせる。
 * 日本語などASCII以外の文字は変更しない。
 * @param {string} username
 */
function normalizeUsername(username) {
  const value = String(username || '').trim();
  return value && /^[a-z]/i.test(value) ? value[0].toUpperCase() + value.slice(1) : value;
}

/**
 * 指定した役割が、指定した許可役割一覧のいずれかに含まれるか。
 * @param {string|undefined|null} role
 * @param {string[]} allowedRoles
 */
function roleAllowed(role, allowedRoles) {
  return typeof role === 'string' && allowedRoles.includes(role);
}

module.exports = { determineRole, roleAllowed, normalizeUsername };

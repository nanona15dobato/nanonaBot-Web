'use strict';

/**
 * ログインユーザーの役割を判定する（仕様書2章）。
 * 副作用なしの純粋関数にしてあるので、ネットワーク/DBアクセスなしでテストできる。
 *
 * @param {object} params
 * @param {string} params.username - OAuthで取得したユーザー名
 * @param {string} params.ownerUsername - フル操作権限を持つユーザー名（通常 "Nanona15dobato"）
 * @param {string[]} params.groups - ユーザーの所属グループ一覧（MediaWiki API由来）
 * @returns {'owner'|'admin_emergency_only'|'denied'}
 */
function determineRole({ username, ownerUsername, groups }) {
  if (!username) return 'denied';
  if (username === ownerUsername) return 'owner';
  if (Array.isArray(groups) && groups.includes('sysop')) return 'admin_emergency_only';
  return 'denied';
}

/**
 * 指定した役割が、指定した許可役割一覧のいずれかに含まれるか。
 * @param {string|undefined|null} role
 * @param {string[]} allowedRoles
 */
function roleAllowed(role, allowedRoles) {
  return typeof role === 'string' && allowedRoles.includes(role);
}

module.exports = { determineRole, roleAllowed };

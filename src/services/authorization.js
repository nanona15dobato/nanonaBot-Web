'use strict';

const config = require('../config');
const mediawiki = require('./mediawiki');
const { determineRole, normalizeUsername } = require('../permissions');

// ログイン時と既存セッションの再確認で同じ権限規則を使用する。
// 明示的な許可は外部APIに依存させず、Wikiグループ由来の権限はキャッシュしない。
async function resolveRole(username) {
  if (typeof username !== 'string' || !normalizeUsername(username)) return 'denied';
  const permissions = config.permissions;
  const explicitRole = determineRole({ username, ...permissions, groups: [] });
  if (explicitRole !== 'denied') return explicitRole;
  return determineRole({
    username,
    ...permissions,
    groups: await mediawiki.getUserGroups(username),
  });
}

module.exports = { resolveRole };

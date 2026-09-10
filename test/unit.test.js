'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { determineRole, roleAllowed, normalizeUsername } = require('../src/permissions');
const { parseReplicaCnf } = require('../src/db/replicaCnf');
const { detectInvokedModule } = require('../scripts/check-redirect-category-template');

test('determineRole: ownerUsernameと一致すればowner', () => {
  const role = determineRole({ username: 'Nanona15dobato', ownerUsername: 'Nanona15dobato', groups: [] });
  assert.equal(role, 'owner');
});

test('determineRole: ownerUsernamesに含まれる追加オーナーはowner', () => {
  const role = determineRole({
    username: 'なのな',
    ownerUsernames: ['Nanona15dobato', 'なのな'],
    groups: [],
  });
  assert.equal(role, 'owner');
});

test('determineRole: owner以外でsysopグループを含めばadmin_emergency_only', () => {
  const role = determineRole({
    username: 'SomeAdmin',
    ownerUsername: 'Nanona15dobato',
    groups: ['*', 'user', 'autoconfirmed', 'sysop'],
  });
  assert.equal(role, 'admin_emergency_only');
});

test('determineRole: extendedconfirmedグループは緊急停止専用', () => {
  const role = determineRole({
    username: 'ExtendedUser',
    ownerUsername: 'Nanona15dobato',
    groups: ['user', 'extendedconfirmed'],
  });
  assert.equal(role, 'admin_emergency_only');
});

test('determineRole: nanona15は緊急停止専用', () => {
  const role = determineRole({
    username: 'nanona15',
    ownerUsernames: ['Nanona15dobato', 'なのな'],
    emergencyStopUsernames: ['nanona15'],
    groups: ['user'],
  });
  assert.equal(role, 'admin_emergency_only');
});

test('determineRole: 緊急停止ユーザー名は先頭ASCII文字の大小を正規化する', () => {
  const role = determineRole({
    username: 'Nanona15',
    ownerUsernames: ['Nanona15dobato', 'なのな'],
    emergencyStopUsernames: ['nanona15'],
    groups: [],
  });
  assert.equal(role, 'admin_emergency_only');
});

test('normalizeUsername: ASCII先頭文字のみ大文字化する', () => {
  assert.equal(normalizeUsername('nanona15'), 'Nanona15');
  assert.equal(normalizeUsername('なのな'), 'なのな');
});

test('determineRole: owner以外・sysopでもなければdenied', () => {
  const role = determineRole({
    username: 'RandomUser',
    ownerUsername: 'Nanona15dobato',
    groups: ['*', 'user', 'autoconfirmed'],
  });
  assert.equal(role, 'denied');
});

test('determineRole: usernameが空ならdenied', () => {
  const role = determineRole({ username: '', ownerUsername: 'Nanona15dobato', groups: ['sysop'] });
  assert.equal(role, 'denied');
});

test('determineRole: groupsが未定義でも例外にならずdenied扱い', () => {
  const role = determineRole({ username: 'X', ownerUsername: 'Nanona15dobato', groups: undefined });
  assert.equal(role, 'denied');
});

test('roleAllowed: 許可リストに含まれていればtrue', () => {
  assert.equal(roleAllowed('owner', ['owner', 'admin_emergency_only']), true);
  assert.equal(roleAllowed('admin_emergency_only', ['owner', 'admin_emergency_only']), true);
});

test('roleAllowed: 許可リストに含まれていなければfalse', () => {
  assert.equal(roleAllowed('denied', ['owner', 'admin_emergency_only']), false);
  assert.equal(roleAllowed(undefined, ['owner']), false);
  assert.equal(roleAllowed(null, ['owner']), false);
});

test('parseReplicaCnf: 典型的なreplica.my.cnf形式をパースできる', () => {
  const content = `[client]\nuser = 's51234'\npassword = 'abcDEF123!@#'\n`;
  const result = parseReplicaCnf(content);
  assert.equal(result.user, 's51234');
  assert.equal(result.password, 'abcDEF123!@#');
});

test('parseReplicaCnf: 引用符なし・空行・コメント混じりでも壊れない', () => {
  const content = `# comment\n[client]\n\nuser=s51234\npassword=plainpass\n`;
  const result = parseReplicaCnf(content);
  assert.equal(result.user, 's51234');
  assert.equal(result.password, 'plainpass');
});

test('parseReplicaCnf: セクション行やキーのない行は無視する', () => {
  const content = `[client]\n= noKey\nuser = 'abc'\n`;
  const result = parseReplicaCnf(content);
  assert.equal(result.user, 'abc');
  assert.equal(Object.keys(result).length, 1);
});

test('detectInvokedModule: #invoke:を検出できる', () => {
  const wikitext = '{{#invoke:リダイレクトの所属カテゴリ|main}}';
  assert.equal(detectInvokedModule(wikitext), 'Module:リダイレクトの所属カテゴリ');
});

test('detectInvokedModule: 空白や大文字小文字ゆれも許容する', () => {
  const wikitext = '{{ #INVOKE : Foo Bar | main | arg1=x }}';
  assert.equal(detectInvokedModule(wikitext), 'Module:Foo Bar');
});

test('detectInvokedModule: #invoke:が無ければnull', () => {
  const wikitext = '[[Category:テスト]] 通常のwikitext';
  assert.equal(detectInvokedModule(wikitext), null);
});

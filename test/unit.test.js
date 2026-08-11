'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { determineRole, roleAllowed } = require('../src/permissions');
const { parseReplicaCnf } = require('../src/db/replicaCnf');
const { detectInvokedModule } = require('../scripts/check-redirect-category-template');

test('determineRole: ownerUsernameと一致すればowner', () => {
  const role = determineRole({ username: 'Nanona15dobato', ownerUsername: 'Nanona15dobato', groups: [] });
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

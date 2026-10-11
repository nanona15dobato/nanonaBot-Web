'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// routes/tasks.js は ../db に依存するため、純粋関数だけを試すのに軽量スタブへ差し替える
const DB_PATH = require.resolve('../src/db');
const fakeModule = new Module(DB_PATH, null);
fakeModule.filename = DB_PATH;
fakeModule.loaded = true;
fakeModule.exports = { pool: { query: async () => [[]] } };
require.cache[DB_PATH] = fakeModule;

const { buildRevertTargets, csvCell, toCsv } = require('../src/routes/tasks');

test('buildRevertTargets: ページごとに、最初の編集の前の版へ戻し、最後の編集の版を取り消し条件にする', () => {
  const targets = buildRevertTargets([
    { id: 1, page_title: 'Template:橋', namespace: 10, revid: 110, base_revid: 100 },
    { id: 2, page_title: '記事A', namespace: 0, revid: 210, base_revid: 200 },
    { id: 3, page_title: 'Template:橋', namespace: 10, revid: 130, base_revid: 120 }, // ウェーブ2で同じページを再編集
    { id: 4, page_title: '版なし', namespace: 0, revid: null, base_revid: 1 },
  ]);
  assert.deepEqual(targets, [
    { title: 'Template:橋', namespace: 10, revid: 130, baseRevid: 100 },
    { title: '記事A', namespace: 0, revid: 210, baseRevid: 200 },
  ]);
});

test('csvCell/toCsv: カンマ・改行・引用符を囲み、数式として解釈されうる値に印を付け、BOMつきで出力する', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('改行\nあり'), '"改行\nあり"');
  assert.equal(csvCell('"引用"'), '"""引用"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell(null), '');
  const csv = toCsv([{ edited_at: new Date('2026-10-01T00:00:00Z'), status: 'edited', task_id: 5, page_title: '記事', revid: 9 }]);
  assert.ok(csv.startsWith('\ufeff日時,結果,タスク,'));
  assert.match(csv, /2026-10-01T00:00:00.000Z,成功,5,,記事,/);
  assert.match(csv, /diff=9&oldid=prev/);
});

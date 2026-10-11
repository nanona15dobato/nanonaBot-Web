'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { undoEdit, undoEdits } = require('../src/worker/undoMerge');

test('undoEdit: 他の人の編集を残したまま、取り消す編集の変更だけを元に戻す', () => {
  const before = '冒頭\n[[Category:旧]]\n本文\n末尾';
  const after = '冒頭\n[[Category:新]]\n本文\n末尾'; // Botの編集
  const current = '冒頭\n[[Category:新]]\n本文\n末尾（他の人が追記）'; // その後の他の人の編集（離れた行）
  assert.deepEqual(undoEdit({ current, after, before }), { ok: true, text: '冒頭\n[[Category:旧]]\n本文\n末尾（他の人が追記）' });
});

test('undoEdit: 同じ行が他の編集でも変わっていれば統合できない', () => {
  const result = undoEdit({ current: 'a\n[[Category:他人の変更]]\nc', after: 'a\n[[Category:新]]\nc', before: 'a\n[[Category:旧]]\nc' });
  assert.deepEqual(result, { ok: false });
});

test('undoEdit: 隣り合った行がそれぞれ変わっている場合も、安全のため統合しない', () => {
  const result = undoEdit({ current: 'a\n[[Category:新]]\nc（他人）', after: 'a\n[[Category:新]]\nc', before: 'a\n[[Category:旧]]\nc' });
  assert.deepEqual(result, { ok: false });
});

test('undoEdits: 同じタスクの複数の編集を新しい順に取り除き、間の他の人の編集は残す', () => {
  const v100 = 'A\n-\nC\n-\nD';
  const v110 = 'A2\n-\nC\n-\nD'; // タスクの1回目の編集（A→A2）
  const v120 = 'A2\n-\nC（他人）\n-\nD'; // 間に他の人の編集
  const v130 = 'A2\n-\nC（他人）\n-\nD2'; // タスクの2回目の編集（D→D2）
  const result = undoEdits(v130, [
    { after: v130, before: v120 },
    { after: v110, before: v100 },
  ]);
  assert.deepEqual(result, { ok: true, text: 'A\n-\nC（他人）\n-\nD' });
});

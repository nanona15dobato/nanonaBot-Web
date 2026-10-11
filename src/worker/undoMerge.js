'use strict';

const { diff3Merge } = require('node-diff3');

/**
 * MediaWikiの「取り消し（undo）」と同じ考え方で、ある編集の変更だけを現在の本文から取り除く（フェーズ12）。
 *
 * 行単位の3者マージ（diff3）を使う:
 *   共通の祖先 = 取り消す編集の直後の本文（after）
 *   こちら側   = 現在の本文（current。後から入った他の人の編集を含む）
 *   あちら側   = 取り消す編集の直前の本文（before）
 * 他の人の編集とBotの編集が別の行なら、他の人の編集を残したままBotの変更だけを元に戻せる。
 * 同じ行がどちらでも変わっているときは統合できない（衝突）。
 *
 * @param {object} params
 * @param {string} params.current
 * @param {string} params.after
 * @param {string} params.before
 * @returns {{ok: true, text: string} | {ok: false}}
 */
function undoEdit({ current, after, before }) {
  const regions = diff3Merge(current.split('\n'), after.split('\n'), before.split('\n'), { excludeFalseConflicts: true });
  const lines = [];
  for (const region of regions) {
    if (region.conflict) return { ok: false };
    lines.push(...region.ok);
  }
  return { ok: true, text: lines.join('\n') };
}

/**
 * 複数の編集を新しい順に1つずつ取り除く（同じタスクが同じページを複数回編集していた場合）。
 * @param {string} current
 * @param {Array<{after: string, before: string}>} editsNewestFirst
 * @returns {{ok: true, text: string} | {ok: false, failedIndex: number}}
 */
function undoEdits(current, editsNewestFirst) {
  let text = current;
  for (let i = 0; i < editsNewestFirst.length; i++) {
    const result = undoEdit({ current: text, ...editsNewestFirst[i] });
    if (!result.ok) return { ok: false, failedIndex: i };
    text = result.text;
  }
  return { ok: true, text };
}

module.exports = { undoEdit, undoEdits };

'use strict';

const WikitextParser = require('../../lib/WikitextParser');

/**
 * リンク解除（unlinkPage。BOTREQのDELETE_PAGE）で、ハットノートテンプレート内の参照も取り除く（フェーズ9）。
 *
 * 対象は「ページ名を位置引数で並べるだけ」の一覧型ハットノートに限る:
 *   {{See also|A|B}} / {{Seealso|A}} / {{See|A}} / {{Main|A|B}} / {{混同|A|B}}
 * 該当する位置引数だけを除き、位置引数が1つも残らなければテンプレート呼び出しごと除く。
 * {{Otheruses|説明|ページ}} や {{For|説明|ページ}} のように引数ごとに役割が違うもの、
 * および名前付き引数（l1= 等の表示名指定）を含む呼び出しは、引数の対応がずれて表示を壊す
 * おそれがあるため変更しない。
 */
const LIST_HATNOTE_TEMPLATES = ['Template:See also', 'Template:Seealso', 'Template:See', 'Template:Main', 'Template:混同'];

/** ページ名の比較用に正規化する（前後空白・先頭コロン・アンダースコア・先頭1文字の大小）。 */
function normalizeTitle(title) {
  const t = String(title).replace(/_/g, ' ').replace(/\s+/g, ' ').trim().replace(/^:/, '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** 引数値が指すページ（節指定 "#..." は除く）が page と同じか。 */
function refersTo(value, page) {
  const title = String(value).split('#')[0];
  return title.trim() !== '' && normalizeTitle(title) === normalizeTitle(page);
}

/**
 * @param {string} wikitext
 * @param {string} page - 解除対象のページ名
 * @returns {{wikitext: string, changed: boolean, count: number}}
 */
function removePageFromHatnotes(wikitext, page) {
  const parser = new WikitextParser();
  const calls = parser.parse(wikitext, { templates: LIST_HATNOTE_TEMPLATES }).templates.filter((t) =>
    LIST_HATNOTE_TEMPLATES.includes(t.name)
  );

  const edits = [];
  for (const call of calls) {
    const args = call.argsOrdered.map((arg) => ({
      ...arg,
      positional: !wikitext.slice(arg.position.start, arg.position.end).includes('='),
    }));
    if (args.some((arg) => !arg.positional)) continue; // 名前付き引数を含む呼び出しは変更しない

    const positional = args.filter((arg) => arg.value.trim() !== '');
    const matching = positional.filter((arg) => refersTo(arg.value, page));
    if (matching.length === 0) continue;

    if (matching.length === positional.length) {
      edits.push(wholeCallRemoval(wikitext, call.position));
    } else {
      // 引数本体の直前の "|" も含めて除く
      for (const arg of matching) edits.push({ start: arg.position.start - 1, end: arg.position.end, pipe: true });
    }
  }
  if (edits.length === 0) return { wikitext, changed: false, count: 0 };

  edits.sort((a, b) => b.start - a.start);
  let result = wikitext;
  let count = 0;
  for (const edit of edits) {
    if (edit.pipe && result[edit.start] !== '|') continue; // 想定外の構造。安全のためスキップ
    result = result.slice(0, edit.start) + result.slice(edit.end);
    count++;
  }
  return { wikitext: result, changed: count > 0, count };
}

/** テンプレート呼び出しを除く範囲。その行に呼び出ししか無ければ行ごと（改行も含めて）除く。 */
function wholeCallRemoval(wikitext, position) {
  const lineStart = wikitext.lastIndexOf('\n', position.start - 1) + 1;
  const newlineAt = wikitext.indexOf('\n', position.end);
  const lineEnd = newlineAt === -1 ? wikitext.length : newlineAt;
  const before = wikitext.slice(lineStart, position.start);
  const after = wikitext.slice(position.end, lineEnd);
  if (before.trim() === '' && after.trim() === '') {
    return { start: lineStart, end: newlineAt === -1 ? lineEnd : lineEnd + 1 };
  }
  return { start: position.start, end: position.end };
}

module.exports = { LIST_HATNOTE_TEMPLATES, removePageFromHatnotes };

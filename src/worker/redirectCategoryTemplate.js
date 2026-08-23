'use strict';

const WikitextParser = require('../../lib/WikitextParser');

/**
 * Template:リダイレクトの所属カテゴリ の実際の引数書式（Toolforge上で
 * scripts/check-redirect-category-template.js を実行し、テンプレート本文と
 * 実使用例4件から確認済み。仕様書8章）:
 *
 *   {{リダイレクトの所属カテゴリ
 *   |header = 見出し（任意）
 *   |collapse = 値があれば折りたたむ（任意、空文字でも可）
 *   |redirect1 = リダイレクト元ページ名（{{{redirect}}}が旧フォールバック）
 *   |1-1 = カテゴリ名（Category:プレフィックス不要）
 *   |1-2 = カテゴリ名
 *   |redirect2 = 2件目のリダイレクト元
 *   |2-1 = カテゴリ名
 *   ...
 *   }}
 *
 * redirectは最大10件（redirect1〜redirect10）、各リダイレクトにつき
 * カテゴリは最大20件（N-1〜N-20）。1件目のリダイレクトを省略した「まとめて表示」用途では
 * 素の位置引数（1,2,3...20）がN-1〜N-20の代わりに使われる。
 * Luaモジュールではない素のwikitextテンプレートであり、番号は名前付き引数のため、
 * 1つ除去しても残りの表示は壊れない（1-2を消しても1-1・1-3はそのまま表示される）。
 */

const TEMPLATE_TITLE = 'Template:リダイレクトの所属カテゴリ';

/** "N-M"形式（N:1-10, M:1-20）、または1件目省略時の素の番号引数（1-20）か判定する。 */
function isCategoryValueKey(key) {
  if (/^([1-9]|10)-([1-9]|1[0-9]|20)$/.test(key)) return true;
  if (/^\d+$/.test(key)) {
    const n = Number(key);
    return n >= 1 && n <= 20;
  }
  return false;
}

/**
 * wikitext中の {{リダイレクトの所属カテゴリ}} 呼び出しをすべて検出する。
 * @param {string} wikitext
 * @returns {Array} WikitextParserのtemplates要素（argsOrdered含む）
 */
function findCalls(wikitext) {
  const parser = new WikitextParser();
  const parsed = parser.parse(wikitext, { templates: [TEMPLATE_TITLE] });
  return parsed.templates.filter((t) => t.name === TEMPLATE_TITLE);
}

/**
 * 1つの呼び出し内で、指定カテゴリ名（Category:プレフィックスなし）を値に持つ
 * カテゴリ引数を探す。
 * @param {object} call - findCalls()の要素
 * @param {string} categoryName
 * @returns {Array<{key:string, value:string, position:{start:number,end:number}}>}
 */
function findMatchingCategoryArgs(call, categoryName) {
  const target = String(categoryName).trim();
  return call.argsOrdered.filter((a) => isCategoryValueKey(a.key) && a.value.trim() === target);
}

/**
 * wikitext中の {{リダイレクトの所属カテゴリ}} 内のカテゴリ名を改名する（Category置換Step4）。
 * 該当が無ければ changed:false でwikitextはそのまま返す。
 * @param {string} wikitext
 * @param {string} fromCategory
 * @param {string} toCategory
 * @returns {{wikitext: string, changed: boolean, count: number}}
 */
function renameCategoryInTemplate(wikitext, fromCategory, toCategory) {
  const toValue = String(toCategory).trim();
  const edits = [];
  for (const call of findCalls(wikitext)) {
    for (const arg of findMatchingCategoryArgs(call, fromCategory)) {
      edits.push({ position: arg.position, oldValue: arg.value.trim() });
    }
  }
  if (edits.length === 0) return { wikitext, changed: false, count: 0 };

  // 後ろの引数から処理することで、書き換えによる位置ズレの影響を避ける
  edits.sort((a, b) => b.position.start - a.position.start);
  let result = wikitext;
  for (const edit of edits) {
    const segment = result.slice(edit.position.start, edit.position.end);
    const idx = segment.indexOf(edit.oldValue);
    if (idx === -1) continue; // 想定外の構造。安全のためスキップする
    const newSegment = segment.slice(0, idx) + toValue + segment.slice(idx + edit.oldValue.length);
    result = result.slice(0, edit.position.start) + newSegment + result.slice(edit.position.end);
  }
  return { wikitext: result, changed: true, count: edits.length };
}

/**
 * wikitext中の {{リダイレクトの所属カテゴリ}} 内のカテゴリ引数を除去する（Category除去Step2）。
 * 名前付き引数（N-M形式）は番号が飛んでも表示が壊れないことをテンプレート本文で確認済みのため、
 * 番号の振り直しは行わない（不要かつリスクを増やすだけのため）。
 * @param {string} wikitext
 * @param {string} category
 * @returns {{wikitext: string, changed: boolean, count: number}}
 */
function removeCategoryFromTemplate(wikitext, category) {
  const positions = [];
  for (const call of findCalls(wikitext)) {
    for (const arg of findMatchingCategoryArgs(call, category)) {
      positions.push(arg.position);
    }
  }
  if (positions.length === 0) return { wikitext, changed: false, count: 0 };

  positions.sort((a, b) => b.start - a.start);
  let result = wikitext;
  let count = 0;
  for (const position of positions) {
    const pipeIndex = position.start - 1;
    if (result[pipeIndex] !== '|') continue; // 想定外の構造（直前が"|"でない）。安全のためスキップ
    result = result.slice(0, pipeIndex) + result.slice(position.end);
    count++;
  }
  return { wikitext: result, changed: count > 0, count };
}

/**
 * 指定カテゴリを標準名前空間のbacklinks候補から探し、実際に構造的に一致する
 * （＝安全に自動編集できる）ページ一覧を返す。taskRunner.jsの対象ページ列挙で使う。
 * @param {object} params
 * @param {string} params.category - Category:プレフィックスを除いた素の名前
 * @param {import('../bot/mwClient').MediaWikiBotClient} params.mwClient
 * @returns {Promise<Array<{title:string, namespace:number}>>}
 */
async function findCandidatePages({ category, mwClient }) {
  // eslint-disable-next-line global-require
  const { resolveBacklinks } = require('./targetResolvers');
  const candidates = await resolveBacklinks({ page: `Category:${category}`, namespaces: [0] });
  const matched = [];
  for (const c of candidates) {
    const page = await mwClient.getPage(c.title);
    if (!page || !page.exists || !page.wikitext) continue;
    const hasMatch = findCalls(page.wikitext).some((call) => findMatchingCategoryArgs(call, category).length > 0);
    if (hasMatch) matched.push({ title: c.title, namespace: c.namespace ?? 0 });
  }
  return matched;
}

module.exports = {
  TEMPLATE_TITLE,
  isCategoryValueKey,
  findCalls,
  findMatchingCategoryArgs,
  renameCategoryInTemplate,
  removeCategoryFromTemplate,
  findCandidatePages,
};

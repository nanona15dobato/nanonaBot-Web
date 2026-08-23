'use strict';

const { resolveBacklinks } = require('./targetResolvers');
const { findCalls, findMatchingCategoryArgs } = require('./redirectCategoryTemplate');

const WARNING_MARKER = 'リダイレクトの所属カテゴリ';
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 240;

/**
 * wikitext中の WARNING_MARKER 周辺を抜き出す（Diff確認画面でのプレビュー用）。
 */
function extractSnippet(wikitext, markerIndex) {
  const start = Math.max(0, markerIndex - SNIPPET_BEFORE);
  const end = Math.min(wikitext.length, markerIndex + SNIPPET_AFTER);
  return (start > 0 ? '…' : '') + wikitext.slice(start, end) + (end < wikitext.length ? '…' : '');
}

/**
 * Category:from への標準名前空間backlinksを取得し、`{{リダイレクトの所属カテゴリ...}}`と
 * 旧カテゴリ名(from)の共起があるのに構造的には一致しないページ（＝自動編集できない・
 * 想定外の記法の可能性がある）だけを警告として返す。
 *
 * Template:リダイレクトの所属カテゴリ の正確な引数書式は確認済み（仕様書8章）で、
 * 構造的に一致するページは redirectCategoryTemplate.js が自動編集する
 * （taskRunner.jsのresolveRuleTargetsForStageで対象ページに含まれ、
 * pipeline.jsのprepareOnePageで実際に書き換えられる）ため、ここでは重複して
 * 警告を出さない。緩い文字列一致はできるが構造的に確認できないケースだけが対象になる
 * （例: 想定外のテンプレート変種、コメントアウトされた記載等）。
 *
 * @param {object} params
 * @param {string} params.from - Category:プレフィックスを除いた素のカテゴリ名
 * @param {import('../bot/mwClient').MediaWikiBotClient} params.mwClient - ページ本文取得に使う
 * @returns {Promise<Array<{pageTitle:string, namespace:number, snippet:string}>>}
 */
async function collectCategoryWarnings({ from, mwClient }) {
  const candidates = await resolveBacklinks({ page: `Category:${from}`, namespaces: [0] });
  const warnings = [];

  for (const candidate of candidates) {
    const page = await mwClient.getPage(candidate.title);
    if (!page || !page.exists || !page.wikitext) continue;

    const markerIndex = page.wikitext.indexOf(WARNING_MARKER);
    if (markerIndex === -1) continue;
    if (!page.wikitext.includes(from)) continue;

    const hasPreciseMatch = findCalls(page.wikitext).some((call) => findMatchingCategoryArgs(call, from).length > 0);
    if (hasPreciseMatch) continue; // 自動編集の対象になるため警告不要

    warnings.push({
      pageTitle: candidate.title,
      namespace: candidate.namespace ?? 0,
      snippet: extractSnippet(page.wikitext, markerIndex),
    });
  }

  return warnings;
}

module.exports = { collectCategoryWarnings, extractSnippet, WARNING_MARKER };

'use strict';

const { resolveBacklinks } = require('./targetResolvers');

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
 * Category:from への標準名前空間backlinksを取得し、各ページに
 * `{{リダイレクトの所属カテゴリ...}}` と旧カテゴリ名(from)の両方が含まれるものを警告として返す。
 * 8章の方針により検出のみ・自動編集は行わない。正確な引数書式が未確認のため、
 * 判定は「テンプレート名らしき文字列」＋「対象カテゴリ名」の共起という緩い基準にとどめている。
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

    warnings.push({
      pageTitle: candidate.title,
      namespace: candidate.namespace ?? 0,
      snippet: extractSnippet(page.wikitext, markerIndex),
    });
  }

  return warnings;
}

module.exports = { collectCategoryWarnings, extractSnippet, WARNING_MARKER };

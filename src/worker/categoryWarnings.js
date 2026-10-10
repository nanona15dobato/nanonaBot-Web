'use strict';

const { scanCategoryBacklinks, extractSnippet, WARNING_MARKER } = require('./redirectCategoryTemplate');

/**
 * Category:from への標準名前空間backlinksのうち、`{{リダイレクトの所属カテゴリ...}}`と
 * 旧カテゴリ名(from)の共起があるのに構造的には一致しないページ（＝自動編集できない・
 * 想定外の記法の可能性がある）だけを警告として返す。
 *
 * Template:リダイレクトの所属カテゴリ の正確な引数書式は確認済み（仕様書8章）で、
 * 構造的に一致するページは redirectCategoryTemplate.js が自動編集する
 * （taskRunner.jsのウェーブ3で対象ページに含まれ、pipeline.jsのprepareOnePageで実際に
 * 書き換えられる）ため、ここでは重複して警告を出さない。緩い文字列一致はできるが
 * 構造的に確認できないケースだけが対象になる（例: 想定外のテンプレート変種、コメントアウトされた記載等）。
 * 本文の取得はウェーブ3の対象確認と共有する（scanCategoryBacklinks。フェーズ9）。
 *
 * @param {object} params
 * @param {string} params.from - Category:プレフィックスを除いた素のカテゴリ名
 * @param {import('../bot/mwClient').MediaWikiBotClient} params.mwClient - ページ本文取得に使う
 * @param {Map<string, Promise>} [params.cache] - タスク実行中の走査結果キャッシュ
 * @returns {Promise<Array<{pageTitle:string, namespace:number, snippet:string}>>}
 */
async function collectCategoryWarnings({ from, mwClient, cache }) {
  return (await scanCategoryBacklinks({ category: from, mwClient, cache })).warnings;
}

module.exports = { collectCategoryWarnings, extractSnippet, WARNING_MARKER };

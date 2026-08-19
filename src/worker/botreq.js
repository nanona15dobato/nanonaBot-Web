'use strict';

const config = require('../config');
const WikitextParser = require('../../lib/WikitextParser');

const BOTREQ_PAGE_TITLE = 'Wikipedia:Bot作業依頼';
const TEMPLATE_TITLE = 'Template:リンク修正依頼/改名';

/**
 * 指定ページ（既定: Wikipedia:Bot作業依頼）のwikitextを取得する。認証不要。
 * @param {string} [pageTitle]
 */
async function fetchBotreqWikitext(pageTitle = BOTREQ_PAGE_TITLE) {
  const url = new URL(config.wiki.apiUrl);
  url.search = new URLSearchParams({
    action: 'query',
    prop: 'revisions',
    titles: pageTitle,
    rvslots: 'main',
    rvprop: 'content|ids|timestamp',
    format: 'json',
    formatversion: '2',
  }).toString();

  const res = await fetch(url, { headers: { 'User-Agent': config.userAgent } });
  if (!res.ok) {
    throw new Error(`MediaWiki APIエラー (${res.status})`);
  }
  const data = await res.json();
  const page = data.query && data.query.pages && data.query.pages[0];
  if (!page || page.missing) {
    throw new Error(`${pageTitle} が見つかりませんでした`);
  }
  const rev = page.revisions && page.revisions[0];
  if (!rev) {
    throw new Error(`${pageTitle} のリビジョンを取得できませんでした`);
  }
  return { wikitext: rev.slots.main.content, revid: rev.revid, timestamp: rev.timestamp };
}

/**
 * value が指定名前空間プレフィックスのいずれかで始まっていれば、プレフィックスを除いた
 * 残りの文字列を返す。どれにも一致しなければnull。
 * @param {string} value
 * @param {string[]} prefixes - 例: ['Category', 'category', 'カテゴリ']
 */
function stripNamespacePrefix(value, prefixes) {
  for (const p of prefixes) {
    const withColon = `${p}:`;
    if (value.startsWith(withColon)) return value.slice(withColon.length).trim();
  }
  return null;
}

const CATEGORY_PREFIXES = ['Category', 'category', 'カテゴリ'];
const TEMPLATE_PREFIXES = ['Template', 'template', 'テンプレート'];

/**
 * {{リンク修正依頼/改名}}の1ペア（from, to）を分類する（仕様書7.2節）。
 * フェーズ1（このフェーズ5実装）では単純な改名のみを自動処理対象とし、
 * DELETE_PAGE/REDIRECT_TARGET/subst:/URL/アンカー・パイプラベル付きペアは
 * 「未対応（要手動設定）」として検出のみ行う。
 *
 * @param {string} rawFrom
 * @param {string} rawTo
 * @returns {{type: string, from?: string, to?: string, rawFrom: string, rawTo: string, reason?: string}}
 */
function classifyPair(rawFrom, rawTo) {
  const from = String(rawFrom).trim();
  const to = String(rawTo).trim();

  if (to === 'DELETE_PAGE') {
    // リンク解除（フェーズ6対応: unlinkPageとして処理）
    return { type: 'unlinkPage', from, rawFrom: from, rawTo: to };
  }
  if (to === 'REDIRECT_TARGET') {
    // リダイレクト解決先は時間とともに変わりうり、操作者から見えにくいため、
    // 安全のためフェーズ6でも自動処理対象に含めない（要手動設定のまま）。
    return { type: 'unsupported', reason: 'REDIRECT_TARGET', rawFrom: from, rawTo: to };
  }
  if (to === 'subst:') {
    // "Template:X |subst:" の形式のみサブスト化として処理する（フェーズ6対応）。
    // Template:プレフィックスが無いfromに対するsubst:指定は想定外のため未対応のままにする。
    const tmplFromForSubst = stripNamespacePrefix(from, TEMPLATE_PREFIXES);
    if (tmplFromForSubst !== null) {
      return { type: 'templateSubst', from: tmplFromForSubst, rawFrom: from, rawTo: to };
    }
    return { type: 'unsupported', reason: 'subst', rawFrom: from, rawTo: to };
  }
  if (/^https?:\/\//i.test(from) || /^https?:\/\//i.test(to)) {
    return { type: 'unsupported', reason: 'URL', rawFrom: from, rawTo: to };
  }
  // アンカー(#)・{{!}}によるパイプラベル指定は、ページ単位の単純な改名を超える
  // 精密な指定のため、フェーズ1では自動処理対象に含めず「要手動確認」とする。
  if (from.includes('#') || to.includes('#') || from.includes('{{!}}') || to.includes('{{!}}')) {
    return { type: 'unsupported', reason: 'anchor_or_label', rawFrom: from, rawTo: to };
  }

  const catFrom = stripNamespacePrefix(from, CATEGORY_PREFIXES);
  const catTo = stripNamespacePrefix(to, CATEGORY_PREFIXES);
  if (catFrom !== null && catTo !== null) {
    return { type: 'categoryRename', from: catFrom, to: catTo, rawFrom: from, rawTo: to };
  }

  const tmplFrom = stripNamespacePrefix(from, TEMPLATE_PREFIXES);
  const tmplTo = stripNamespacePrefix(to, TEMPLATE_PREFIXES);
  if (tmplFrom !== null && tmplTo !== null) {
    return { type: 'templateRename', from: tmplFrom, to: tmplTo, rawFrom: from, rawTo: to };
  }

  // 片方だけCategory:/Template:の場合は名前空間が噛み合わない不整合ペアとして扱う
  if ((catFrom !== null) !== (catTo !== null)) {
    return { type: 'unsupported', reason: 'namespace_mismatch', rawFrom: from, rawTo: to };
  }
  if ((tmplFrom !== null) !== (tmplTo !== null)) {
    return { type: 'unsupported', reason: 'namespace_mismatch', rawFrom: from, rawTo: to };
  }

  // 通常のリンク改名: リンク置換／リンク置換2の自動判定（仕様書7.3節）
  // 改名元に曖昧さ回避の全角括弧が無く、改名先にはある場合はリンク置換2（表示保持）を選ぶ。
  const fromHasParen = from.includes('（');
  const toHasParen = to.includes('（');
  const type = !fromHasParen && toHasParen ? 'linkRename2' : 'linkRename';
  return { type, from, to, rawFrom: from, rawTo: to };
}

/**
 * wikitext中の {{リンク修正依頼/改名}} 呼び出しをすべて検出し、パースする。
 * WikitextParserのargsOrdered（出現順配列）を使うことで、キー名に依存せず
 * 「提案」以外の無名引数を順番どおりペアとして取り出せる。
 *
 * @param {string} wikitext
 * @returns {Array<{index:number, proposal:string|null, original:string, pairs:Array}>}
 */
function parseBotreqTemplates(wikitext) {
  const parser = new WikitextParser();
  const parsed = parser.parse(wikitext, { templates: [TEMPLATE_TITLE] });
  const calls = parsed.templates.filter((t) => t.name === TEMPLATE_TITLE);

  return calls.map((call, idx) => {
    const proposalArg = call.argsOrdered.find((a) => a.key === '提案');
    const positional = call.argsOrdered
      .filter((a) => /^\d+$/.test(a.key))
      .sort((a, b) => Number(a.key) - Number(b.key));

    const pairs = [];
    for (let i = 0; i + 1 < positional.length; i += 2) {
      pairs.push(classifyPair(positional[i].value, positional[i + 1].value));
    }

    return {
      index: idx,
      proposal: proposalArg ? proposalArg.value.trim() : null,
      original: call.original,
      pairs,
    };
  });
}

module.exports = {
  BOTREQ_PAGE_TITLE,
  TEMPLATE_TITLE,
  fetchBotreqWikitext,
  stripNamespacePrefix,
  classifyPair,
  parseBotreqTemplates,
};

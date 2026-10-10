'use strict';

const config = require('../config');
const WikitextParser = require('../../lib/WikitextParser');

const BOTREQ_PAGE_TITLE = 'Wikipedia:Bot作業依頼';
const BOTREQ_TOPIC_LIST_TITLE = 'Wikipedia:Bot作業依頼/topic list';
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
/**
 * 「ページ名#節{{!}}表示名」形式の指定を分解する（各要素は省略可）。
 * @param {string} spec
 * @returns {{title: string, anchor: string|null, label: string|null}}
 */
function splitLinkSpec(spec) {
  const [titleAndAnchor, ...labelParts] = String(spec).split('{{!}}');
  const label = labelParts.length > 0 ? labelParts.join('{{!}}').trim() || null : null;
  const hashAt = titleAndAnchor.indexOf('#');
  if (hashAt === -1) return { title: titleAndAnchor.trim(), anchor: null, label };
  return {
    title: titleAndAnchor.slice(0, hashAt).trim(),
    anchor: titleAndAnchor.slice(hashAt + 1).trim() || null,
    label,
  };
}

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
  // アンカー(#)・{{!}}によるパイプラベル指定（フェーズ9）:
  // 「改名元#節1{{!}}ラベル |改名先#節2{{!}}ラベル」は [[改名元#節1|ラベル]] を
  // [[改名先#節2|ラベル]] に直す指定（Template:リンク修正依頼/改名/doc の書式例）。
  // 通常記事どうしのリンクに限り linkRenameExact として扱い、Category/Template・
  // 改名元/改名先のページ名が空のもの（同一ページ内の節リンク等）は要手動確認のまま残す。
  if (from.includes('#') || to.includes('#') || from.includes('{{!}}') || to.includes('{{!}}')) {
    const fromSpec = splitLinkSpec(from);
    const toSpec = splitLinkSpec(to);
    const hasNamespacePrefix = [fromSpec.title, toSpec.title].some(
      (title) => stripNamespacePrefix(title, CATEGORY_PREFIXES) !== null || stripNamespacePrefix(title, TEMPLATE_PREFIXES) !== null
    );
    const hasBrokenLabel = [fromSpec.label, toSpec.label].some((label) => label !== null && /\[\[|\]\]|\|/.test(label));
    if (!fromSpec.title || !toSpec.title || hasNamespacePrefix || hasBrokenLabel) {
      return { type: 'unsupported', reason: 'anchor_or_label', rawFrom: from, rawTo: to };
    }
    return {
      type: 'linkRenameExact',
      from: fromSpec.title,
      to: toSpec.title,
      fromAnchor: fromSpec.anchor,
      toAnchor: toSpec.anchor,
      fromLabel: fromSpec.label,
      toLabel: toSpec.label,
      rawFrom: from,
      rawTo: to,
    };
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

const REDIRECT_QUERY_BATCH = 50; // action=query の titles に一度に渡せる上限（非Bot権限での既定）

/**
 * REDIRECT_TARGET 指定のペアについて、取得時点のリダイレクト解決先を問い合わせ、
 * 通常のペア（linkRename/linkRename2/templateRename等）に置き換える（フェーズ8）。
 *
 * 解決先は時間とともに変わりうるため、自動で追従はしない。BOTREQ取得の時点で解決先を
 * 確定させ、`redirectResolved` として画面に「改名元 → 解決先」を明示したうえで、
 * 操作者が取り込むかどうかを判断する（取り込んだ時点の解決先がルールの to に固定される）。
 * 次の場合は引き続き未対応（要手動設定）のまま残す:
 * - 改名元がリダイレクトではない／存在しない（REDIRECT_TARGET_NOT_REDIRECT）
 * - 解決先が節（#アンカー）付き、または解決先が改名元と同じ名前空間種別に収まらない等で
 *   classifyPair が未対応と判定したもの
 *
 * @param {Array} proposals - parseBotreqTemplates() の戻り値（破壊的に更新する）
 * @param {(params: object) => Promise<object>} [apiGetFn] - テスト用に差し替え可能なAPI呼び出し
 * @returns {Promise<Array>} 同じ proposals
 */
async function resolveRedirectTargets(proposals, apiGetFn) {
  // eslint-disable-next-line global-require
  const apiGet = apiGetFn || require('./targetResolvers').apiGet;
  const pending = [];
  for (const proposal of proposals) {
    proposal.pairs.forEach((pair, index) => {
      if (pair.type === 'unsupported' && pair.reason === 'REDIRECT_TARGET') pending.push({ proposal, index, pair });
    });
  }
  if (pending.length === 0) return proposals;

  const titles = [...new Set(pending.map(({ pair }) => pair.rawFrom))];
  /** @type {Map<string, {to: string, fragment: string|null}>} */
  const resolved = new Map();
  for (let i = 0; i < titles.length; i += REDIRECT_QUERY_BATCH) {
    const batch = titles.slice(i, i + REDIRECT_QUERY_BATCH);
    const data = await apiGet({ action: 'query', titles: batch.join('|'), redirects: '1' });
    const query = data.query || {};
    // 入力名 → 正規化名 → リダイレクト元 の順に辿る
    const normalized = new Map((query.normalized || []).map((n) => [n.from, n.to]));
    const redirects = new Map((query.redirects || []).map((r) => [r.from, r]));
    for (const title of batch) {
      const redirect = redirects.get(normalized.get(title) || title);
      if (redirect) resolved.set(title, { to: redirect.to, fragment: redirect.tofragment || null });
    }
  }

  for (const { proposal, index, pair } of pending) {
    const target = resolved.get(pair.rawFrom);
    if (!target) {
      proposal.pairs[index] = { ...pair, reason: 'REDIRECT_TARGET_NOT_REDIRECT' };
      continue;
    }
    const resolvedTo = target.fragment ? `${target.to}#${target.fragment}` : target.to;
    const classified = classifyPair(pair.rawFrom, resolvedTo);
    proposal.pairs[index] = { ...classified, rawTo: pair.rawTo, redirectResolved: true, resolvedTo };
  }
  return proposals;
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

/**
 * topic listの自動生成テーブルから、依頼アンカーと進捗欄を取り出す。
 * topic listは通常のwikitextテーブルなので、依頼セル内のリンク構文を保持したまま読む。
 */
function parseBotreqTopicList(wikitext) {
  const entries = [];
  for (const block of String(wikitext || '').split(/\n\|-/)) {
    const lines = block.split(/\r?\n/);
    const cells = lines.filter((line) => /^\|[^|]/.test(line)).map((line) => line.slice(1).trim());
    if (cells.length < 3) continue;
    const link = cells[1].match(/\[\[([^|\]]+)#([^|\]]+)(?:\|([^\]]+))?\]\]/);
    if (!link) continue;
    const progressTemplate = cells[2].match(/\{\{([^{}]+)\}\}/);
    entries.push({
      anchor: link[2].trim(),
      title: (link[3] || link[2]).trim(),
      progress: progressTemplate ? progressTemplate[1].trim() : cells[2].replace(/<[^>]+>/g, '').trim(),
    });
  }
  return entries;
}

module.exports = {
  BOTREQ_PAGE_TITLE,
  BOTREQ_TOPIC_LIST_TITLE,
  TEMPLATE_TITLE,
  fetchBotreqWikitext,
  stripNamespacePrefix,
  splitLinkSpec,
  classifyPair,
  parseBotreqTemplates,
  parseBotreqTopicList,
  resolveRedirectTargets,
};

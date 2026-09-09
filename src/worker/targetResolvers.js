'use strict';

const config = require('../config');

const MAX_RESULTS = 5000; // 暴走防止の上限（仕様書14章「regexSearchの件数上限」に対応する暫定値）
const PAGE_LIMIT = 500;

/** namespaces配列をMediaWiki APIのパイプ区切り文字列にする。null/未指定なら全名前空間（パラメータ省略）。 */
function namespaceParam(namespaces) {
  if (!namespaces || namespaces.length === 0) return undefined;
  return namespaces.join('|');
}

async function apiGet(params) {
  const url = new URL(config.wiki.apiUrl);
  // URLSearchParamsはundefinedを文字列"undefined"として送ってしまうため、
  // 全名前空間を表す未指定値はクエリから完全に除外する。
  const definedParams = Object.fromEntries(
    Object.entries({ format: 'json', formatversion: '2', ...params }).filter(([, value]) => value !== undefined && value !== null)
  );
  url.search = new URLSearchParams(definedParams).toString();
  const res = await fetch(url, { headers: { 'User-Agent': config.userAgent } });
  if (!res.ok) {
    throw new Error(`MediaWiki APIエラー (${res.status})`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`MediaWiki APIエラー [${data.error.code}]: ${data.error.info}`);
  }
  return data;
}

/**
 * list=XXX形式のAPIを継続パラメータを追いながら呼び出し、{title, namespace}の配列を返す共通処理。
 * @param {object} params
 * @param {object} baseParams - action=query以下の固定パラメータ（list, cmtitle等）
 * @param {string} listKey - data.query[listKey] の配列を読む
 * @param {string} continueKey - data.continue[continueKey] を次回リクエストに使う
 */
async function fetchList(baseParams, listKey, continueKey) {
  const results = [];
  let contValue;
  do {
    const params = { action: 'query', ...baseParams };
    if (contValue) params[continueKey] = contValue;
    const data = await apiGet(params);
    const items = (data.query && data.query[listKey]) || [];
    for (const item of items) {
      results.push({ title: item.title, namespace: item.ns });
    }
    contValue = data.continue ? data.continue[continueKey] : null;
  } while (contValue && results.length < MAX_RESULTS);
  return results;
}

/**
 * カテゴリメンバー一覧を取得する（仕様書6.3・6.4節: Category置換/除去の主対象）。
 * @param {object} params
 * @param {string} params.category - "Category:" プレフィックスの有無どちらでも可
 * @param {number[]|null} [params.namespaces] - nullなら全名前空間
 */
async function resolveCategoryMembers({ category, namespaces }) {
  const title = category.startsWith('Category:') || category.startsWith('category:') ? category : `Category:${category}`;
  return fetchList(
    {
      list: 'categorymembers',
      cmtitle: title,
      cmlimit: String(PAGE_LIMIT),
      cmnamespace: namespaceParam(namespaces),
    },
    'categorymembers',
    'cmcontinue'
  );
}

/**
 * 指定ページへのbacklinks一覧を取得する（仕様書6.1・6.2節、6.3節のwarningSourceでも使用）。
 * @param {object} params
 * @param {string} params.page
 * @param {number[]|null} [params.namespaces]
 */
async function resolveBacklinks({ page, namespaces }) {
  return fetchList(
    {
      list: 'backlinks',
      bltitle: page,
      bllimit: String(PAGE_LIMIT),
      blnamespace: namespaceParam(namespaces),
    },
    'backlinks',
    'blcontinue'
  );
}

/**
 * 指定テンプレートを使用しているページ一覧を取得する（仕様書6.5節: テンプレート置換）。
 * @param {object} params
 * @param {string} params.template - "Template:" プレフィックスの有無どちらでも可
 * @param {number[]|null} [params.namespaces] - 既定[0]は呼び出し側で設定する
 */
async function resolveEmbeddedIn({ template, namespaces }) {
  const title = template.startsWith('Template:') || template.startsWith('template:') ? template : `Template:${template}`;
  return fetchList(
    {
      list: 'embeddedin',
      eititle: title,
      eilimit: String(PAGE_LIMIT),
      einamespace: namespaceParam(namespaces),
    },
    'embeddedin',
    'eicontinue'
  );
}

/**
 * CirrusSearchのinsource:正規表現検索で対象ページを取得する。
 * 仕様書4章の方針どおり、APIエラー（結果過多・タイムアウト等）は例外にせず
 * { results: [], error: message } を返して呼び出し側が処理を継続できるようにする。
 * @param {object} params
 * @param {string} params.query - 例: "insource:/旧テンプレ/"
 * @param {number[]|null} [params.namespaces]
 * @returns {Promise<{results: Array<{title:string, namespace:number}>, error: string|null}>}
 */
async function resolveRegexSearch({ query, namespaces }) {
  try {
    const results = await fetchList(
      {
        list: 'search',
        srsearch: query,
        srlimit: String(Math.min(PAGE_LIMIT, 500)),
        srnamespace: namespaceParam(namespaces),
        srwhat: 'text',
        srprop: '',
      },
      'search',
      'sroffset'
    );
    return { results, error: null };
  } catch (err) {
    return { results: [], error: String((err && err.message) || err) };
  }
}

/**
 * config内のtargetSource記述にもとづき対象ページを解決する共通エントリポイント。
 * manualListはネットワークアクセス不要のためここでは扱わず、呼び出し側（taskRunner）で直接処理する。
 * @param {object} targetSource
 * @returns {Promise<{results: Array<{title:string, namespace:number}>, error: string|null}>}
 */
async function resolveTargetSource(targetSource) {
  switch (targetSource.type) {
    case 'category':
      return { results: await resolveCategoryMembers(targetSource), error: null };
    case 'backlinks':
      return { results: await resolveBacklinks({ page: targetSource.page, namespaces: targetSource.namespaces }), error: null };
    case 'embeddedin':
      return {
        results: await resolveEmbeddedIn({ template: targetSource.page, namespaces: targetSource.namespaces }),
        error: null,
      };
    case 'regexSearch':
      return resolveRegexSearch({ query: targetSource.query, namespaces: targetSource.namespaces });
    default:
      throw new Error(`resolveTargetSource: manualList以外の未知のtype "${targetSource.type}"`);
  }
}

module.exports = {
  namespaceParam,
  resolveCategoryMembers,
  resolveBacklinks,
  resolveEmbeddedIn,
  resolveRegexSearch,
  resolveTargetSource,
};

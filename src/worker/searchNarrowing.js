'use strict';

/**
 * リンク置換の対象（リンク元）を、全文検索（CirrusSearch）で本文に旧リンクの記述があるページだけに絞る（任意。rule.searchNarrowing）。
 *
 * リンク元（list=backlinks）には、テンプレート経由などで本文に [[旧]] が書かれていないページも含まれ、
 * それらは取得しても変更不要（スキップ）になる。検索
 *   linksto:"旧" insource:/(\[\[:?|\|) *旧 *[\]|#}]/
 * の結果とリンク元の共通部分だけを対象にすれば、スキップを減らせる。
 *
 * ただし検索には取りこぼしの危険がある（正規表現検索の時間切れ・1万件の上限・索引の更新の遅れ）ため、
 * 時間切れ・上限超え・エラーのときは絞り込まずにリンク元のすべてを対象に戻す。
 * 名前空間付きのページ名（別名で書かれたリンクを正規表現で拾いきれない）や、リンク元が少ないときも絞り込まない。
 */

const SEARCH_LIMIT = 10000; // list=search で取得できる件数の上限（sroffset の上限）
const PAGE_SIZE = 500;
const MIN_CANDIDATES = 50; // これより少なければ絞り込まない（効果が小さく、取りこぼしの危険だけが残るため）

/** Lucene の正規表現（insource:/…/）で、1文字をその文字そのものとして扱う形にする。 */
function luceneChar(c) {
  if (c === ' ' || c === '_') return '[ _]';
  if (/[\p{L}\p{N}]/u.test(c)) return c;
  return '\\' + c; // 記号はすべてエスケープ（Lucene では # @ < > & ~ なども特殊文字）
}

/**
 * 旧リンクの記述に一致する Lucene 正規表現（スラッシュは含まない）。
 * [[旧]]・[[旧|…]]・[[旧#…]]・[[ 旧 ]]・{{テンプレート|旧}}（ハットノート・仮リンク等）を拾う。
 * 先頭の文字は大文字・小文字の両方、空白と下線は同一視する。
 */
function linkRegex(title) {
  const chars = [...String(title).trim()];
  if (!chars.length) return null;
  const [first, ...rest] = chars;
  const upper = first.toUpperCase();
  const lower = first.toLowerCase();
  const head = upper !== lower ? `[${luceneChar(upper)}${luceneChar(lower)}]` : luceneChar(first);
  return `(\\[\\[:?|\\|) *${head}${rest.map(luceneChar).join('')} *[\\]\\|\\#\\}]`;
}

function searchQuery(title) {
  const regex = linkRegex(title);
  if (!regex) return null;
  // 区切りのスラッシュは luceneChar が記号として既にエスケープしている
  return `linksto:"${String(title).trim().replace(/"/g, '\\"')}" insource:/${regex}/`;
}

/** 検索の応答に「正規表現検索が時間切れ」の警告があるか。 */
function timedOut(data) {
  const w = data && data.warnings && data.warnings.search;
  const text = typeof w === 'string' ? w : w && (w.warnings || w['*'] || '');
  return /timed out|時間切れ|タイムアウト/i.test(String(text || ''));
}

/**
 * @param {object} params
 * @param {string} params.from - 旧リンク（改名元）
 * @param {number[]|null} params.namespaces - 対象の名前空間（null は全名前空間）
 * @param {Array<{title: string, namespace: number}>} params.candidates - リンク元
 * @param {(params: object) => Promise<object>} [params.apiGet] - テスト用に差し替え可能な API 呼び出し
 * @returns {Promise<{results: Array, note: string}>}
 */
async function narrowBySearch({ from, namespaces, candidates, apiGet }) {
  // eslint-disable-next-line global-require
  apiGet = apiGet || require('./targetResolvers').apiGet;
  const keep = (reason) => ({ results: candidates, note: `検索での絞り込みはしていません（${reason}）。リンク元のすべて（${candidates.length}件）を対象にします` });

  if (candidates.length < MIN_CANDIDATES) return keep(`リンク元が${candidates.length}件と少ないため`);

  // 名前空間付きのページ名は、別名（WP: など）で書かれたリンクを正規表現で拾いきれないため絞り込まない
  try {
    const info = await apiGet({ action: 'query', titles: from });
    const page = info.query && info.query.pages && info.query.pages[0];
    if (!page || page.ns !== 0) return keep('標準名前空間以外のページ名のため');
  } catch (err) {
    return keep(`ページ名を確認できないため: ${err.message}`);
  }

  const query = searchQuery(from);
  if (!query) return keep('改名元が空のため');

  const found = new Set();
  let offset = 0;
  try {
    for (;;) {
      const data = await apiGet({
        action: 'query',
        list: 'search',
        srsearch: query,
        srnamespace: namespaces && namespaces.length ? namespaces.join('|') : '*',
        srlimit: String(PAGE_SIZE),
        sroffset: offset ? String(offset) : undefined,
        srinfo: 'totalhits',
        srprop: '',
        srwhat: 'text',
      });
      if (timedOut(data)) return keep('正規表現の検索が時間切れになり、結果が一部しか得られなかったため');
      const total = data.query && data.query.searchinfo ? data.query.searchinfo.totalhits : 0;
      if (total > SEARCH_LIMIT) return keep(`検索結果が${total}件と、取得できる上限（${SEARCH_LIMIT}件）を超えるため`);
      for (const item of (data.query && data.query.search) || []) found.add(item.title);
      const next = data.continue && data.continue.sroffset;
      if (!next) break;
      offset = Number(next);
    }
  } catch (err) {
    return keep(`検索に失敗したため: ${err.message}`);
  }

  const results = candidates.filter((c) => found.has(c.title));
  if (candidates.truncated) results.truncated = true;
  return {
    results,
    note: `検索で絞り込みました: リンク元${candidates.length}件のうち、本文に旧リンクの記述がある${results.length}件を対象にします（${candidates.length - results.length}件を除外。検索の索引に未反映の最近の編集は拾えないことがあります）`,
  };
}

module.exports = { narrowBySearch, linkRegex, searchQuery, timedOut, MIN_CANDIDATES, SEARCH_LIMIT };

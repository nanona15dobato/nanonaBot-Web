'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { narrowBySearch, linkRegex, searchQuery, timedOut, MIN_CANDIDATES } = require('../src/worker/searchNarrowing');

const candidates = (n) => Array.from({ length: n }, (_, i) => ({ title: `記事${i}`, namespace: 0 }));

/** list=search の応答を返す偽の API。pages の各要素が1回分の応答。 */
function fakeApi({ ns = 0, pages = [], error = null }) {
  const calls = [];
  const apiGet = async (params) => {
    calls.push(params);
    if (params.titles) return { query: { pages: [{ title: params.titles, ns }] } };
    if (error) throw new Error(error);
    const page = pages[Math.floor((Number(params.sroffset) || 0) / 500)] || { titles: [] };
    return {
      query: { searchinfo: { totalhits: page.total ?? 0 }, search: page.titles.map((title) => ({ title })) },
      ...(page.next ? { continue: { sroffset: page.next } } : {}),
      ...(page.warnings ? { warnings: page.warnings } : {}),
    };
  };
  return { apiGet, calls };
}

test('linkRegex / searchQuery: [[旧…]] と {{テンプレート|旧}} を拾い、先頭の大小・空白と下線を同一視し、記号はエスケープする', () => {
  assert.equal(linkRegex('東京都庁'), String.raw`(\[\[:?|\|) *東京都庁 *[\]\|\#\}]`);
  assert.equal(linkRegex('Microsoft Windows'), String.raw`(\[\[:?|\|) *[Mm]icrosoft[ _]Windows *[\]\|\#\}]`);
  assert.equal(linkRegex('C++'), String.raw`(\[\[:?|\|) *[Cc]\+\+ *[\]\|\#\}]`);
  // 検索式の区切りのスラッシュ・linksto の引用符はエスケープする
  assert.equal(searchQuery('A/B'), String.raw`linksto:"A/B" insource:/(\[\[:?|\|) *[Aa]\/B *[\]\|\#\}]/`);
  assert.equal(searchQuery('X "Y"').split(' insource:')[0], String.raw`linksto:"X \"Y\""`);
});

test('narrowBySearch: リンク元と検索結果の共通部分だけにする', async () => {
  const { apiGet } = fakeApi({ pages: [{ total: 3, titles: ['記事1', '記事3', 'リンク元に無い記事'] }] });
  const r = await narrowBySearch({ from: '旧', namespaces: [0], candidates: candidates(60), apiGet });
  assert.deepEqual(r.results.map((c) => c.title), ['記事1', '記事3']);
  assert.match(r.note, /60件のうち.*2件を対象.*58件を除外/);
});

test('narrowBySearch: 検索結果が複数ページにわたるときは続きも取得する', async () => {
  const { apiGet, calls } = fakeApi({
    pages: [
      { total: 600, titles: ['記事1'], next: 500 },
      { total: 600, titles: ['記事2'] },
    ],
  });
  const r = await narrowBySearch({ from: '旧', namespaces: null, candidates: candidates(60), apiGet });
  assert.deepEqual(r.results.map((c) => c.title), ['記事1', '記事2']);
  assert.equal(calls.filter((c) => c.list === 'search').length, 2);
  assert.equal(calls.find((c) => c.list === 'search').srnamespace, '*');
});

test('narrowBySearch: 時間切れ・上限超え・エラー・標準名前空間以外・リンク元が少ないときは絞り込まない', async () => {
  const all = candidates(60);
  const cases = [
    [fakeApi({ pages: [{ total: 10, titles: ['記事1'], warnings: { search: { warnings: 'The regex search timed out, so only partial results are available.' } } }] }), /時間切れ/],
    [fakeApi({ pages: [{ total: 12000, titles: ['記事1'] }] }), /上限/],
    [fakeApi({ error: 'boom' }), /検索に失敗/],
    [fakeApi({ ns: 4, pages: [{ total: 1, titles: ['記事1'] }] }), /標準名前空間以外/],
  ];
  for (const [{ apiGet }, reason] of cases) {
    const r = await narrowBySearch({ from: '旧', namespaces: [0], candidates: all, apiGet });
    assert.equal(r.results, all);
    assert.match(r.note, reason);
  }
  const few = candidates(MIN_CANDIDATES - 1);
  const r = await narrowBySearch({ from: '旧', namespaces: [0], candidates: few, apiGet: fakeApi({}).apiGet });
  assert.equal(r.results, few);
  assert.match(r.note, /少ない/);
});

test('timedOut: 検索の警告から時間切れを見分ける', () => {
  assert.equal(timedOut({ warnings: { search: { warnings: 'The regex search timed out' } } }), true);
  assert.equal(timedOut({ warnings: { search: 'The regex search timed out' } }), true);
  assert.equal(timedOut({}), false);
});

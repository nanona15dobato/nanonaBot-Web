'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  namespaceParam,
  resolveCategoryMembers,
  resolveBacklinks,
  resolveEmbeddedIn,
  resolveRegexSearch,
} = require('../src/worker/targetResolvers');

test('namespaceParam: null/未指定はundefined（全名前空間）、配列はパイプ区切り', () => {
  assert.equal(namespaceParam(null), undefined);
  assert.equal(namespaceParam(undefined), undefined);
  assert.equal(namespaceParam([]), undefined);
  assert.equal(namespaceParam([0]), '0');
  assert.equal(namespaceParam([0, 10]), '0|10');
});

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('resolveCategoryMembers: cmcontinueを追って全件取得する', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    const u = new URL(String(url));
    assert.equal(u.searchParams.get('list'), 'categorymembers');
    assert.equal(u.searchParams.get('cmtitle'), 'Category:テスト');
    if (!u.searchParams.get('cmcontinue')) {
      return jsonResponse({
        query: { categorymembers: [{ title: 'ページA', ns: 0 }] },
        continue: { cmcontinue: 'CONT1' },
      });
    }
    assert.equal(u.searchParams.get('cmcontinue'), 'CONT1');
    return jsonResponse({ query: { categorymembers: [{ title: 'ページB', ns: 0 }] } });
  };
  try {
    const results = await resolveCategoryMembers({ category: 'テスト', namespaces: null });
    assert.deepEqual(results, [
      { title: 'ページA', namespace: 0 },
      { title: 'ページB', namespace: 0 },
    ]);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveCategoryMembers: namespacesを指定するとcmnamespaceがパイプ区切りで送られる', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    assert.equal(u.searchParams.get('cmnamespace'), '0|10');
    return jsonResponse({ query: { categorymembers: [] } });
  };
  try {
    await resolveCategoryMembers({ category: 'Category:テスト', namespaces: [0, 10] });
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveBacklinks: blcontinueに対応する', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    assert.equal(u.searchParams.get('list'), 'backlinks');
    assert.equal(u.searchParams.get('bltitle'), 'プタリン・ジャヤ・スタジアム');
    return jsonResponse({ query: { backlinks: [{ title: 'リンク元記事', ns: 0 }] } });
  };
  try {
    const results = await resolveBacklinks({ page: 'プタリン・ジャヤ・スタジアム', namespaces: [0] });
    assert.deepEqual(results, [{ title: 'リンク元記事', namespace: 0 }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveEmbeddedIn: Template:プレフィックスが無くても自動付与する', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    assert.equal(u.searchParams.get('eititle'), 'Template:旧テンプレ');
    return jsonResponse({ query: { embeddedin: [] } });
  };
  try {
    await resolveEmbeddedIn({ template: '旧テンプレ', namespaces: [0] });
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveRegexSearch: 正常時はresultsを返しerrorはnull', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({ query: { search: [{ title: 'ヒットページ', ns: 0 }] } });
  try {
    const { results, error } = await resolveRegexSearch({ query: 'insource:/旧テンプレ/', namespaces: null });
    assert.deepEqual(results, [{ title: 'ヒットページ', namespace: 0 }]);
    assert.equal(error, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveRegexSearch: APIエラー時は例外を投げず、空配列+エラーメッセージを返す（仕様書4章の方針）', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({ error: { code: 'timeout', info: '検索がタイムアウトしました' } });
  try {
    const { results, error } = await resolveRegexSearch({ query: 'insource:/x/', namespaces: null });
    assert.deepEqual(results, []);
    assert.match(error, /タイムアウト/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveRegexSearch: ネットワークエラーでも例外を投げない', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('network down');
  };
  try {
    const { results, error } = await resolveRegexSearch({ query: 'insource:/x/', namespaces: null });
    assert.deepEqual(results, []);
    assert.match(error, /network down/);
  } finally {
    global.fetch = originalFetch;
  }
});

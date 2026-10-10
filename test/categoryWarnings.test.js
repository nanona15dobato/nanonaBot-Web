'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectCategoryWarnings, extractSnippet } = require('../src/worker/categoryWarnings');

test('extractSnippet: マーカー周辺を切り出し、省略記号を付ける', () => {
  const text = 'x'.repeat(100) + 'リダイレクトの所属カテゴリ' + 'y'.repeat(300);
  const idx = text.indexOf('リダイレクトの所属カテゴリ');
  const snippet = extractSnippet(text, idx);
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.endsWith('…'));
  assert.ok(snippet.includes('リダイレクトの所属カテゴリ'));
});

test('collectCategoryWarnings: 構造的に一致するページは警告に含めない（自動編集対象のため）', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      query: {
        backlinks: [
          { title: 'ページA（構造一致）', ns: 0 },
          { title: 'ページB（テンプレなし）', ns: 0 },
          { title: 'ページC（別カテゴリ言及）', ns: 0 },
          { title: 'ページD（緩い一致のみ）', ns: 0 },
        ],
      },
    }),
  });

  const pages = {
    'ページA（構造一致）': '本文…{{リダイレクトの所属カテゴリ|redirect1=X|1-1=旧カテゴリ名}}…',
    'ページB（テンプレなし）': '本文のみ、テンプレなし',
    'ページC（別カテゴリ言及）': '{{リダイレクトの所属カテゴリ|redirect1=X|1-1=別のカテゴリ}}',
    // マーカー文字列とカテゴリ名は共起するが、テンプレート呼び出しの引数としては
    // 構造的に確認できない（コメントアウトされている）ケース
    'ページD（緩い一致のみ）': '<!-- リダイレクトの所属カテゴリとして 旧カテゴリ名 を検討中 -->',
  };
  const mwClient = {
    getPage: async (title) => ({ exists: true, wikitext: pages[title] || '' }),
  };

  try {
    const warnings = await collectCategoryWarnings({ from: '旧カテゴリ名', mwClient });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].pageTitle, 'ページD（緩い一致のみ）');
  } finally {
    global.fetch = originalFetch;
  }
});

test('collectCategoryWarnings: 存在しないページはスキップする', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ query: { backlinks: [{ title: '削除済みページ', ns: 0 }] } }),
  });
  const mwClient = { getPage: async () => ({ exists: false }) };

  try {
    const warnings = await collectCategoryWarnings({ from: 'X', mwClient });
    assert.deepEqual(warnings, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test('scanCategoryBacklinks: キャッシュを渡すと警告収集とウェーブ3の対象確認で本文取得を共有する', async () => {
  const { findCandidatePages } = require('../src/worker/redirectCategoryTemplate');
  const originalFetch = global.fetch;
  let backlinkRequests = 0;
  global.fetch = async () => {
    backlinkRequests++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ query: { backlinks: [{ title: '一致', ns: 0 }, { title: '緩い一致', ns: 0 }] } }),
    };
  };
  const fetchedPages = [];
  const mwClient = {
    getPage: async (title) => {
      fetchedPages.push(title);
      return {
        exists: true,
        wikitext:
          title === '一致'
            ? '{{リダイレクトの所属カテゴリ|redirect1=X|1-1=旧}}'
            : '<!-- {{リダイレクトの所属カテゴリ}} -->旧',
      };
    },
  };
  try {
    const cache = new Map();
    const warnings = await collectCategoryWarnings({ from: '旧', mwClient, cache });
    const matches = await findCandidatePages({ category: '旧', mwClient, cache });
    assert.deepEqual(warnings.map((w) => w.pageTitle), ['緩い一致']);
    assert.deepEqual(matches, [{ title: '一致', namespace: 0 }]);
    assert.equal(backlinkRequests, 1);
    assert.deepEqual(fetchedPages, ['一致', '緩い一致']);
  } finally {
    global.fetch = originalFetch;
  }
});

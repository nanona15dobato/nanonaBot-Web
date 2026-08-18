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

test('collectCategoryWarnings: テンプレート名と旧カテゴリ名が共起するページのみ警告として返す', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      query: {
        backlinks: [
          { title: 'ページA（該当）', ns: 0 },
          { title: 'ページB（テンプレなし）', ns: 0 },
          { title: 'ページC（別カテゴリ言及）', ns: 0 },
        ],
      },
    }),
  });

  const pages = {
    'ページA（該当）': '本文…{{リダイレクトの所属カテゴリ|旧カテゴリ名}}…',
    'ページB（テンプレなし）': '本文のみ、テンプレなし',
    'ページC（別カテゴリ言及）': '{{リダイレクトの所属カテゴリ|別のカテゴリ}}',
  };
  const mwClient = {
    getPage: async (title) => ({ exists: true, wikitext: pages[title] || '' }),
  };

  try {
    const warnings = await collectCategoryWarnings({ from: '旧カテゴリ名', mwClient });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].pageTitle, 'ページA（該当）');
    assert.match(warnings[0].snippet, /リダイレクトの所属カテゴリ/);
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

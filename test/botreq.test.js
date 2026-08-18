'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stripNamespacePrefix,
  classifyPair,
  parseBotreqTemplates,
  fetchBotreqWikitext,
} = require('../src/worker/botreq');

// ---- stripNamespacePrefix ----

test('stripNamespacePrefix: 一致するプレフィックスがあれば除いた文字列を返す', () => {
  assert.equal(stripNamespacePrefix('Category:日本の橋', ['Category', 'category', 'カテゴリ']), '日本の橋');
  assert.equal(stripNamespacePrefix('カテゴリ:日本の橋', ['Category', 'category', 'カテゴリ']), '日本の橋');
});

test('stripNamespacePrefix: 一致しなければnull', () => {
  assert.equal(stripNamespacePrefix('日本の橋', ['Category', 'category', 'カテゴリ']), null);
});

// ---- classifyPair ----

test('classifyPair: 通常のページ名同士はlinkRename', () => {
  const result = classifyPair('プタリン・ジャヤ・スタジアム', 'ペタリン・ジャヤ・スタジアム');
  assert.equal(result.type, 'linkRename');
  assert.equal(result.from, 'プタリン・ジャヤ・スタジアム');
  assert.equal(result.to, 'ペタリン・ジャヤ・スタジアム');
});

test('classifyPair: 改名元に括弧が無く改名先にあればlinkRename2（仕様書7.3節）', () => {
  const result = classifyPair('プタリン', 'プタリン（スタジアム）');
  assert.equal(result.type, 'linkRename2');
});

test('classifyPair: 改名元にも括弧があればlinkRename（曖昧さ回避同士の付け替え）', () => {
  const result = classifyPair('プタリン（旧）', 'プタリン（新）');
  assert.equal(result.type, 'linkRename');
});

test('classifyPair: Category:同士はcategoryRename（プレフィックスを除いた名前になる）', () => {
  const result = classifyPair('Category:旧カテゴリ', 'Category:新カテゴリ');
  assert.equal(result.type, 'categoryRename');
  assert.equal(result.from, '旧カテゴリ');
  assert.equal(result.to, '新カテゴリ');
});

test('classifyPair: Template:同士はtemplateRename', () => {
  const result = classifyPair('Template:旧テンプレ', 'Template:新テンプレ');
  assert.equal(result.type, 'templateRename');
  assert.equal(result.from, '旧テンプレ');
  assert.equal(result.to, '新テンプレ');
});

test('classifyPair: DELETE_PAGE/REDIRECT_TARGET/subst:/URLは未対応', () => {
  assert.equal(classifyPair('A', 'DELETE_PAGE').reason, 'DELETE_PAGE');
  assert.equal(classifyPair('A', 'REDIRECT_TARGET').reason, 'REDIRECT_TARGET');
  assert.equal(classifyPair('Template:A', 'subst:').reason, 'subst');
  assert.equal(classifyPair('http://move.from/x', 'https://move.to/y').reason, 'URL');
  for (const r of [
    classifyPair('A', 'DELETE_PAGE'),
    classifyPair('A', 'REDIRECT_TARGET'),
    classifyPair('Template:A', 'subst:'),
    classifyPair('http://a', 'http://b'),
  ]) {
    assert.equal(r.type, 'unsupported');
  }
});

test('classifyPair: アンカー・{{!}}パイプラベル付きは未対応（フェーズ1では単純改名のみ）', () => {
  assert.equal(classifyPair('改名元2#アンカー1', '改名先2#アンカー2').reason, 'anchor_or_label');
  assert.equal(classifyPair('改名元3#アンカー1{{!}}ラベル', '改名先3#アンカー2{{!}}ラベル').reason, 'anchor_or_label');
});

test('classifyPair: 片方だけCategory:/Template:の不整合ペアは未対応', () => {
  assert.equal(classifyPair('Category:A', 'B').reason, 'namespace_mismatch');
  assert.equal(classifyPair('Template:A', 'B').reason, 'namespace_mismatch');
});

// ---- parseBotreqTemplates ----

test('parseBotreqTemplates: ユーザー提示の実例を正しくパースする', () => {
  const wikitext = `
{{リンク修正依頼/改名
|提案 = [[ノート:ペタリン・ジャヤ・スタジアム]]
|プタリン・ジャヤ・スタジアム|ペタリン・ジャヤ・スタジアム
}}
`;
  const proposals = parseBotreqTemplates(wikitext);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].proposal, '[[ノート:ペタリン・ジャヤ・スタジアム]]');
  assert.equal(proposals[0].pairs.length, 1);
  assert.deepEqual(
    { type: proposals[0].pairs[0].type, from: proposals[0].pairs[0].from, to: proposals[0].pairs[0].to },
    { type: 'linkRename', from: 'プタリン・ジャヤ・スタジアム', to: 'ペタリン・ジャヤ・スタジアム' }
  );
});

test('parseBotreqTemplates: 仕様書8章の複合例（複数ペア種別混在）を正しく分類する', () => {
  const wikitext = `
{{リンク修正依頼/改名
|改名元1 |改名先1
|Template:改名元 |Template:改名先
|Category:改名元 |Category:改名先
|改名元X |DELETE_PAGE
|改名元Y |REDIRECT_TARGET
|http://move.from/path |https://move.to/path
}}
`;
  const proposals = parseBotreqTemplates(wikitext);
  assert.equal(proposals.length, 1);
  const types = proposals[0].pairs.map((p) => p.type);
  assert.deepEqual(types, ['linkRename', 'templateRename', 'categoryRename', 'unsupported', 'unsupported', 'unsupported']);
});

test('parseBotreqTemplates: 複数の{{リンク修正依頼/改名}}呼び出しをすべて検出する', () => {
  const wikitext = `
{{リンク修正依頼/改名|A1|A2}}
本文…
{{リンク修正依頼/改名|B1|B2}}
`;
  const proposals = parseBotreqTemplates(wikitext);
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].pairs[0].from, 'A1');
  assert.equal(proposals[1].pairs[0].from, 'B1');
});

test('parseBotreqTemplates: 該当テンプレートが無ければ空配列', () => {
  assert.deepEqual(parseBotreqTemplates('本文のみ、テンプレートなし'), []);
});

test('parseBotreqTemplates: {{!}}を含むアンカー付きペアも例外を起こさずunsupportedになる', () => {
  const wikitext = `
{{リンク修正依頼/改名
|改名元3#アンカー1{{!}}リンクラベル |改名先3#アンカー2{{!}}リンクラベル
}}
`;
  const proposals = parseBotreqTemplates(wikitext);
  assert.equal(proposals[0].pairs[0].type, 'unsupported');
  assert.equal(proposals[0].pairs[0].reason, 'anchor_or_label');
});

// ---- fetchBotreqWikitext ----

test('fetchBotreqWikitext: ページ本文・revidを取得する', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    assert.equal(u.searchParams.get('titles'), 'Wikipedia:Bot作業依頼');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        query: {
          pages: [
            {
              title: 'Wikipedia:Bot作業依頼',
              revisions: [{ revid: 123, timestamp: '2026-01-01T00:00:00Z', slots: { main: { content: '本文' } } }],
            },
          ],
        },
      }),
    };
  };
  try {
    const result = await fetchBotreqWikitext();
    assert.equal(result.wikitext, '本文');
    assert.equal(result.revid, 123);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchBotreqWikitext: ページが存在しなければ例外', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ query: { pages: [{ title: 'X', missing: true }] } }),
  });
  try {
    await assert.rejects(() => fetchBotreqWikitext('X'), /見つかりませんでした/);
  } finally {
    global.fetch = originalFetch;
  }
});

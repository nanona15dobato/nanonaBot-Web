'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rct = require('../src/worker/redirectCategoryTemplate');

// 以下はすべて scripts/check-redirect-category-template.js をToolforge上で実行して
// 取得した実際のページの{{リダイレクトの所属カテゴリ}}呼び出し（2026年時点）。
// テンプレート自体はLuaモジュールではなく素のwikitextテンプレートで、
// redirect1〜redirect10 / N-1〜N-20（Category:プレフィックス不要）という
// 名前付き引数を使うことが本文から確認できている（仕様書8章）。

const SAMPLE_単一リダイレクト = `{{リダイレクトの所属カテゴリ
|redirect1=菊池通隆
|1-1=日本のアニメーター
|1-2=日本のキャラクターデザイナー
|1-3=アニメのキャラクターデザイナー
}}`;

const SAMPLE_複数リダイレクト = `{{リダイレクトの所属カテゴリ
|redirect1=鶴見史郎
|1-1=日本の漫画原作者
|redirect2=鷹見吾郎
|2-1=日本の漫画原作者
|redirect3=菅谷充
|3-1=日本の小説家
|3-2=架空戦記作家
|3-3=本名のリダイレクト
}}`;

const SAMPLE_collapse_header付き = `{{リダイレクトの所属カテゴリ
|collapse=
|header=この記事は以下のカテゴリでも参照できます
|redirect1=森高夕次
|1-1=日本の漫画原作者
}}`;

const SAMPLE_4リダイレクト_スペース区切り = `{{リダイレクトの所属カテゴリ
| header = この記事は以下のカテゴリでも参照できます
| redirect1 = ああっ女神さまっ 小っちゃいって事は便利だねっ
| 1-1 = 1998年のテレビアニメ
| 1-2 = WOWOWアニメ
| redirect2 = ああっ女神さまっ それぞれの翼
| 2-1 = 2006年のテレビアニメ
| 2-2 = NBCユニバーサル・ジャパンのアニメ作品
}}`;

test('findCalls: 単一リダイレクト例を検出しargsOrderedのキー順が正しい', () => {
  const calls = rct.findCalls(SAMPLE_単一リダイレクト);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].argsOrdered.map((a) => a.key),
    ['redirect1', '1-1', '1-2', '1-3']
  );
});

test('isCategoryValueKey: N-M形式と1〜20の素の番号引数を判定する', () => {
  assert.equal(rct.isCategoryValueKey('1-1'), true);
  assert.equal(rct.isCategoryValueKey('10-20'), true);
  assert.equal(rct.isCategoryValueKey('11-1'), false); // redirect11は存在しない
  assert.equal(rct.isCategoryValueKey('1-21'), false); // カテゴリ21件目は存在しない
  assert.equal(rct.isCategoryValueKey('5'), true); // まとめて表示用の素の位置引数
  assert.equal(rct.isCategoryValueKey('redirect1'), false);
  assert.equal(rct.isCategoryValueKey('header'), false);
  assert.equal(rct.isCategoryValueKey('collapse'), false);
});

test('findMatchingCategoryArgs: 値が一致する引数だけを返す', () => {
  const calls = rct.findCalls(SAMPLE_単一リダイレクト);
  const matches = rct.findMatchingCategoryArgs(calls[0], '日本のキャラクターデザイナー');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].key, '1-2');
});

test('renameCategoryInTemplate: 単一リダイレクト例で該当箇所だけを改名する', () => {
  const result = rct.renameCategoryInTemplate(SAMPLE_単一リダイレクト, '日本のキャラクターデザイナー', '日本のキャラクターデザイナー(新)');
  assert.equal(result.changed, true);
  assert.equal(result.count, 1);
  assert.match(result.wikitext, /\|1-2=日本のキャラクターデザイナー\(新\)/);
  // 他の引数は変化しないこと
  assert.match(result.wikitext, /\|redirect1=菊池通隆/);
  assert.match(result.wikitext, /\|1-1=日本のアニメーター/);
  assert.match(result.wikitext, /\|1-3=アニメのキャラクターデザイナー/);
});

test('renameCategoryInTemplate: 該当が無ければchanged:falseで元のまま', () => {
  const result = rct.renameCategoryInTemplate(SAMPLE_単一リダイレクト, '存在しないカテゴリ', '新カテゴリ');
  assert.equal(result.changed, false);
  assert.equal(result.wikitext, SAMPLE_単一リダイレクト);
});

test('removeCategoryFromTemplate: 単一リダイレクト例で該当行を丸ごと除去する', () => {
  const result = rct.removeCategoryFromTemplate(SAMPLE_単一リダイレクト, '日本のキャラクターデザイナー');
  assert.equal(result.changed, true);
  assert.equal(result.count, 1);
  assert.doesNotMatch(result.wikitext, /日本のキャラクターデザイナー/);
  // 残った名前付き引数は、読みやすいように1から連番へ詰める。
  assert.match(result.wikitext, /\|1-1=日本のアニメーター/);
  assert.match(result.wikitext, /\|1-2=アニメのキャラクターデザイナー/);
  assert.doesNotMatch(result.wikitext, /\|1-3=/);
});

test('removeCategoryFromTemplate: 複数の名前付き引数をリダイレクトごとに連番へ詰める', () => {
  const wikitext = `{{リダイレクトの所属カテゴリ
| redirect1 = A
| 1-1 = 残す1
| 1-2 = 削除対象
| 1-3 = 残す2
| redirect2 = B
| 2-1 = 削除対象
| 2-2 = 残す3
| 2-4 = 残す4
}}`;
  const result = rct.removeCategoryFromTemplate(wikitext, '削除対象');

  assert.equal(result.count, 2);
  assert.match(result.wikitext, /\| 1-1 = 残す1/);
  assert.match(result.wikitext, /\| 1-2 = 残す2/);
  assert.match(result.wikitext, /\| 2-1 = 残す3/);
  assert.match(result.wikitext, /\| 2-2 = 残す4/);
  assert.doesNotMatch(result.wikitext, /[12]-[34] =/);
});

test('renameCategoryInTemplate: 複数リダイレクトにまたがる同一カテゴリを全て改名する', () => {
  const result = rct.renameCategoryInTemplate(SAMPLE_複数リダイレクト, '日本の漫画原作者', '日本の漫画家（原作担当）');
  assert.equal(result.count, 2);
  const matches = result.wikitext.match(/日本の漫画家（原作担当）/g);
  assert.equal(matches.length, 2);
  assert.doesNotMatch(result.wikitext, /\|1-1=日本の漫画原作者/);
  // 無関係な3-1〜3-3は変化しない
  assert.match(result.wikitext, /\|3-1=日本の小説家/);
  assert.match(result.wikitext, /\|3-2=架空戦記作家/);
  assert.match(result.wikitext, /\|3-3=本名のリダイレクト/);
});

test('removeCategoryFromTemplate: 複数リダイレクトにまたがる同一カテゴリを全て除去する', () => {
  const result = rct.removeCategoryFromTemplate(SAMPLE_複数リダイレクト, '日本の漫画原作者');
  assert.equal(result.count, 2);
  assert.doesNotMatch(result.wikitext, /日本の漫画原作者/);
  assert.match(result.wikitext, /\|redirect1=鶴見史郎/);
  assert.match(result.wikitext, /\|redirect2=鷹見吾郎/);
  assert.match(result.wikitext, /\|redirect3=菅谷充/);
});

test('removeCategoryFromTemplate: collapse=（空文字）やheaderには影響しない', () => {
  const result = rct.removeCategoryFromTemplate(SAMPLE_collapse_header付き, '日本の漫画原作者');
  assert.equal(result.changed, true);
  assert.match(result.wikitext, /\|collapse=\n/);
  assert.match(result.wikitext, /\|header=この記事は以下のカテゴリでも参照できます/);
  assert.match(result.wikitext, /\|redirect1=森高夕次/);
  assert.doesNotMatch(result.wikitext, /1-1/);
});

test('renameCategoryInTemplate: "key = value"のようにスペースが入る記法でも動く', () => {
  const result = rct.renameCategoryInTemplate(SAMPLE_4リダイレクト_スペース区切り, 'WOWOWアニメ', 'WOWOWの制作アニメ');
  assert.equal(result.changed, true);
  assert.match(result.wikitext, /\| 1-2 = WOWOWの制作アニメ/);
  assert.match(result.wikitext, /\| 2-1 = 2006年のテレビアニメ/);
});

test('findCandidatePages: backlinksのうち構造的に一致するページだけを返す', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      query: {
        backlinks: [
          { title: '一致するページ', ns: 0 },
          { title: 'テンプレなしページ', ns: 0 },
        ],
      },
    }),
  });

  const pages = {
    一致するページ: SAMPLE_単一リダイレクト,
    テンプレなしページ: '本文のみ',
  };
  const mwClient = { getPage: async (title) => ({ exists: true, wikitext: pages[title] || '' }) };

  try {
    const results = await rct.findCandidatePages({ category: '日本のアニメーター', mwClient });
    assert.deepEqual(results.map((r) => r.title), ['一致するページ']);
  } finally {
    global.fetch = originalFetch;
  }
});

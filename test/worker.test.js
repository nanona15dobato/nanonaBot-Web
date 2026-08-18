'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyReplacementSteps } = require('../src/worker/regexEngine');
const { validateTaskConfig } = require('../src/worker/taskConfig');
const { parseJsonColumn, toJsonColumn } = require('../src/dbJson');

test('applyReplacementSteps: 単純な置換ステップを順番に適用する', () => {
  const text = '[[プタリン・ジャヤ・スタジアム]]とその周辺';
  const steps = [
    {
      pattern: '\\[\\[\\s*プタリン・ジャヤ・スタジアム\\s*(\\]\\]|\\#[^\\]]*\\]\\]|\\|[^\\]]*\\]\\])',
      flags: 'g',
      replacement: '[[ペタリン・ジャヤ・スタジアム$1',
    },
  ];
  const result = applyReplacementSteps(text, steps);
  assert.equal(result, '[[ペタリン・ジャヤ・スタジアム]]とその周辺');
});

test('applyReplacementSteps: 複数ステップを順に適用する（リンク置換のStep1+Step2相当）', () => {
  const text = '[[A|A]]';
  const steps = [
    { pattern: '\\[\\[\\s*A\\s*\\|\\s*A\\s*\\]\\]', flags: 'g', replacement: '[[A]]' },
  ];
  assert.equal(applyReplacementSteps(text, steps), '[[A]]');
});

test('applyReplacementSteps: <nowiki>内は置換されない（protectRegions連携）', () => {
  const text = '本文の[[A]]は変わるが、<nowiki>[[A]]</nowiki>は変わらない';
  const steps = [{ pattern: '\\[\\[A\\]\\]', flags: 'g', replacement: '[[B]]' }];
  const result = applyReplacementSteps(text, steps);
  assert.equal(result, '本文の[[B]]は変わるが、<nowiki>[[A]]</nowiki>は変わらない');
});

test('applyReplacementSteps: loopUntilStableで重複を1つになるまで整理できる', () => {
  // Category置換Step2相当: 重複した[[Category:B]]を1つに整理
  const text = '[[Category:B]]本文[[Category:B]]さらに本文[[Category:B]]';
  const steps = [
    {
      pattern: '(\\[\\[Category:B\\]\\])([\\s\\S]*?)\\n?\\[\\[Category:B\\]\\]',
      flags: '',
      replacement: '$1$2',
      loopUntilStable: true,
    },
  ];
  const result = applyReplacementSteps(text, steps);
  const count = (result.match(/\[\[Category:B\]\]/g) || []).length;
  assert.equal(count, 1);
});

test('validateTaskConfig: 正しい設定はvalid=true', () => {
  const config = {
    account: 'NanonaBot',
    replacements: [
      {
        templateType: 'custom',
        steps: [{ pattern: 'foo', flags: 'g', replacement: 'bar' }],
        targetSource: { type: 'manualList', titles: ['サンプルページ'] },
      },
    ],
    editSettings: { botFlag: true, minorEdit: true, editSummary: 'test edit', editIntervalSeconds: 10 },
    reviewSettings: { mode: 'auto', autoWaitSeconds: 30 },
    onFailure: 'pause',
  };
  const { valid, errors } = validateTaskConfig(config);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('validateTaskConfig: manualモードはmanualTimeoutHoursが必須', () => {
  const config = {
    account: 'NanonaBot',
    replacements: [
      {
        templateType: 'custom',
        steps: [{ pattern: 'foo', replacement: 'bar' }],
        targetSource: { type: 'manualList', titles: ['X'] },
      },
    ],
    editSettings: { editSummary: 'test', editIntervalSeconds: 10 },
    reviewSettings: { mode: 'manual' },
    onFailure: 'pause',
  };
  const { valid, errors } = validateTaskConfig(config);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('manualTimeoutHours')));
});

test('validateTaskConfig: 不正な正規表現はエラーになる', () => {
  const config = {
    account: 'NanonaBot',
    replacements: [
      {
        templateType: 'custom',
        steps: [{ pattern: '[[[', replacement: 'x' }],
        targetSource: { type: 'manualList', titles: ['X'] },
      },
    ],
    editSettings: { editSummary: 'test', editIntervalSeconds: 10 },
    reviewSettings: { mode: 'auto', autoWaitSeconds: 10 },
    onFailure: 'pause',
  };
  const { valid, errors } = validateTaskConfig(config);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('不正な正規表現')));
});

test('validateTaskConfig: editIntervalSecondsが5未満ならエラー（仕様書12章）', () => {
  const config = {
    account: 'NanonaBot',
    replacements: [
      {
        templateType: 'custom',
        steps: [{ pattern: 'a', replacement: 'b' }],
        targetSource: { type: 'manualList', titles: ['X'] },
      },
    ],
    editSettings: { editSummary: 'test', editIntervalSeconds: 1 },
    reviewSettings: { mode: 'auto', autoWaitSeconds: 10 },
    onFailure: 'pause',
  };
  const { valid, errors } = validateTaskConfig(config);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('editIntervalSeconds')));
});

test('validateTaskConfig: 未知のアカウントはエラー', () => {
  const config = {
    account: 'SomeoneElseBot',
    replacements: [
      {
        templateType: 'custom',
        steps: [{ pattern: 'a', replacement: 'b' }],
        targetSource: { type: 'manualList', titles: ['X'] },
      },
    ],
    editSettings: { editSummary: 'test', editIntervalSeconds: 10 },
    reviewSettings: { mode: 'auto', autoWaitSeconds: 10 },
    onFailure: 'pause',
  };
  const { valid, errors } = validateTaskConfig(config);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('account')));
});

test('parseJsonColumn / toJsonColumn: 文字列・オブジェクトどちらでも往復できる', () => {
  const original = { a: 1, b: ['x', 'y'] };
  const serialized = toJsonColumn(original);
  assert.equal(typeof serialized, 'string');
  assert.deepEqual(parseJsonColumn(serialized), original);
  // 既にパース済みオブジェクトを渡してもそのまま返す（mysql2の挙動ゆれ対策）
  assert.deepEqual(parseJsonColumn(original), original);
});

test('parseJsonColumn: nullや不正なJSONはfallbackを返す', () => {
  assert.deepEqual(parseJsonColumn(null, []), []);
  assert.deepEqual(parseJsonColumn('{not valid json', { x: 1 }), { x: 1 });
});

// ---- フェーズ4: テンプレート系ルールのバリデーション ----

function baseConfig(replacements) {
  return {
    account: 'NanonaBot',
    replacements,
    editSettings: { editSummary: 'test', editIntervalSeconds: 10 },
    reviewSettings: { mode: 'auto', autoWaitSeconds: 10 },
    onFailure: 'pause',
  };
}

test('validateTaskConfig: linkRenameはfrom/toがあればvalid', () => {
  const { valid, errors } = validateTaskConfig(
    baseConfig([{ templateType: 'linkRename', from: 'A', to: 'B' }])
  );
  assert.equal(valid, true, JSON.stringify(errors));
});

test('validateTaskConfig: linkRenameはtoが無いとエラー', () => {
  const { valid, errors } = validateTaskConfig(baseConfig([{ templateType: 'linkRename', from: 'A' }]));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('.to')));
});

test('validateTaskConfig: categoryRemoveはtoが無くてもvalid（除去のみのため）', () => {
  const { valid, errors } = validateTaskConfig(baseConfig([{ templateType: 'categoryRemove', from: 'A' }]));
  assert.equal(valid, true, JSON.stringify(errors));
});

test('validateTaskConfig: templateRenameはfrom/to必須、namespacesは任意', () => {
  const ok = validateTaskConfig(
    baseConfig([{ templateType: 'templateRename', from: 'A', to: 'B', namespaces: [0, 10] }])
  );
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));

  const ng = validateTaskConfig(baseConfig([{ templateType: 'templateRename', from: 'A', to: 'B', namespaces: ['not-a-number'] }]));
  assert.equal(ng.valid, false);
  assert.ok(ng.errors.some((e) => e.includes('namespaces')));
});

test('validateTaskConfig: 未知のtemplateTypeはエラー', () => {
  const { valid, errors } = validateTaskConfig(baseConfig([{ templateType: 'nonsense', from: 'A', to: 'B' }]));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('templateType')));
});

test('validateTaskConfig: customはtargetSourceがcategory/backlinks/embeddedin/regexSearchでもvalid', () => {
  const types = [
    { type: 'category', category: 'テスト' },
    { type: 'backlinks', page: 'テスト' },
    { type: 'embeddedin', page: 'テスト' },
    { type: 'regexSearch', query: 'insource:/x/' },
  ];
  for (const targetSource of types) {
    const { valid, errors } = validateTaskConfig(
      baseConfig([{ templateType: 'custom', steps: [{ pattern: 'a', replacement: 'b' }], targetSource }])
    );
    assert.equal(valid, true, `${targetSource.type}: ${JSON.stringify(errors)}`);
  }
});

test('validateTaskConfig: customのtargetSource.typeが不正ならエラー', () => {
  const { valid, errors } = validateTaskConfig(
    baseConfig([{ templateType: 'custom', steps: [{ pattern: 'a', replacement: 'b' }], targetSource: { type: 'invalid' } }])
  );
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('targetSource.type')));
});

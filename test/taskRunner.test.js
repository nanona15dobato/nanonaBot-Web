'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// taskRunner.js は ../db (mysql2実プール) に依存するが、このテストで使う純粋関数
// （materializeReplacements/computeStageCount/ruleAppliesToStage）はDBに触れないため、
// mysql2未インストールのサンドボックスでも読み込めるよう ../db を軽量スタブに差し替える
// （test/pipeline.test.js と同じ手法）。
const DB_PATH = require.resolve('../src/db');
const fakeModule = new Module(DB_PATH, null);
fakeModule.filename = DB_PATH;
fakeModule.loaded = true;
fakeModule.exports = {
  pool: {
    query: async () => {
      throw new Error('このテストではpool.queryは呼ばれない想定です');
    },
    getConnection: async () => {
      throw new Error('このテストではgetConnectionは呼ばれない想定です');
    },
  },
};
require.cache[DB_PATH] = fakeModule;

const {
  materializeReplacements,
  computeStageCount,
  ruleAppliesToStage,
  resolveRuleTargetsForStage,
} = require('../src/worker/taskRunner');
const { applyReplacementSteps } = require('../src/worker/regexEngine');

test('materializeReplacements: customはstepsをそのまま維持する', () => {
  const input = [{ templateType: 'custom', steps: [{ pattern: 'a', replacement: 'b' }], targetSource: { type: 'manualList', titles: ['X'] } }];
  const result = materializeReplacements(input);
  assert.equal(result[0].steps[0].pattern, 'a');
});

test('materializeReplacements: linkRenameは実際に動くstepsを自動生成する', () => {
  const input = [{ templateType: 'linkRename', from: 'A', to: 'B' }];
  const result = materializeReplacements(input);
  assert.ok(Array.isArray(result[0].steps) && result[0].steps.length > 0);
  const output = applyReplacementSteps('[[A]]', result[0].steps);
  assert.equal(output, '[[B]]');
});

test('materializeReplacements: categoryRemoveはtoが無くてもsteps生成できる', () => {
  const input = [{ templateType: 'categoryRemove', from: 'A' }];
  const result = materializeReplacements(input);
  const output = applyReplacementSteps('[[Category:A]]', result[0].steps);
  assert.equal(output, '');
});

test('materializeReplacements: 未知のtemplateTypeは例外を投げる', () => {
  assert.throws(() => materializeReplacements([{ templateType: 'nonsense' }]), /未知のtemplateType/);
});

test('computeStageCount: linkRename/linkRename2を含めば2、それ以外は1', () => {
  assert.equal(computeStageCount([{ templateType: 'custom' }]), 1);
  assert.equal(computeStageCount([{ templateType: 'templateRename' }]), 1);
  assert.equal(computeStageCount([{ templateType: 'linkRename' }]), 2);
  assert.equal(computeStageCount([{ templateType: 'linkRename2' }]), 2);
  assert.equal(computeStageCount([{ templateType: 'custom' }, { templateType: 'linkRename' }]), 2);
});

test('ruleAppliesToStage: linkRename系はステージ1・2両方、それ以外はステージ1のみ', () => {
  assert.equal(ruleAppliesToStage({ templateType: 'linkRename' }, 1), true);
  assert.equal(ruleAppliesToStage({ templateType: 'linkRename' }, 2), true);
  assert.equal(ruleAppliesToStage({ templateType: 'linkRename2' }, 2), true);
  assert.equal(ruleAppliesToStage({ templateType: 'categoryRename' }, 1), true);
  assert.equal(ruleAppliesToStage({ templateType: 'categoryRename' }, 2), false);
  assert.equal(ruleAppliesToStage({ templateType: 'custom' }, 2), false);
  assert.equal(ruleAppliesToStage({ templateType: 'templateRename' }, 2), false);
});

// ---- フェーズ6: unlinkPage/templateSubst ----

test('materializeReplacements: unlinkPageはtoなしでsteps生成できる', () => {
  const input = [{ templateType: 'unlinkPage', from: 'A' }];
  const result = materializeReplacements(input);
  assert.equal(applyReplacementSteps('[[A]]と[[B]]', result[0].steps), 'Aと[[B]]');
});

test('materializeReplacements: templateSubstはtoなしでsteps生成できる', () => {
  const input = [{ templateType: 'templateSubst', from: 'A' }];
  const result = materializeReplacements(input);
  assert.equal(applyReplacementSteps('{{A}}', result[0].steps), '{{subst:A}}');
});

// ---- フェーズ6: forceTargets（失敗ページ再試行）----

test('computeStageCount: forceTargets指定時はlinkRename系でもウェーブ分割しない', () => {
  assert.equal(computeStageCount([{ templateType: 'linkRename', forceTargets: ['X'] }]), 1);
  assert.equal(
    computeStageCount([
      { templateType: 'linkRename', forceTargets: ['X'] },
      { templateType: 'custom' },
    ]),
    1
  );
});

test('ruleAppliesToStage: forceTargets指定時はtemplateTypeによらずステージ1のみ', () => {
  assert.equal(ruleAppliesToStage({ templateType: 'linkRename', forceTargets: ['X'] }, 1), true);
  assert.equal(ruleAppliesToStage({ templateType: 'linkRename', forceTargets: ['X'] }, 2), false);
});

test('resolveRuleTargetsForStage: forceTargets指定時は通常のAPI解決をバイパスし指定タイトルのみ返す', async () => {
  // categoryRenameは本来resolveCategoryMembers（ネットワークアクセス）を呼ぶが、
  // forceTargetsがあればそれより先にバイパスされるため、fetchが無い環境でも呼び出せる。
  const rule = { templateType: 'categoryRename', from: 'X', to: 'Y', forceTargets: ['失敗したページA', '失敗したページB'] };
  const { results, error } = await resolveRuleTargetsForStage(rule, 1);
  assert.deepEqual(
    results.map((r) => r.title),
    ['失敗したページA', '失敗したページB']
  );
  assert.equal(error, null);
});

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
  namespacesOrDefault,
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

test('2ウェーブ構成: ウェーブ1の対象が0件でもlinkRename系はウェーブ2の対象取得対象である', () => {
  // runStagePipelineは対象0件ならcompleted:trueを返すため、runTaskはこの判定を使って
  // 続けてウェーブ2を列挙・実行する。ここではその前提となるルール適用範囲を固定する。
  const rule = { templateType: 'linkRename', from: '旧ページ', to: '新ページ' };
  assert.equal(computeStageCount([rule]), 2);
  assert.equal(ruleAppliesToStage(rule, 1), true);
  assert.equal(ruleAppliesToStage(rule, 2), true);
});

test('namespacesOrDefault: 明示的なnullは全名前空間のまま、未指定だけが標準名前空間になる', () => {
  assert.deepEqual(namespacesOrDefault(undefined), [0]);
  assert.equal(namespacesOrDefault(null), null);
  assert.deepEqual(namespacesOrDefault([2]), [2]);
});

test('resolveRuleTargetsForStage: linkRenameのウェーブ2はnamespaces:nullを全名前空間としてAPIへ渡す', async () => {
  const originalFetch = global.fetch;
  let requestedNamespace;
  global.fetch = async (url) => {
    requestedNamespace = new URL(String(url)).searchParams.get('blnamespace');
    return { ok: true, status: 200, json: async () => ({ query: { backlinks: [] } }) };
  };
  try {
    await resolveRuleTargetsForStage({ templateType: 'linkRename', from: '利用者:旧', to: '利用者:新', namespaces: null }, 2);
    assert.equal(requestedNamespace, null);
  } finally {
    global.fetch = originalFetch;
  }
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

// ---- フェーズ7: categoryRename/categoryRemoveの対象に、リダイレクトの所属カテゴリ構造一致ページも含める ----

test('resolveRuleTargetsForStage: categoryRenameはカテゴリメンバーとリダイレクトの所属カテゴリ一致ページを統合する', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get('list') === 'categorymembers') {
      return { ok: true, status: 200, json: async () => ({ query: { categorymembers: [{ title: 'カテゴリメンバーページ', ns: 0 }] } }) };
    }
    if (u.searchParams.get('list') === 'backlinks') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ query: { backlinks: [{ title: 'テンプレ一致ページ', ns: 0 }, { title: 'カテゴリメンバーページ', ns: 0 }] } }),
      };
    }
    throw new Error('想定外のAPI呼び出し: ' + u.search);
  };
  const mwClient = {
    getPage: async (title) => ({
      exists: true,
      wikitext: title === 'テンプレ一致ページ' ? '{{リダイレクトの所属カテゴリ|redirect1=X|1-1=旧カテゴリ}}' : '本文のみ',
    }),
  };

  try {
    const rule = { templateType: 'categoryRename', from: '旧カテゴリ', to: '新カテゴリ' };
    const { results } = await resolveRuleTargetsForStage(rule, 1, mwClient);
    const titles = results.map((r) => r.title).sort();
    // カテゴリメンバーページ（直接タグ）とテンプレ一致ページ（構造一致）が重複なく統合される
    assert.deepEqual(titles, ['カテゴリメンバーページ', 'テンプレ一致ページ']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveRuleTargetsForStage: mwClientが無い場合はリダイレクトの所属カテゴリ確認をスキップする（例外を投げない）', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ query: { categorymembers: [{ title: 'X', ns: 0 }] } }) });
  try {
    const rule = { templateType: 'categoryRemove', from: 'カテゴリA' };
    const { results, error } = await resolveRuleTargetsForStage(rule, 1 /* mwClient省略 */);
    assert.equal(error, null);
    assert.deepEqual(results.map((r) => r.title), ['X']);
  } finally {
    global.fetch = originalFetch;
  }
});

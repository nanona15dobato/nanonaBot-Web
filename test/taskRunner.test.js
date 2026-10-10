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
process.env.NULL_EDIT_INTERVAL_MS = '0';

const {
  materializeReplacements,
  computeStageCount,
  ruleAppliesToStage,
  namespacesOrDefault,
  resolveRuleTargetsForStage,
  nullEditTemplateTransclusionsIfNeeded,
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

test('computeStageCount: Category系を含めば3、linkRename系を含めば2、それ以外は1', () => {
  assert.equal(computeStageCount([{ templateType: 'custom' }]), 1);
  assert.equal(computeStageCount([{ templateType: 'templateRename' }]), 1);
  assert.equal(computeStageCount([{ templateType: 'linkRename' }]), 2);
  assert.equal(computeStageCount([{ templateType: 'linkRename2' }]), 2);
  assert.equal(computeStageCount([{ templateType: 'custom' }, { templateType: 'linkRename' }]), 2);
  assert.equal(computeStageCount([{ templateType: 'categoryRename' }]), 3);
  assert.equal(computeStageCount([{ templateType: 'linkRename' }, { templateType: 'categoryRemove' }]), 3);
});

test('ruleAppliesToStage: linkRename系はステージ1・2、Category系は1〜3、それ以外はステージ1のみ', () => {
  assert.equal(ruleAppliesToStage({ templateType: 'linkRename' }, 1), true);
  assert.equal(ruleAppliesToStage({ templateType: 'linkRename' }, 2), true);
  assert.equal(ruleAppliesToStage({ templateType: 'linkRename' }, 3), false);
  assert.equal(ruleAppliesToStage({ templateType: 'linkRename2' }, 2), true);
  assert.equal(ruleAppliesToStage({ templateType: 'categoryRename' }, 1), true);
  assert.equal(ruleAppliesToStage({ templateType: 'categoryRename' }, 2), true);
  assert.equal(ruleAppliesToStage({ templateType: 'categoryRemove' }, 3), true);
  assert.equal(ruleAppliesToStage({ templateType: 'custom' }, 2), false);
  assert.equal(ruleAppliesToStage({ templateType: 'templateRename' }, 2), false);
});

/** list=categorymembers / backlinks へのリクエストを記録し、指定の結果を返すfetchスタブ */
function stubWikiApi(responses) {
  const requests = [];
  global.fetch = async (url) => {
    const params = Object.fromEntries(new URL(String(url)).searchParams.entries());
    requests.push(params);
    const items = responses[params.list] || [];
    return { ok: true, status: 200, json: async () => ({ query: { [params.list]: items } }) };
  };
  return requests;
}

test('resolveRuleTargetsForStage: Category系のウェーブ1はTemplate名前空間のメンバーだけを取る', async () => {
  const originalFetch = global.fetch;
  const requests = stubWikiApi({ categorymembers: [{ title: 'Template:橋', ns: 10 }] });
  try {
    const { results } = await resolveRuleTargetsForStage({ templateType: 'categoryRename', from: '旧', to: '新', namespaces: null }, 1);
    assert.deepEqual(results, [{ title: 'Template:橋', namespace: 10 }]);
    assert.equal(requests[0].cmnamespace, '10');

    // Template名前空間を含まない名前空間指定ならウェーブ1は空（APIも呼ばない）
    const empty = await resolveRuleTargetsForStage({ templateType: 'categoryRename', from: '旧', to: '新', namespaces: [0] }, 1);
    assert.deepEqual(empty.results, []);
    assert.equal(requests.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveRuleTargetsForStage: Category系のウェーブ2は取り直したメンバーからTemplateを除く', async () => {
  const originalFetch = global.fetch;
  const requests = stubWikiApi({
    categorymembers: [
      { title: '記事A', ns: 0 },
      { title: 'Template:橋', ns: 10 },
    ],
  });
  try {
    const { results } = await resolveRuleTargetsForStage({ templateType: 'categoryRemove', from: '旧', namespaces: null }, 2);
    assert.deepEqual(results, [{ title: '記事A', namespace: 0 }]);
    assert.equal(requests[0].cmnamespace, undefined);

    await resolveRuleTargetsForStage({ templateType: 'categoryRemove', from: '旧', namespaces: [0, 10] }, 2);
    assert.equal(requests[1].cmnamespace, '0');
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveRuleTargetsForStage: Category置換のウェーブ3はfixCategoryLinks指定時のみカテゴリのリンク元を加える', async () => {
  const originalFetch = global.fetch;
  const requests = stubWikiApi({ backlinks: [{ title: 'Wikipedia:カテゴリ一覧', ns: 4 }] });
  try {
    const without = await resolveRuleTargetsForStage({ templateType: 'categoryRename', from: '旧', to: '新', namespaces: null }, 3);
    assert.deepEqual(without.results, []);
    assert.equal(requests.length, 0);

    const withLinks = await resolveRuleTargetsForStage(
      { templateType: 'categoryRename', from: '旧', to: '新', namespaces: null, fixCategoryLinks: true },
      3
    );
    assert.deepEqual(withLinks.results, [{ title: 'Wikipedia:カテゴリ一覧', namespace: 4 }]);
    assert.equal(requests[0].bltitle, 'Category:旧');
  } finally {
    global.fetch = originalFetch;
  }
});

test('materializeReplacements: fixCategoryLinks指定のCategory置換は[[:Category:旧]]リンクも置換する', () => {
  const [withLinks] = materializeReplacements([{ templateType: 'categoryRename', from: '旧', to: '新', fixCategoryLinks: true }]);
  const [withoutLinks] = materializeReplacements([{ templateType: 'categoryRename', from: '旧', to: '新' }]);
  const text = '[[Category:旧]] [[:Category:旧|一覧]]';
  assert.equal(applyReplacementSteps(text, withLinks.steps), '[[Category:新]] [[:Category:新|一覧]]');
  assert.equal(applyReplacementSteps(text, withoutLinks.steps), '[[Category:新]] [[:Category:旧|一覧]]');
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

// ---- フェーズ7: リダイレクトの所属カテゴリ構造一致ページはCategory系のウェーブ3で扱う ----

test('resolveRuleTargetsForStage: Category系のウェーブ3はリダイレクトの所属カテゴリ一致ページとリンク元を重複なく統合する', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get('list') === 'backlinks') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ query: { backlinks: [{ title: 'テンプレ一致ページ', ns: 0 }, { title: 'リンクのみのページ', ns: 0 }] } }),
      };
    }
    throw new Error('想定外のAPI呼び出し: ' + u.search);
  };
  const mwClient = {
    getPage: async (title) => ({
      exists: true,
      wikitext: title === 'テンプレ一致ページ' ? '{{リダイレクトの所属カテゴリ|redirect1=X|1-1=旧カテゴリ}}' : '[[:Category:旧カテゴリ]]',
    }),
  };

  try {
    const rule = { templateType: 'categoryRename', from: '旧カテゴリ', to: '新カテゴリ' };
    // チェックボックス無し: 構造一致ページだけ
    const plain = await resolveRuleTargetsForStage(rule, 3, mwClient);
    assert.deepEqual(plain.results.map((r) => r.title), ['テンプレ一致ページ']);

    // チェックボックス有り: リンク元全体を加える（構造一致ページとは重複させない）
    const withLinks = await resolveRuleTargetsForStage({ ...rule, fixCategoryLinks: true }, 3, mwClient);
    assert.deepEqual(withLinks.results.map((r) => r.title).sort(), ['テンプレ一致ページ', 'リンクのみのページ']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveRuleTargetsForStage: mwClientが無い場合はリダイレクトの所属カテゴリ確認をスキップする（例外を投げない）', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('APIは呼ばれない想定です');
  };
  try {
    const rule = { templateType: 'categoryRemove', from: 'カテゴリA' };
    const { results, error } = await resolveRuleTargetsForStage(rule, 3 /* mwClient省略 */);
    assert.equal(error, null);
    assert.deepEqual(results, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test('materializeReplacements: Category:/Template:プレフィックス付きのfrom/toは除いてからstepsを作る', () => {
  const [cat, tmpl] = materializeReplacements([
    { templateType: 'categoryRename', from: 'Category:日本の橋', to: ' カテゴリ:日本の橋梁 ' },
    { templateType: 'templateRename', from: 'Template:旧', to: 'Template:新' },
  ]);
  assert.equal(cat.from, '日本の橋');
  assert.equal(cat.to, '日本の橋梁');
  assert.equal(tmpl.from, '旧');
  assert.equal(tmpl.to, '新');
  const { applyReplacementSteps } = require('../src/worker/regexEngine');
  assert.equal(applyReplacementSteps('[[Category:日本の橋]]', cat.steps), '[[Category:日本の橋梁]]');
  assert.equal(applyReplacementSteps('{{旧|a}}', tmpl.steps), '{{新|a}}');
});

test('nullEditTemplateTransclusionsIfNeeded: Category系で編集したテンプレートの使用ページだけをnull editし、完了印を残す', async () => {
  const originalFetch = global.fetch;
  const originalQuery = fakeModule.exports.pool.query;
  const task = { id: 1, target_titles_json: JSON.stringify({ 1: ['Template:カテゴリ付き', 'Template:リンクのみ'] }) };
  const embeddedinRequests = [];
  global.fetch = async (url) => {
    const params = Object.fromEntries(new URL(String(url)).searchParams.entries());
    embeddedinRequests.push(params.eititle);
    const pages = { 'Template:カテゴリ付き': [{ title: '記事A', ns: 0 }, { title: '記事B', ns: 0 }] };
    return { ok: true, status: 200, json: async () => ({ query: { embeddedin: pages[params.eititle] || [] } }) };
  };
  fakeModule.exports.pool.query = async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT target_titles_json FROM tasks')) return [[{ target_titles_json: task.target_titles_json }]];
    if (s.startsWith('SELECT page_title, matched_rule_indices FROM task_pages')) {
      return [
        [
          { page_title: 'Template:カテゴリ付き', matched_rule_indices: '[1]' }, // Category置換ルールで編集
          { page_title: 'Template:リンクのみ', matched_rule_indices: '[0]' }, // linkRenameルールのみ
        ],
      ];
    }
    if (s.startsWith('SELECT emergency_stopped')) return [[{ emergency_stopped: 0 }]];
    if (s.startsWith('SELECT status FROM tasks')) return [[{ status: 'running' }]];
    if (s.startsWith('INSERT INTO task_logs')) return [{}];
    if (s.startsWith('UPDATE tasks SET target_titles_json')) {
      task.target_titles_json = params[0];
      return [{ affectedRows: 1 }];
    }
    throw new Error('想定外のSQL: ' + s);
  };
  const nullEdited = [];
  const mwClient = { nullEdit: async (title) => nullEdited.push(title) };
  const replacements = [
    { templateType: 'linkRename', from: 'A', to: 'B' },
    { templateType: 'categoryRename', from: '旧', to: '新' },
  ];

  try {
    const result = await nullEditTemplateTransclusionsIfNeeded(task, replacements, mwClient);
    assert.deepEqual(result, { stopped: null });
    assert.deepEqual(embeddedinRequests, ['Template:カテゴリ付き']);
    assert.deepEqual(nullEdited, ['記事A', '記事B']);
    assert.equal(JSON.parse(task.target_titles_json).nullEditDone, true);

    // 再開時は繰り返さない
    await nullEditTemplateTransclusionsIfNeeded(task, replacements, mwClient);
    assert.deepEqual(nullEdited, ['記事A', '記事B']);
  } finally {
    global.fetch = originalFetch;
    fakeModule.exports.pool.query = originalQuery;
  }
});

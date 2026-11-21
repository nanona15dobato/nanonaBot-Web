'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const data = require('../docs/assets/bot-workflows.json');
const { compile } = require('../scripts/workflow-reference');
const { buildPlan } = require('../scripts/templates/workflow-composer');
const { resolveGlobalTargets } = require('../src/worker/globalWaves');
// Resolve real worker target branches without opening a database or accessing the wiki.
const dbPath = require.resolve('../src/db');
const stub = new Module(dbPath); stub.loaded = true; stub.exports = { pool: {} }; require.cache[dbPath] = stub;
const { resolveRuleTargetsForStage } = require('../src/worker/taskRunner');

test('documentation replacement examples are checked against the worker transforms', () => {
  const rules = compile(data.ruleReference);
  assert.equal(rules.length, 10);
  assert.ok(rules.every(rule => rule.examples.length && rule.examples.every(example => example.steps.length)));
  const broken = structuredClone(data.ruleReference); broken[0].examples[0].after = 'incorrect example';
  assert.throws(() => compile(broken), /Documentation example drift/);
});

test('documentation composition partitions all kinds like the actual global target resolver', async () => {
  const original = global.fetch;
  const pages = [{ title: '記事A', ns: 0 }, { title: 'Template:T', ns: 10 }, { title: 'Wikipedia:資料', ns: 4 }];
  global.fetch = async url => {
    const q = new URL(url).searchParams;
    const ns = ['cmnamespace', 'blnamespace', 'einamespace', 'eunamespace', 'srnamespace'].map(key => q.get(key)).find(value => value !== null);
    const found = pages.filter(page => !ns || ns.split('|').includes(String(page.ns)));
    return { ok: true, json: async () => ({ query: { [q.get('list')]: found } }) };
  };
  try {
    for (const [scope, namespaces] of [['main', [0]], ['main-template', [0, 10]], ['template', [10]], ['all', null]]) {
      for (const source of data.extractionSources.map(source => source.id)) {
        for (const entry of data.ruleReference) {
          const rule = { templateType: entry.id, ...entry.examples[0].params, namespaces };
          if (entry.id === 'custom') rule.targetSource = { type: source, titles: ['記事A', 'Template:T'], page: '旧', category: '旧', query: 'insource:/旧/', namespaces };
          const options = { fixedPlan: false, resolveLegacy: resolveRuleTargetsForStage, resolveMentions: async () => ({ results: [{ title: '記事A', namespace: 0 }], error: null }) };
          const client = { getPage: async title => ({ namespace: title.startsWith('Template:') ? 10 : 0 }) };
          const plan = buildPlan(data.ruleReference, [entry.id], { scope, source, refresh: true, residual: false });
          for (const [stage, id] of [[1, 'template'], [2, 'main']]) {
            const actual = await resolveGlobalTargets(rule, stage, client, options);
            assert.equal(plan.find(phase => phase.id === id).rules.length > 0, actual.results.length > 0, `${entry.id}/${scope}/${source}/${stage}`);
          }
        }
      }
    }
  } finally { global.fetch = original; }
});

test('composition retains rule order, separates refresh from edits, and omits manual residual discovery', () => {
  let plan = buildPlan(data.ruleReference, ['templateRename', 'linkRename', 'templateRename'], { scope: 'main-template', source: 'manualList', refresh: true, residual: true });
  assert.deepEqual(plan.map(phase => phase.id), ['template', 'refresh', 'main', 'residual']);
  assert.deepEqual(plan[0].rules.map(rule => rule.id), ['templateRename', 'linkRename']);
  plan = buildPlan(data.ruleReference, ['custom'], { scope: 'main', source: 'manualList', refresh: false, residual: true });
  assert.deepEqual(plan.map(phase => phase.id), ['template', 'main']);
  assert.deepEqual(buildPlan(data.ruleReference, [], { scope: 'all' }), []);
});

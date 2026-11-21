'use strict';

const VERSION = 'global-v1';
const TEMPLATE_NS = 10;
const PRIORITY_TYPES = ['linkRename', 'linkRename2', 'linkRenameExact', 'urlRename', 'categoryRename', 'categoryRemove'];
const CATEGORY_TYPES = ['categoryRename', 'categoryRemove'];
const isGlobalConfig = (config) => config.workflowVersion === VERSION;
const isFixedPlan = (rules) => rules.every((r) => r.forceTargets || r.templateType === 'revertEdits');
const stageCount = (rules) => isFixedPlan(rules) ? 1 : 2;

function legacyStageCount(rules) {
  return Math.max(1, ...rules.map(r => r.forceTargets ? 1 : CATEGORY_TYPES.includes(r.templateType) ? 3 : PRIORITY_TYPES.includes(r.templateType) ? 2 : 1));
}

function mergeResults(...groups) {
  const seen = new Set();
  const results = [];
  for (const group of groups) {
    for (const item of group.results) {
      if (!seen.has(item.title)) { seen.add(item.title); results.push(item); }
    }
  }
  if (groups.some((g) => g.results.truncated)) results.truncated = true;
  return { results, error: groups.map((g) => g.error).filter(Boolean).join(' / ') || null,
    note: groups.map((g) => g.note).filter(Boolean).join(' / ') || undefined };
}

/** The legacy resolver supplies API discovery only; new tasks partition the union by namespace. */
async function resolveGlobalTargets(rule, stage, mwClient, options) {
  const { resolveLegacy, resolveMentions, fixedPlan, namespaceCache = new Map() } = options;
  if (fixedPlan) return stage === 1 ? resolveLegacy(rule, 1, mwClient, options) : { results: [], error: null };
  let queryRule = rule;
  if (options.remainingPurge && rule.searchNarrowing) queryRule = { ...rule, searchNarrowing: false };
  const priority = PRIORITY_TYPES.includes(rule.templateType) && !rule.forceTargets;
  if (stage === 1 && !priority) {
    const namespaces = rule.templateType === 'custom' ? rule.targetSource.namespaces : rule.namespaces === undefined ? [0] : rule.namespaces;
    const manual = rule.forceTargets || rule.templateType === 'revertEdits' || rule.targetSource?.type === 'manualList';
    if (!manual && namespaces && namespaces.length && !namespaces.includes(TEMPLATE_NS)) return { results: [], error: null };
    if (!manual) {
      queryRule = rule.templateType === 'custom'
        ? { ...queryRule, targetSource: { ...rule.targetSource, namespaces: [TEMPLATE_NS] } }
        : { ...queryRule, namespaces: [TEMPLATE_NS] };
    }
  }
  // Category Template edits are always the first phase, independently of the main namespace selection.
  if (stage === 1 && CATEGORY_TYPES.includes(rule.templateType) && !rule.forceTargets) queryRule = { ...queryRule, namespaces: [TEMPLATE_NS] };
  const legacyStage = priority ? stage : 1;
  const groups = [await resolveLegacy(queryRule, legacyStage, mwClient, options)];
  if (stage === 2 && CATEGORY_TYPES.includes(rule.templateType) && !rule.forceTargets) {
    groups.push(await resolveMentions(rule, mwClient, options.scanCache));
  }
  const merged = mergeResults(...groups);
  const results = [];
  for (const item of merged.results) {
    let namespace = item.namespace;
    if (!Number.isInteger(namespace)) {
      if (!namespaceCache.has(item.title)) {
        // Never guess main namespace: a Template must not be edited after its caller-refresh phase.
        const known = (await mwClient.getPage(item.title))?.namespace;
        if (!Number.isInteger(known)) throw new Error(`名前空間を確認できませんでした: ${item.title}`);
        namespaceCache.set(item.title, known);
      }
      namespace = namespaceCache.get(item.title);
    }
    if ((stage === 1) === (namespace === TEMPLATE_NS)) results.push({ ...item, namespace });
  }
  if (merged.results.truncated) results.truncated = true;
  return { ...merged, results };
}

module.exports = { legacyStageCount, VERSION, isGlobalConfig, isFixedPlan, stageCount, resolveGlobalTargets, mergeResults };

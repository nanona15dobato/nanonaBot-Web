'use strict';
const { pool } = require('../db');
const { parseJsonColumn } = require('../dbJson');
const excludedNamespaces = task => new Set(parseJsonColumn(task.config_json, {}).targetExcludedNamespaces || []);
const { isGlobalConfig, isFixedPlan } = require('./globalWaves');
async function overrides(task) {
  if (!task.control_revision) return [];
  const [rows] = await pool.query('SELECT page_title, namespace, added, excluded FROM task_target_overrides WHERE task_id = ?', [task.id]);
  return rows;
}
async function filterExcluded(task, titles, mwClient) {
  const excluded = new Set((await overrides(task)).filter(r => r.excluded).map(r => r.page_title));
  const blocked = excludedNamespaces(task);
  const result = titles.filter(title => !excluded.has(title));
  if (!blocked.size || !result.length) return result;
  const namespaces = new Map();
  for (let i = 0; i < result.length; i += 50) {
    const batch = result.slice(i, i + 50);
    const data = await mwClient.request({ action:'query', prop:'info', titles:batch.join('|') });
    const normal = new Map((data.query?.normalized || []).map(n => [n.from,n.to]));
    const pages = new Map((data.query?.pages || []).map(p => [p.title,p.ns]));
    for (const title of batch) {
      const ns = pages.get(normal.get(title) || title);
      if (!Number.isInteger(ns)) throw new Error('更新対象の名前空間を確認できません: ' + title);
      namespaces.set(title,ns);
    }
  }
  return result.filter(title => !blocked.has(namespaces.get(title)));
}
async function augmentTargets(task, replacements, stage, titleToInfo, stageCount, config) {
  const entries = await overrides(task);
  const blocked = excludedNamespaces(task);
  const excluded = new Set(entries.filter(r => r.excluded).map(r => r.page_title));
  const [finished] = await pool.query("SELECT page_title FROM task_pages WHERE task_id = ? AND status IN ('edited','skipped','rejected','failed')", [task.id]);
  const done = new Set(finished.map(r => r.page_title));
  for (const item of entries) {
    const targetStage = isFixedPlan(replacements) ? 1 : item.namespace === 10 ? 1 : isGlobalConfig(config) ? 2 : Math.min(2, stageCount);
    if (item.added && !item.excluded && targetStage === stage && !done.has(item.page_title)) titleToInfo.set(item.page_title, { namespace: item.namespace, ruleIndices: new Set(replacements.map((_, i) => i)) });
  }
  for (const title of titleToInfo.keys()) if (excluded.has(title) || done.has(title) || blocked.has(titleToInfo.get(title).namespace)) titleToInfo.delete(title);
}
module.exports = { filterExcluded, augmentTargets };

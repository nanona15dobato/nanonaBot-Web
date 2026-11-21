'use strict';
const { pool } = require('../db');
const { isGlobalConfig, isFixedPlan } = require('./globalWaves');
async function overrides(task) {
  if (!task.control_revision) return [];
  const [rows] = await pool.query('SELECT page_title, namespace, added, excluded FROM task_target_overrides WHERE task_id = ?', [task.id]);
  return rows;
}
async function filterExcluded(task, titles) {
  const excluded = new Set((await overrides(task)).filter(r => r.excluded).map(r => r.page_title));
  return titles.filter(title => !excluded.has(title));
}
async function augmentTargets(task, replacements, stage, titleToInfo, stageCount, config) {
  const entries = await overrides(task);
  const excluded = new Set(entries.filter(r => r.excluded).map(r => r.page_title));
  const [finished] = await pool.query("SELECT page_title FROM task_pages WHERE task_id = ? AND status IN ('edited','skipped','rejected','failed')", [task.id]);
  const done = new Set(finished.map(r => r.page_title));
  for (const item of entries) {
    const targetStage = isFixedPlan(replacements) ? 1 : item.namespace === 10 ? 1 : isGlobalConfig(config) ? 2 : Math.min(2, stageCount);
    if (item.added && !item.excluded && targetStage === stage && !done.has(item.page_title)) titleToInfo.set(item.page_title, { namespace: item.namespace, ruleIndices: new Set(replacements.map((_, i) => i)) });
  }
  for (const title of titleToInfo.keys()) if (excluded.has(title) || done.has(title)) titleToInfo.delete(title);
}
module.exports = { filterExcluded, augmentTargets };

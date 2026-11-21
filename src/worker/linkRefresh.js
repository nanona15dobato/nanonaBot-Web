'use strict';

const { pool } = require('../db');
const { filterExcluded } = require('./targetOverrides');
const { parseJsonColumn, toJsonColumn } = require('../dbJson');
const { resolveEmbeddedIn } = require('./targetResolvers');
const { getWorkerSettings } = require('../services/settings');
const { writeTaskLogSafely: log } = require('./taskLog');

const { stopReason, wait } = require('./taskControl');
async function readState(taskId) {
  const [rows] = await pool.query('SELECT target_titles_json FROM tasks WHERE id = ?', [taskId]);
  return parseJsonColumn(rows[0]?.target_titles_json, {}) || {};
}
async function saveState(taskId, key, state) {
  const json = await readState(taskId);
  json[key] = state;
  await pool.query('UPDATE tasks SET target_titles_json = ? WHERE id = ?', [toJsonColumn(json), taskId]);
}

/** Persist a separate checkpoint for each refresh phase; never change page-edit statuses. */
async function refresh(task, mwClient, { key, stage, label, method, discover }) {
  const stopped = await stopReason(task.id);
  if (stopped) return { stopped };
  let state = (await readState(task.id))[key];
  if (state?.complete) return { stopped: null };
  if (!state) {
    let discovered;
    try { discovered = await discover(); }
    catch (error) {
      if (error.refreshStopped) return { stopped: error.refreshStopped };
      await log({ taskId: task.id, stage, level: 'error', message: `${label}の対象取得に失敗しました: ${String(error.message || error)}` });
      throw error;
    }
    const titles = await filterExcluded(task, [...new Set(discovered)], mwClient);
    state = { titles, done: 0, failed: 0, method };
    await saveState(task.id, key, state);
    await log({ taskId: task.id, stage, message: `${label}を開始します（${titles.length}件、${method}）。` });
  }
  const usePurge = state.method === 'purge';
  const size = usePurge ? 50 : 1;
  const { nullEditIntervalMs } = await getWorkerSettings();
  for (let i = state.done; i < state.titles.length; i += size) {
    const reason = await stopReason(task.id);
    if (reason) return { stopped: reason };
    const originalBatch = state.titles.slice(i, i + size);
    const batch = await filterExcluded(task, originalBatch, mwClient);
    const stoppedAfterLookup = await stopReason(task.id);
    if (stoppedAfterLookup) return { stopped: stoppedAfterLookup };
    let failed = [];
    try {
      if (!batch.length) { /* explicitly excluded after a stopped update */ } else if (usePurge) {
        try { failed = (await mwClient.purgeWithLinkUpdate(batch)).failed; }
        catch (error) {
          if (error.mwCode !== 'ratelimited') throw error;
          const reason = await wait(Number(process.env.RATE_LIMIT_WAIT_MS || 60000), task.id);
          if (reason) return { stopped: reason };
          failed = (await mwClient.purgeWithLinkUpdate(batch)).failed;
        }
      } else await mwClient.nullEdit(batch[0]);
    } catch (error) {
      failed = batch;
      await log({ taskId: task.id, stage, level: 'warning', message: `${label}の更新に失敗しました: ${String(error.mwInfo || error.message || error)}` });
    }
    for (const title of failed) await log({ taskId: task.id, stage, pageTitle: title, level: 'warning', message: `${label}でリンク表・カテゴリ所属を更新できませんでした。` });
    state.failed += failed.length;
    state.done = i + originalBatch.length;
    await saveState(task.id, key, state);
    if (state.done < state.titles.length) {
      const reason = await wait(nullEditIntervalMs, task.id);
      if (reason) return { stopped: reason };
    }
  }
  const total = state.titles.length;
  state = { complete: true, total, failed: state.failed, method: state.method };
  await saveState(task.id, key, state);
  await log({ taskId: task.id, stage, level: state.failed ? 'warning' : 'info', message: `${label}が完了しました（${total}件中${state.failed}件失敗）。` });
  return { stopped: null };
}

async function refreshTemplateCallers(task, mwClient, method = 'purge') {
  return refresh(task, mwClient, { key: 'templateRefresh', stage: 1, method, label: '編集したTemplateの呼び出し先の更新', discover: async () => {
    const [rows] = await pool.query("SELECT page_title FROM task_pages WHERE task_id = ? AND stage = 1 AND namespace = 10 AND status = 'edited'", [task.id]);
    const titles = [];
    for (const row of rows) {
      const stopped = await stopReason(task.id);
      // Do not persist a partial discovery list as complete; resume discovers it again.
      if (stopped) throw Object.assign(new Error('呼び出し先の取得を中断しました'), { refreshStopped: stopped });
      const results = await resolveEmbeddedIn({ template: row.page_title, namespaces: null });
      if (results.truncated) await log({ taskId: task.id, stage: 1, pageTitle: row.page_title, level: 'warning', message: '呼び出し先の取得が上限で打ち切られました。取得済みのページだけ更新します。' });
      titles.push(...results.map((r) => r.title));
    }
    return titles;
  } });
}

async function purgeRemainingTargets(task, mwClient, replacements, resolveTargets) {
  return refresh(task, mwClient, { key: 'remainingRefresh', stage: 2, method: 'purge', label: '編集後に残る参照候補のpurge', discover: async () => {
    const titles = [];
    for (const rule of replacements) {
      if (rule.forceTargets || rule.templateType === 'revertEdits' || rule.targetSource?.type === 'manualList') continue;
      for (const stage of [1, 2]) {
        const stopped = await stopReason(task.id);
        if (stopped) throw Object.assign(new Error('残存候補の取得を中断しました'), { refreshStopped: stopped });
        const result = await resolveTargets(rule, stage);
        if (result.error || result.results.truncated) await log({ taskId: task.id, stage: 2, level: 'warning', message: `残存候補の再取得に注意があります: ${result.error || '上限で打ち切り'}` });
        titles.push(...result.results.map((r) => r.title));
      }
    }
    return titles;
  } });
}

module.exports = { stopReason, refreshTemplateCallers, purgeRemainingTargets, refresh };

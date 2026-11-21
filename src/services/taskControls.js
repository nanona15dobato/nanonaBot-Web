'use strict';
const { pool } = require('../db');
const { parseJsonColumn, toJsonColumn } = require('../dbJson');
const { validateTaskConfig } = require('../worker/taskConfig');
const waves = require('../worker/globalWaves');
const EDITABLE = ['queued', 'paused', 'emergency_stopped', 'expired'];
class TaskControlError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new TaskControlError(status, code, message); };
async function lookupTitles(titles) {
  const { MediaWikiBotClient } = require('../bot/mwClient');
  const config = require('../config');
  const reader = new MediaWikiBotClient({ apiUrl: config.wiki.apiUrl, userAgent: config.userAgent, anonymous: true });
  const result = [];
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const data = await reader.request({ action: 'query', prop: 'info', titles: batch.join('|') });
    const normalized = new Map((data.query?.normalized || []).map(n => [n.from, n.to]));
    const pages = new Map((data.query?.pages || []).map(p => [p.title, p]));
    for (const input of batch) {
      const page = pages.get(normalized.get(input) || input);
      if (!page || page.invalid || (!Number.isInteger(page.ns) || page.ns < 0)) fail(400, 'invalid_title', `ページ名を確認できません: ${input}`);
      result.push({ title: page.title, namespace: page.ns, exists: !page.missing });
    }
  }
  return result;
}
function createTaskControls({ db = pool, lookup = lookupTitles } = {}) {
  async function locked(id, fn) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM tasks WHERE id = ? FOR UPDATE', [id]);
      if (!rows[0]) fail(404, 'not_found', 'タスクが見つかりません。');
      const result = await fn(conn, rows[0]);
      await conn.commit(); return result;
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  }
  async function audit(conn, id, user, message) {
    await conn.query('INSERT INTO task_logs (task_id, level, message, created_at) VALUES (?, ?, ?, NOW())', [id, 'info', `${message}（操作: ${user}）`]);
  }
  function editable(task, revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) fail(400, 'invalid_revision', '変更前のタスク版番号が必要です。画面を更新してください。');
    if (Number(task.control_revision || 0) !== revision) fail(409, 'revision_conflict', '別の操作で設定・対象が変更されました。画面を更新して内容を確認してください。');
    if (!EDITABLE.includes(task.status) || task.worker_active || task.pause_requested) fail(409, 'task_busy', '一時停止が完了してから変更してください。実行中・停止処理中・終了済みのタスクは変更できません。');
  }
  async function replan(conn, task, config) {
    await conn.query("UPDATE task_pages SET status = 'failed', error_message = ? WHERE task_id = ? AND status = 'editing'", ['編集中断の結果が不明です。ページ履歴を確認してください。', task.id]);
    await conn.query("DELETE FROM task_pages WHERE task_id = ? AND status IN ('pending','preparing','prepared','awaiting_review','approved')", [task.id]);
    await conn.query('DELETE FROM task_warnings WHERE task_id = ?', [task.id]);
    const [counts] = await conn.query('SELECT COUNT(*) AS cnt FROM task_pages WHERE task_id = ?', [task.id]);
    const revision = Number(task.control_revision || 0) + 1;
    const state = { replan: true, enumeratedStages: [], revision };
    await conn.query(`UPDATE tasks SET config_json = ?, account = ?, mode = ?, target_titles_json = ?,
      control_revision = ?, current_stage = 1, stage_count = ?, progress_current = ?, progress_total = ?, review_timeout_at = NULL,
      updated_at = NOW() WHERE id = ?`, [toJsonColumn(config), config.account, config.reviewSettings.mode, toJsonColumn(state), revision,
      waves.isGlobalConfig(config) ? waves.stageCount(config.replacements) : waves.legacyStageCount(config.replacements), counts[0].cnt, counts[0].cnt, task.id]);
    return { ok: true, revision };
  }
  async function pause(id, user) {
    return locked(id, async (conn, task) => {
      if (task.status === 'queued') {
        await conn.query("UPDATE tasks SET status = 'paused', pause_requested = 0, updated_at = NOW() WHERE id = ?", [id]);
        await audit(conn, id, user, '待機中のタスクを一時停止しました'); return { ok: true, paused: true };
      }
      if (task.status === 'running') {
        await conn.query('UPDATE tasks SET pause_requested = 1, updated_at = NOW() WHERE id = ?', [id]);
        await audit(conn, id, user, '一時停止を要求しました。進行中の処理の終了を待っています'); return { ok: true, paused: false };
      }
      if (['paused', 'emergency_stopped', 'expired'].includes(task.status)) return { ok: true, paused: !task.worker_active && !task.pause_requested };
      fail(409, 'not_pausable', 'このタスクは一時停止できる状態ではありません。');
    });
  }
  async function updateConfig(id, user, config, revision) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail(400, 'invalid_config', 'タスク設定が必要です。');
    return locked(id, async (conn, task) => {
      editable(task, revision);
      const old = parseJsonColumn(task.config_json, {});
      const next = { ...old, ...config, workflowVersion: old.workflowVersion };
      if (waves.isFixedPlan(old.replacements) && JSON.stringify(old.replacements) !== JSON.stringify(next.replacements)) fail(400, 'fixed_rules', '固定対象の再試行・一括取り消しでは置換ルールを変更できません。編集設定は変更できます。');
      const validation = validateTaskConfig(next);
      if (!validation.valid) fail(400, 'invalid_config', validation.errors.join('\n'));
      const result = await replan(conn, task, next);
      await audit(conn, id, user, 'タスク設定を変更しました。未処理の対象・差分・承認は再開時に作り直します'); return result;
    });
  }
  async function updateTargets(id, user, body) {
    const lists = {};
    for (const key of ['add', 'exclude', 'restore']) {
      const value = body[key] === undefined ? [] : body[key];
      if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim() || v.trim().length > 512 || /[|#\u0000-\u001f]/.test(v))) fail(400, 'invalid_titles', '対象は節を含まないページ名の配列で指定してください。');
      lists[key] = [...new Set(value.map(v => v.trim()))];
    }
    const names = [...new Set(Object.values(lists).flat())];
    if (!names.length || names.length > 200) fail(400, 'invalid_titles', '1回の変更は1〜200ページにしてください。');
    const resolved = await lookup(names);
    if (resolved.length !== names.length) fail(502, 'title_lookup_failed', 'ページ名の照合に失敗しました。');
    const mapping = new Map(names.map((n, i) => [n, resolved[i]]));
    for (const key of Object.keys(lists)) lists[key] = [...new Map(lists[key].map(n => [mapping.get(n).title, mapping.get(n)])).values()];
    const all = Object.values(lists).flat().map(p => p.title);
    if (new Set(all).size !== all.length) fail(400, 'conflicting_targets', '同じページを追加・除外・除外解除へ同時に指定できません。');
    if (lists.add.some(p => !p.exists)) fail(400, 'missing_page', '追加対象には存在するページを指定してください。');
    return locked(id, async (conn, task) => {
      editable(task, body.revision);
      const config = parseJsonColumn(task.config_json, {});
      if (lists.add.length && config.replacements.some(r => r.templateType === 'revertEdits')) fail(400, 'fixed_revert_targets', '一括取り消しに、元の編集情報がないページは追加できません。');
      if (lists.add.length) {
        const [edited] = await conn.query("SELECT page_title FROM task_pages WHERE task_id = ? AND status = 'edited' AND page_title COLLATE utf8mb4_bin IN (?) UNION SELECT page_title FROM edit_log WHERE task_id = ? AND status = 'edited' AND page_title COLLATE utf8mb4_bin IN (?)", [id, lists.add.map(p => p.title), id, lists.add.map(p => p.title)]);
        if (edited.length) fail(409, 'already_edited', '編集済みのページはこのタスクに再追加できません。別のタスクを作成してください。');
      }
      for (const p of lists.add) {
        await conn.query(`INSERT INTO task_target_overrides (task_id,page_title,namespace,added,excluded,updated_by) VALUES (?,?,?,1,0,?)
          ON DUPLICATE KEY UPDATE namespace=VALUES(namespace), added=1, excluded=0, updated_by=VALUES(updated_by)`, [id,p.title,p.namespace,user]);
        await conn.query("DELETE FROM task_pages WHERE task_id = ? AND page_title COLLATE utf8mb4_bin = ? AND status IN ('failed','skipped','rejected')", [id,p.title]);
      }
      for (const p of lists.exclude) await conn.query(`INSERT INTO task_target_overrides (task_id,page_title,namespace,added,excluded,updated_by) VALUES (?,?,?,0,1,?)
        ON DUPLICATE KEY UPDATE excluded=1, updated_by=VALUES(updated_by)`, [id,p.title,p.namespace,user]);
      for (const p of lists.restore) await conn.query('UPDATE task_target_overrides SET excluded=0, updated_by=? WHERE task_id=? AND page_title=?', [user,id,p.title]);
      const result = await replan(conn, task, config);
      await audit(conn, id, user, `対象を変更しました（追加${lists.add.length}件・除外${lists.exclude.length}件・除外解除${lists.restore.length}件）。追加ページには全置換ルールを適用します`);
      return { ...result, added: lists.add.length, excluded: lists.exclude.length, restored: lists.restore.length };
    });
  }
  return { pause, updateConfig, updateTargets };
}
module.exports = { ...createTaskControls(), createTaskControls, TaskControlError, EDITABLE };

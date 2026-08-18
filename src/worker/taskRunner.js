'use strict';

const { pool } = require('../db');
const { getClient } = require('../bot/accounts');
const { parseJsonColumn, toJsonColumn } = require('../dbJson');
const { runStagePipeline } = require('./pipeline');
const { buildStepsForTemplateType, KNOWN_PRESET_TEMPLATE_TYPES } = require('./templatePresets');
const { resolveTargetSource, resolveCategoryMembers, resolveBacklinks, resolveEmbeddedIn } = require('./targetResolvers');
const { collectCategoryWarnings } = require('./categoryWarnings');

const WAVE_TEMPLATE_TYPES = ['linkRename', 'linkRename2'];
const CATEGORY_TEMPLATE_TYPES = ['categoryRename', 'categoryRemove'];

/**
 * config.replacements の各ルールに、実際に適用するsteps配列を付与した配列を返す。
 * "custom" はユーザー指定のstepsをそのまま使う。テンプレート系（5種類）は
 * templatePresets.js で自動生成する（仕様書6章。ハットノート正規表現の修正済み版を使用）。
 */
function materializeReplacements(replacements) {
  return (replacements || []).map((rule) => {
    if (rule.templateType === 'custom') return rule;
    if (KNOWN_PRESET_TEMPLATE_TYPES.includes(rule.templateType)) {
      const steps = buildStepsForTemplateType(rule.templateType, { from: rule.from, to: rule.to });
      return { ...rule, steps };
    }
    throw new Error(`materializeReplacements: 未知のtemplateType "${rule.templateType}"`);
  });
}

function computeStageCount(replacements) {
  return replacements.some((r) => WAVE_TEMPLATE_TYPES.includes(r.templateType)) ? 2 : 1;
}

/** そのルールが指定ステージで対象ページ収集の対象になるか。 */
function ruleAppliesToStage(rule, stage) {
  if (WAVE_TEMPLATE_TYPES.includes(rule.templateType)) return stage === 1 || stage === 2;
  // custom/categoryRename/categoryRemove/templateRename はステージ1のみ
  return stage === 1;
}

/**
 * 1ルール・1ステージ分の対象ページを解決する。
 * @returns {Promise<{results: Array<{title:string, namespace:number}>, error: string|null}>}
 */
async function resolveRuleTargetsForStage(rule, stage) {
  switch (rule.templateType) {
    case 'custom':
      if (rule.targetSource.type === 'manualList') {
        const results = (rule.targetSource.titles || [])
          .map((t) => String(t).trim())
          .filter(Boolean)
          .map((title) => ({ title, namespace: null })); // manualListは名前空間不明のため null（表示用途のみ）
        return { results, error: null };
      }
      return resolveTargetSource(rule.targetSource);

    case 'linkRename':
    case 'linkRename2':
      if (stage === 1) {
        // ウェーブ1: Template名前空間固定（仕様書6.1/6.2節）
        return { results: await resolveBacklinks({ page: rule.from, namespaces: [10] }), error: null };
      }
      // ウェーブ2: その他ページ（既定ns=0、複数選択可）。ウェーブ1の編集完了後に再取得する。
      return { results: await resolveBacklinks({ page: rule.from, namespaces: rule.namespaces || [0] }), error: null };

    case 'categoryRename':
    case 'categoryRemove':
      return {
        results: await resolveCategoryMembers({ category: rule.from, namespaces: rule.namespaces ?? null }),
        error: null,
      };

    case 'templateRename':
      return { results: await resolveEmbeddedIn({ template: rule.from, namespaces: rule.namespaces || [0] }), error: null };

    default:
      throw new Error(`resolveRuleTargetsForStage: 未知のtemplateType "${rule.templateType}"`);
  }
}

/**
 * 指定ステージの対象ページを列挙し、task_pagesへ投入する（そのステージが未列挙の場合のみ＝冪等）。
 * ウェーブ2は「ウェーブ1の全ページが編集完了してから」呼ばれる想定（runTask側で保証する）。
 */
async function enumerateStageIfNeeded(task, replacements, stage) {
  const [existingCountRows] = await pool.query(
    'SELECT COUNT(*) AS cnt FROM task_pages WHERE task_id = ? AND stage = ?',
    [task.id, stage]
  );
  if (existingCountRows[0].cnt > 0) return; // 既に列挙済み（再開等）

  const titleToInfo = new Map(); // title -> { namespace, ruleIndices: Set }
  const stageErrors = [];

  for (let idx = 0; idx < replacements.length; idx++) {
    const rule = replacements[idx];
    if (!ruleAppliesToStage(rule, stage)) continue;

    const { results, error } = await resolveRuleTargetsForStage(rule, stage);
    if (error) {
      stageErrors.push(`replacements[${idx}] (${rule.templateType}): ${error}`);
    }
    for (const item of results) {
      if (!titleToInfo.has(item.title)) {
        titleToInfo.set(item.title, { namespace: item.namespace, ruleIndices: new Set() });
      }
      titleToInfo.get(item.title).ruleIndices.add(idx);
    }
  }

  const titles = [...titleToInfo.keys()];

  if (stageErrors.length > 0) {
    console.warn(`[taskRunner] タスク${task.id} stage${stage} 対象取得で一部エラー:`, stageErrors.join(' / '));
  }

  if (titles.length === 0) {
    // このステージの対象が0件。ウェーブ2でよくあるケース（9章: 0件でも必ず実行する。
    // 実行した結果0件だったのはウェーブ1の結果とは独立した事実であり、異常ではない）。
    return;
  }

  const values = titles.map((title, i) => {
    const info = titleToInfo.get(title);
    return [task.id, stage, i, title, info.namespace ?? 0, toJsonColumn([...info.ruleIndices]), 'pending'];
  });

  await pool.query(
    `INSERT INTO task_pages
       (task_id, stage, order_index, page_title, namespace, matched_rule_indices, status)
     VALUES ?`,
    [values]
  );

  const [taskRows] = await pool.query('SELECT target_titles_json, progress_total FROM tasks WHERE id = ?', [task.id]);
  const existingTitlesJson = parseJsonColumn(taskRows[0].target_titles_json, {});
  existingTitlesJson[String(stage)] = titles;
  const newProgressTotal = (taskRows[0].progress_total || 0) + titles.length;

  await pool.query('UPDATE tasks SET target_titles_json = ?, progress_total = ?, current_stage = ? WHERE id = ?', [
    toJsonColumn(existingTitlesJson),
    newProgressTotal,
    stage,
    task.id,
  ]);
}

/**
 * Category系ルール（categoryRename/categoryRemove）について、
 * Template:リダイレクトの所属カテゴリ絡みの警告を収集する（仕様書6.3/6.4節・8章）。
 * 主対象の編集とは独立しており、検出のみ・自動編集は行わない。1回のみ実行する（冪等）。
 */
async function collectWarningsIfNeeded(task, replacements, mwClient) {
  const [existingRows] = await pool.query('SELECT COUNT(*) AS cnt FROM task_warnings WHERE task_id = ?', [task.id]);
  if (existingRows[0].cnt > 0) return;

  const allWarnings = [];
  for (let idx = 0; idx < replacements.length; idx++) {
    const rule = replacements[idx];
    if (!CATEGORY_TEMPLATE_TYPES.includes(rule.templateType)) continue;
    try {
      const warnings = await collectCategoryWarnings({ from: rule.from, mwClient });
      for (const w of warnings) allWarnings.push({ ruleIndex: idx, ...w });
    } catch (err) {
      console.warn(`[taskRunner] タスク${task.id} replacements[${idx}] の警告収集に失敗:`, err.message || err);
    }
  }

  if (allWarnings.length === 0) return;

  const values = allWarnings.map((w) => [task.id, w.ruleIndex, w.pageTitle, w.namespace ?? 0, w.snippet || null]);
  await pool.query(`INSERT INTO task_warnings (task_id, rule_index, page_title, namespace, snippet) VALUES ?`, [
    values,
  ]);
}

/**
 * タスクを1件処理する（新規実行・一時停止からの再開いずれもこの関数を通る）。
 * ワーカーのメインループ（worker.js）から呼ばれる。
 * @param {object} task - tasksテーブルの1行
 */
async function runTask(task) {
  const config = parseJsonColumn(task.config_json, {});
  const replacements = materializeReplacements(config.replacements);

  const stageCount = computeStageCount(replacements);
  await pool.query('UPDATE tasks SET stage_count = ? WHERE id = ?', [stageCount, task.id]);

  if (config.reviewSettings && config.reviewSettings.mode === 'manual' && !task.review_timeout_at) {
    const timeoutAt = new Date(Date.now() + config.reviewSettings.manualTimeoutHours * 3600 * 1000);
    await pool.query('UPDATE tasks SET review_timeout_at = ? WHERE id = ?', [timeoutAt, task.id]);
  }

  const mwClient = await getClient(task.account);

  // Category系の警告収集は主対象の編集を待たず、同じ準備フェーズ内で並行して行える（9章）
  await collectWarningsIfNeeded(task, replacements, mwClient);

  // ---- ウェーブ1 ----
  await enumerateStageIfNeeded(task, replacements, 1);
  let result = await runStagePipeline({
    taskId: task.id,
    stage: 1,
    mwClient,
    account: task.account,
    replacements,
    editSettings: config.editSettings,
    reviewSettings: config.reviewSettings,
    onFailure: config.onFailure,
  });

  if (result.emergencyStopped) {
    await pool.query(`UPDATE tasks SET status = 'emergency_stopped', updated_at = NOW() WHERE id = ?`, [task.id]);
    return;
  }
  if (result.expired || result.paused) {
    return;
  }

  // ---- ウェーブ2（linkRename/linkRename2ルールがある場合のみ） ----
  if (stageCount === 2) {
    await enumerateStageIfNeeded(task, replacements, 2);
    result = await runStagePipeline({
      taskId: task.id,
      stage: 2,
      mwClient,
      account: task.account,
      replacements,
      editSettings: config.editSettings,
      reviewSettings: config.reviewSettings,
      onFailure: config.onFailure,
    });

    if (result.emergencyStopped) {
      await pool.query(`UPDATE tasks SET status = 'emergency_stopped', updated_at = NOW() WHERE id = ?`, [task.id]);
      return;
    }
    if (result.expired || result.paused) {
      return;
    }
  }

  // 最終ステータスは、実行中の一時的なhadFailuresではなく、
  // task_pages全体を見て「failedが1件でもあるか」で判定する
  // （resumeを挟んだ場合でも正しく判定できるようにするため）。
  const [failureCountRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM task_pages WHERE task_id = ? AND status = 'failed'`,
    [task.id]
  );
  const finalStatus = failureCountRows[0].cnt > 0 ? 'completed_with_failures' : 'completed';
  await pool.query(`UPDATE tasks SET status = ?, updated_at = NOW() WHERE id = ?`, [finalStatus, task.id]);
}

module.exports = {
  runTask,
  materializeReplacements,
  computeStageCount,
  ruleAppliesToStage,
};

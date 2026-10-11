'use strict';

const { pool } = require('../db');
const { getClient } = require('../bot/accounts');
const { parseJsonColumn, toJsonColumn } = require('../dbJson');
const { runStagePipeline } = require('./pipeline');
const { buildStepsForTemplateType, categoryTextSteps, KNOWN_PRESET_TEMPLATE_TYPES } = require('./templatePresets');
const {
  resolveTargetSource,
  resolveCategoryMembers,
  resolveBacklinks,
  resolveEmbeddedIn,
  resolveRegexSearch,
  resolveExtUrlUsage,
  MAX_RESULTS,
} = require('./targetResolvers');
const { collectCategoryWarnings } = require('./categoryWarnings');
const { findCandidatePages: findRedirectCategoryTemplatePages } = require('./redirectCategoryTemplate');
const { writeTaskLogSafely } = require('./taskLog');
const { isEmergencyStopped } = require('./emergencyStop');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ウェーブ1=Template名前空間 → ウェーブ2=その他ページ の2ウェーブで処理する種別 */
const WAVE_TEMPLATE_TYPES = ['linkRename', 'linkRename2', 'linkRenameExact', 'urlRename'];
/**
 * ウェーブ1=Template名前空間のカテゴリメンバー（編集後、そのテンプレートの使用ページをnull edit）
 * → ウェーブ2=カテゴリメンバーを取り直して残りを編集
 * → ウェーブ3=標準名前空間のうちTemplate:リダイレクトの所属カテゴリ・任意で「Category:旧」の記述があるページ
 * の3ウェーブで処理する種別
 */
const CATEGORY_TEMPLATE_TYPES = ['categoryRename', 'categoryRemove'];
const TEMPLATE_NAMESPACE = 10;
/** null edit（purge時は1バッチ）同士の間隔（ミリ秒）。版を作らない軽い操作のため通常の編集間隔より短くする。 */
const NULL_EDIT_INTERVAL_MS = Number(process.env.NULL_EDIT_INTERVAL_MS || 1000);
/** purge（forcelinkupdate）1リクエストあたりのページ数（action=purge の titles 上限） */
const PURGE_BATCH_SIZE = 50;
/** レート制限（ratelimited）に当たったときに待つ時間（ミリ秒） */
const RATE_LIMIT_WAIT_MS = Number(process.env.RATE_LIMIT_WAIT_MS || 60000);

/** 1ページをnull editし、失敗したページ名の配列を返す（例外はそのまま投げる）。 */
async function nullEditOne(mwClient, title) {
  await mwClient.nullEdit(title);
  return [];
}

/** purgeを1バッチ行い、更新できなかったページ名の配列を返す。レート制限時は待ってから1回だけやり直す。 */
async function purgeBatch(mwClient, titles) {
  try {
    return (await mwClient.purgeWithLinkUpdate(titles)).failed;
  } catch (err) {
    if (err.mwCode !== 'ratelimited') throw err;
    await sleep(RATE_LIMIT_WAIT_MS);
    return (await mwClient.purgeWithLinkUpdate(titles)).failed;
  }
}

/**
 * 未指定（旧APIクライアント等）は種別ごとの既定値を使うが、明示的なnullは
 * 「全名前空間」を表す。UIの「未選択=全名前空間」と同じ意味にそろえる。
 */
function namespacesOrDefault(namespaces, defaultNamespaces = [0]) {
  return namespaces === undefined ? defaultNamespaces : namespaces;
}

/**
 * config.replacements の各ルールに、実際に適用するsteps配列を付与した配列を返す。
 * "custom" はユーザー指定のstepsをそのまま使う。テンプレート系（5種類）は
 * templatePresets.js で自動生成する（仕様書6章。ハットノート正規表現の修正済み版を使用）。
 */
const NAMESPACE_PREFIXES_BY_TYPE = {
  categoryRename: /^\s*(?:Category|category|カテゴリ)\s*:\s*/,
  categoryRemove: /^\s*(?:Category|category|カテゴリ)\s*:\s*/,
  templateRename: /^\s*(?:Template|template|テンプレート)\s*:\s*/,
  templateSubst: /^\s*(?:Template|template|テンプレート)\s*:\s*/,
};

/**
 * from/toの前後空白と、種別ごとに不要な名前空間プレフィックス（画面上「省略可」としているもの）を除く。
 * 例: categoryRenameの "Category:日本の橋" → "日本の橋"。プレフィックス付きのまま置換パターンを作ると
 * "[[Category:Category:日本の橋]]" を探すことになり、何も置換されないため。
 */
function normalizeRuleName(templateType, name) {
  if (typeof name !== 'string') return name;
  const prefix = NAMESPACE_PREFIXES_BY_TYPE[templateType];
  const trimmed = name.trim();
  return prefix ? trimmed.replace(prefix, '') : trimmed;
}

function materializeReplacements(replacements) {
  return (replacements || []).map((rule) => {
    if (rule.templateType === 'custom') return rule;
    if (KNOWN_PRESET_TEMPLATE_TYPES.includes(rule.templateType)) {
      const from = normalizeRuleName(rule.templateType, rule.from);
      const to = normalizeRuleName(rule.templateType, rule.to);
      let steps = buildStepsForTemplateType(rule.templateType, { ...rule, from, to });
      // 「Category:旧 の記述も置換する」が選ばれたCategory置換（設定キーは互換のためfixCategoryLinksのまま）
      if (rule.templateType === 'categoryRename' && rule.fixCategoryLinks) {
        steps = [...steps, ...categoryTextSteps(from, to)];
      }
      return { ...rule, from, to, steps };
    }
    throw new Error(`materializeReplacements: 未知のtemplateType "${rule.templateType}"`);
  });
}

/** 1つのルールが必要とするウェーブ数。 */
function ruleStageCount(rule) {
  // forceTargets指定時（失敗ページ再試行。フェーズ6）はウェーブ分割せず常に1ステージで扱う
  if (rule.forceTargets) return 1;
  if (CATEGORY_TEMPLATE_TYPES.includes(rule.templateType)) return 3;
  if (WAVE_TEMPLATE_TYPES.includes(rule.templateType)) return 2;
  return 1;
}

function computeStageCount(replacements) {
  return Math.max(1, ...replacements.map(ruleStageCount));
}

/** そのルールが指定ステージで対象ページ収集の対象になるか。 */
function ruleAppliesToStage(rule, stage) {
  // custom/templateRename等はステージ1のみ、linkRename系は1・2、Category系は1〜3
  return stage >= 1 && stage <= ruleStageCount(rule);
}

/** namespaces指定（nullは全名前空間）にTemplate名前空間が含まれるか。 */
function includesTemplateNamespace(namespaces) {
  return !namespaces || namespaces.includes(TEMPLATE_NAMESPACE);
}

/**
 * 1ルール・1ステージ分の対象ページを解決する。
 * @param {object} rule
 * @param {number} stage
 * @param {import('../bot/mwClient').MediaWikiBotClient} [mwClient] - categoryRename/categoryRemoveで
 *   Template:リダイレクトの所属カテゴリの構造一致ページを調べるのに使う（省略時はスキップする）
 * @returns {Promise<{results: Array<{title:string, namespace:number}>, error: string|null}>}
 */
async function resolveRuleTargetsForStage(rule, stage, mwClient, options = {}) {
  // 失敗ページ再試行（フェーズ6）: 通常のtargetSource解決をバイパスし、
  // 指定されたページ名だけを対象にする。templateTypeによらず常に有効。
  if (rule.forceTargets) {
    const results = rule.forceTargets.map((title) => ({ title, namespace: null }));
    return { results, error: null };
  }

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
    case 'linkRenameExact':
      if (stage === 1) {
        // ウェーブ1: Template名前空間固定（仕様書6.1/6.2節）
        return { results: await resolveBacklinks({ page: rule.from, namespaces: [10] }), error: null };
      }
      // ウェーブ2: その他ページ（未指定時は既定ns=0、nullは全名前空間、複数選択可）。
      // ウェーブ1の編集完了後に再取得する。
      return { results: await resolveBacklinks({ page: rule.from, namespaces: namespacesOrDefault(rule.namespaces) }), error: null };

    case 'urlRename':
      // 外部リンクの付け替え（フェーズ10）: リンク置換と同じく、テンプレートを先に直す2ウェーブ構成
      if (stage === 1) return { results: await resolveExtUrlUsage({ url: rule.from, namespaces: [10] }), error: null };
      return { results: await resolveExtUrlUsage({ url: rule.from, namespaces: namespacesOrDefault(rule.namespaces) }), error: null };

    case 'categoryRename':
    case 'categoryRemove': {
      const namespaces = rule.namespaces ?? null; // 既定は全名前空間
      if (stage === 1) {
        // ウェーブ1: Template名前空間のカテゴリメンバー。テンプレートがカテゴリを付けている場合、
        // 先に直してから使用ページをnull editすることで、ウェーブ2の対象からそれらを外せる。
        if (!includesTemplateNamespace(namespaces)) return { results: [], error: null };
        return { results: await resolveCategoryMembers({ category: rule.from, namespaces: [TEMPLATE_NAMESPACE] }), error: null };
      }
      if (stage === 2) {
        // ウェーブ2: null edit後に取り直したカテゴリメンバーのうち、Template以外の残り
        const otherNamespaces = namespaces ? namespaces.filter((n) => n !== TEMPLATE_NAMESPACE) : null;
        if (otherNamespaces && otherNamespaces.length === 0) return { results: [], error: null };
        const members = await resolveCategoryMembers({ category: rule.from, namespaces: otherNamespaces });
        const results = members.filter((m) => m.namespace !== TEMPLATE_NAMESPACE);
        if (members.truncated) results.truncated = true;
        return { results, error: null };
      }
      return resolveCategoryMentionTargets(rule, mwClient, options.scanCache);
    }

    case 'templateRename':
      return { results: await resolveEmbeddedIn({ template: rule.from, namespaces: namespacesOrDefault(rule.namespaces) }), error: null };

    case 'unlinkPage':
      // リンク解除（BOTREQのDELETE_PAGE。フェーズ6）。既定ns=0、複数選択可。
      // linkRename系のような2ウェーブ構成は取らず単一ステージで扱う（簡易実装）。
      return { results: await resolveBacklinks({ page: rule.from, namespaces: namespacesOrDefault(rule.namespaces) }), error: null };

    case 'templateSubst':
      // テンプレートのsubst化（BOTREQのTemplate:X→subst:。フェーズ6）
      return { results: await resolveEmbeddedIn({ template: rule.from, namespaces: namespacesOrDefault(rule.namespaces) }), error: null };

    default:
      throw new Error(`resolveRuleTargetsForStage: 未知のtemplateType "${rule.templateType}"`);
  }
}

/**
 * Category系のウェーブ3: 標準名前空間（ns=0）のうち、旧カテゴリ名を本文に記述しているページを対象にする
 * （ルールの名前空間指定によらず常に標準名前空間のみ）。
 * - Template:リダイレクトの所属カテゴリ内で構造的にこのカテゴリ名を保持しているページ
 *   （8章で確認済みの書式にもとづき自動編集する。mwClient無しでは判定できないためスキップ）
 * - fixCategoryLinks指定時（Category置換のみ）は、「Category:旧」という記述を置換するため、
 *   カテゴリページのリンク元と insource:"Category:旧" の検索結果も加える（リンクになっていない
 *   記述は backlinks に出てこないため検索で補う）。該当箇所が無いページは準備段階で
 *   「変更なし」としてスキップされる。
 */
async function resolveCategoryMentionTargets(rule, mwClient, scanCache) {
  const MAIN_NAMESPACE = [0];
  const errors = [];

  let templateResults = [];
  if (mwClient) {
    try {
      templateResults = await findRedirectCategoryTemplatePages({ category: rule.from, mwClient, cache: scanCache });
    } catch (err) {
      console.warn(
        `[taskRunner] Template:リダイレクトの所属カテゴリの対象確認に失敗しました（${rule.from}）:`,
        err.message || err
      );
    }
  }

  let mentionResults = [];
  if (rule.templateType === 'categoryRename' && rule.fixCategoryLinks) {
    const backlinks = await resolveBacklinks({ page: `Category:${rule.from}`, namespaces: MAIN_NAMESPACE });
    const search = await resolveRegexSearch({
      query: `insource:"Category:${rule.from.replace(/"/g, '')}"`,
      namespaces: MAIN_NAMESPACE,
    });
    if (search.error) errors.push(`insource検索: ${search.error}`);
    mentionResults = [...backlinks, ...search.results];
    if (backlinks.truncated || search.results.truncated) mentionResults.truncated = true;
  }

  const seen = new Set();
  const merged = [];
  for (const p of [...templateResults, ...mentionResults]) {
    if (p.namespace !== 0 || seen.has(p.title)) continue;
    seen.add(p.title);
    merged.push(p);
  }
  if (mentionResults.truncated) merged.truncated = true;
  return { results: merged, error: errors.length > 0 ? errors.join(' / ') : null };
}

/**
 * 指定ステージの対象ページを列挙し、task_pagesへ投入する（そのステージが未列挙の場合のみ＝冪等）。
 * ウェーブ2は「ウェーブ1の全ページが編集完了してから」呼ばれる想定（runTask側で保証する）。
 * @param {object} task
 * @param {Array} replacements
 * @param {number} stage
 * @param {import('../bot/mwClient').MediaWikiBotClient} mwClient
 */
async function enumerateStageIfNeeded(task, replacements, stage, mwClient, options = {}) {
  const [existingCountRows] = await pool.query(
    'SELECT COUNT(*) AS cnt FROM task_pages WHERE task_id = ? AND stage = ?',
    [task.id, stage]
  );
  if (existingCountRows[0].cnt > 0) {
    return { alreadyEnumerated: true, targetCount: existingCountRows[0].cnt, errors: [] };
  }

  const titleToInfo = new Map(); // title -> { namespace, ruleIndices: Set }
  const stageErrors = [];

  for (let idx = 0; idx < replacements.length; idx++) {
    const rule = replacements[idx];
    if (!ruleAppliesToStage(rule, stage)) continue;

    const { results, error } = await resolveRuleTargetsForStage(rule, stage, mwClient, options);
    if (error) {
      stageErrors.push(`replacements[${idx}] (${rule.templateType}): ${error}`);
    }
    if (results.truncated) {
      stageErrors.push(
        `replacements[${idx}] (${rule.templateType}): 対象ページが上限（${MAX_RESULTS}件）に達したため、以降は取得していません`
      );
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
    return { alreadyEnumerated: false, targetCount: 0, errors: stageErrors };
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
  return { alreadyEnumerated: false, targetCount: titles.length, errors: stageErrors };
}

/**
 * Category系ルール（categoryRename/categoryRemove）について、
 * Template:リダイレクトの所属カテゴリ絡みの警告を収集する（仕様書6.3/6.4節・8章）。
 * 主対象の編集とは独立しており、検出のみ・自動編集は行わない。1回のみ実行する（冪等）。
 */
async function collectWarningsIfNeeded(task, replacements, mwClient, scanCache) {
  const [existingRows] = await pool.query('SELECT COUNT(*) AS cnt FROM task_warnings WHERE task_id = ?', [task.id]);
  if (existingRows[0].cnt > 0) return;

  const allWarnings = [];
  for (let idx = 0; idx < replacements.length; idx++) {
    const rule = replacements[idx];
    if (!CATEGORY_TEMPLATE_TYPES.includes(rule.templateType)) continue;
    try {
      const warnings = await collectCategoryWarnings({ from: rule.from, mwClient, cache: scanCache });
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
 * Category系ルールのウェーブ1で編集したテンプレートについて、そのテンプレートを使用している
 * ページをnull editし、カテゴリ所属を即座に再計算させる（ジョブキューの反映待ちをしない）。
 * これによりウェーブ2で取り直すカテゴリメンバーから、テンプレート経由で所属していた
 * ページが外れ、本文に [[Category:旧]] を持つページだけが残る。
 * 完了したらtarget_titles_jsonに印を付け、再開時に繰り返さない。
 *
 * @returns {Promise<{stopped: null|'emergency'|'cancelled'}>}
 */
async function nullEditTemplateTransclusionsIfNeeded(task, replacements, mwClient, method = 'nullEdit') {
  const targetTitles = await readTargetTitlesJson(task.id);
  if (targetTitles.nullEditDone) return { stopped: null };

  // 前回の実行が途中で止まっていれば、保存しておいた対象一覧の続きから再開する（フェーズ10）
  const saved = targetTitles.nullEdit;
  if (saved && Array.isArray(saved.titles)) {
    return runNullEdits(task, mwClient, method, saved.titles, Number(saved.done) || 0, saved.templateCount || 0);
  }

  const categoryRuleIndices = new Set(
    replacements
      .map((r, i) => (CATEGORY_TEMPLATE_TYPES.includes(r.templateType) && !r.forceTargets ? i : -1))
      .filter((i) => i >= 0)
  );
  const [templateRows] = await pool.query(
    `SELECT page_title, matched_rule_indices FROM task_pages
     WHERE task_id = ? AND stage = 1 AND namespace = ? AND status = 'edited'`,
    [task.id, TEMPLATE_NAMESPACE]
  );
  const editedTemplates = templateRows
    .filter((row) => parseJsonColumn(row.matched_rule_indices, []).some((i) => categoryRuleIndices.has(i)))
    .map((row) => row.page_title);

  const titles = [];
  const seen = new Set();
  for (const template of editedTemplates) {
    const transclusions = await resolveEmbeddedIn({ template, namespaces: null });
    for (const { title } of transclusions) {
      if (seen.has(title)) continue;
      seen.add(title);
      titles.push(title);
    }
  }

  // 対象一覧を保存してから始める（途中で止まっても再開時に同じ一覧の続きから処理できるように）
  await updateTargetTitlesJson(task.id, (json) => {
    json.nullEdit = { titles, done: 0, templateCount: editedTemplates.length };
  });
  return runNullEdits(task, mwClient, method, titles, 0, editedTemplates.length);
}

async function readTargetTitlesJson(taskId) {
  const [rows] = await pool.query('SELECT target_titles_json FROM tasks WHERE id = ?', [taskId]);
  return parseJsonColumn(rows[0] && rows[0].target_titles_json, {}) || {};
}

/** target_titles_json を読み直してから書き換える（他の項目を上書きしないように）。 */
async function updateTargetTitlesJson(taskId, mutate) {
  const json = await readTargetTitlesJson(taskId);
  mutate(json);
  await pool.query('UPDATE tasks SET target_titles_json = ? WHERE id = ?', [toJsonColumn(json), taskId]);
}

/** null edit 1件ごとに進捗を保存すると書き込みが多すぎるため、この件数ごとに保存する */
const NULL_EDIT_PROGRESS_SAVE_EVERY = 10;

/**
 * 保存済みの対象一覧 titles を startIndex 件目から null edit / purge する。
 * 進捗（処理済み件数）を定期的に保存し、止まった場合も次回はその続きから再開する。
 */
async function runNullEdits(task, mwClient, method, titles, startIndex, templateCount) {
  const usePurge = method === 'purge';
  const methodLabel = usePurge ? 'purge（forcelinkupdate）' : 'null edit';
  const batchSize = usePurge ? PURGE_BATCH_SIZE : 1;
  const saveProgress = (done) =>
    updateTargetTitlesJson(task.id, (json) => {
      if (json.nullEdit) json.nullEdit.done = done;
    });

  if (titles.length > 0) {
    await writeTaskLogSafely({
      taskId: task.id,
      stage: 1,
      level: 'info',
      message:
        startIndex > 0
          ? `使用ページの${methodLabel}を前回の続き（${startIndex + 1}/${titles.length}件目）から再開します。`
          : `編集したテンプレート${templateCount}件の使用ページ${titles.length}件を${methodLabel}で更新します。`,
    });
  }

  let failures = 0;
  let sinceSave = 0;
  for (let i = startIndex; i < titles.length; i += batchSize) {
    if (await isEmergencyStopped()) {
      await saveProgress(i);
      return { stopped: 'emergency' };
    }
    const [statusRows] = await pool.query('SELECT status FROM tasks WHERE id = ?', [task.id]);
    if (!statusRows[0] || statusRows[0].status === 'cancelled') {
      await saveProgress(i);
      return { stopped: 'cancelled' };
    }

    const batch = titles.slice(i, i + batchSize);
    try {
      const failedTitles = usePurge ? await purgeBatch(mwClient, batch) : await nullEditOne(mwClient, batch[0]);
      for (const title of failedTitles) {
        failures++;
        await writeTaskLogSafely({
          taskId: task.id,
          stage: 1,
          pageTitle: title,
          level: 'warning',
          message: `${methodLabel}できませんでした（ページが存在しない等）。`,
        });
      }
    } catch (err) {
      failures += batch.length;
      await writeTaskLogSafely({
        taskId: task.id,
        stage: 1,
        pageTitle: batch.length === 1 ? batch[0] : null,
        level: 'warning',
        message: `${methodLabel}に失敗しました（${batch.length}件）: ${String((err && (err.mwInfo || err.message)) || err)}`,
      });
    }
    sinceSave += batch.length;
    if (usePurge || sinceSave >= NULL_EDIT_PROGRESS_SAVE_EVERY) {
      await saveProgress(i + batch.length);
      sinceSave = 0;
    }
    if (i + batchSize < titles.length) await sleep(NULL_EDIT_INTERVAL_MS);
  }

  if (titles.length > 0) {
    const processed = titles.length - startIndex;
    await writeTaskLogSafely({
      taskId: task.id,
      stage: 1,
      level: failures > 0 ? 'warning' : 'info',
      message:
        failures > 0
          ? `${methodLabel}が完了しました（${processed}件中${failures}件失敗）。`
          : `${methodLabel}が完了しました（${processed}件）。`,
    });
  }

  // 完了したら対象一覧は消し、完了印だけを残す（再開時に繰り返さない）
  await updateTargetTitlesJson(task.id, (json) => {
    delete json.nullEdit;
    json.nullEditDone = true;
  });
  return { stopped: null };
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
  await writeTaskLogSafely({
    taskId: task.id,
    level: 'info',
    message: `タスクの実行を開始しました（${stageCount}ウェーブ構成）。`,
  });

  if (config.reviewSettings && config.reviewSettings.mode === 'manual' && !task.review_timeout_at) {
    const timeoutAt = new Date(Date.now() + config.reviewSettings.manualTimeoutHours * 3600 * 1000);
    await pool.query('UPDATE tasks SET review_timeout_at = ? WHERE id = ?', [timeoutAt, task.id]);
  }

  const mwClient = await getClient(task.account);

  // Category系の警告収集とウェーブ3の対象確認は、同じリンク元ページの本文を使うため
  // タスク実行中は走査結果を共有する（フェーズ9）
  const scanCache = new Map();

  // Category系の警告収集は主対象の編集を待たず、同じ準備フェーズ内で並行して行える（9章）
  await collectWarningsIfNeeded(task, replacements, mwClient, scanCache);

  const hasCategoryWaves = replacements.some((r) => ruleStageCount(r) === 3);

  for (let stage = 1; stage <= stageCount; stage++) {
    const label = `ウェーブ${stage}`;
    await pool.query('UPDATE tasks SET current_stage = ? WHERE id = ?', [stage, task.id]);

    // 前のウェーブの編集完了後に対象を取り直す（前のウェーブの対象が0件でも後続ウェーブは必ず実行する）
    await writeTaskLogSafely({ taskId: task.id, stage, level: 'info', message: `${label}の対象ページを取得します。` });
    const enumeration = await enumerateStageIfNeeded(task, replacements, stage, mwClient, { scanCache });
    await writeTaskLogSafely({
      taskId: task.id,
      stage,
      level: enumeration.errors.length > 0 ? 'warning' : 'info',
      // 取得時の警告（検索エラー・件数上限での打ち切り等）は内容もWeb上で確認できるようにする
      message:
        (enumeration.alreadyEnumerated
          ? `${label}は既に列挙済みです（${enumeration.targetCount}件）。`
          : `${label}の対象ページ取得が完了しました（${enumeration.targetCount}件）。`) +
        (enumeration.errors.length > 0 ? ` 注意: ${enumeration.errors.join(' / ')}` : ''),
    });

    const result = await runStagePipeline({
      taskId: task.id,
      stage,
      mwClient,
      account: task.account,
      replacements,
      editSettings: config.editSettings,
      reviewSettings: config.reviewSettings,
      onFailure: config.onFailure,
    });

    if (result.emergencyStopped) {
      await writeTaskLogSafely({ taskId: task.id, stage, level: 'warning', message: `緊急停止を検知したため、${label}を中断しました。` });
      await pool.query(`UPDATE tasks SET status = 'emergency_stopped', updated_at = NOW() WHERE id = ?`, [task.id]);
      return;
    }
    if (result.expired || result.paused) {
      await writeTaskLogSafely({
        taskId: task.id,
        stage,
        level: result.expired ? 'warning' : 'error',
        message: result.expired ? `レビュー期限切れのため、${label}を終了しました。` : `失敗により、${label}を一時停止しました。`,
      });
      return;
    }
    if (result.cancelled) {
      await writeTaskLogSafely({ taskId: task.id, stage, level: 'info', message: 'タスクが中止されました。' });
      return;
    }
    await writeTaskLogSafely({
      taskId: task.id,
      stage,
      level: result.hadFailures ? 'warning' : 'info',
      message: result.hadFailures ? `${label}が完了しました（一部ページは失敗）。` : `${label}が完了しました。`,
    });

    // Category系: ウェーブ1で直したテンプレートの使用ページをnull editしてからウェーブ2を取得する
    if (stage === 1 && hasCategoryWaves) {
      const linkUpdateMethod = (config.editSettings && config.editSettings.linkUpdateMethod) || 'nullEdit';
      const { stopped } = await nullEditTemplateTransclusionsIfNeeded(task, replacements, mwClient, linkUpdateMethod);
      if (stopped === 'emergency') {
        await writeTaskLogSafely({ taskId: task.id, stage, level: 'warning', message: '緊急停止を検知したため、null editを中断しました。' });
        await pool.query(`UPDATE tasks SET status = 'emergency_stopped', updated_at = NOW() WHERE id = ?`, [task.id]);
        return;
      }
      if (stopped === 'cancelled') {
        await writeTaskLogSafely({ taskId: task.id, stage, level: 'info', message: 'タスクが中止されました。' });
        return;
      }
    }
  }

  // 最終ステータスは、実行中の一時的なhadFailuresではなく、
  // task_pages全体を見て「failedが1件でもあるか」で判定する
  // （resumeを挟んだ場合でも正しく判定できるようにするため）。
  const [currentTaskRows] = await pool.query('SELECT status FROM tasks WHERE id = ?', [task.id]);
  if (!currentTaskRows[0] || currentTaskRows[0].status === 'cancelled') {
    await writeTaskLogSafely({ taskId: task.id, level: 'info', message: 'タスクが中止されました。' });
    return;
  }
  const [failureCountRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM task_pages WHERE task_id = ? AND status = 'failed'`,
    [task.id]
  );
  const finalStatus = failureCountRows[0].cnt > 0 ? 'completed_with_failures' : 'completed';
  await pool.query(`UPDATE tasks SET status = ?, updated_at = NOW() WHERE id = ?`, [finalStatus, task.id]);
  await writeTaskLogSafely({
    taskId: task.id,
    level: finalStatus === 'completed' ? 'info' : 'warning',
    message: finalStatus === 'completed' ? 'タスクが完了しました。' : 'タスクが完了しました（失敗したページがあります）。',
  });
}

module.exports = {
  runTask,
  materializeReplacements,
  computeStageCount,
  ruleAppliesToStage,
  namespacesOrDefault,
  resolveRuleTargetsForStage,
  nullEditTemplateTransclusionsIfNeeded,
};

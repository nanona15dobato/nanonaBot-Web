'use strict';

const { pool } = require('../db');
const { applyReplacementSteps } = require('./regexEngine');
const { isEmergencyStopped } = require('./emergencyStop');
const { writeEditLog } = require('./editLog');
const { parseJsonColumn } = require('../dbJson');
const { renameCategoryInTemplate, removeCategoryFromTemplate } = require('./redirectCategoryTemplate');
const { removePageFromHatnotes } = require('./hatnoteUnlink');
const { writeTaskLogSafely } = require('./taskLog');
const { undoEdits } = require('./undoMerge');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 承認待ちの確認間隔・再試行の回数と間隔は、設定画面（DB）→ 環境変数 → 既定値 の順で決まる（フェーズ11）。
// 画面での承認から編集開始までの遅れは、承認待ちの確認間隔（既定500ms）以内になる。
const { getWorkerSettings } = require('../services/settings');

/**
 * 正規表現では安全に扱えない、テンプレート引数の構造にもとづく書き換えを行う。
 * - categoryRename/categoryRemove: Template:リダイレクトの所属カテゴリ内の該当カテゴリ引数
 *   （仕様書6.3/6.4節・8章）
 * - unlinkPage: 一覧型ハットノート（{{See also}}等）内の該当ページ引数（フェーズ9）
 * 該当箇所が無ければ何もしない（安全に無変化で返る）。
 * @param {string} wikitext
 * @param {Array} matchedRules
 * @returns {string}
 */
function applyRedirectCategoryTemplateEdits(wikitext, matchedRules) {
  let text = wikitext;
  for (const rule of matchedRules) {
    if (rule.templateType === 'categoryRename') {
      text = renameCategoryInTemplate(text, rule.from, rule.to).wikitext;
    } else if (rule.templateType === 'categoryRemove') {
      text = removeCategoryFromTemplate(text, rule.from).wikitext;
    } else if (rule.templateType === 'unlinkPage') {
      text = removePageFromHatnotes(text, rule.from).wikitext;
    }
  }
  return text;
}

/**
 * ページ本文に、そのページに該当するルールを適用した結果を返す（準備・編集競合後の作り直しで共通）。
 * @returns {string}
 */
function buildNewWikitext(wikitext, row, ctx) {
  const ruleIndices = parseJsonColumn(row.matched_rule_indices, []);
  const matchedRules = ruleIndices.map((idx) => ctx.replacements[idx]).filter(Boolean);
  const steps = matchedRules.flatMap((r) => r.steps || []);
  // Category置換/除去ルールが含まれる場合は{{リダイレクトの所属カテゴリ}}内の該当カテゴリ引数を、
  // リンク解除ルールが含まれる場合はハットノート内の該当ページ引数を併せて書き換える
  // （該当が無いページには影響しない）
  return applyRedirectCategoryTemplateEdits(applyReplacementSteps(wikitext, steps), matchedRules);
}

// ===== 一括取り消し（フェーズ12） =====

/** このページに当てはまる一括取り消しのルール（無ければ null）。 */
function findRevertRule(row, ctx) {
  const ruleIndices = parseJsonColumn(row.matched_rule_indices, []);
  for (const idx of ruleIndices) {
    const rule = ctx.replacements[idx];
    if (rule && rule.templateType === 'revertEdits') return rule;
  }
  return null;
}

/** このページが一括取り消しの対象なら、取り消す編集（{ revid, baseRevid, edits }）を返す。 */
function findRevertTarget(row, ctx) {
  const ruleIndices = parseJsonColumn(row.matched_rule_indices, []);
  for (const idx of ruleIndices) {
    const rule = ctx.replacements[idx];
    if (rule && rule.templateType === 'revertEdits') {
      return (rule.targets || []).find((t) => t.title === row.page_title) || { missing: true };
    }
  }
  return null;
}

/** 取り消しをしないページ（後に他の編集がある等）を、理由つきのスキップにする。 */
async function skipRevert(row, page, reason) {
  await pool.query(
    `UPDATE task_pages SET status = 'skipped', error_message = ?, original_wikitext = ?, prepared_at = NOW() WHERE id = ?`,
    [reason, page ? page.wikitext : null, row.id]
  );
  return { status: 'skipped', row, page };
}

/** 取り消す編集の一覧（古い順）。旧形式（edits なし）の対象は1回の編集として扱う。 */
function revertEditsOf(target) {
  if (Array.isArray(target.edits) && target.edits.length > 0) return target.edits;
  return [{ revid: target.revid, baseRevid: target.baseRevid }];
}

/** そのタスクの編集どうしの間に、他の人の編集が挟まっていないか（各編集の元の版が1つ前の編集の版と一致する）。 */
function isContiguous(edits) {
  for (let i = 1; i < edits.length; i++) {
    if (Number(edits[i].baseRevid) !== Number(edits[i - 1].revid)) return false;
  }
  return true;
}

async function savePreparedRevert(row, page, newText, note) {
  await pool.query(
    `UPDATE task_pages
       SET status = 'prepared', base_revid = ?, base_timestamp = ?,
           original_wikitext = ?, new_wikitext = ?, error_message = ?, prepared_at = NOW()
     WHERE id = ?`,
    [page.revid, new Date(page.baseTimestamp), page.wikitext, newText, note, row.id]
  );
  return { status: 'prepared', row, page, newWikitext: newText };
}

/**
 * 一括取り消しの準備。
 * - そのタスクの最後の編集が今も最新版で、タスクの編集どうしの間に他の人の編集が無ければ、
 *   最初の編集の前の版の本文にそのまま戻す（差分は「現在 → 編集前」）。
 * - 後に（または間に）他の人の編集がある場合:
 *   - useUndo 指定時は、MediaWikiの取り消し（undo）と同じ行単位の3者マージで、そのタスクの編集だけを
 *     新しい順に取り除く。他の人の編集と同じ行が変わっていて統合できなければ取り消さない。
 *   - 指定が無ければ、他の人の編集まで巻き戻さないよう取り消さない。
 */
async function prepareRevert(row, ctx, page, target) {
  if (target.missing || !target.revid || !target.baseRevid) {
    return skipRevert(row, page, '取り消す編集の情報が見つからないため、取り消していません。');
  }
  const edits = revertEditsOf(target);
  const useUndo = Boolean(findRevertRule(row, ctx) && findRevertRule(row, ctx).useUndo);
  const isLatest = Number(page.revid) === Number(target.revid);

  if (isLatest && isContiguous(edits)) {
    const oldText = await ctx.mwClient.getRevisionContent(target.baseRevid);
    if (oldText === null) {
      return skipRevert(row, page, `編集前の版（${target.baseRevid}）の本文を取得できないため、取り消していません。`);
    }
    if (oldText === page.wikitext) return skipRevert(row, page, '既に編集前の内容に戻っています。');
    return savePreparedRevert(row, page, oldText, null);
  }

  const why = isLatest
    ? 'このタスクの編集の間に他の編集がある'
    : `後に他の編集がある（取り消す版 ${target.revid}、現在の版 ${page.revid}）`;
  if (!useUndo) {
    return skipRevert(row, page, `${why}ため取り消していません。手動で確認してください（「取り消し（undo）で統合する」を選ぶと統合を試みます）。`);
  }

  // MediaWikiの取り消しと同じ方法で、そのタスクの編集だけを新しい順に取り除く
  const steps = [];
  for (const edit of [...edits].reverse()) {
    const [after, before] = await Promise.all([
      ctx.mwClient.getRevisionContent(edit.revid),
      ctx.mwClient.getRevisionContent(edit.baseRevid),
    ]);
    if (after === null || before === null) {
      return skipRevert(row, page, `版（${edit.revid} または ${edit.baseRevid}）の本文を取得できないため、取り消していません。`);
    }
    steps.push({ after, before });
  }
  const merged = undoEdits(page.wikitext, steps);
  if (!merged.ok) {
    return skipRevert(
      row,
      page,
      `${why}うえ、同じ箇所が他の編集でも変わっているため統合できず、取り消していません。手動で確認してください。`
    );
  }
  if (merged.text === page.wikitext) return skipRevert(row, page, '既にこのタスクの変更は取り除かれています。');
  return savePreparedRevert(
    row,
    page,
    merged.text,
    `${why}ため、MediaWikiの取り消し（undo）と同じ方法で他の編集を残して統合しました。差分を確認してください。`
  );
}

/**
 * 1つのページを準備する（wikitext取得→置換適用→差分の有無判定→DB更新）。
 * 仕様書9.2節 手順1に対応。
 *
 * @returns {Promise<{status:'prepared'|'skipped'|'failed', row:object, page?:object, newWikitext?:string}>}
 */
async function prepareOnePage(row, ctx) {
  await pool.query(`UPDATE task_pages SET status = 'preparing' WHERE id = ?`, [row.id]);

  try {
    const page = await ctx.mwClient.getPage(row.page_title);

    // 手入力・再試行で追加したページは列挙時点では名前空間が分からず0で登録されているため、
    // 実際の名前空間に直す（ページ一覧・edit_log・Template判定に使われる）
    if (page && Number.isInteger(page.namespace) && page.namespace !== row.namespace) {
      await pool.query('UPDATE task_pages SET namespace = ? WHERE id = ?', [page.namespace, row.id]);
      row.namespace = page.namespace;
    }

    if (!page || !page.exists) {
      const msg = 'ページが存在しません（削除済みまたはタイトル誤り）';
      await pool.query(`UPDATE task_pages SET status = 'failed', error_message = ? WHERE id = ?`, [msg, row.id]);
      return { status: 'failed', row, error: new Error(msg) };
    }

    // 一括取り消し（フェーズ12）: そのタスクの編集がまだ最新版のときだけ、編集前の版の本文に戻す
    const revertTarget = findRevertTarget(row, ctx);
    if (revertTarget) return prepareRevert(row, ctx, page, revertTarget);

    const newWikitext = buildNewWikitext(page.wikitext, row, ctx);

    if (newWikitext === page.wikitext) {
      await pool.query(
        `UPDATE task_pages SET status = 'skipped', original_wikitext = ?, prepared_at = NOW() WHERE id = ?`,
        [page.wikitext, row.id]
      );
      return { status: 'skipped', row, page };
    }

    await pool.query(
      `UPDATE task_pages
         SET status = 'prepared', base_revid = ?, base_timestamp = ?,
             original_wikitext = ?, new_wikitext = ?, prepared_at = NOW()
       WHERE id = ?`,
      [page.revid, new Date(page.baseTimestamp), page.wikitext, newWikitext, row.id]
    );
    return { status: 'prepared', row, page, newWikitext };
  } catch (err) {
    const msg = String((err && err.message) || err);
    await pool.query(`UPDATE task_pages SET status = 'failed', error_message = ? WHERE id = ?`, [msg, row.id]);
    return { status: 'failed', row, error: err };
  }
}

/**
 * 承認されるのを待つ（仕様書9.2節 手順2・3）。
 * auto/manualともtask_pages.statusをポーリングし、待機中の即時承認・却下を尊重する。
 * reviewSettingsは実行中に変更されるため、毎回tasks.config_jsonから読み直す。
 *   タスクのreview_timeout_atを超えたらタスクをexpiredにして待機終了する。
 *
 * @returns {Promise<boolean>} 承認されたらtrue、却下/期限切れ/緊急停止ならfalse
 */
async function waitForApproval({ taskId, pageId, reviewSettings }) {
  // 先読みで準備されたページは前のページの確認中に準備済みになっているため、
  // 自動承認の待機時間は「確認待ちになった時点」から数える。画面側のカウントダウンも
  // prepared_at を起点にしているので、ここで確認待ち開始時刻に揃える。
  // 先読み中に画面から前もって承認・却下されたページ（status が approved/rejected）は
  // 確認待ちに戻さず、そのまま結果を使う（待ち時間を無くすため）。
  const reviewStartedAt = Date.now();
  const { reviewPollMs } = await getWorkerSettings();
  await pool.query(
    `UPDATE task_pages SET status = 'awaiting_review', prepared_at = NOW() WHERE id = ? AND status = 'prepared'`,
    [pageId]
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const [pageRows] = await pool.query(`SELECT status FROM task_pages WHERE id = ?`, [pageId]);
    const pageStatus = pageRows[0] && pageRows[0].status;
    if (pageStatus === 'approved') return true;
    if (pageStatus === 'rejected') return false;

    if (await isEmergencyStopped()) return false;

    const [taskRows] = await pool.query(
      `SELECT status, review_timeout_at, mode, config_json FROM tasks WHERE id = ?`,
      [taskId]
    );
    const task = taskRows[0];
    if (!task || ['cancelled', 'emergency_stopped', 'paused'].includes(task.status)) return false;

    const currentSettings = {
      ...reviewSettings,
      ...parseJsonColumn(task.config_json, {}).reviewSettings,
      mode: task.mode || reviewSettings.mode,
    };
    let sleepMs = reviewPollMs;
    if (currentSettings.mode === 'auto') {
      const autoWaitSeconds = Math.max(0, Number(currentSettings.autoWaitSeconds) || 0);
      const deadline = reviewStartedAt + autoWaitSeconds * 1000;
      // 自動承認の予定時刻が次の確認より前なら、その時刻ちょうどに起きる
      sleepMs = Math.max(0, Math.min(reviewPollMs, deadline - Date.now()));
      if (Date.now() >= deadline) {
        const [result] = await pool.query(
          `UPDATE task_pages SET status = 'approved', reviewed_at = NOW()
           WHERE id = ? AND status = 'awaiting_review'`,
          [pageId]
        );
        if (result.affectedRows > 0) return true;
      }
    }

    if (task.review_timeout_at && new Date(task.review_timeout_at).getTime() < Date.now()) {
      await pool.query(`UPDATE tasks SET status = 'expired', updated_at = NOW() WHERE id = ?`, [taskId]);
      return false;
    }

    await sleep(sleepMs);
  }
}

// ===== 編集失敗時の再試行 =====

/** 一時的な失敗として再試行するMediaWiki APIのエラーコード */
const RETRYABLE_MW_CODES = ['editconflict', 'ratelimited', 'readonly', 'maxlag', 'lockmanager-fail-conflict'];

/** n回目（1始まり）の再試行までの待ち時間。既定は10秒・20秒・40秒と倍々に延ばす。 */
function retryDelayMs(n, baseMs = Number(process.env.EDIT_RETRY_BASE_MS ?? 10000)) {
  return Math.max(0, Number(baseMs)) * 2 ** (n - 1);
}

/**
 * 時間を置けば成功しうる失敗か。保護・ブロック・AbuseFilter・スパムブラックリスト等
 * （再試行しても結果が変わらないもの）は対象外。
 */
function isRetryableEditError(err) {
  if (!err || err.editResult !== undefined) return false;
  if (err.mwCode) return RETRYABLE_MW_CODES.includes(err.mwCode) || /^internal_api_error_/.test(err.mwCode);
  if (err.httpStatus) return err.httpStatus >= 500 || err.httpStatus === 429;
  return true; // 通信エラー・タイムアウト（fetch自体の失敗）
}

/** 再試行までの待機。緊急停止・中止されたらすぐ戻る。 */
async function waitBeforeRetry(ms, taskId) {
  const until = Date.now() + ms;
  for (;;) {
    if (await isEmergencyStopped()) return 'emergency';
    const [rows] = await pool.query(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
    if (!rows[0] || rows[0].status === 'cancelled') return 'cancelled';
    const remain = until - Date.now();
    if (remain <= 0) return null;
    await sleep(Math.min(1000, remain));
  }
}

/**
 * 編集競合のあと、最新版を取り直して同じルールを適用し直す。
 * @returns {Promise<{changed: boolean, page?: object, newWikitext?: string}>}
 */
async function rebuildAfterConflict(row, ctx) {
  const page = await ctx.mwClient.getPage(row.page_title);
  if (!page || !page.exists) throw new Error('ページが存在しません（準備後に削除された可能性があります）');
  const newWikitext = buildNewWikitext(page.wikitext, row, ctx);
  if (newWikitext === page.wikitext) return { changed: false, page };
  await pool.query(
    `UPDATE task_pages SET base_revid = ?, base_timestamp = ?, original_wikitext = ?, new_wikitext = ? WHERE id = ?`,
    [page.revid, new Date(page.baseTimestamp), page.wikitext, newWikitext, row.id]
  );
  return { changed: true, page, newWikitext };
}

/** 現在の確認モード（画面から実行中に切り替えられるため、DBのタスク行から読む）。 */
async function currentReviewMode(ctx) {
  const [rows] = await pool.query(`SELECT mode FROM tasks WHERE id = ?`, [ctx.taskId]);
  return (rows[0] && rows[0].mode) || (ctx.reviewSettings && ctx.reviewSettings.mode) || 'auto';
}

/** 編集の最終的な失敗をtask_pagesとedit_logに記録する。 */
async function recordEditFailure(row, ctx, page, message) {
  await pool.query(`UPDATE task_pages SET status = 'failed', error_message = ? WHERE id = ?`, [message, row.id]);
  await writeEditLog({
    taskId: row.task_id,
    stage: row.stage,
    pageTitle: row.page_title,
    namespace: row.namespace,
    account: ctx.account,
    status: 'failed',
    baseRevid: page.revid,
    editSummary: ctx.editSettings.editSummary,
    errorMessage: message,
  });
}

/** 競合後の最新版で変更が不要になっていたときのスキップ処理。 */
async function skipAfterConflict(row, latestPage) {
  await pool.query(`UPDATE task_pages SET status = 'skipped', error_message = NULL, original_wikitext = ? WHERE id = ?`, [
    latestPage.wikitext,
    row.id,
  ]);
  await writeTaskLogSafely({
    taskId: row.task_id,
    stage: row.stage,
    pageTitle: row.page_title,
    level: 'info',
    message: '編集競合後に最新版を確認したところ、変更の必要が無くなっていたためスキップしました。',
  });
  return { ok: true, skipped: true };
}

/**
 * 手動確認モードで編集競合が起きたとき: 最新版で作り直し、確認待ち（の手前の準備完了）に戻す。
 * 次の waitForApproval で確認待ちになり、画面には作り直した差分が表示される。
 */
async function returnToReviewAfterConflict(row, ctx, page, msg) {
  let rebuilt;
  try {
    rebuilt = await rebuildAfterConflict(row, ctx);
  } catch (rebuildErr) {
    await recordEditFailure(row, ctx, page, String((rebuildErr && rebuildErr.message) || rebuildErr));
    return { ok: false, error: rebuildErr };
  }
  if (!rebuilt.changed) return skipAfterConflict(row, rebuilt.page);

  await pool.query(`UPDATE task_pages SET status = 'prepared', reviewed_at = NULL, error_message = ? WHERE id = ?`, [
    `編集競合（${msg}）のため、最新版で作り直しました。差分を確認してください。`,
    row.id,
  ]);
  await writeTaskLogSafely({
    taskId: row.task_id,
    stage: row.stage,
    pageTitle: row.page_title,
    level: 'warning',
    message: '編集競合が起きたため、最新版で作り直して確認待ちに戻しました（手動確認モード）。',
  });
  return { ok: false, needsReview: true, prepared: { status: 'prepared', row, page: rebuilt.page, newWikitext: rebuilt.newWikitext } };
}

/**
 * 承認されたページを実際に編集する（仕様書9.2節 手順4）。
 * 必ずbasetimestamp/starttimestampを指定し、MediaWiki側の編集競合検出に委ねる。
 * 一時的な失敗（編集競合・レート制限・サーバーエラー等）は間隔を延ばしながら再試行し、
 * 編集競合のときは最新版を取り直して同じルールを適用し直してから再試行する。
 * 成功/最終的な失敗のいずれの場合もedit_logへ即座に記録する。
 *
 * 手動確認モードで編集競合が起きた場合は自動で再試行せず、最新版で作り直した差分を
 * 改めて確認してもらうため、ページを確認待ちに戻して needsReview を返す。
 *
 * @returns {Promise<{ok: boolean, skipped?: boolean, needsReview?: boolean, prepared?: object,
 *   interrupted?: 'emergency'|'cancelled', error?: Error}>}
 */
async function editOnePage(prepared, ctx) {
  const { row } = prepared;
  let { page, newWikitext } = prepared;
  const workerSettings = await getWorkerSettings();
  const maxRetries = Math.max(0, workerSettings.editRetryCount);
  await pool.query(`UPDATE task_pages SET status = 'editing' WHERE id = ?`, [row.id]);

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await ctx.mwClient.edit({
        title: row.page_title,
        text: newWikitext,
        summary: ctx.editSettings.editSummary,
        bot: ctx.editSettings.botFlag,
        minor: ctx.editSettings.minorEdit,
        baseTimestamp: page.baseTimestamp,
        startTimestamp: page.startTimestamp,
      });

      await pool.query(`UPDATE task_pages SET status = 'edited', error_message = NULL, edited_at = NOW() WHERE id = ?`, [row.id]);
      await writeEditLog({
        taskId: row.task_id,
        stage: row.stage,
        pageTitle: row.page_title,
        namespace: row.namespace,
        account: ctx.account,
        status: 'edited',
        revid: result.revid,
        baseRevid: page.revid,
        editSummary: ctx.editSettings.editSummary,
      });
      return { ok: true };
    } catch (err) {
      const msg = String((err && err.mwInfo) || (err && err.message) || err);

      if (attempt >= maxRetries || !isRetryableEditError(err)) {
        const finalMsg = attempt > 0 ? `${msg}（${attempt}回再試行しましたが失敗しました）` : msg;
        await recordEditFailure(row, ctx, page, finalMsg);
        return { ok: false, error: err };
      }

      // 手動確認モードの編集競合: 待たずに最新版で作り直し、確認待ちに戻す（確認モードは実行中に変わりうるので都度読む）
      // 一括取り消しで編集競合: 準備後に他の人が編集したので、その編集まで巻き戻さないよう取り消さない
      if (err.mwCode === 'editconflict' && findRevertTarget(row, ctx)) {
        await skipRevert(row, null, '取り消しの準備後に他の編集があったため、取り消していません。手動で確認してください。');
        return { ok: true, skipped: true };
      }
      if (err.mwCode === 'editconflict' && (await currentReviewMode(ctx)) === 'manual') {
        return returnToReviewAfterConflict(row, ctx, page, msg);
      }

      const retryNo = attempt + 1;
      const delayMs = retryDelayMs(retryNo, workerSettings.editRetryBaseMs);
      const waitText = `約${Math.round(delayMs / 1000)}秒後`;
      await pool.query(`UPDATE task_pages SET error_message = ? WHERE id = ?`, [
        `再試行待ち（${retryNo}/${maxRetries}、${waitText}）: ${msg}`,
        row.id,
      ]);
      await writeTaskLogSafely({
        taskId: row.task_id,
        stage: row.stage,
        pageTitle: row.page_title,
        level: 'warning',
        message: `編集に失敗したため${waitText}に再試行します（${retryNo}/${maxRetries}）: ${msg}`,
      });

      const stopped = await waitBeforeRetry(delayMs, ctx.taskId);
      if (stopped) {
        // 編集は行われていないので「承認済み」に戻す（再開時に準備からやり直す）
        await pool.query(`UPDATE task_pages SET status = 'approved', error_message = NULL WHERE id = ?`, [row.id]);
        return { ok: false, interrupted: stopped };
      }

      if (err.mwCode === 'editconflict') {
        // 同じ本文のままでは必ず再び競合するため、最新版にルールを適用し直す
        let rebuilt;
        try {
          rebuilt = await rebuildAfterConflict(row, ctx);
        } catch (rebuildErr) {
          await recordEditFailure(row, ctx, page, String((rebuildErr && rebuildErr.message) || rebuildErr));
          return { ok: false, error: rebuildErr };
        }
        // 競合した編集で既に同じ修正が入っていた等、もう変更の必要が無い
        if (!rebuilt.changed) return skipAfterConflict(row, rebuilt.page);
        page = rebuilt.page;
        newWikitext = rebuilt.newWikitext;
      }
    }
  }
}

/**
 * 1ステージ分のtask_pagesを、先読みパイプラインで処理する（仕様書9.2節）。
 * 先読みは、変更不要（スキップ）のページを飛ばして、次に編集が要るページまで進めておく。
 *
 * @param {object} ctx
 * @param {number} ctx.taskId
 * @param {number} ctx.stage
 * @param {import('../bot/mwClient').MediaWikiBotClient} ctx.mwClient
 * @param {string} ctx.account
 * @param {Array} ctx.replacements - config_json.replacements（そのままの配列）
 * @param {object} ctx.editSettings
 * @param {object} ctx.reviewSettings
 * @param {'pause'|'skipAndContinue'} ctx.onFailure
 * @returns {Promise<{completed:boolean, paused?:boolean, emergencyStopped?:boolean, expired?:boolean, cancelled?:boolean, hadFailures:boolean}>}
 */
/**
 * 前回の実行が途中で止まった（一時停止・緊急停止・期限切れ・ワーカー再起動）際に
 * 処理途中の状態で残ったページを、再開時に処理し直せる状態へ戻す。
 * runStagePipelineはpendingのページだけを処理するため、これをしないと
 * 先読み済み・確認待ちだったページが永久に処理されないまま残ってしまう。
 * 編集API呼び出し中に止まったページ（editing）は実際に編集されたか分からないため、
 * 二重編集を避けて失敗扱いにし、edit_log/再試行で確認できるようにする。
 */
async function resetInterruptedPages(ctx) {
  await pool.query(
    `UPDATE task_pages SET status = 'pending'
     WHERE task_id = ? AND stage = ? AND status IN ('preparing', 'prepared', 'awaiting_review', 'approved')`,
    [ctx.taskId, ctx.stage]
  );
  await pool.query(
    `UPDATE task_pages SET status = 'failed', error_message = ?
     WHERE task_id = ? AND stage = ? AND status = 'editing'`,
    ['編集中に処理が中断されたため、編集結果を確認できませんでした（ページ履歴を確認してください）', ctx.taskId, ctx.stage]
  );
}

/** 進捗は処理が確定したページ数から求める（再開を挟んでも数え漏れ・二重計上が起きないように）。 */
async function updateProgress(taskId) {
  await pool.query(
    `UPDATE tasks SET progress_current = (
       SELECT COUNT(*) FROM task_pages
       WHERE task_id = ? AND status IN ('edited', 'skipped', 'failed', 'rejected')
     ), updated_at = NOW() WHERE id = ?`,
    [taskId, taskId]
  );
}

async function runStagePipeline(ctx) {
  await resetInterruptedPages(ctx);

  const [rows] = await pool.query(
    `SELECT * FROM task_pages WHERE task_id = ? AND stage = ? AND status = 'pending' ORDER BY order_index ASC`,
    [ctx.taskId, ctx.stage]
  );
  if (rows.length === 0) return { completed: true, hadFailures: false };

  if (await isEmergencyStopped()) {
    return { completed: false, emergencyStopped: true, hadFailures: false };
  }

  // 先読み: 今のページの確認・編集・編集間隔の待ちの間に、次に編集するページを準備しておく。
  // 準備した結果が「変更不要（スキップ）」なら、その場で確定させてさらに次を準備し、
  // 編集が要るページ（または失敗したページ）が見つかるまで進む（＝次に編集するものを待機させておく）。
  const ahead = { stopped: false };
  async function prepareAhead(from) {
    for (let j = from; j < rows.length; j++) {
      if (ahead.stopped || (await isEmergencyStopped())) return null;
      const result = await prepareOnePage(rows[j], ctx);
      if (result.status === 'skipped') {
        await updateProgress(ctx.taskId);
        continue;
      }
      return { index: j, result };
    }
    return null;
  }

  let hadFailures = false;
  let nextPromise = null;
  let current = await prepareAhead(0);

  try {
    while (current) {
      nextPromise = prepareAhead(current.index + 1);

      if (await isEmergencyStopped()) {
        return { completed: false, emergencyStopped: true, hadFailures };
      }
      const [taskRows] = await pool.query(`SELECT status FROM tasks WHERE id = ?`, [ctx.taskId]);
      if (!taskRows[0] || taskRows[0].status === 'cancelled') {
        return { completed: false, cancelled: true, hadFailures };
      }

      let editedAt = null; // 実際に編集した時刻（次の編集までの間隔をこの時刻から数える）
      if (current.result.status === 'failed') {
        hadFailures = true;
        if (ctx.onFailure === 'pause') {
          await pauseTask(ctx.taskId);
          return { completed: false, paused: true, hadFailures };
        }
        // skipAndContinue: 何もせず次へ
      } else if (current.result.status === 'prepared') {
        // 手動確認モードで編集競合が起きたときは、最新版で作り直した差分を改めて確認するため
        // 確認待ちに戻る（editOnePage が needsReview を返す）。それ以外は1回で抜ける。
        let target = current.result;
        for (;;) {
          const approved = await waitForApproval({
            taskId: ctx.taskId,
            pageId: target.row.id,
            reviewSettings: ctx.reviewSettings,
          });

          // waitForApproval内でタスクがexpired/emergency_stoppedになっている可能性があるため確認
          const [taskRows] = await pool.query(`SELECT status FROM tasks WHERE id = ?`, [ctx.taskId]);
          const taskStatus = taskRows[0] && taskRows[0].status;
          if (['expired', 'emergency_stopped', 'cancelled'].includes(taskStatus)) {
            return {
              completed: false,
              expired: taskStatus === 'expired',
              emergencyStopped: taskStatus === 'emergency_stopped',
              cancelled: taskStatus === 'cancelled',
              hadFailures,
            };
          }
          // 確認待ちの間に緊急停止された場合、そのページは却下ではなく未処理のまま残す
          // （再開時にpendingへ戻して改めて確認できるようにする）
          if (await isEmergencyStopped()) {
            return { completed: false, emergencyStopped: true, hadFailures };
          }

          if (!approved) {
            await pool.query(
              `UPDATE task_pages SET status = 'rejected', reviewed_at = NOW() WHERE id = ? AND status != 'rejected'`,
              [target.row.id]
            );
            break;
          }

          const editResult = await editOnePage(target, ctx);
          if (editResult.needsReview) {
            target = editResult.prepared;
            continue;
          }
          if (editResult.interrupted) {
            // 再試行の待機中に緊急停止・中止された
            return {
              completed: false,
              emergencyStopped: editResult.interrupted === 'emergency',
              cancelled: editResult.interrupted === 'cancelled',
              hadFailures,
            };
          }
          if (!editResult.ok) {
            hadFailures = true;
            if (ctx.onFailure === 'pause') {
              await pauseTask(ctx.taskId);
              return { completed: false, paused: true, hadFailures };
            }
          }
          // 実際に編集しなかった（競合後に変更不要と分かった）ときは編集間隔をあけない
          if (!editResult.skipped) editedAt = Date.now();
          break;
        }
      }

      await updateProgress(ctx.taskId);

      // 次に編集するページ（先読みがスキップを飛ばして見つけたもの）。見つからなければこのステージは終わり
      const next = await nextPromise;
      nextPromise = null;
      // 編集間隔は、編集した時刻から数える（その間に先読みが進むため、待ち時間が増えない）。
      // 次に編集するページが無いとき（残りがすべてスキップ・終わり）は待たない
      if (editedAt !== null && next) {
        const remaining = Math.max(0, ctx.editSettings.editIntervalSeconds) * 1000 - (Date.now() - editedAt);
        if (remaining > 0) await sleep(remaining);
      }
      current = next;
    }
  } finally {
    // 途中で抜けた場合も、裏で走っている先読みを止め、完了を待ってから戻る
    // （放置するとワーカーの次の処理と並行してDBを書き換えてしまうため）。
    ahead.stopped = true;
    if (nextPromise) await nextPromise.catch(() => {});
  }

  return { completed: true, hadFailures };
}

async function pauseTask(taskId) {
  await updateProgress(taskId);
  await pool.query(`UPDATE tasks SET status = 'paused', updated_at = NOW() WHERE id = ?`, [taskId]);
}

module.exports = {
  runStagePipeline,
  prepareOnePage,
  waitForApproval,
  editOnePage,
  applyRedirectCategoryTemplateEdits,
  isRetryableEditError,
  retryDelayMs,
};

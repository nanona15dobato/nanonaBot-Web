'use strict';

const { pool } = require('../db');
const { applyReplacementSteps } = require('./regexEngine');
const { isEmergencyStopped } = require('./emergencyStop');
const { writeEditLog } = require('./editLog');
const { parseJsonColumn } = require('../dbJson');
const { renameCategoryInTemplate, removeCategoryFromTemplate } = require('./redirectCategoryTemplate');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REVIEW_POLL_MS = 500;

/**
 * matchedRulesのうちcategoryRename/categoryRemoveについて、
 * Template:リダイレクトの所属カテゴリ内の該当カテゴリ引数も書き換える（仕様書6.3/6.4節・8章）。
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
    }
  }
  return text;
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

    if (!page || !page.exists) {
      const msg = 'ページが存在しません（削除済みまたはタイトル誤り）';
      await pool.query(`UPDATE task_pages SET status = 'failed', error_message = ? WHERE id = ?`, [msg, row.id]);
      return { status: 'failed', row, error: new Error(msg) };
    }

    const ruleIndices = parseJsonColumn(row.matched_rule_indices, []);
    const matchedRules = ruleIndices.map((idx) => ctx.replacements[idx]).filter(Boolean);
    const steps = matchedRules.flatMap((r) => r.steps || []);
    let newWikitext = applyReplacementSteps(page.wikitext, steps);
    // Category置換/除去ルールが含まれる場合、{{リダイレクトの所属カテゴリ}}内の
    // 該当カテゴリ引数も併せて書き換える（該当が無いページには影響しない）
    newWikitext = applyRedirectCategoryTemplateEdits(newWikitext, matchedRules);

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
 * タスクのreviewSettingsをポーリングごとに読み直すため、auto/manualの切替は
 * 現在待機中のページにも反映される。どちらのモードでも外部からの承認・却下を優先する。
 *   タスクのreview_timeout_atを超えたらタスクをexpiredにして待機終了する。
 *
 * @returns {Promise<boolean>} 承認されたらtrue、却下/期限切れ/緊急停止ならfalse
 */
async function waitForApproval({ taskId, pageId, reviewSettings }) {
  await pool.query(`UPDATE task_pages SET status = 'awaiting_review', review_deadline_at = NULL WHERE id = ?`, [pageId]);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const [pageRows] = await pool.query(`SELECT status, review_deadline_at FROM task_pages WHERE id = ?`, [pageId]);
    const page = pageRows[0];
    const pageStatus = page && page.status;
    if (pageStatus === 'approved') return true;
    if (pageStatus === 'rejected' || !page) return false;

    if (await isEmergencyStopped()) return false;

    const [taskRows] = await pool.query(`SELECT status, review_timeout_at, config_json FROM tasks WHERE id = ?`, [taskId]);
    const task = taskRows[0];
    if (!task || ['emergency_stopped', 'paused', 'cancelled'].includes(task.status)) return false;

    const currentReviewSettings = parseJsonColumn(task.config_json, {}).reviewSettings || reviewSettings;
    if (currentReviewSettings.mode === 'auto') {
      let deadline = page.review_deadline_at && new Date(page.review_deadline_at).getTime();
      if (!deadline) {
        deadline = Date.now() + Math.max(0, Number(currentReviewSettings.autoWaitSeconds) || 0) * 1000;
        await pool.query(`UPDATE task_pages SET review_deadline_at = ? WHERE id = ? AND status = 'awaiting_review'`, [
          new Date(deadline),
          pageId,
        ]);
      }
      if (Date.now() >= deadline) {
        await pool.query(
          `UPDATE task_pages SET status = 'approved', reviewed_at = NOW() WHERE id = ? AND status = 'awaiting_review'`,
          [pageId]
        );
      }
    } else {
      // 自動待機中から手動へ切り替えたとき、画面のカウントダウンを消す。
      if (page.review_deadline_at) {
        await pool.query(`UPDATE task_pages SET review_deadline_at = NULL WHERE id = ? AND status = 'awaiting_review'`, [pageId]);
      }
      if (task.review_timeout_at && new Date(task.review_timeout_at).getTime() < Date.now()) {
        await pool.query(`UPDATE tasks SET status = 'expired' WHERE id = ?`, [taskId]);
        return false;
      }
    }

    // 自動承認UPDATEと手動操作が競合した場合も、最終statusで確定する。
    const [updatedPageRows] = await pool.query(`SELECT status FROM task_pages WHERE id = ?`, [pageId]);
    if (updatedPageRows[0] && updatedPageRows[0].status === 'approved') return true;
    if (!updatedPageRows[0] || updatedPageRows[0].status === 'rejected') return false;

    if (currentReviewSettings.mode !== 'auto' && task.review_timeout_at && new Date(task.review_timeout_at).getTime() < Date.now()) {
      await pool.query(`UPDATE tasks SET status = 'expired' WHERE id = ?`, [taskId]);
      return false;
    }

    await sleep(REVIEW_POLL_MS);
  }
}

/**
 * 承認されたページを実際に編集する（仕様書9.2節 手順4）。
 * 必ずbasetimestamp/starttimestampを指定し、MediaWiki側の編集競合検出に委ねる。
 * 成功/失敗いずれの場合もedit_logへ即座に記録する。
 */
async function editOnePage(prepared, ctx) {
  const { row, page, newWikitext } = prepared;
  await pool.query(`UPDATE task_pages SET status = 'editing' WHERE id = ?`, [row.id]);

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

    await pool.query(`UPDATE task_pages SET status = 'edited', edited_at = NOW() WHERE id = ?`, [row.id]);
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
    await pool.query(`UPDATE task_pages SET status = 'failed', error_message = ? WHERE id = ?`, [msg, row.id]);
    await writeEditLog({
      taskId: row.task_id,
      stage: row.stage,
      pageTitle: row.page_title,
      namespace: row.namespace,
      account: ctx.account,
      status: 'failed',
      baseRevid: page.revid,
      editSummary: ctx.editSettings.editSummary,
      errorMessage: msg,
    });
    return { ok: false, error: err };
  }
}

/**
 * 1ステージ分のtask_pagesを、1ページ先読みパイプラインで処理する（仕様書9.2節）。
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
 * @returns {Promise<{completed:boolean, paused?:boolean, emergencyStopped?:boolean, expired?:boolean, hadFailures:boolean}>}
 */
async function runStagePipeline(ctx) {
  const [initialTaskRows] = await pool.query(`SELECT status FROM tasks WHERE id = ?`, [ctx.taskId]);
  if (initialTaskRows[0] && initialTaskRows[0].status === 'cancelled') {
    return { completed: false, cancelled: true, hadFailures: false };
  }
  const [rows] = await pool.query(
    `SELECT * FROM task_pages WHERE task_id = ? AND stage = ? AND status = 'pending' ORDER BY order_index ASC`,
    [ctx.taskId, ctx.stage]
  );
  if (rows.length === 0) return { completed: true, hadFailures: false };

  let hadFailures = false;

  if (await isEmergencyStopped()) {
    return { completed: false, emergencyStopped: true, hadFailures };
  }

  let current = await prepareOnePage(rows[0], ctx);
  let nextPromise = rows[1] ? prepareOnePage(rows[1], ctx) : null;

  for (let i = 0; i < rows.length; i++) {
    const [taskRowsBeforePage] = await pool.query(`SELECT status FROM tasks WHERE id = ?`, [ctx.taskId]);
    if (taskRowsBeforePage[0] && taskRowsBeforePage[0].status === 'cancelled') {
      return { completed: false, cancelled: true, hadFailures };
    }
    if (await isEmergencyStopped()) {
      return { completed: false, emergencyStopped: true, hadFailures };
    }

    if (current.status === 'failed') {
      hadFailures = true;
      if (ctx.onFailure === 'pause') {
        await pool.query(`UPDATE tasks SET status = 'paused' WHERE id = ?`, [ctx.taskId]);
        return { completed: false, paused: true, hadFailures };
      }
      // skipAndContinue: 何もせず次へ
    } else if (current.status === 'prepared') {
      const approved = await waitForApproval({
        taskId: ctx.taskId,
        pageId: current.row.id,
        reviewSettings: ctx.reviewSettings,
      });

      // waitForApproval内でタスクがexpired/emergency_stoppedになっている可能性があるため確認
      const [taskRows] = await pool.query(`SELECT status FROM tasks WHERE id = ?`, [ctx.taskId]);
      const taskStatus = taskRows[0] && taskRows[0].status;
      if (taskStatus === 'expired' || taskStatus === 'emergency_stopped' || taskStatus === 'cancelled') {
        return {
          completed: false,
          expired: taskStatus === 'expired',
          emergencyStopped: taskStatus === 'emergency_stopped',
          cancelled: taskStatus === 'cancelled',
          hadFailures,
        };
      }

      if (!approved) {
        await pool.query(`UPDATE task_pages SET status = 'rejected', reviewed_at = NOW() WHERE id = ? AND status != 'rejected'`, [
          current.row.id,
        ]);
      } else {
        if (await isEmergencyStopped()) {
          return { completed: false, emergencyStopped: true, hadFailures };
        }
        const editResult = await editOnePage(current, ctx);
        if (!editResult.ok) {
          hadFailures = true;
          if (ctx.onFailure === 'pause') {
            await pool.query(`UPDATE tasks SET status = 'paused' WHERE id = ?`, [ctx.taskId]);
            return { completed: false, paused: true, hadFailures };
          }
        }
        await sleep(Math.max(0, ctx.editSettings.editIntervalSeconds) * 1000);
      }
    }
    // status === 'skipped' の場合は何もせず次へ

    await pool.query(`UPDATE tasks SET progress_current = progress_current + 1, updated_at = NOW() WHERE id = ?`, [
      ctx.taskId,
    ]);

    if (nextPromise) {
      current = await nextPromise;
      const after = rows[i + 2];
      nextPromise = after ? prepareOnePage(after, ctx) : null;
    }
  }

  return { completed: true, hadFailures };
}

module.exports = { runStagePipeline, prepareOnePage, waitForApproval, editOnePage, applyRedirectCategoryTemplateEdits };

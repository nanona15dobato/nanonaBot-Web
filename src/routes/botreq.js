'use strict';

const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const botreqDesk = require('../services/botreqDesk');
const {
  fetchBotreqWikitext,
  parseBotreqTemplates,
  parseBotreqTopicList,
  resolveRedirectTargets,
  BOTREQ_TOPIC_LIST_TITLE,
} = require('../worker/botreq');

// Wikipedia:Bot作業依頼 から {{リンク修正依頼/改名}} を検出・パースして返す（owner専用）。
// 検出結果はプレビューのみで、キューへの投入はタスク作成画面で操作者が明示的に行う（仕様書7章）。
/**
 * 依頼ごとに {{リンク修正依頼/改名}} を取り出し、各提案に依頼（threadId・name・着手時に作った Bot の要約 botSummary）を付ける。
 * 依頼の節に入っていない呼び出しは含めない。
 */
function proposalsByRequest(requests) {
  const proposals = [];
  for (const r of requests) {
    for (const p of parseBotreqTemplates(r.text)) {
      proposals.push({ ...p, index: proposals.length, request: { threadId: r.threadId, name: r.name, botSummary: r.botSummary, logTitle: r.logTitle } });
    }
  }
  return proposals;
}

// 各提案に、それが書かれた依頼と、着手時に作った Bot の要約を付けて返す（フェーズ13）。
// ?threadId=h-… を付けると、その依頼の提案だけを返し、request にその依頼を入れる（Bot作業依頼の画面から来たとき）。
// 依頼ごとの情報を取れない場合（運用者アカウントでログインできない等）は、従来どおりページ全体から依頼なしで返す。
router.get('/api/botreq/proposals', requireRole('owner'), async (req, res, next) => {
  try {
    const threadId = typeof req.query.threadId === 'string' && req.query.threadId ? req.query.threadId : null;
    const [{ wikitext, revid }, { wikitext: topicListWikitext, timestamp: topicListTimestamp }, requests] = await Promise.all([
      fetchBotreqWikitext(),
      fetchBotreqWikitext(BOTREQ_TOPIC_LIST_TITLE),
      botreqDesk.requestSections({ threadId }).catch((err) => {
        if (threadId) throw err;
        console.error('[botreq] 依頼ごとの情報を取れないため、ページ全体から取り込みます:', err.message);
        return null;
      }),
    ]);
    // REDIRECT_TARGET は取得時点の解決先を確定させて表示する（取り込むかは操作者が判断する）
    const proposals = await resolveRedirectTargets(requests ? proposalsByRequest(requests) : parseBotreqTemplates(wikitext));
    const request = threadId && requests ? requests[0] : null;
    res.json({
      revid,
      proposals,
      topicProgress: parseBotreqTopicList(topicListWikitext),
      topicListTimestamp,
      request: request ? { threadId: request.threadId, name: request.name, botSummary: request.botSummary, logTitle: request.logTitle } : null,
    });
  } catch (err) {
    sendDeskError(res, next, err);
  }
});

// ---- 着手・完了・解決（フェーズ13）。作業記録・依頼への返信は config.botreq.account のアカウントで編集する ----

// 権限が足りないことを示す API のエラーコード
const PERMISSION_CODES = new Set(['permissiondenied', 'badaccess-groups', 'readapidenied', 'writeapidenied', 'mwoauth-invalidauthorizationrequest']);

/** ウィキの API のエラーを、どの API で失敗したか・権限が原因ならその対処を添えた文にする。 */
function describeWikiError(err) {
  const where = err.apiAction ? `ウィキの API（action=${err.apiAction}）で失敗しました` : 'ウィキで失敗しました';
  const code = err.mwCode ? ` [${err.mwCode}]` : '';
  let message = `${where}${code}: ${err.mwInfo || err.message}`;
  if (err.diagnosis) message += ` — ${err.diagnosis}`;
  const permission = PERMISSION_CODES.has(err.mwCode) || /not allowed|permission/i.test(err.mwInfo || '');
  if (permission && ['edit', 'discussiontoolsedit'].includes(err.apiAction)) {
    message +=
      ' — 「このセッションの権限」に edit が無い場合は、ツールに設定した BotPassword（上のログイン名）の権限（Special:BotPasswords）が足りません。' +
      '画面右上の「保存に使うアカウントを確認」でも確かめられます。';
  }
  return message;
}

function sendDeskError(res, next, err) {
  if (err.status) return res.status(err.status).json({ message: err.message });
  if (err.mwCode === 'editconflict') {
    return res.status(409).json({ code: 'editconflict', message: '編集が競合しました。閉じて、もう一度操作してください。' });
  }
  if (err.mwCode === 'articleexists') {
    return res.status(409).json({ code: 'articleexists', message: '作業記録のページが既に作成されていました。閉じて、もう一度操作してください。' });
  }
  if (err.mwCode || err.editResult) {
    return res.status(502).json({ code: err.mwCode || null, message: describeWikiError(err) });
  }
  if (err.httpStatus) {
    const message =
      err.httpStatus === 429
        ? 'ウィキへのリクエストが多すぎるため断られました。少し待ってから、もう一度操作してください。'
        : describeWikiError(err);
    return res.status(502).json({ code: `http_${err.httpStatus}`, message });
  }
  return next(err);
}

// 運用者アカウントの確認（ログインした名前・権限・編集するページで編集が許されるか）
router.get('/api/botreq/account-check', requireRole('owner'), async (req, res, next) => {
  try {
    res.json({ accounts: await botreqDesk.checkAccounts() });
  } catch (err) {
    sendDeskError(res, next, err);
  }
});

// 依頼の一覧（状態・依頼者・作業記録の有無）
router.get('/api/botreq/requests', requireRole('owner'), async (req, res, next) => {
  try {
    res.json(await botreqDesk.listRequests());
  } catch (err) {
    sendDeskError(res, next, err);
  }
});

// 保存する内容を作る（まだ編集しない）。kind: start | complete | resolve
router.post('/api/botreq/prepare', requireRole('owner'), async (req, res, next) => {
  try {
    const body = req.body || {};
    res.json(await botreqDesk.prepare(body.kind, body.threadId));
  } catch (err) {
    sendDeskError(res, next, err);
  }
});

router.post('/api/botreq/render', requireRole('owner'), async (req, res, next) => {
  try {
    const { title, text } = req.body || {};
    if (typeof title !== 'string' || typeof text !== 'string') return res.status(400).json({ message: 'title と text が必要です' });
    res.json({ html: await botreqDesk.renderPreview(title, text) });
  } catch (err) {
    sendDeskError(res, next, err);
  }
});

router.post('/api/botreq/diff', requireRole('owner'), async (req, res, next) => {
  try {
    const { title, oldText, newText } = req.body || {};
    if (typeof title !== 'string' || typeof oldText !== 'string' || typeof newText !== 'string') {
      return res.status(400).json({ message: 'title・oldText・newText が必要です' });
    }
    res.json({ html: await botreqDesk.renderDiff(title, oldText, newText) });
  } catch (err) {
    sendDeskError(res, next, err);
  }
});

// 保存する（必要なら依頼のコメントへ返信する）
router.post('/api/botreq/save', requireRole('owner'), async (req, res, next) => {
  try {
    const errors = botreqDesk.validateSave(req.body);
    if (errors.length) return res.status(400).json({ errors });
    const result = await botreqDesk.save(req.body);
    console.log(`[botreq] ${req.session.username}: ${req.body.title} を保存しました（rev ${result.revid}）`);
    res.json(result);
  } catch (err) {
    sendDeskError(res, next, err);
  }
});

module.exports = router;
module.exports.sendDeskError = sendDeskError;
module.exports.proposalsByRequest = proposalsByRequest;
module.exports.describeWikiError = describeWikiError;

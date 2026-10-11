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
router.get('/api/botreq/proposals', requireRole('owner'), async (req, res, next) => {
  try {
    const [{ wikitext, revid }, { wikitext: topicListWikitext, timestamp: topicListTimestamp }] = await Promise.all([
      fetchBotreqWikitext(),
      fetchBotreqWikitext(BOTREQ_TOPIC_LIST_TITLE),
    ]);
    // REDIRECT_TARGET は取得時点の解決先を確定させて表示する（取り込むかは操作者が判断する）
    const proposals = await resolveRedirectTargets(parseBotreqTemplates(wikitext));
    res.json({ revid, proposals, topicProgress: parseBotreqTopicList(topicListWikitext), topicListTimestamp });
  } catch (err) {
    next(err);
  }
});

// ---- 着手・完了・解決（フェーズ13）。作業記録・依頼への返信は config.botreq.account のアカウントで編集する ----

function sendDeskError(res, next, err) {
  if (err.status) return res.status(err.status).json({ message: err.message });
  if (err.mwCode === 'editconflict') {
    return res.status(409).json({ code: 'editconflict', message: '編集が競合しました。閉じて、もう一度操作してください。' });
  }
  if (err.mwCode === 'articleexists') {
    return res.status(409).json({ code: 'articleexists', message: '作業記録のページが既に作成されていました。閉じて、もう一度操作してください。' });
  }
  if (err.mwCode || err.editResult) return res.status(502).json({ code: err.mwCode || null, message: err.mwInfo || err.message });
  return next(err);
}

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

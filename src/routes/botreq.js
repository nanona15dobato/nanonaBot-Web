'use strict';

const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const { fetchBotreqWikitext, parseBotreqTemplates } = require('../worker/botreq');

// Wikipedia:Bot作業依頼 から {{リンク修正依頼/改名}} を検出・パースして返す（owner専用）。
// 検出結果はプレビューのみで、キューへの投入はタスク作成画面で操作者が明示的に行う（仕様書7章）。
router.get('/api/botreq/proposals', requireRole('owner'), async (req, res, next) => {
  try {
    const { wikitext, revid } = await fetchBotreqWikitext();
    const proposals = parseBotreqTemplates(wikitext);
    res.json({ revid, proposals });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

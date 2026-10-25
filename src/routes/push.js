'use strict';

const express = require('express');
const { requireRole } = require('../middleware/auth');
const push = require('../services/push');
const router = express.Router();

router.use('/api/push', requireRole('owner'));
function route(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof push.PushError) return res.status(error.status).json({ error: 'push_error', message: error.message });
      // DBや購読情報を含む例外をログやレスポンスに展開しない。
      if (error.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'push_unavailable', message: '端末通知の準備が完了していません。' });
      next(new Error('端末通知の設定を処理できませんでした。'));
    }
  };
}

router.get('/api/push/config', route(async (req, res) => {
  const settings = push.configured();
  res.json({ configured: Boolean(settings), publicKey: settings ? settings.publicKey : null,
    events: push.EVENTS, defaultEvents: push.DEFAULT_EVENTS });
}));
router.get('/api/push/subscription', route(async (req, res) => {
  res.json(await push.status(req.sessionID, req.session.username, req.query.endpointHash));
}));
router.post('/api/push/subscription', route(async (req, res) => {
  const input = req.body || {};
  res.json(await push.subscribe(req.sessionID, req.session.username, req.session.cookie.expires, input.subscription, input.events, input.publicKey));
}));
router.put('/api/push/subscription', route(async (req, res) => {
  const input = req.body || {};
  res.json(await push.update(req.sessionID, req.session.username, input.endpointHash, input.events));
}));
router.delete('/api/push/subscription', route(async (req, res) => {
  await push.unsubscribe(req.sessionID, req.session.username, (req.body || {}).endpointHash);
  res.json({ registered: false });
}));
router.post('/api/push/test', route(async (req, res) => {
  const endpointHash = (req.body || {}).endpointHash;
  const status = await push.status(req.sessionID, req.session.username, endpointHash);
  if (!status.registered) throw new push.PushError(404, 'このログインでは端末通知が有効になっていません。');
  const result = await push.sendEvent('test', '/settings', { sessionId: req.sessionID, endpointHash });
  res.json({ accepted: result.sent > 0 });
}));

module.exports = router;

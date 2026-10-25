'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const oauthService = require('../services/oauth');
const { resolveRole } = require('../services/authorization');
const { escapeHtml } = require('../views/shell');
const push = require('../services/push');

router.get('/oauth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  res.redirect(oauthService.buildAuthorizeUrl(state));
});

router.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.status(400).send(
      `OAuth認可が拒否・失敗しました: ${escapeHtml(error)} ${escapeHtml(errorDescription || '')}`
    );
  }
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send('OAuthの状態が不正です（stateの不一致、またはセッション切れ）。もう一度ログインしてください。');
  }
  delete req.session.oauthState;

  try {
    const token = await oauthService.exchangeCodeForToken(code);
    const profile = await oauthService.fetchProfile(token.access_token);
    const username = profile && profile.username;

    if (!username) {
      throw new Error('OAuthプロフィールにusernameが含まれていませんでした。');
    }

    const role = await resolveRole(username);

    // ログイン前のセッションIDを使い回さない（セッション固定攻撃対策）。
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));

    // フェーズ1ではOAuthアクセストークン自体はセッションに保存しない。
    // 編集操作は各BotアカウントのBotPassword（.env/envvars）で行う設計であり
    // （仕様書2章「認証は2系統に分離する」）、操作者自身のトークンを保持し続ける
    // 必要が今のところ無いため、保持範囲を最小化する。
    req.session.username = username;
    req.session.role = role;

    if (role === 'denied') {
      return res.status(403).send(`${escapeHtml(username)} さんはこのツールの利用権限がありません。`);
    }
    res.redirect('/');
  } catch (err) {
    console.error('[oauth/callback] error:', err);
    res.status(500).send('ログイン処理中にエラーが発生しました。しばらくしてから再度お試しください。');
  }
});

router.post('/oauth/logout', async (req, res, next) => {
  try { await push.revokeSession(req.sessionID); }
  catch { console.warn('[push] 購読を削除できませんでした。ログアウト後は送信対象から除外されます。'); }
  req.session.destroy((error) => {
    if (error) return next(new Error('ログアウトを完了できませんでした。'));
    res.clearCookie('nanona_bot_sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.redirect('/');
  });
});

module.exports = router;

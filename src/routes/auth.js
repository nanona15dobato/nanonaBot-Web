'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const oauthService = require('../services/oauth');
const mediawiki = require('../services/mediawiki');
const config = require('../config');
const { determineRole } = require('../permissions');

router.get('/oauth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  res.redirect(oauthService.buildAuthorizeUrl(state));
});

router.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    return res.status(400).send(`OAuth認可が拒否・失敗しました: ${error} ${errorDescription || ''}`);
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

    const isOwner = username === config.permissions.ownerUsername;
    const groups = isOwner ? [] : await mediawiki.getUserGroups(username);
    const role = determineRole({ username, ownerUsername: config.permissions.ownerUsername, groups });

    // フェーズ1ではOAuthアクセストークン自体はセッションに保存しない。
    // 編集操作は各BotアカウントのBotPassword（.env/envvars）で行う設計であり
    // （仕様書2章「認証は2系統に分離する」）、操作者自身のトークンを保持し続ける
    // 必要が今のところ無いため、保持範囲を最小化する。
    req.session.username = username;
    req.session.role = role;

    if (role === 'denied') {
      return res.status(403).send(`${username} さんはこのツールの利用権限がありません。`);
    }
    res.redirect('/');
  } catch (err) {
    console.error('[oauth/callback] error:', err);
    res.status(500).send('ログイン処理中にエラーが発生しました。しばらくしてから再度お試しください。');
  }
});

router.post('/oauth/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

module.exports = router;

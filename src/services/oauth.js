'use strict';

const config = require('../config');

/**
 * 認可エンドポイントへのリダイレクトURLを組み立てる。
 * @param {string} state - CSRF対策用のランダム文字列（セッションに保存し、callbackで照合する）
 */
function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.oauth.clientId,
    redirect_uri: config.oauth.callbackUrl,
    state,
  });
  return `https://${config.oauth.wikiHost}/w/rest.php/oauth2/authorize?${params.toString()}`;
}

/**
 * 認可コードをアクセストークンに交換する。
 * 必ず application/x-www-form-urlencoded で送る（multipart/form-dataは415エラーになる）。
 * @param {string} code
 */
async function exchangeCodeForToken(code) {
  const res = await fetch(`https://${config.oauth.wikiHost}/w/rest.php/oauth2/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.userAgent,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.oauth.clientId,
      client_secret: config.oauth.clientSecret,
      redirect_uri: config.oauth.callbackUrl,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuthトークン取得に失敗しました (${res.status}): ${text}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, token_type }
}

/**
 * アクセストークンを使ってプロフィール（ユーザー名等）を取得する。
 * @param {string} accessToken
 */
async function fetchProfile(accessToken) {
  const res = await fetch(`https://${config.oauth.wikiHost}/w/rest.php/oauth2/resource/profile`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': config.userAgent,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuthプロフィール取得に失敗しました (${res.status}): ${text}`);
  }
  return res.json(); // 期待するフィールド例: { username, sub, editcount, ... }
}

module.exports = { buildAuthorizeUrl, exchangeCodeForToken, fetchProfile };

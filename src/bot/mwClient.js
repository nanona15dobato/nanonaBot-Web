'use strict';

const { CookieJar } = require('./cookieJar');
const { cleanParams } = require('./mwUtil');

/**
 * MediaWiki API (api.php) 向けの最小限のBotクライアント。
 * mwn等の既存ライブラリではなく、公式ドキュメント（API:Edit, API:Login）に
 * 記載された手順をそのまま実装している。理由: basetimestamp/starttimestampを
 * 使った編集競合検出（仕様書9.2節）を確実に・検証可能な形で実装するため。
 *
 * ログインの流れ（Special:BotPasswordsで発行したlgname/lgpasswordを使う）:
 *   1. GET  action=query&meta=tokens&type=login  → logintoken取得（同時にセッションCookie発行）
 *   2. POST action=login（lgname/lgpassword/lgtoken）→ ログイン成功でセッションが本ログイン状態に
 *   3. 以後の書き込み系リクエストの前に GET action=query&meta=tokens でCSRFトークンを取得
 */
class MediaWikiBotClient {
  /**
   * @param {object} params
   * @param {string} params.apiUrl - 例: "https://ja.wikipedia.org/w/api.php"
   * @param {string} params.username - Special:BotPasswords発行のログイン名（"User@BotName"形式）
   * @param {string} params.password - Special:BotPasswords発行のボットパスワード
   * @param {string} params.userAgent
   */
  constructor({ apiUrl, username, password, userAgent }) {
    if (!apiUrl || !username || !password) {
      throw new Error('MediaWikiBotClient: apiUrl/username/passwordは必須です');
    }
    this.apiUrl = apiUrl;
    this.username = username;
    this.password = password;
    this.userAgent = userAgent || 'NanonaBotTool/0.1';
    this.cookieJar = new CookieJar();
    this.loggedIn = false;
  }

  /**
   * @param {object} params
   * @param {'GET'|'POST'} [method]
   */
  async request(params, method = 'GET') {
    const cleaned = cleanParams({ format: 'json', formatversion: '2', ...params });
    const headers = {
      'User-Agent': this.userAgent,
      Cookie: this.cookieJar.header(),
    };

    let res;
    if (method === 'GET') {
      const url = new URL(this.apiUrl);
      url.search = new URLSearchParams(cleaned).toString();
      res = await fetch(url, { headers });
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      res = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: new URLSearchParams(cleaned),
      });
    }

    this.cookieJar.updateFromResponse(res);

    if (!res.ok) {
      throw new Error(`MediaWiki APIへのHTTPリクエストが失敗しました (${res.status})`);
    }
    const data = await res.json();
    if (data.error) {
      const err = new Error(`MediaWiki APIエラー [${data.error.code}]: ${data.error.info}`);
      err.mwCode = data.error.code;
      err.mwInfo = data.error.info;
      throw err;
    }
    return data;
  }

  /** ログイン（Special:BotPasswords方式）。 */
  async login() {
    const tokenRes = await this.request({ action: 'query', meta: 'tokens', type: 'login' });
    const loginToken = tokenRes.query.tokens.logintoken;

    const loginRes = await this.request(
      {
        action: 'login',
        lgname: this.username,
        lgpassword: this.password,
        lgtoken: loginToken,
      },
      'POST'
    );

    if (!loginRes.login || loginRes.login.result !== 'Success') {
      const reason = loginRes.login ? loginRes.login.result : '不明なエラー';
      throw new Error(`ログインに失敗しました (${this.username}): ${reason}`);
    }
    this.loggedIn = true;
    this.loggedInUsername = loginRes.login.lgusername;
    return loginRes.login;
  }

  /** CSRFトークンを取得する（編集など書き込み系操作の直前に毎回呼ぶ）。 */
  async getCsrfToken() {
    const res = await this.request({ action: 'query', meta: 'tokens' });
    return res.query.tokens.csrftoken;
  }

  /**
   * ページの現在の本文・リビジョン情報を取得する。
   * curtimestamp=1 でサーバー時刻も取得し、starttimestampの基準にする
   * （ボット側の時計のズレの影響を受けないようにするため）。
   *
   * @param {string} title
   * @returns {Promise<null|{title:string, pageid:number, exists:boolean, revid:number|null,
   *   baseTimestamp:string|null, startTimestamp:string, wikitext:string}>}
   */
  async getPage(title) {
    const res = await this.request({
      action: 'query',
      titles: title,
      prop: 'revisions',
      rvprop: 'ids|timestamp|content',
      rvslots: 'main',
      curtimestamp: '1',
    });
    const page = res.query.pages[0];
    if (!page) return null;
    if (page.missing) {
      return {
        title: page.title,
        pageid: null,
        exists: false,
        revid: null,
        baseTimestamp: null,
        startTimestamp: res.curtimestamp,
        wikitext: '',
      };
    }
    const rev = page.revisions && page.revisions[0];
    return {
      title: page.title,
      pageid: page.pageid,
      exists: true,
      revid: rev ? rev.revid : null,
      baseTimestamp: rev ? rev.timestamp : null,
      startTimestamp: res.curtimestamp,
      wikitext: rev ? rev.slots.main.content : '',
    };
  }

  /**
   * ページを編集する。basetimestamp/starttimestampを必ず指定し、
   * 準備後に他の利用者が編集していた場合はMediaWiki側が editconflict を
   * 返すようにする（仕様書9.2節 手順4）。
   *
   * @param {object} params
   * @param {string} params.title
   * @param {string} params.text
   * @param {string} params.summary
   * @param {boolean} params.bot
   * @param {boolean} params.minor
   * @param {string} params.baseTimestamp
   * @param {string} params.startTimestamp
   * @returns {Promise<{revid:number, newTimestamp:string}>}
   */
  async edit({ title, text, summary, bot, minor, baseTimestamp, startTimestamp }) {
    const token = await this.getCsrfToken();
    const res = await this.request(
      {
        action: 'edit',
        title,
        text,
        summary,
        token,
        bot: bot ? '1' : undefined,
        minor: minor ? '1' : undefined,
        notminor: minor ? undefined : '1',
        basetimestamp: baseTimestamp || undefined,
        starttimestamp: startTimestamp || undefined,
      },
      'POST'
    );

    if (!res.edit || res.edit.result !== 'Success') {
      throw new Error(`編集に失敗しました: ${JSON.stringify(res.edit)}`);
    }
    return { revid: res.edit.newrevid, newTimestamp: res.edit.newtimestamp };
  }
}

module.exports = { MediaWikiBotClient };

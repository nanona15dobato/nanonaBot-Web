'use strict';

const { CookieJar } = require('./cookieJar');
const { cleanParams } = require('./mwUtil');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 編集時に指定するmaxlag（秒）。Bot運用の慣行どおり5秒（API:Etiquette）。 */
const EDIT_MAXLAG_SECONDS = 5;
const MAX_LAG_RETRIES = 5;
/** ログインセッション切れを示すエラーコード。再ログインしてから1回だけ再試行する。 */
const SESSION_LOST_CODES = ['assertuserfailed', 'assertbotfailed', 'badtoken', 'notloggedin'];

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
    // サーバーのレプリケーション遅延（maxlag）で拒否された場合は、指示された秒数待ってから再試行する
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(params, method);
      } catch (err) {
        if (err.mwCode !== 'maxlag' || attempt >= MAX_LAG_RETRIES) throw err;
        await sleep((err.retryAfterSeconds || EDIT_MAXLAG_SECONDS) * 1000);
      }
    }
  }

  async requestOnce(params, method) {
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
      const err = new Error(`MediaWiki APIへのHTTPリクエストが失敗しました (${res.status})`);
      err.httpStatus = res.status;
      throw err;
    }
    const data = await res.json();
    if (data.error) {
      const err = new Error(`MediaWiki APIエラー [${data.error.code}]: ${data.error.info}`);
      err.mwCode = data.error.code;
      err.mwInfo = data.error.info;
      const retryAfter = typeof res.headers.get === 'function' ? Number(res.headers.get('retry-after')) : NaN;
      if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterSeconds = retryAfter;
      throw err;
    }
    return data;
  }

  /** ログイン（Special:BotPasswords方式）。再ログイン時は古いセッションCookieを捨ててからやり直す。 */
  async login() {
    this.cookieJar = new CookieJar();
    this.loggedIn = false;
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
        namespace: page.ns,
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
      namespace: page.ns,
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
  async edit(params) {
    return this.withSessionRetry(() => this.editOnce(params));
  }

  /**
   * 長時間稼働でBotPasswordのセッションが切れた場合（CSRFトークンが匿名用の "+\\" になる等）。
   * assert=userにより匿名（IP）での編集は必ず拒否されるので、再ログインして1回だけやり直す。
   */
  async withSessionRetry(fn) {
    try {
      return await fn();
    } catch (err) {
      if (!SESSION_LOST_CODES.includes(err.mwCode)) throw err;
      await this.login();
      return fn();
    }
  }

  /**
   * 複数ページをまとめて purge し、forcelinkupdate でリンク表・カテゴリ所属を再計算させる（フェーズ9）。
   * null editと同じ目的で使える一括版。版は作成されない。titlesは最大50件ずつ渡すこと。
   * @param {string[]} titles
   * @returns {Promise<{purged: string[], failed: string[]}>}
   */
  async purgeWithLinkUpdate(titles) {
    return this.withSessionRetry(async () => {
      const res = await this.request(
        {
          action: 'purge',
          titles: titles.join('|'),
          forcelinkupdate: '1',
          assert: 'user',
          maxlag: String(EDIT_MAXLAG_SECONDS),
        },
        'POST'
      );
      const purged = [];
      const failed = [];
      for (const entry of res.purge || []) {
        if (entry.purged) purged.push(entry.title);
        else failed.push(entry.title);
      }
      return { purged, failed };
    });
  }

  /**
   * null edit（本文を変えない編集）を行い、ページのリンク表・カテゴリ所属を再計算させる。
   * テンプレートを編集した直後、そのテンプレートを使っているページのカテゴリ所属を
   * ジョブキューの処理を待たずに更新するために使う。版は作成されない。
   * @param {string} title
   */
  async nullEdit(title) {
    return this.withSessionRetry(async () => {
      const token = await this.getCsrfToken();
      const res = await this.request(
        {
          action: 'edit',
          title,
          appendtext: '', // 本文に何も足さない＝変更なしの保存（null edit）
          token,
          assert: 'user',
          maxlag: String(EDIT_MAXLAG_SECONDS),
          nocreate: '1',
        },
        'POST'
      );
      if (!res.edit || res.edit.result !== 'Success') {
        throw new Error(`null editに失敗しました: ${JSON.stringify(res.edit)}`);
      }
      return res.edit;
    });
  }

  async editOnce({ title, text, summary, bot, minor, baseTimestamp, startTimestamp }) {
    const token = await this.getCsrfToken();
    const res = await this.request(
      {
        action: 'edit',
        title,
        text,
        summary,
        token,
        assert: 'user', // ログインが切れていたらIPで編集せずエラーにする
        maxlag: String(EDIT_MAXLAG_SECONDS),
        nocreate: '1', // 準備後に削除されたページを再作成しない
        bot: bot ? '1' : undefined,
        minor: minor ? '1' : undefined,
        notminor: minor ? undefined : '1',
        basetimestamp: baseTimestamp || undefined,
        starttimestamp: startTimestamp || undefined,
      },
      'POST'
    );

    if (!res.edit || res.edit.result !== 'Success') {
      // AbuseFilter・CAPTCHA等で保存されなかった場合（再試行しても結果は変わらない）
      const err = new Error(`編集に失敗しました: ${JSON.stringify(res.edit)}`);
      err.editResult = res.edit || null;
      throw err;
    }
    return { revid: res.edit.newrevid, newTimestamp: res.edit.newtimestamp };
  }
}

module.exports = { MediaWikiBotClient };

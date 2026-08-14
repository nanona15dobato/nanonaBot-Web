'use strict';

/**
 * 最小限のCookieJar。fetch()はブラウザと違って自動でCookieを保持しないため、
 * MediaWikiのログインセッション（action=login後のセッションCookie）を
 * 手動で保持・付与するために使う。
 */
class CookieJar {
  constructor() {
    /** @type {Map<string,string>} */
    this.cookies = new Map();
  }

  /**
   * fetch()のResponseからSet-Cookieを取り込む。
   * Node 18.14+ / 20 の fetch (undici) では headers.getSetCookie() で
   * 複数のSet-Cookieを配列として取得できる。
   * @param {Response} res
   */
  updateFromResponse(res) {
    const setCookieHeaders =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const sc of setCookieHeaders) {
      const firstPart = sc.split(';', 1)[0];
      const eq = firstPart.indexOf('=');
      if (eq === -1) continue;
      const name = firstPart.slice(0, eq).trim();
      const value = firstPart.slice(eq + 1).trim();
      if (!name) continue;
      this.cookies.set(name, value);
    }
  }

  /** @returns {string} リクエストのCookieヘッダに使う文字列 */
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

module.exports = { CookieJar };

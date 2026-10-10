'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CookieJar } = require('../src/bot/cookieJar');
const { parseMwTimestamp, toMwTimestamp, cleanParams } = require('../src/bot/mwUtil');
const { MediaWikiBotClient } = require('../src/bot/mwClient');

// ---- CookieJar ----

function makeResponse({ setCookies = [] } = {}) {
  return {
    headers: { getSetCookie: () => setCookies },
  };
}

test('CookieJar: Set-Cookieを取り込んでheader()に反映する', () => {
  const jar = new CookieJar();
  jar.updateFromResponse(makeResponse({ setCookies: ['session=abc123; Path=/; HttpOnly'] }));
  assert.equal(jar.header(), 'session=abc123');
});

test('CookieJar: 複数Cookie・上書きを正しく扱う', () => {
  const jar = new CookieJar();
  jar.updateFromResponse(makeResponse({ setCookies: ['a=1; Path=/', 'b=2; Path=/'] }));
  jar.updateFromResponse(makeResponse({ setCookies: ['a=999; Path=/'] }));
  const header = jar.header();
  assert.ok(header.includes('a=999'));
  assert.ok(header.includes('b=2'));
  assert.ok(!header.includes('a=1'));
});

// ---- mwUtil ----

test('toMwTimestamp / parseMwTimestamp: ISO8601で往復できる', () => {
  const original = '2026-08-11T12:34:56Z';
  const date = parseMwTimestamp(original);
  assert.equal(toMwTimestamp(date), original);
});

test('cleanParams: undefined/nullを除去し、それ以外は文字列化する', () => {
  const result = cleanParams({ a: 1, b: undefined, c: null, d: true, e: 'x' });
  assert.deepEqual(result, { a: '1', d: 'true', e: 'x' });
});

// ---- MediaWikiBotClient（fetchをモックして検証） ----

/**
 * MediaWikiのログイン→CSRFトークン取得→編集の流れを模擬するfetchモックを作る。
 * @returns {{fetchFn: Function, calls: Array}}
 */
function createMockMwFetch() {
  const calls = [];

  function jsonResponse(body, { setCookies = [] } = {}) {
    return {
      ok: true,
      status: 200,
      headers: { getSetCookie: () => setCookies },
      json: async () => body,
    };
  }

  async function fetchFn(input, init = {}) {
    const method = init.method || 'GET';
    const cookieSent = (init.headers && init.headers.Cookie) || '';
    let params;
    let urlStr;

    if (method === 'GET') {
      urlStr = String(input);
      params = Object.fromEntries(new URL(urlStr).searchParams.entries());
    } else {
      urlStr = String(input);
      params = Object.fromEntries(new URLSearchParams(init.body).entries());
    }

    calls.push({ method, urlStr, params, cookieSent });

    if (params.meta === 'tokens' && params.type === 'login') {
      return jsonResponse(
        { query: { tokens: { logintoken: 'LOGINTOKEN+\\' } } },
        { setCookies: ['presession=pre1; Path=/'] }
      );
    }
    if (params.action === 'login') {
      assert.ok(cookieSent.includes('presession=pre1'), 'ログイン時に事前セッションCookieを送っていること');
      return jsonResponse(
        { login: { result: 'Success', lgusername: 'NanonaBot' } },
        { setCookies: ['session=loggedin1; Path=/'] }
      );
    }
    if (params.action === 'query' && params.meta === 'tokens' && !params.type) {
      assert.ok(cookieSent.includes('session=loggedin1'), 'CSRFトークン取得時にログイン後Cookieを送っていること');
      return jsonResponse({ query: { tokens: { csrftoken: 'CSRFTOKEN+\\' } } });
    }
    if (params.action === 'query' && params.prop === 'revisions') {
      return jsonResponse({
        curtimestamp: '2026-08-11T10:00:00Z',
        query: {
          pages: [
            {
              pageid: 1,
              title: params.titles,
              revisions: [
                {
                  revid: 100,
                  timestamp: '2026-08-11T09:00:00Z',
                  slots: { main: { content: '[[プタリン・ジャヤ・スタジアム]]' } },
                },
              ],
            },
          ],
        },
      });
    }
    if (params.action === 'edit') {
      assert.equal(params.basetimestamp, '2026-08-11T09:00:00Z', 'basetimestampが準備時のrevisionと一致していること');
      assert.equal(params.starttimestamp, '2026-08-11T10:00:00Z', 'starttimestampが準備時のcurtimestampと一致していること');
      assert.equal(cookieSent.includes('session=loggedin1'), true);
      return jsonResponse({ edit: { result: 'Success', newrevid: 101, newtimestamp: '2026-08-11T10:00:05Z' } });
    }

    throw new Error('想定外のリクエスト: ' + JSON.stringify(params));
  }

  return { fetchFn, calls };
}

test('MediaWikiBotClient: login→getPage→editが正しいCookie・basetimestampで動く', async () => {
  const { fetchFn, calls } = createMockMwFetch();
  const originalFetch = global.fetch;
  global.fetch = fetchFn;

  try {
    const client = new MediaWikiBotClient({
      apiUrl: 'https://ja.wikipedia.org/w/api.php',
      username: 'NanonaBot@toolname',
      password: 'dummy-bot-password',
      userAgent: 'Test/1.0',
    });

    await client.login();
    assert.equal(client.loggedIn, true);
    assert.equal(client.loggedInUsername, 'NanonaBot');

    const page = await client.getPage('プタリン・ジャヤ・スタジアム');
    assert.equal(page.exists, true);
    assert.equal(page.revid, 100);
    assert.equal(page.baseTimestamp, '2026-08-11T09:00:00Z');
    assert.equal(page.startTimestamp, '2026-08-11T10:00:00Z');
    assert.equal(page.wikitext, '[[プタリン・ジャヤ・スタジアム]]');

    const result = await client.edit({
      title: 'プタリン・ジャヤ・スタジアム',
      text: '[[ペタリン・ジャヤ・スタジアム]]',
      summary: 'Bot: リンク修正',
      bot: true,
      minor: true,
      baseTimestamp: page.baseTimestamp,
      startTimestamp: page.startTimestamp,
    });
    assert.equal(result.revid, 101);

    // 呼び出し順の確認（ログイントークン→ログイン→CSRF→ページ取得→CSRF(edit直前)→編集）
    const actionSequence = calls.map((c) => `${c.params.action || ''}:${c.params.type || ''}`);
    assert.ok(actionSequence.includes('query:login'));
    assert.ok(actionSequence.includes('login:'));
    assert.ok(actionSequence.includes('edit:'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('MediaWikiBotClient: ログイン失敗時はエラーを投げる', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const params =
      (init.method || 'GET') === 'GET'
        ? Object.fromEntries(new URL(String(input)).searchParams.entries())
        : Object.fromEntries(new URLSearchParams(init.body).entries());
    if (params.type === 'login') {
      return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ query: { tokens: { logintoken: 'T' } } }) };
    }
    if (params.action === 'login') {
      return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ login: { result: 'WrongPass' } }) };
    }
    throw new Error('unexpected');
  };

  try {
    const client = new MediaWikiBotClient({
      apiUrl: 'https://ja.wikipedia.org/w/api.php',
      username: 'X@Y',
      password: 'wrong',
      userAgent: 'Test/1.0',
    });
    await assert.rejects(() => client.login(), /ログインに失敗しました/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('MediaWikiBotClient: 存在しないページはexists=falseを返す', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { getSetCookie: () => [] },
    json: async () => ({
      curtimestamp: '2026-08-11T10:00:00Z',
      query: { pages: [{ title: '存在しないページ', missing: true }] },
    }),
  });

  try {
    const client = new MediaWikiBotClient({
      apiUrl: 'https://ja.wikipedia.org/w/api.php',
      username: 'X@Y',
      password: 'z',
      userAgent: 'Test/1.0',
    });
    const page = await client.getPage('存在しないページ');
    assert.equal(page.exists, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('MediaWikiBotClient: セッション切れ（assertuserfailed）時は再ログインして1回だけ編集をやり直す', async () => {
  const originalFetch = global.fetch;
  const actions = [];
  let editAttempts = 0;
  global.fetch = async (input, init = {}) => {
    const params =
      (init.method || 'GET') === 'GET'
        ? Object.fromEntries(new URL(String(input)).searchParams.entries())
        : Object.fromEntries(new URLSearchParams(init.body).entries());
    actions.push(params.type === 'login' ? 'logintoken' : params.action === 'query' ? 'csrf' : params.action);
    const json = (body) => ({ ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => body });
    if (params.type === 'login') return json({ query: { tokens: { logintoken: 'T' } } });
    if (params.action === 'login') return json({ login: { result: 'Success', lgusername: 'NanonaBot' } });
    if (params.action === 'query') return json({ query: { tokens: { csrftoken: 'C' } } });
    if (params.action === 'edit') {
      assert.equal(params.assert, 'user', 'ログイン切れでIP編集にならないようassert=userを付ける');
      assert.equal(params.nocreate, '1');
      editAttempts++;
      if (editAttempts === 1) return json({ error: { code: 'assertuserfailed', info: 'You are no longer logged in' } });
      return json({ edit: { result: 'Success', newrevid: 5, newtimestamp: '2026-08-11T10:00:05Z' } });
    }
    throw new Error('unexpected');
  };

  try {
    const client = new MediaWikiBotClient({ apiUrl: 'https://ja.wikipedia.org/w/api.php', username: 'X@Y', password: 'z' });
    const result = await client.edit({ title: 'A', text: 'B', summary: 's', bot: true, minor: true });
    assert.equal(result.revid, 5);
    assert.deepEqual(actions, ['csrf', 'edit', 'logintoken', 'login', 'csrf', 'edit']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('MediaWikiBotClient: nullEditは本文を変えない編集（appendtext空・nocreate・assert=user）を送る', async () => {
  const originalFetch = global.fetch;
  let editParams;
  global.fetch = async (input, init = {}) => {
    const params =
      (init.method || 'GET') === 'GET'
        ? Object.fromEntries(new URL(String(input)).searchParams.entries())
        : Object.fromEntries(new URLSearchParams(init.body).entries());
    const json = (body) => ({ ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => body });
    if (params.action === 'query') return json({ query: { tokens: { csrftoken: 'C' } } });
    if (params.action === 'edit') {
      editParams = params;
      return json({ edit: { result: 'Success', nochange: true } });
    }
    throw new Error('unexpected');
  };
  try {
    const client = new MediaWikiBotClient({ apiUrl: 'https://ja.wikipedia.org/w/api.php', username: 'X@Y', password: 'z' });
    await client.nullEdit('記事A');
    assert.equal(editParams.title, '記事A');
    assert.equal(editParams.appendtext, '');
    assert.equal(editParams.text, undefined);
    assert.equal(editParams.nocreate, '1');
    assert.equal(editParams.assert, 'user');
  } finally {
    global.fetch = originalFetch;
  }
});

test('MediaWikiBotClient: purgeWithLinkUpdateはforcelinkupdate付きでまとめてpurgeし、失敗ページを返す', async () => {
  const originalFetch = global.fetch;
  let purgeParams;
  global.fetch = async (input, init = {}) => {
    purgeParams = Object.fromEntries(new URLSearchParams(init.body).entries());
    return {
      ok: true,
      status: 200,
      headers: { getSetCookie: () => [] },
      json: async () => ({ purge: [{ title: 'A', purged: true, linkupdate: true }, { title: 'B', missing: true }] }),
    };
  };
  try {
    const client = new MediaWikiBotClient({ apiUrl: 'https://ja.wikipedia.org/w/api.php', username: 'X@Y', password: 'z' });
    const result = await client.purgeWithLinkUpdate(['A', 'B']);
    assert.equal(purgeParams.action, 'purge');
    assert.equal(purgeParams.titles, 'A|B');
    assert.equal(purgeParams.forcelinkupdate, '1');
    assert.deepEqual(result, { purged: ['A'], failed: ['B'] });
  } finally {
    global.fetch = originalFetch;
  }
});

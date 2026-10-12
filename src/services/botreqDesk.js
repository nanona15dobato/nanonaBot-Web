'use strict';

/**
 * Bot作業依頼の「着手・完了・解決」（フェーズ13）。
 * 利用者スクリプト（userscripts/botreq.js）と同じ操作を、ツールの画面から行えるようにする。
 * 作業記録（利用者:nanonaBot/依頼/YYYY年）の編集と、依頼への返信は config.botreq.account のアカウントで行う。
 *
 * 各操作は、まず prepare で「保存する内容（計画）」を作って画面に返し、操作者が確認・修正してから save する。
 * 計画の本文は before + text + after で、text だけを画面で編集する。保存時は basetimestamp で編集競合を検出する。
 */

const config = require('../config');
const L = require('./botreqLog');
const { BOTREQ_PAGE_TITLE } = require('../worker/botreq');

const MAX_CONTRIBS = 100000; // 完了時に数える投稿の上限（記録の取り違えなどで極端に多いときは止める）

const REVID_CHUNK = 500; // edit_log を revid で引くときの1回の IN の件数

/** MediaWiki の利用者名の比較用（先頭の文字の大小・空白と下線を区別しない）。 */
function normalizeUser(name) {
  const s = String(name || '').replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * 作業記録の編集に使うアカウント。BOTREQ_LOG_ACCOUNT が無ければ、作業記録の利用者空間の持ち主（ツールに設定したアカウントの中から）。
 * jawiki は $wgRestrictUserPageEditing が有効で、他人の利用者ページの編集には editalluserpages が要るが、
 * この権限はどの BotPassword の権限（grant）にも無いため、運用者の BotPassword では作業記録を編集できない。
 */
function logAccount() {
  if (config.botreq.logAccount) return config.botreq.logAccount;
  const owner = (config.botreq.logPrefix.match(/^(?:利用者|User)\s*:\s*([^/]+)\//i) || [])[1];
  if (owner) {
    const { ACCOUNT_ENV_MAP } = require('../bot/accountNames');
    const found = Object.keys(ACCOUNT_ENV_MAP).find((name) => normalizeUser(name) === normalizeUser(owner));
    if (found) return found;
  }
  return config.botreq.account;
}

/** 編集するページに応じたアカウント（作業記録は持ち主のアカウント、依頼ページは運用者のアカウント）。 */
function accountFor(title) {
  return isLogTitle(title) ? logAccount() : config.botreq.account;
}

async function defaultClient(account = config.botreq.account) {
  try {
    return await require('../bot/accounts').getClient(account);
  } catch (err) {
    // 認証情報が未設定・BotPassword の失効など。画面に理由を出せるようにする
    throw Object.assign(new Error(`${account} でウィキにログインできません: ${err.message}`), { status: 502 });
  }
}

let anonymousReader = null;

/**
 * 読み取り用のクライアント。依頼ページ・作業記録・投稿記録などは公開情報なので、ログインせずに読む。
 * 運用者の BotPassword のセッションでは、付与した権限（grant）によって一部の API（action=parse・
 * discussiontoolspageinfo 等）が「You are not allowed to execute the action you have requested.」で拒否されることがあるため。
 * 編集（save）だけを運用者のアカウントで行う。
 */
function defaultReader() {
  if (!anonymousReader) {
    const { MediaWikiBotClient } = require('../bot/mwClient');
    anonymousReader = new MediaWikiBotClient({ apiUrl: config.wiki.apiUrl, userAgent: config.userAgent, anonymous: true });
  }
  return anonymousReader;
}

/** DB へのクエリ（テストでは差し替える）。DB を使わない環境でも一覧などは動くよう、遅延して読み込む。 */
function defaultQuery(sql, params) {
  return require('../db').pool.query(sql, params);
}

/**
 * Bot作業依頼に紐づけたタスク（config_json.botreq.threadId）を、依頼の節 ID ごとにまとめる。
 * DB が使えないときは空にする（一覧の表示は続ける）。
 * @returns {Promise<Map<string, Array<{id: number, status: string, account: string}>>>}
 */
async function linkedTasks(query) {
  const byThread = new Map();
  try {
    const [rows] = await query(
      `SELECT id, status, account, JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.botreq.threadId')) AS thread_id
         FROM tasks
        WHERE JSON_EXTRACT(config_json, '$.botreq.threadId') IS NOT NULL
        ORDER BY id DESC
        LIMIT 1000`
    );
    for (const row of rows) {
      if (!row.thread_id) continue;
      if (!byThread.has(row.thread_id)) byThread.set(row.thread_id, []);
      byThread.get(row.thread_id).push({ id: row.id, status: row.status, account: row.account });
    }
  } catch (err) {
    console.error('[botreq] 紐づけたタスクを読めません:', err.message);
  }
  return byThread;
}

/**
 * 投稿の revid から、どのタスクの編集か（edit_log）を数える。ツール以外の編集は taskId=null。
 * @returns {Promise<Array<{taskId: number|null, count: number}>>}
 */
async function editsByTask(query, revids) {
  const counts = new Map();
  const found = new Set();
  try {
    for (let i = 0; i < revids.length; i += REVID_CHUNK) {
      const chunk = revids.slice(i, i + REVID_CHUNK);
      const [rows] = await query(
        `SELECT task_id, revid FROM edit_log WHERE status = 'edited' AND revid IN (${chunk.map(() => '?').join(',')})`,
        chunk
      );
      for (const row of rows) {
        if (found.has(Number(row.revid))) continue;
        found.add(Number(row.revid));
        counts.set(row.task_id, (counts.get(row.task_id) || 0) + 1);
      }
    }
  } catch (err) {
    console.error('[botreq] 編集ログを読めません:', err.message);
    return null;
  }
  const other = revids.length - found.size;
  const list = [...counts.entries()].map(([taskId, count]) => ({ taskId, count })).sort((a, b) => b.count - a.count);
  if (other > 0) list.push({ taskId: null, count: other });
  return list;
}

function isLogTitle(title) {
  return typeof title === 'string' && title.startsWith(config.botreq.logPrefix) && /^\d{4}年$/.test(title.slice(config.botreq.logPrefix.length));
}

/** 依頼ページと、その版の節・スレッドをまとめて取得する。 */
async function loadRequestPage(client) {
  const page = await client.getPage(BOTREQ_PAGE_TITLE);
  if (!page || !page.exists) throw new Error(`${BOTREQ_PAGE_TITLE} が見つかりません`);
  // ログインしない読み取りは同時に送ると断られやすい（HTTP 429）ため、1つずつ送る
  const parsed = await client.request({ action: 'parse', oldid: String(page.revid), prop: 'sections' });
  const dt = await client.request({
    action: 'discussiontoolspageinfo',
    page: BOTREQ_PAGE_TITLE,
    oldid: String(page.revid),
    prop: 'threaditemshtml',
    excludesignatures: '1',
  });
  const sections = L.sliceSections(page.wikitext, parsed.parse.sections, BOTREQ_PAGE_TITLE);
  const items = dt.discussiontoolspageinfo.threaditemshtml;
  const requests = L.matchHeadingsToSections(L.collectRequestHeadings(items), sections).map(({ heading, name, section }) => {
    const first = L.firstComment(heading);
    return {
      threadId: heading.id,
      name,
      level: Number(heading.headingLevel) || (section && section.level) || 2,
      sectionIndex: section ? section.index : null,
      sectionText: section ? section.text : '',
      ownText: section ? section.ownText : '',
      requester: first ? first.author : null,
      requesterName: first ? first.displayName || first.author : null,
      requestedAt: first ? first.timestamp : null,
      commentId: first ? first.id : null,
      commentCount: heading.commentCount || 0,
      latestReplyAt: heading.latestReplyTimestamp || null,
    };
  });
  return { page, requests };
}

async function getEditCount(client, user) {
  const data = await client.request({ action: 'query', list: 'users', ususers: user, usprop: 'editcount' });
  const entry = data.query.users[0];
  if (!entry || entry.missing) throw new Error(`利用者 ${user} が見つかりません`);
  return entry.editcount;
}

/** 利用者の最近の投稿（新しい順）を n 件まで取得する。 */
async function getRecentContribs(client, user, n) {
  const list = [];
  let cont = {};
  while (list.length < n) {
    const data = await client.request({ action: 'query', list: 'usercontribs', ucuser: user, ucprop: 'ids|timestamp', uclimit: 'max', ...cont });
    list.push(...data.query.usercontribs);
    if (!data.continue) break;
    cont = data.continue;
  }
  return list.slice(0, n);
}

/** 依頼の年ごとの作業記録のページを取得する（Map: 年 → getPage の結果）。 */
async function loadLogs(client, requests) {
  const years = [...new Set(requests.filter((r) => r.requestedAt).map((r) => L.jstYear(r.requestedAt)))];
  const logs = new Map();
  for (const year of years) {
    logs.set(year, await client.getPage(`${config.botreq.logPrefix}${year}年`)); // 1つずつ（HTTP 429 を避ける）
  }
  return logs;
}

/** その依頼の作業記録の節（無ければ null）。 */
function logSectionOf(logs, request) {
  const log = request.requestedAt ? logs.get(L.jstYear(request.requestedAt)) : null;
  return log && log.exists ? L.findLogSection(log.wikitext, request.threadId) : null;
}

/**
 * 依頼の一覧（状態・依頼者・作業記録の有無）。
 * @returns {Promise<{revid: number, requests: object[]}>}
 */
async function listRequests({ client, query } = {}) {
  client = client || defaultReader();
  const [{ page, requests }, tasks] = await Promise.all([loadRequestPage(client), linkedTasks(query || defaultQuery)]);
  const logs = await loadLogs(client, requests);
  return {
    revid: page.revid,
    logPrefix: config.botreq.logPrefix,
    requests: requests.map((r) => {
      const { status, label } = L.detectStatus(r.ownText);
      const logSection = logSectionOf(logs, r);
      return {
        threadId: r.threadId,
        name: r.name,
        level: r.level,
        sectionIndex: r.sectionIndex,
        status,
        statusLabel: label,
        requester: r.requester,
        requesterName: r.requesterName,
        requestedAt: r.requestedAt,
        commentCount: r.commentCount,
        latestReplyAt: r.latestReplyAt,
        logTitle: r.requestedAt ? L.logTitleFor(config.botreq.logPrefix, r.requestedAt) : null,
        logState: !logSection ? 'none' : logSection.finished ? 'finished' : 'started',
        tasks: tasks.get(r.threadId) || [],
      };
    }),
  };
}

async function findRequest(client, threadId) {
  const loaded = await loadRequestPage(client);
  const request = loaded.requests.find((r) => r.threadId === threadId);
  if (!request) throw Object.assign(new Error('この依頼の節が見つかりません。一覧を読み込み直してください。'), { status: 404 });
  if (!request.requestedAt) throw Object.assign(new Error('この依頼の節に署名つきのコメントがありません。'), { status: 400 });
  return { ...loaded, request };
}

async function prepareStart(client, threadId) {
  const { request: req } = await findRequest(client, threadId);
  const logTitle = L.logTitleFor(config.botreq.logPrefix, req.requestedAt);
  const editCount = await getEditCount(client, config.botreq.botUser);
  const log = await client.getPage(logTitle);
  const notes = [];
  // 作業記録を Bot 自身のアカウントで編集する場合、この着手の保存でも Bot の編集回数が1つ増える。
  // その1編集を作業に数えないよう、記録する編集回数に足しておく
  const selfLog = normalizeUser(logAccount()) === normalizeUser(config.botreq.botUser);
  const recordedCount = editCount + (selfLog ? 1 : 0);
  const current = log.exists ? log.wikitext : L.newLogPage(L.jstYear(req.requestedAt), config.botreq.operator);
  if (!log.exists) notes.push({ type: 'notice', text: `${logTitle} はまだありません。保存すると、このページを作成します。` });
  const counted = L.incrementHeadCount(current);
  if (!counted) throw new Error(`${logTitle} に {{../head|件数=…}} が見つかりません`);
  if (log.exists && L.findLogSection(log.wikitext, threadId)) {
    notes.push({ type: 'warning', text: 'この依頼の作業記録は既にあります。続けると、もう1つ追加します。' });
  }
  const links = L.discussionLinks(req.ownText, { requestPage: BOTREQ_PAGE_TITLE });
  const { text, botSummary } = L.buildStartSection({
    num: counted.num,
    name: req.name,
    threadId,
    editCount: recordedCount,
    logTitle,
    discussion: links.length ? links[0].wikitext : '',
    requester: req.requester,
    requesterName: req.requesterName,
    requestedAt: req.requestedAt,
    now: Date.now(),
  });
  return {
    kind: 'start',
    threadId,
    name: req.name,
    title: logTitle,
    text,
    oldText: log.exists ? log.wikitext : '',
    before: counted.content.replace(/\s+$/, '') + '\n\n',
    after: '\n',
    baseTimestamp: log.baseTimestamp,
    startTimestamp: log.startTimestamp,
    createOnly: !log.exists,
    summary: `+依頼 /* ${req.name} */ 着手`,
    links,
    copy: { label: 'Bot の編集の要約', value: botSummary },
    comment: { text: '{{BOTREQ|着手}}--~~~~', commentId: req.commentId },
    notes,
  };
}

async function prepareComplete(client, threadId, query) {
  const { request: req } = await findRequest(client, threadId);
  const logTitle = L.logTitleFor(config.botreq.logPrefix, req.requestedAt);
  const editCount = await getEditCount(client, config.botreq.botUser);
  const log = await client.getPage(logTitle);
  if (!log.exists) throw new Error(`${logTitle} がありません。先に「着手」を保存してください。`);
  const section = L.findLogSection(log.wikitext, threadId);
  if (!section) throw new Error(`${logTitle} に、この依頼の作業記録が見つかりません。先に「着手」を保存してください。`);
  if (section.startCount === null) throw new Error('作業記録の <!--sec …--> から着手時点の編集回数を読み取れません。');
  const count = editCount - section.startCount;
  if (count <= 0) throw new Error(`着手してから ${config.botreq.botUser} の編集が増えていません。`);
  if (count > MAX_CONTRIBS) throw new Error(`着手してからの編集が ${count} 件と多すぎます。作業記録の <!--sec …--> を確認してください。`);
  const contribs = await getRecentContribs(client, config.botreq.botUser, count);
  if (!contribs.length) throw new Error(`${config.botreq.botUser} の投稿記録を取得できません。`);
  const notes = [];
  if (contribs.length < count) {
    notes.push({
      type: 'warning',
      text: `編集回数の差は ${count} 件ですが、投稿記録には ${contribs.length} 件しかありません（削除された編集など）。${contribs.length} 件で記録します。`,
    });
  }
  if (section.finished) notes.push({ type: 'warning', text: 'この依頼の作業記録は既に完了しています。保存すると上書きします。' });
  // 内訳: どのタスクの編集か。この依頼に紐づけていないタスクやツール以外の編集が混ざっていれば知らせる
  const breakdown = await editsByTask(query, contribs.map((c) => Number(c.revid)).filter(Boolean));
  if (breakdown) {
    const linked = new Set(((await linkedTasks(query)).get(threadId) || []).map((t) => t.id));
    const foreign = breakdown.filter((b) => b.taskId !== null && linked.size > 0 && !linked.has(b.taskId));
    if (foreign.length) {
      notes.push({
        type: 'warning',
        text: `この依頼に紐づけていないタスクの編集が含まれています（${foreign.map((b) => `#${b.taskId}: ${b.count}件`).join('、')}）。範囲を確認してください。`,
      });
    }
  }
  const work = L.contributionLinks(config.botreq.botUser, contribs);
  const text = L.buildCompleteSection(section.core, {
    oldest: contribs[contribs.length - 1].timestamp,
    newest: contribs[0].timestamp,
    work,
  });
  return {
    kind: 'complete',
    threadId,
    name: req.name,
    title: logTitle,
    text,
    oldText: log.wikitext,
    before: log.wikitext.slice(0, section.start),
    after: section.tail + log.wikitext.slice(section.end),
    baseTimestamp: log.baseTimestamp,
    startTimestamp: log.startTimestamp,
    createOnly: false,
    summary: `/* ${req.name} */ 完了 更新`,
    comment: {
      text: L.completeComment({ requester: req.requester, work }),
      commentId: req.commentId,
      help: '「…が0項目のため」の部分は、必要に応じて書き換えてください。',
    },
    workSummary: {
      count: contribs.length,
      oldest: contribs[contribs.length - 1].timestamp,
      newest: contribs[0].timestamp,
      breakdown, // [{taskId, count}]（taskId=null はツール以外の編集）。DB が読めなければ null
    },
    notes,
  };
}

async function prepareResolve(client, threadId) {
  const { page, request: req } = await findRequest(client, threadId);
  if (!req.sectionIndex) throw new Error('この依頼の節の番号を特定できません。');
  const notes = [];
  const closed = L.detectStatus(req.ownText);
  if (closed.status === 'resolved') notes.push({ type: 'warning', text: `この節は既に閉じられています（{{${closed.label}}}）。` });
  const core = req.sectionText.replace(/\s+$/, '');
  return {
    kind: 'resolve',
    threadId,
    name: req.name,
    title: BOTREQ_PAGE_TITLE,
    section: req.sectionIndex,
    text: L.insertResolved(core),
    oldText: core,
    before: '',
    after: '',
    baseTimestamp: page.baseTimestamp,
    startTimestamp: page.startTimestamp,
    createOnly: false,
    summary: `/* ${req.name} */ + 解決済み`,
    notes,
  };
}

const PREPARE = { start: prepareStart, complete: prepareComplete, resolve: prepareResolve };

async function prepare(kind, threadId, { client, query } = {}) {
  if (!PREPARE[kind]) throw Object.assign(new Error(`不明な操作です: ${kind}`), { status: 400 });
  if (typeof threadId !== 'string' || !L.REQUEST_THREAD_ID_RE.test(threadId)) {
    throw Object.assign(new Error('依頼の節の ID が正しくありません'), { status: 400 });
  }
  const plan = await PREPARE[kind](client || defaultReader(), threadId, query || defaultQuery);
  // 保存するアカウント（作業記録は利用者空間の持ち主、依頼ページと返信は運用者）を画面に出す
  plan.saveAccount = accountFor(plan.title);
  if (plan.comment) plan.commentAccount = config.botreq.account;
  return plan;
}

/** 保存の入力を確かめる。誤りがあれば理由の配列を返す。 */
function validateSave(body) {
  const errors = [];
  const b = body || {};
  const isRequestPage = b.title === BOTREQ_PAGE_TITLE;
  if (!isRequestPage && !isLogTitle(b.title)) errors.push('編集できるのは Bot作業依頼 と作業記録のページだけです');
  if (typeof b.text !== 'string' || !b.text.trim()) errors.push('本文が空です');
  if (typeof b.summary !== 'string') errors.push('要約が正しくありません');
  if (isRequestPage && !/^\d+$/.test(String(b.section || ''))) errors.push('依頼ページは節を指定して編集します');
  if (isRequestPage && b.createOnly) errors.push('依頼ページは作成できません');
  if (!b.createOnly && typeof b.baseTimestamp !== 'string') errors.push('編集の基準時刻（baseTimestamp）がありません');
  if (b.comment !== undefined && b.comment !== null) {
    if (typeof b.comment.text !== 'string' || !b.comment.text.trim()) errors.push('コメントが空です');
    if (typeof b.comment.commentId !== 'string' || !/^c-/.test(b.comment.commentId)) errors.push('返信先のコメント ID が正しくありません');
  }
  return errors;
}

/**
 * 保存し、必要なら依頼のコメントへ返信する。
 * @returns {Promise<{revid: number|null, nochange: boolean, comment: null|{ok: boolean, error?: string}}>}
 */
const CHECK_RIGHTS = ['edit', 'createpage'];

/**
 * 運用者アカウントの確認。ログインした名前・グループ・このセッションの権限（BotPassword の grant で絞られたもの）と、
 * 編集するページで MediaWiki が編集を許すか（intestactions）を返す。保存が権限エラーになったときの原因の切り分けに使う。
 * @param {object} [options]
 * @param {string[]} [options.titles] - 確かめるページ（既定: Bot作業依頼と今年の作業記録）
 */
async function checkAccount({ client, titles, account = config.botreq.account } = {}) {
  client = client || (await defaultClient(account));
  const pages = titles && titles.length ? titles : [BOTREQ_PAGE_TITLE, `${config.botreq.logPrefix}${L.jstYear(Date.now())}年`];
  const { ACCOUNT_ENV_MAP } = require('../bot/accountNames');
  const env = ACCOUNT_ENV_MAP[account];
  const info = await client.request({ action: 'query', meta: 'userinfo', uiprop: 'groups|rights' });
  const user = info.query.userinfo;
  const tested = await client.request({
    action: 'query',
    prop: 'info',
    titles: pages.join('|'),
    intestactions: 'edit|create',
    intestactionsdetail: 'full',
    errorformat: 'plaintext',
  });
  const reasons = (list) => (Array.isArray(list) ? list.map((m) => `${m.text || m.html || ''}${m.code ? `（${m.code}）` : ''}`.trim()) : []);
  return {
    account,
    loginName: env ? process.env[env.user] || null : null, // BotPassword のログイン名（例: 利用者名@Bot名）。パスワードは返さない
    userName: user.anon !== undefined ? null : user.name,
    groups: user.groups || [],
    rights: Object.fromEntries(CHECK_RIGHTS.map((r) => [r, (user.rights || []).includes(r)])),
    pages: tested.query.pages.map((p) => {
      const action = p.missing ? 'create' : 'edit';
      const result = p.actions ? p.actions[action] : undefined;
      // intestactionsdetail=full では、許される操作は空の配列、拒否される操作は理由の配列になる
      return { title: p.title, exists: !p.missing, action, allowed: Array.isArray(result) ? result.length === 0 : Boolean(result), reasons: reasons(result) };
    }),
  };
}

/**
 * 保存に使う2つのアカウント（作業記録用・依頼ページ用）を、それぞれ編集するページで確かめる。同じアカウントなら1つにまとめる。
 * @returns {Promise<Array<object>>} checkAccount の結果に role（用途）を足したもの
 */
async function checkAccounts() {
  const logTitle = `${config.botreq.logPrefix}${L.jstYear(Date.now())}年`;
  const roles = [
    { role: '作業記録', account: logAccount(), title: logTitle },
    { role: '依頼ページ・返信', account: config.botreq.account, title: BOTREQ_PAGE_TITLE },
  ];
  const results = [];
  for (const account of [...new Set(roles.map((r) => r.account))]) {
    const mine = roles.filter((r) => r.account === account);
    const check = await checkAccount({ account, titles: mine.map((r) => r.title) });
    results.push({ ...check, role: mine.map((r) => r.role).join('・') });
  }
  return results;
}

/** checkAccount の結果を、エラーに添える1行の説明にする。 */
function describeAccountCheck(check, title) {
  const page = check.pages.find((p) => p.title === title) || check.pages[0];
  const missing = CHECK_RIGHTS.filter((r) => !check.rights[r]);
  const parts = [
    `ログイン: ${check.userName || '（ログインしていない）'}${check.loginName ? `（BotPassword: ${check.loginName}）` : ''}`,
    `このセッションの権限: ${missing.length ? `${missing.join('・')} が無い` : 'edit・createpage あり'}`,
  ];
  if (page) parts.push(`「${page.title}」の${page.action === 'create' ? '作成' : '編集'}: ${page.allowed ? '可' : `不可（${page.reasons.join(' / ') || '理由不明'}）`}`);
  // 権限はあるのに他人の利用者ページを編集できない: jawiki の $wgRestrictUserPageEditing（editalluserpages は BotPassword に付けられない）
  const owner = page && (page.title.match(/^(?:利用者|User)\s*:\s*([^/]+)/i) || [])[1];
  if (page && !page.allowed && !missing.length && owner && check.userName && normalizeUser(owner) !== normalizeUser(check.userName)) {
    parts.push(
      `他人（${owner}）の利用者ページは、jawiki では editalluserpages の権限が無いと編集できず、この権限は BotPassword では付けられません。` +
        `持ち主のアカウントで編集するよう、BOTREQ_LOG_ACCOUNT=${owner} を設定してください`
    );
  }
  return parts.join('。');
}

async function save(body, { client } = {}) {
  const account = accountFor(body.title);
  client = client || (await defaultClient(account));
  try {
    return await saveWith(client, body);
  } catch (err) {
    // 権限エラーなら、ログインしたアカウント・権限・そのページでの判定を添える（原因の切り分け用）
    if (err.mwCode === 'permissiondenied' && err.apiAction === 'edit') {
      try {
        err.diagnosis = describeAccountCheck(await checkAccount({ client, account, titles: [body.title] }), body.title);
      } catch (diagErr) {
        err.diagnosis = `アカウントの確認にも失敗しました: ${diagErr.message}`;
      }
    }
    throw err;
  }
}

async function saveWith(client, body) {
  const edit = await client.withSessionRetry(async () => {
    const token = await client.getCsrfToken();
    const res = await client.request(
      {
        action: 'edit',
        title: body.title,
        text: body.text,
        summary: body.summary,
        section: body.section ? String(body.section) : undefined,
        token,
        assert: 'user',
        watchlist: 'nochange',
        createonly: body.createOnly ? '1' : undefined,
        nocreate: body.createOnly ? undefined : '1',
        basetimestamp: body.createOnly ? undefined : body.baseTimestamp,
        starttimestamp: body.startTimestamp || undefined,
      },
      'POST'
    );
    if (!res.edit || res.edit.result !== 'Success') {
      throw Object.assign(new Error(`保存できませんでした: ${JSON.stringify(res.edit || res)}`), { editResult: res.edit || null });
    }
    return res.edit;
  });

  let comment = null;
  if (body.comment) {
    try {
      await client.withSessionRetry(async () => {
        const token = await client.getCsrfToken();
        await client.request(
          {
            action: 'discussiontoolsedit',
            paction: 'addcomment',
            page: BOTREQ_PAGE_TITLE,
            commentid: body.comment.commentId,
            wikitext: body.comment.text,
            token,
            assert: 'user',
          },
          'POST'
        );
      });
      comment = { ok: true };
    } catch (err) {
      comment = { ok: false, error: `${err.mwCode ? `[${err.mwCode}] ` : ''}${err.mwInfo || err.message}` };
    }
  }
  return { revid: edit.newrevid || null, nochange: Boolean(edit.nochange), comment };
}

/** プレビュー（保存前の本文を、そのページとして描画する）。 */
async function renderPreview(title, text, { client } = {}) {
  client = client || defaultReader();
  const data = await client.request(
    {
      action: 'parse',
      title,
      text,
      contentmodel: 'wikitext',
      pst: '1',
      preview: '1',
      prop: 'text',
      disableeditsection: '1',
      disablelimitreport: '1',
    },
    'POST'
  );
  return data.parse.text;
}

/** 差分（MediaWiki の差分の表の行）。 */
async function renderDiff(title, oldText, newText, { client } = {}) {
  client = client || defaultReader();
  const data = await client.request(
    {
      action: 'compare',
      fromtitle: title,
      fromslots: 'main',
      'fromtext-main': oldText,
      'fromcontentmodel-main': 'wikitext',
      totitle: title,
      toslots: 'main',
      'totext-main': newText,
      'tocontentmodel-main': 'wikitext',
      prop: 'diff',
      difftype: 'table',
    },
    'POST'
  );
  return (data.compare && data.compare.body) || '';
}

/**
 * 依頼ごとの節の本文（小節を含まない）と、着手時に作った Bot の編集の要約。
 * タスク作成画面で {{リンク修正依頼/改名}} を依頼ごとに取り込み、タスクを依頼に紐づけて要約欄を入れるのに使う。
 * threadId を指定すると、その依頼だけを返す（見つからなければ 404）。
 * @returns {Promise<Array<{threadId: string, name: string, text: string, botSummary: string|null, logTitle: string|null}>>}
 */
async function requestSections({ client, threadId } = {}) {
  if (threadId !== undefined && threadId !== null && (typeof threadId !== 'string' || !L.REQUEST_THREAD_ID_RE.test(threadId))) {
    throw Object.assign(new Error('依頼の節の ID が正しくありません'), { status: 400 });
  }
  client = client || defaultReader();
  const { requests } = await loadRequestPage(client);
  const picked = threadId ? requests.filter((r) => r.threadId === threadId) : requests;
  if (threadId && !picked.length) {
    throw Object.assign(new Error('この依頼の節が見つかりません。Bot作業依頼の画面を読み込み直してください。'), { status: 404 });
  }
  const logs = await loadLogs(client, picked);
  return picked.map((r) => {
    const logSection = logSectionOf(logs, r);
    return {
      threadId: r.threadId,
      name: r.name,
      text: r.ownText,
      botSummary: logSection ? L.extractBotSummary(logSection.core) : null,
      logTitle: r.requestedAt ? L.logTitleFor(config.botreq.logPrefix, r.requestedAt) : null,
    };
  });
}

/**
 * タスクに紐づけられる依頼の一覧（{{リンク修正依頼/改名}} の有無を問わない）。新しい依頼を先、閉じられた依頼を後にする。
 * @returns {Promise<Array<{threadId: string, name: string, status: string, statusLabel: string|null, botSummary: string|null, logTitle: string|null}>>}
 */
async function linkCandidates(options = {}) {
  const sections = await requestSections(options);
  const list = sections.map((r) => {
    const { status, label } = L.detectStatus(r.text);
    return { threadId: r.threadId, name: r.name, status, statusLabel: label, botSummary: r.botSummary, logTitle: r.logTitle };
  });
  const open = list.filter((r) => r.status !== 'resolved').reverse();
  const closed = list.filter((r) => r.status === 'resolved').reverse();
  return [...open, ...closed];
}

module.exports = { listRequests, prepare, validateSave, save, renderPreview, renderDiff, isLogTitle, requestSections, linkCandidates, checkAccount, checkAccounts, describeAccountCheck, logAccount, accountFor };

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

async function defaultClient() {
  try {
    return await require('../bot/accounts').getClient(config.botreq.account);
  } catch (err) {
    // 認証情報が未設定・BotPassword の失効など。画面に理由を出せるようにする
    throw Object.assign(new Error(`${config.botreq.account} でウィキにログインできません: ${err.message}`), { status: 502 });
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
    editCount,
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
  return PREPARE[kind](client || defaultReader(), threadId, query || defaultQuery);
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
async function save(body, { client } = {}) {
  client = client || (await defaultClient());
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

module.exports = { listRequests, prepare, validateSave, save, renderPreview, renderDiff, isLogTitle, requestSections };

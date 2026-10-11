'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../src/services/botreqLog');
const desk = require('../src/services/botreqDesk');

const REQUEST_PAGE = 'Wikipedia:Bot作業依頼';
const LOG_TITLE = '利用者:nanonaBot/依頼/2026年';
const THREAD = 'h-バイオハザード-20261010124600';

// ---- 純粋関数 ----

test('formatJst / contribsOffset: 作業記録と同じ書式', () => {
  assert.equal(L.formatJst('2026-01-03T06:27:00Z'), '2026年1月3日 (土) 15:27 (JST)');
  assert.equal(L.formatJst('2026-01-03T15:05:00Z'), '2026年1月4日 (日) 00:05 (JST)'); // 0時は「24時」にしない
  assert.equal(L.contribsOffset(Date.parse('2026-01-03T07:54:37Z') + 1000), '20260103075438');
});

test('encodeSecId: 節IDの「-」を U+FFFD にする（既存の記録と同じ）', () => {
  assert.equal(L.secMarker('h-宮崎誠改名-20260103062700'), '<!--sec h�宮崎誠改名�20260103062700|');
});

test('incrementHeadCount: {{../head|件数=}} を1つ増やす', () => {
  const r = L.incrementHeadCount('{{../head\n|y=2026\n|運用者=nanona15dobato\n|件数=69\n}}\n本文');
  assert.equal(r.num, 70);
  assert.match(r.content, /\|件数=70\n/);
  assert.equal(L.incrementHeadCount('見出しなし'), null);
});

const LOG = [
  '{{../head\n|y=2026\n|運用者=nanona15dobato\n|件数=2\n}}',
  '',
  '== <span class="anchor" id="botreq-n-1"></span>前の依頼 ==',
  '<!--sec h�前の依頼�20260101000000|100-->',
  '* 着手時刻 - x',
  '',
  '== 親の見出し ==',
  '=== <span class="anchor" id="botreq-n-2"></span>バイオハザード ===',
  `<!--sec ${L.encodeSecId(THREAD)}|161272-->`,
  '* 要約欄 - …',
  '* 着手(準備)時刻 - 2026年10月10日 (土) 22:00 (JST)',
  '* 終了時刻 - ',
  '* 作業 - ',
  '',
  '== 次の依頼 ==',
  '本文',
].join('\n');

test('findLogSection: 小見出しの記録でも、見出しの行から次の見出しの手前までを取り出す', () => {
  const s = L.findLogSection(LOG, THREAD);
  assert.ok(s.core.startsWith('=== <span class="anchor" id="botreq-n-2"></span>バイオハザード ==='));
  assert.ok(s.core.endsWith('* 作業 -'));
  assert.equal(s.tail, ' \n\n');
  assert.equal(s.startCount, 161272);
  assert.equal(s.finished, false);
  assert.equal(L.findLogSection(LOG, 'h-無い-20260101000000'), null);
});

test('contributionLinks: 5000件ずつのリンクにし、複数なら合計を付ける', () => {
  const contribs = [{ timestamp: '2026-01-03T07:54:37Z' }, { timestamp: '2026-01-03T07:00:00Z' }, { timestamp: '2026-01-02T00:00:00Z' }];
  assert.equal(L.contributionLinks('nanonaBot', contribs), '{{利用者の投稿記録リンク|nanonaBot|3|20260103075438|text=3編集}}');
  assert.equal(
    L.contributionLinks('nanonaBot', contribs, 2),
    '{{利用者の投稿記録リンク|nanonaBot|2|20260103075438|text=2編集}},{{利用者の投稿記録リンク|nanonaBot|1|20260102000001|text=1編集}}の計3編集'
  );
});

test('detectStatus: {{解決済み}} を優先し、無ければ最後の {{BOTREQ}} で判断する', () => {
  assert.equal(L.detectStatus('== a ==\n本文').status, 'open');
  assert.equal(L.detectStatus('{{BOTREQ|着手}}').status, 'started');
  assert.equal(L.detectStatus('{{BOTREQ|着手}}\n{{BOTREQ|完了}}').status, 'completed');
  assert.equal(L.detectStatus('{{BOTREQ|完了}}\n{{解決済み|~~~~}}').status, 'resolved');
  assert.deepEqual(L.detectStatus('{{BOTREQ|保留}}'), { status: 'other', label: '保留' });
});

test('discussionLinks: 署名・テンプレート・この依頼ページを除き、ノートやプロジェクトを先にする。カテゴリは「:」付き', () => {
  const text = [
    '* 議論: [[ノート:NHK_ONE_(テレビ配信)]]',
    '[[Category:旧カテゴリ]] → [[Category:新カテゴリ]]',
    '[[プロジェクト:映画#他項目と同じタイトルの作品の場合|PJ映画]]',
    '<!-- [[ノート:隠れ]] -->',
    '[[Wikipedia:Bot作業依頼#前の節]] {{BOTREQ|着手}} --[[利用者:A|A]]（[[利用者‐会話:A|会話]]） [https://example.org 外部]',
  ].join('\n');
  assert.deepEqual(
    L.discussionLinks(text, { requestPage: REQUEST_PAGE }).map((l) => l.wikitext),
    [
      '[[ノート:NHK ONE (テレビ配信)]]',
      '[[プロジェクト:映画#他項目と同じタイトルの作品の場合|PJ映画]]',
      '[[:Category:旧カテゴリ]]',
      '[[:Category:新カテゴリ]]',
      '[https://example.org 外部]',
    ]
  );
});

test('sliceSections / matchHeadingsToSections: バイト位置で節を切り、見出しの文字列で依頼と突き合わせる', () => {
  const wikitext = '{{/ヘッダ}}\n== [[第一]]の改名 ==\nあ\n=== 小 ===\nい\n== バイオハザード ==\nう\n';
  const offset = (s) => Buffer.byteLength(wikitext.slice(0, wikitext.indexOf(s)), 'utf8');
  const sections = [
    { index: 'T-1', level: '2', line: '案内', byteoffset: null, fromtitle: 'Wikipedia:Bot作業依頼/ヘッダ' },
    { index: '1', level: '2', line: '<a>第一</a>の改名', byteoffset: offset('== [[第一]]'), fromtitle: REQUEST_PAGE },
    { index: '2', level: '3', line: '小', byteoffset: offset('=== 小'), fromtitle: REQUEST_PAGE },
    { index: '3', level: '2', line: 'バイオハザード', byteoffset: offset('== バイオ'), fromtitle: REQUEST_PAGE },
  ];
  const sliced = L.sliceSections(wikitext, sections, REQUEST_PAGE);
  assert.equal(sliced.length, 3);
  assert.equal(sliced[0].text, '== [[第一]]の改名 ==\nあ\n=== 小 ===\nい\n'); // 小節を含む
  assert.equal(sliced[1].text, '=== 小 ===\nい\n');
  const matched = L.matchHeadingsToSections(
    [{ id: 'h-第一の改名-20261007095500', html: '<span id="x"></span><a href="./第一">第一</a>の改名' }, { id: THREAD, html: 'バイオハザード' }],
    sliced
  );
  assert.deepEqual(matched.map((m) => m.section && m.section.index), ['1', '3']);
});

test('sliceSections: jawiki の byteoffset は文字単位。文字単位の位置でも正しく切る', () => {
  const wikitext = '<!-- 日本語のコメント -->\n== 一 ==\nあ\n== 二 ==\nい';
  const sections = [
    { index: '1', level: '2', line: '一', byteoffset: wikitext.indexOf('== 一'), fromtitle: REQUEST_PAGE },
    { index: '2', level: '2', line: '二', byteoffset: wikitext.indexOf('== 二'), fromtitle: REQUEST_PAGE },
  ];
  assert.deepEqual(L.sliceSections(wikitext, sections, REQUEST_PAGE).map((s) => s.text), ['== 一 ==\nあ\n', '== 二 ==\nい']);
  assert.throws(() => L.sliceSections(wikitext, [{ ...sections[0], byteoffset: 3 }], REQUEST_PAGE), /一致しません/);
});

test('firstComment: 入れ子も含めて最も古いコメント（冒頭の {{解決済み}} の署名ではなく依頼）', () => {
  const heading = {
    replies: [
      { type: 'comment', id: 'c-op-1', author: 'Op', timestamp: '2026-10-10T15:16:00Z', replies: [] },
      { type: 'comment', id: 'c-req', author: '依頼者', timestamp: '2026-10-10T12:46:00Z', replies: [{ type: 'comment', id: 'c-op-2', author: 'Op', timestamp: '2026-10-10T14:00:00Z' }] },
      { type: 'heading', id: 'h-小-20261009000000', replies: [{ type: 'comment', id: 'c-old', author: 'X', timestamp: '2026-10-09T00:00:00Z' }] },
    ],
  };
  assert.equal(L.firstComment(heading).id, 'c-req');
});

// ---- サービス（ウィキはスタブ） ----

function fakeClient({ log = LOG, editCount = 161396, contribsTotal = 124 } = {}) {
  const requestWikitext = '{{/ヘッダ}}\n== バイオハザード ==\n依頼です。[[プロジェクト:映画#節]] --[[利用者:さえぼー|さえぼー]] 2026年10月10日 (土) 12:46 (UTC)\n:{{BOTREQ|着手}}--[[利用者:Op|Op]]\n';
  const calls = [];
  const client = {
    calls,
    async getPage(title) {
      if (title === REQUEST_PAGE) {
        return { exists: true, revid: 500, baseTimestamp: '2026-10-11T00:00:00Z', startTimestamp: '2026-10-11T01:00:00Z', wikitext: requestWikitext };
      }
      if (title === LOG_TITLE && log !== null) {
        return { exists: true, revid: 600, baseTimestamp: '2026-10-10T23:00:00Z', startTimestamp: '2026-10-11T01:00:00Z', wikitext: log };
      }
      return { exists: false, revid: null, baseTimestamp: null, startTimestamp: '2026-10-11T01:00:00Z', wikitext: '' };
    },
    async request(params, method) {
      calls.push({ params, method });
      if (params.action === 'parse' && params.prop === 'sections') {
        return {
          parse: {
            sections: [
              { index: 'T-1', level: '2', line: '案内', byteoffset: null, fromtitle: 'Wikipedia:Bot作業依頼/ヘッダ' },
              { index: '1', level: '2', line: 'バイオハザード', byteoffset: Buffer.byteLength('{{/ヘッダ}}\n'), fromtitle: REQUEST_PAGE },
            ],
          },
        };
      }
      if (params.action === 'discussiontoolspageinfo') {
        return {
          discussiontoolspageinfo: {
            threaditemshtml: [
              { type: 'heading', id: 'h-案内', html: '案内', replies: [] },
              {
                type: 'heading',
                id: THREAD,
                html: 'バイオハザード',
                headingLevel: 2,
                commentCount: 2,
                replies: [{ type: 'comment', id: 'c-さえぼー-20261010124600-バイオハザード', author: 'さえぼー', timestamp: '2026-10-10T12:46:00Z', replies: [] }],
              },
            ],
          },
        };
      }
      if (params.list === 'users') return { query: { users: [{ editcount: editCount }] } };
      if (params.list === 'usercontribs') {
        const list = Array.from({ length: contribsTotal }, (_, i) => ({
          revid: 9000 - i,
          timestamp: new Date(Date.parse('2026-10-10T14:44:59Z') - i * 10000).toISOString().replace('.000', ''),
        }));
        return { query: { usercontribs: list } };
      }
      if (params.action === 'edit') return { edit: { result: 'Success', newrevid: 700 } };
      if (params.action === 'discussiontoolsedit') return { discussiontoolsedit: { result: 'success' } };
      throw new Error('unexpected ' + JSON.stringify(params));
    },
    async getCsrfToken() {
      return 'token+\\';
    },
    async withSessionRetry(fn) {
      return fn();
    },
  };
  return client;
}

test('listRequests: 依頼の節だけを、状態・依頼者・作業記録の状態つきで返す', async () => {
  const data = await desk.listRequests({ client: fakeClient() });
  assert.equal(data.requests.length, 1);
  const r = data.requests[0];
  assert.equal(r.threadId, THREAD);
  assert.equal(r.sectionIndex, '1');
  assert.equal(r.status, 'started');
  assert.equal(r.requester, 'さえぼー');
  assert.equal(r.logTitle, LOG_TITLE);
  assert.equal(r.logState, 'started');
});

test('prepare(start): 件数を増やし、議論場所の候補と依頼者・編集回数を入れた記録を作る', async () => {
  const plan = await desk.prepare('start', THREAD, { client: fakeClient() });
  assert.equal(plan.title, LOG_TITLE);
  assert.match(plan.text, /^== <span class="anchor" id="botreq-n-3"><\/span>バイオハザード ==\n/);
  // 作業記録は NanonaBot（＝作業を数える Bot）で編集するため、着手の保存の1編集を除くよう +1 して記録する
  assert.match(plan.text, new RegExp(`<!--sec ${L.encodeSecId(THREAD)}\\|161397-->`));
  assert.equal(plan.saveAccount, 'NanonaBot');
  assert.equal(plan.commentAccount, 'Nanona15dobato');
  assert.match(plan.text, /\* 議論場所 - \[\[プロジェクト:映画#節\]\]/);
  assert.match(plan.text, /\* 依頼者 - \[\[User:さえぼー\|さえぼー\]\] さん/);
  assert.match(plan.before, /\|件数=3\n/);
  assert.equal(plan.createOnly, false);
  assert.equal(plan.comment.commentId, 'c-さえぼー-20261010124600-バイオハザード');
  assert.ok(plan.notes.some((n) => /既にあります/.test(n.text)));
});

test('prepare(start): 作業記録のページが無ければ、作成する内容にする', async () => {
  const plan = await desk.prepare('start', THREAD, { client: fakeClient({ log: null }) });
  assert.equal(plan.createOnly, true);
  assert.match(plan.before, /^\{\{\.\.\/head\n\|y=2026\n\|運用者=nanona15dobato\n\|件数=1\n\}\}\n\n$/);
});

test('prepare(complete): 着手からの編集数の投稿記録リンクと時刻を書き込み、前後は元のまま', async () => {
  const plan = await desk.prepare('complete', THREAD, { client: fakeClient() });
  assert.match(plan.text, /\* 作業 - \{\{利用者の投稿記録リンク\|nanonaBot\|124\|20261010144500\|text=124編集\}\}$/);
  assert.match(plan.text, /\* 着手時刻 - 2026年10月10日 \(土\) 23:24 \(JST\)/);
  assert.match(plan.text, /\* 終了時刻 - 2026年10月10日 \(土\) 23:44 \(JST\)/);
  const full = plan.before + plan.text.trim() + plan.after;
  assert.ok(full.startsWith(LOG.slice(0, LOG.indexOf('=== <span'))));
  assert.ok(full.endsWith('\n\n== 次の依頼 ==\n本文'));
  assert.match(plan.comment.text, /^\{\{at\|さえぼー\}\}:\{\{BOTREQ\|完了\}\} Botにて\{\{利用者の投稿記録リンク/);
});

test('prepare(complete): 着手していなければエラー', async () => {
  await assert.rejects(desk.prepare('complete', THREAD, { client: fakeClient({ log: '{{../head|件数=0}}' }) }), /先に「着手」/);
  await assert.rejects(desk.prepare('complete', THREAD, { client: fakeClient({ editCount: 161272 }) }), /増えていません/);
});

test('prepare(resolve): 依頼の節の見出しの直後に {{解決済み}} を入れ、節を指定して編集する', async () => {
  const plan = await desk.prepare('resolve', THREAD, { client: fakeClient() });
  assert.equal(plan.title, REQUEST_PAGE);
  assert.equal(plan.section, '1');
  assert.ok(plan.text.startsWith('== バイオハザード ==\n{{解決済み|~~~~}}\n依頼です。'));
});

test('prepare: 不明な操作・正しくない ID は 400', async () => {
  await assert.rejects(desk.prepare('delete', THREAD, { client: fakeClient() }), (err) => err.status === 400);
  await assert.rejects(desk.prepare('start', 'h-案内', { client: fakeClient() }), (err) => err.status === 400);
});

test('validateSave: 編集できるページ・節・基準時刻・返信先を確かめる', () => {
  assert.deepEqual(desk.validateSave({ title: LOG_TITLE, text: 'x', summary: 's', baseTimestamp: 't' }), []);
  assert.deepEqual(desk.validateSave({ title: LOG_TITLE, text: 'x', summary: 's', createOnly: true }), []);
  assert.ok(desk.validateSave({ title: 'Wikipedia:他のページ', text: 'x', summary: 's', baseTimestamp: 't' }).length);
  assert.ok(desk.validateSave({ title: REQUEST_PAGE, text: 'x', summary: 's', baseTimestamp: 't' }).length); // 節の指定が無い
  assert.deepEqual(desk.validateSave({ title: REQUEST_PAGE, section: '1', text: 'x', summary: 's', baseTimestamp: 't' }), []);
  assert.ok(desk.validateSave({ title: LOG_TITLE, text: 'x', summary: 's', baseTimestamp: 't', comment: { text: 'a', commentId: 'h-x' } }).length);
});

test('save: basetimestamp つきで編集し、指定があれば依頼のコメントへ返信する', async () => {
  const client = fakeClient();
  const result = await desk.save(
    { title: REQUEST_PAGE, section: '1', text: 't', summary: 's', baseTimestamp: 'b', startTimestamp: 'st', comment: { text: 'c', commentId: 'c-x' } },
    { client }
  );
  assert.deepEqual(result, { revid: 700, nochange: false, comment: { ok: true } });
  const edit = client.calls.find((c) => c.params.action === 'edit').params;
  assert.equal(edit.section, '1');
  assert.equal(edit.basetimestamp, 'b');
  assert.equal(edit.nocreate, '1');
  assert.equal(edit.assert, 'user');
  const reply = client.calls.find((c) => c.params.action === 'discussiontoolsedit').params;
  assert.equal(reply.commentid, 'c-x');
  assert.equal(reply.paction, 'addcomment');
});

// ---- フェーズ13の改善: 小見出し・タスクとの紐づけ・内訳 ----

/** tasks / edit_log を返す偽の DB。 */
function fakeQuery({ tasks = [], editLog = [] } = {}) {
  return async (sql, params) => {
    if (/FROM tasks/.test(sql)) return [tasks];
    if (/FROM edit_log/.test(sql)) return [editLog.filter((row) => params.includes(row.revid))];
    throw new Error('unexpected sql ' + sql);
  };
}

test('sliceSections: ownText は小節を含まない（状態の判定用）', () => {
  const wikitext = '== 親 ==\n親の本文\n=== 子 ===\n{{BOTREQ|完了}}\n';
  const sections = [
    { index: '1', level: '2', line: '親', byteoffset: 0, fromtitle: REQUEST_PAGE },
    { index: '2', level: '3', line: '子', byteoffset: wikitext.indexOf('=== 子'), fromtitle: REQUEST_PAGE },
  ];
  const [parent, child] = L.sliceSections(wikitext, sections, REQUEST_PAGE);
  assert.equal(parent.ownText, '== 親 ==\n親の本文\n');
  assert.ok(parent.text.includes('{{BOTREQ|完了}}'));
  assert.equal(L.detectStatus(parent.ownText).status, 'open'); // 子の依頼の完了で、親を完了にしない
  assert.equal(L.detectStatus(child.ownText).status, 'completed');
});

test('listRequests: 依頼に紐づけたタスクを返す（DB が読めなくても一覧は出す）', async () => {
  const data = await desk.listRequests({
    client: fakeClient(),
    query: fakeQuery({ tasks: [{ id: 12, status: 'completed', account: 'NanonaBot', thread_id: THREAD }, { id: 13, status: 'queued', account: 'NanonaBot', thread_id: 'h-他-20260101000000' }] }),
  });
  assert.deepEqual(data.requests[0].tasks, [{ id: 12, status: 'completed', account: 'NanonaBot' }]);
  const failing = await desk.listRequests({ client: fakeClient(), query: async () => { throw new Error('no db'); } });
  assert.deepEqual(failing.requests[0].tasks, []);
});

test('prepare(complete): 編集の内訳をタスクごとに数え、紐づけていないタスクの編集が混ざれば注意する', async () => {
  const editLog = [
    ...Array.from({ length: 100 }, (_, i) => ({ task_id: 12, revid: 9000 - i })),
    ...Array.from({ length: 20 }, (_, i) => ({ task_id: 15, revid: 8900 - i })),
  ];
  const plan = await desk.prepare('complete', THREAD, {
    client: fakeClient(),
    query: fakeQuery({ tasks: [{ id: 12, status: 'completed', account: 'NanonaBot', thread_id: THREAD }], editLog }),
  });
  assert.deepEqual(plan.workSummary.breakdown, [
    { taskId: 12, count: 100 },
    { taskId: 15, count: 20 },
    { taskId: null, count: 4 },
  ]);
  assert.ok(plan.notes.some((n) => /紐づけていないタスクの編集.*#15: 20件/.test(n.text)));
});

test('prepare(complete): 依頼にタスクを紐づけていなければ、内訳だけ出して注意はしない', async () => {
  const plan = await desk.prepare('complete', THREAD, { client: fakeClient(), query: fakeQuery({ editLog: [{ task_id: 15, revid: 9000 }] }) });
  assert.deepEqual(plan.workSummary.breakdown, [{ taskId: 15, count: 1 }, { taskId: null, count: 123 }]);
  assert.ok(!plan.notes.some((n) => /紐づけていない/.test(n.text)));
});

test('extractBotSummary: 作業記録の「要約欄」から Bot の要約を取り出す', () => {
  assert.equal(
    L.extractBotSummary('== x ==\n* 要約欄 - <code><nowiki>Bot:[[利用者:nanonaBot/依頼/2026年#botreq-n-1|作業依頼]] - 依頼</nowiki></code>\n* 依頼 - …'),
    'Bot:[[利用者:nanonaBot/依頼/2026年#botreq-n-1|作業依頼]] - 依頼'
  );
  assert.equal(L.extractBotSummary('* 要約欄 - Bot: 手書きの要約 '), 'Bot: 手書きの要約');
  assert.equal(L.extractBotSummary('* 要約欄 - '), null);
  assert.equal(L.extractBotSummary('* 依頼 - …'), null);
});

test('requestSections: 依頼ごとの本文（小節を含まない）と、作業記録の Bot の要約', async () => {
  const log = LOG.replace('* 要約欄 - …', '* 要約欄 - <code><nowiki>Bot:[[利用者:nanonaBot/依頼/2026年#botreq-n-2|作業依頼]] - バイオハザード</nowiki></code>');
  const [r] = await desk.requestSections({ client: fakeClient({ log }), threadId: THREAD });
  assert.equal(r.name, 'バイオハザード');
  assert.ok(r.text.startsWith('== バイオハザード =='));
  assert.equal(r.botSummary, 'Bot:[[利用者:nanonaBot/依頼/2026年#botreq-n-2|作業依頼]] - バイオハザード');
  assert.equal(r.logTitle, LOG_TITLE);
  const [unstarted] = await desk.requestSections({ client: fakeClient({ log: null }) });
  assert.equal(unstarted.botSummary, null);
  await assert.rejects(desk.requestSections({ client: fakeClient(), threadId: 'x' }), (err) => err.status === 400);
  await assert.rejects(desk.requestSections({ client: fakeClient(), threadId: 'h-無い-20260101000000' }), (err) => err.status === 404);
});

test('detectStatus: {{済み}}・{{失効}} とリダイレクト（Resolved・Stale）も閉じられた依頼にする', () => {
  assert.deepEqual(L.detectStatus('== a ==\n{{済み|--署名}}\n{{BOTREQ|着手}}'), { status: 'resolved', label: '済み' });
  assert.deepEqual(L.detectStatus('{{失効|--署名}}'), { status: 'resolved', label: '失効' });
  assert.deepEqual(L.detectStatus('{{Resolved|x}}'), { status: 'resolved', label: '解決済み' });
  assert.deepEqual(L.detectStatus('{{stale}}'), { status: 'resolved', label: '失効' });
  assert.deepEqual(L.detectStatus('{{Template:解決済み|x}}'), { status: 'resolved', label: '解決済み' });
  assert.equal(L.detectStatus('<!-- {{解決済み}} -->').status, 'open'); // コメントアウトは数えない
  assert.equal(L.detectStatus('{{済みマーク}}').status, 'open'); // 別のテンプレート
});

test('detectStatus: BOTREQ の作業中・準備中は着手、done・作業済みは完了', () => {
  assert.equal(L.detectStatus('{{BOTREQ|作業中}}').status, 'started');
  assert.equal(L.detectStatus('{{BOTREQ|準備中}}').status, 'started');
  assert.equal(L.detectStatus('{{BOTREQ|done}}').status, 'completed');
  assert.equal(L.detectStatus('{{BOTREQ|作業済み3}}').status, 'completed');
  assert.deepEqual(L.detectStatus('{{BOTREQ|不受理}}'), { status: 'other', label: '不受理' });
});

test('MediaWikiBotClient: anonymous はログイン情報なしで作れ、ログインはできない（読み取り専用）', async () => {
  const { MediaWikiBotClient } = require('../src/bot/mwClient');
  const anon = new MediaWikiBotClient({ apiUrl: 'https://ja.wikipedia.org/w/api.php', userAgent: 'Test/1.0', anonymous: true });
  assert.equal(anon.anonymous, true);
  await assert.rejects(anon.login(), /ログインできません/);
  assert.throws(() => new MediaWikiBotClient({ apiUrl: 'https://ja.wikipedia.org/w/api.php', userAgent: 'Test/1.0' }), /必須/);
});

// ---- 運用者アカウントの確認（保存が権限エラーになったときの切り分け） ----

function accountClient({ rights = ['read', 'edit', 'createpage'], editAllowed = true, failEdit = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(params) {
      calls.push(params);
      if (params.meta === 'userinfo') return { query: { userinfo: { name: 'Nanona15dobato', groups: ['*', 'user', 'autoconfirmed'], rights } } };
      if (params.intestactions) {
        return {
          query: {
            pages: params.titles.split('|').map((title) => ({
              title,
              actions: { edit: editAllowed ? [] : [{ code: 'badaccess-group0', text: 'You are not allowed to execute the action you have requested.' }] },
            })),
          },
        };
      }
      if (params.action === 'edit') {
        if (failEdit) {
          throw Object.assign(new Error('denied'), { mwCode: 'permissiondenied', mwInfo: 'You are not allowed to execute the action you have requested.', apiAction: 'edit' });
        }
        return { edit: { result: 'Success', newrevid: 1 } };
      }
      throw new Error('unexpected ' + JSON.stringify(params));
    },
    async getCsrfToken() {
      return 't';
    },
    async withSessionRetry(fn) {
      return fn();
    },
  };
}

test('checkAccount: ログインした利用者・このセッションの権限・ページごとの可否を返す', async () => {
  const ok = await desk.checkAccount({ client: accountClient(), titles: [LOG_TITLE] });
  assert.equal(ok.userName, 'Nanona15dobato');
  assert.deepEqual(ok.rights, { edit: true, createpage: true });
  assert.deepEqual(ok.pages, [{ title: LOG_TITLE, exists: true, action: 'edit', allowed: true, reasons: [] }]);

  const ng = await desk.checkAccount({ client: accountClient({ rights: ['read'], editAllowed: false }), titles: [LOG_TITLE] });
  assert.deepEqual(ng.rights, { edit: false, createpage: false });
  assert.equal(ng.pages[0].allowed, false);
  assert.match(desk.describeAccountCheck(ng, LOG_TITLE), /edit・createpage が無い.*編集: 不可/);
});

test('save: 権限エラーのときは、アカウントの確認結果をエラーに添える', async () => {
  const client = accountClient({ rights: ['read'], editAllowed: false, failEdit: true });
  await assert.rejects(
    desk.save({ title: LOG_TITLE, text: 't', summary: 's', baseTimestamp: 'b' }, { client }),
    (err) => err.mwCode === 'permissiondenied' && /ログイン: Nanona15dobato.*edit・createpage が無い/.test(err.diagnosis)
  );
});

test('logAccount / accountFor: 作業記録は利用者空間の持ち主（NanonaBot）、依頼ページは運用者で編集する', () => {
  assert.equal(desk.logAccount(), 'NanonaBot'); // 利用者:nanonaBot/依頼/ → 先頭の大小を区別せず NanonaBot
  assert.equal(desk.accountFor(LOG_TITLE), 'NanonaBot');
  assert.equal(desk.accountFor(REQUEST_PAGE), 'Nanona15dobato');
});

test('describeAccountCheck: 権限はあるのに他人の利用者ページを編集できないときは、editalluserpages と BOTREQ_LOG_ACCOUNT を案内する', () => {
  const check = {
    account: 'Nanona15dobato',
    loginName: 'Nanona15dobato@N15',
    userName: 'Nanona15dobato',
    groups: ['user'],
    rights: { edit: true, createpage: true },
    pages: [{ title: '利用者:NanonaBot/依頼/2026年', exists: true, action: 'edit', allowed: false, reasons: ['要求した操作を行うことは許可されていません。（permissiondenied）'] }],
  };
  const text = desk.describeAccountCheck(check, '利用者:NanonaBot/依頼/2026年');
  assert.match(text, /editalluserpages/);
  assert.match(text, /BOTREQ_LOG_ACCOUNT=NanonaBot/);
});

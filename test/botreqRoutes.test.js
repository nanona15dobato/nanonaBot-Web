'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sendDeskError, proposalsByRequest } = require('../src/routes/botreq');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('sendDeskError: 画面に理由を出せるエラーは JSON で返し、それ以外は共通のエラー処理へ回す', () => {
  const cases = [
    [Object.assign(new Error('x'), { status: 404 }), 404],
    [Object.assign(new Error('x'), { mwCode: 'editconflict' }), 409],
    [Object.assign(new Error('x'), { mwCode: 'articleexists' }), 409],
    [Object.assign(new Error('x'), { mwCode: 'protectedpage', mwInfo: '保護されています' }), 502],
    [Object.assign(new Error('x'), { httpStatus: 429 }), 502],
  ];
  for (const [err, code] of cases) {
    const res = fakeRes();
    sendDeskError(res, () => assert.fail('next は呼ばない'), err);
    assert.equal(res.statusCode, code, err.mwCode || String(err.status || err.httpStatus));
  }
  const res429 = fakeRes();
  sendDeskError(res429, () => {}, Object.assign(new Error('x'), { httpStatus: 429 }));
  assert.match(res429.body.message, /多すぎる/);

  let passed = null;
  sendDeskError(fakeRes(), (err) => (passed = err), new TypeError('bug'));
  assert.ok(passed instanceof TypeError);
});

test('proposalsByRequest: 提案に、書かれた依頼と Bot の要約を付け、通し番号を振り直す', () => {
  const t = (from, to) => `{{リンク修正依頼/改名|提案=[[ノート:X]]|${from}|${to}}}`;
  const proposals = proposalsByRequest([
    { threadId: 'h-A-20260101000000', name: 'A', text: '== A ==\n' + t('旧1', '新1'), botSummary: 'Bot: A', logTitle: 'L' },
    { threadId: 'h-B-20260102000000', name: 'B', text: '== B ==\n' + t('旧2', '新2') + '\n' + t('旧3', '新3'), botSummary: null, logTitle: 'L' },
  ]);
  assert.deepEqual(proposals.map((p) => [p.index, p.request.name, p.request.botSummary, p.pairs[0].from]), [
    [0, 'A', 'Bot: A', '旧1'],
    [1, 'B', null, '旧2'],
    [2, 'B', null, '旧3'],
  ]);
});

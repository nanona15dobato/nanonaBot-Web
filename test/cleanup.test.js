'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// cleanup.js は ../db（mysql2実プール）に依存するため、軽量な疑似DBに差し替えてから読み込む
const DB_PATH = require.resolve('../src/db');
const calls = [];
let pagesLeft = 0;
let taskRows = [];
const fakeModule = new Module(DB_PATH, null);
fakeModule.filename = DB_PATH;
fakeModule.loaded = true;
fakeModule.exports = {
  pool: {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push({ s, params });
      if (s.startsWith('SELECT id FROM tasks')) return [taskRows];
      if (s.startsWith('DELETE FROM task_pages')) {
        const n = Math.min(pagesLeft, params[1]);
        pagesLeft -= n;
        return [{ affectedRows: n }];
      }
      if (s.startsWith('INSERT INTO task_logs')) return [{}];
      throw new Error('想定外のSQL: ' + s);
    },
  },
};
require.cache[DB_PATH] = fakeModule;

const { cleanupOldTaskPages, FINISHED_STATUSES } = require('../src/worker/cleanup');

test('cleanupOldTaskPages: 終わったタスクだけを対象にし、保持日数を条件に渡す', async () => {
  calls.length = 0;
  taskRows = [];
  await cleanupOldTaskPages({ retentionDays: 14 });
  const select = calls.find((c) => c.s.startsWith('SELECT id FROM tasks'));
  assert.deepEqual(select.params[0], ['completed', 'completed_with_failures', 'failed', 'cancelled']);
  assert.equal(select.params[1], 14);
  // 再開できる状態は消さない
  for (const status of ['paused', 'emergency_stopped', 'expired', 'queued', 'running']) {
    assert.ok(!FINISHED_STATUSES.includes(status), status);
  }
});

test('cleanupOldTaskPages: 作業データを分けて削除し、実行ログに残す', async () => {
  calls.length = 0;
  taskRows = [{ id: 5 }];
  pagesLeft = 2500;
  const result = await cleanupOldTaskPages({ retentionDays: 14, batchSize: 1000 });
  assert.deepEqual(result, { tasks: 1, pages: 2500 });
  assert.equal(calls.filter((c) => c.s.startsWith('DELETE FROM task_pages')).length, 3); // 1000 + 1000 + 500
  const log = calls.find((c) => c.s.startsWith('INSERT INTO task_logs'));
  assert.equal(log.params[0], 5);
  assert.match(log.params[log.params.length - 1], /ページ2500件分.*14日/);
});

test('cleanupOldTaskPages: 保持日数が0以下なら何もしない', async () => {
  calls.length = 0;
  assert.deepEqual(await cleanupOldTaskPages({ retentionDays: 0 }), { tasks: 0, pages: 0 });
  assert.equal(calls.length, 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { requeueInterruptedTasks, REQUEUE_MESSAGE } = require('../src/worker/recovery');

/** tasks と、各タスクの直近の「キューに戻しました」の件数を持つ偽の DB。 */
function fakePool(tasks, recentRequeues) {
  const updates = [];
  return {
    updates,
    async query(sql, params) {
      if (/SELECT id FROM tasks WHERE status = 'running'/.test(sql)) return [tasks.filter((t) => t.status === 'running').map((t) => ({ id: t.id }))];
      if (/FROM task_logs/.test(sql)) {
        assert.equal(params[1], REQUEUE_MESSAGE);
        return [[{ cnt: recentRequeues[params[0]] || 0 }]];
      }
      if (/UPDATE tasks SET status = 'queued'/.test(sql)) {
        updates.push([params[0], 'queued']);
        return [{}];
      }
      if (/UPDATE tasks SET status = 'failed'/.test(sql)) {
        updates.push([params[0], 'failed']);
        return [{}];
      }
      if (/SELECT \* FROM tasks WHERE id = \?/.test(sql)) return [[tasks.find((t) => t.id === params[0])]];
      throw new Error('unexpected sql ' + sql);
    },
  };
}

const quiet = { warn() {}, error() {} };

test('requeueInterruptedTasks: 中断されたタスクはキューに戻す', async () => {
  const pool = fakePool([{ id: 1, status: 'running' }], {});
  const logs = [];
  const result = await requeueInterruptedTasks({ pool, writeTaskLog: async (e) => logs.push(e), logger: quiet });
  assert.deepEqual(result, { requeued: [1], failed: [] });
  assert.deepEqual(pool.updates, [[1, 'queued']]);
  assert.equal(logs[0].message, REQUEUE_MESSAGE);
});

test('requeueInterruptedTasks: 同じタスクで再起動が続いている（ワーカーを落としている）なら、戻さずに失敗にして通知する', async () => {
  const pool = fakePool([{ id: 48, status: 'running' }, { id: 49, status: 'running' }], { 48: 2, 49: 1 });
  const logs = [];
  const notified = [];
  const result = await requeueInterruptedTasks({
    pool,
    writeTaskLog: async (e) => logs.push(e),
    notifyTaskStatus: async (task, status) => notified.push([task.id, status]),
    logger: quiet,
  });
  assert.deepEqual(result, { requeued: [49], failed: [48] });
  assert.deepEqual(pool.updates, [[48, 'failed'], [49, 'queued']]);
  assert.match(logs.find((e) => e.taskId === 48).message, /3回続けて停止/);
  assert.deepEqual(notified, [[48, 'failed']]);
});

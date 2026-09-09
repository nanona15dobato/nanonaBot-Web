'use strict';

/**
 * pipeline.js は ../db（mysql2実プールを作る実DB接続モジュール）に依存しているため、
 * このサンドボックスのようにmysql2/dotenvがインストールされていない環境でも
 * ロジックを検証できるよう、require.cache を使って ../db を軽量な
 * インメモリ疑似DBに差し替えてから require する。
 *
 * 目的: 1ページ先読みパイプライン（仕様書9.2節）が、実際に
 * 「Aを確認している間にBを裏で準備する」という順序で動くこと、
 * および onFailure="skipAndContinue" で1件失敗しても後続ページの
 * 処理が続くことを検証する。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const DB_PATH = require.resolve('../src/db');

/** SQL文字列から大まかな操作を判定するための軽量インメモリDB */
function createFakeDb() {
  const tasks = new Map();
  const taskPages = new Map();
  let nextPageId = 1;
  const editLogRows = [];
  const calls = [];

  function seedTask(task) {
    tasks.set(task.id, { ...task });
  }
  function seedPages(rows) {
    for (const r of rows) {
      const id = nextPageId++;
      taskPages.set(id, { id, reviewed_at: null, prepared_at: null, edited_at: null, ...r });
    }
  }

  async function query(sql, params = []) {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT emergency_stopped FROM system_status')) {
      return [[{ emergency_stopped: false }]];
    }

    if (s.startsWith('SELECT * FROM task_pages WHERE task_id')) {
      const [taskId, stage] = params;
      const rows = [...taskPages.values()]
        .filter((p) => p.task_id === taskId && p.stage === stage && p.status === 'pending')
        .sort((a, b) => a.order_index - b.order_index);
      return [rows];
    }

    if (s.startsWith('UPDATE task_pages SET status = ?') === false && s.startsWith('UPDATE task_pages SET status')) {
      // 各種 UPDATE task_pages SET status = '...' ... WHERE id = ?
      const idParam = params[params.length - 1];
      const row = taskPages.get(idParam);
      if (!row) return [{ affectedRows: 0 }];

      if (s.includes("status = 'preparing'")) {
        row.status = 'preparing';
      } else if (s.includes("status = 'skipped'")) {
        row.status = 'skipped';
        row.original_wikitext = params[0];
      } else if (s.includes("status = 'prepared'")) {
        row.status = 'prepared';
        [row.base_revid, row.base_timestamp, row.original_wikitext, row.new_wikitext] = params;
      } else if (s.includes("status = 'failed'")) {
        row.status = 'failed';
        row.error_message = params[0];
      } else if (s.includes("status = 'awaiting_review'")) {
        row.status = 'awaiting_review';
      } else if (s.includes("status = 'approved'")) {
        row.status = 'approved';
      } else if (s.includes("status = 'rejected'")) {
        if (row.status !== 'rejected') row.status = 'rejected';
      } else if (s.includes("status = 'editing'")) {
        row.status = 'editing';
      } else if (s.includes("status = 'edited'")) {
        row.status = 'edited';
      }
      return [{ affectedRows: 1 }];
    }

    if (s.startsWith('SELECT status FROM task_pages WHERE id')) {
      const row = taskPages.get(params[0]);
      return [[row ? { status: row.status } : undefined].filter(Boolean)];
    }

    if (s.startsWith('SELECT status, review_timeout_at FROM tasks')) {
      const t = tasks.get(params[0]);
      return [t ? [{ status: t.status, review_timeout_at: t.review_timeout_at || null }] : []];
    }

    if (s.startsWith('SELECT status FROM tasks WHERE id')) {
      const t = tasks.get(params[0]);
      return [t ? [{ status: t.status }] : []];
    }

    if (s.startsWith("UPDATE tasks SET status = 'paused'")) {
      tasks.get(params[0]).status = 'paused';
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("UPDATE tasks SET status = 'expired'")) {
      tasks.get(params[0]).status = 'expired';
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('UPDATE tasks SET progress_current')) {
      const t = tasks.get(params[0]);
      t.progress_current = (t.progress_current || 0) + 1;
      return [{ affectedRows: 1 }];
    }

    if (s.startsWith('INSERT INTO edit_log')) {
      editLogRows.push(params);
      return [{ insertId: editLogRows.length }];
    }

    throw new Error('fakeDb: 未対応のSQL: ' + s);
  }

  const pool = {
    query,
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      query,
      release: () => {},
    }),
  };

  return { pool, seedTask, seedPages, taskPages, tasks, editLogRows, calls };
}

function withStubbedDb(fakePool, fn) {
  const fakeModule = new Module(DB_PATH, null);
  fakeModule.filename = DB_PATH;
  fakeModule.loaded = true;
  fakeModule.exports = { pool: fakePool };
  const prev = require.cache[DB_PATH];
  require.cache[DB_PATH] = fakeModule;
  try {
    return fn();
  } finally {
    if (prev) require.cache[DB_PATH] = prev;
    else delete require.cache[DB_PATH];
    // pipeline.js / emergencyStop.js / editLog.js も再評価させるためキャッシュを掃除
    delete require.cache[require.resolve('../src/worker/pipeline')];
    delete require.cache[require.resolve('../src/worker/emergencyStop')];
    delete require.cache[require.resolve('../src/worker/editLog')];
  }
}

test('runStagePipeline: 1ページ先読みで進行し、skipAndContinueで1件失敗しても続行する', async () => {
  const db = createFakeDb();
  db.seedTask({
    id: 1,
    status: 'running',
    review_timeout_at: null,
    progress_current: 0,
  });
  db.seedPages([
    { task_id: 1, stage: 1, order_index: 0, page_title: 'ページA', namespace: 0, matched_rule_indices: '[0]', status: 'pending' },
    { task_id: 1, stage: 1, order_index: 1, page_title: 'ページB(失敗)', namespace: 0, matched_rule_indices: '[0]', status: 'pending' },
    { task_id: 1, stage: 1, order_index: 2, page_title: 'ページC', namespace: 0, matched_rule_indices: '[0]', status: 'pending' },
  ]);

  const getPageCallOrder = [];
  const editCallOrder = [];

  const mwClient = {
    async getPage(title) {
      getPageCallOrder.push(title);
      return {
        title,
        exists: true,
        revid: 1,
        baseTimestamp: '2026-08-11T09:00:00Z',
        startTimestamp: '2026-08-11T09:00:01Z',
        wikitext: `本文 ${title} 旧`,
      };
    },
    async edit({ title }) {
      editCallOrder.push(title);
      if (title === 'ページB(失敗)') {
        const err = new Error('編集競合');
        err.mwInfo = 'editconflict';
        throw err;
      }
      return { revid: 999, newTimestamp: '2026-08-11T09:00:05Z' };
    },
  };

  await withStubbedDb(db.pool, async () => {
    const { runStagePipeline } = require('../src/worker/pipeline');

    const result = await runStagePipeline({
      taskId: 1,
      stage: 1,
      mwClient,
      account: 'NanonaBot',
      replacements: [{ steps: [{ pattern: '旧', flags: 'g', replacement: '新' }] }],
      editSettings: { botFlag: true, minorEdit: true, editSummary: 'test', editIntervalSeconds: 0 },
      reviewSettings: { mode: 'auto', autoWaitSeconds: 0 },
      onFailure: 'skipAndContinue',
    });

    assert.equal(result.completed, true);
    assert.equal(result.hadFailures, true);
  });

  // 3ページとも準備され、3ページとも編集が試みられたこと
  assert.deepEqual(getPageCallOrder, ['ページA', 'ページB(失敗)', 'ページC']);
  assert.deepEqual(editCallOrder, ['ページA', 'ページB(失敗)', 'ページC']);

  // 最終状態の確認
  const finalStatuses = [...db.taskPages.values()].map((p) => [p.page_title, p.status]);
  assert.deepEqual(finalStatuses, [
    ['ページA', 'edited'],
    ['ページB(失敗)', 'failed'],
    ['ページC', 'edited'],
  ]);

  // edit_logには成功2件・失敗1件が記録されていること
  assert.equal(db.editLogRows.length, 3);
});

test('runStagePipeline: onFailure="pause"は失敗直後にタスクを止め、以降のページへ進まない', async () => {
  const db = createFakeDb();
  db.seedTask({ id: 2, status: 'running', review_timeout_at: null, progress_current: 0 });
  db.seedPages([
    { task_id: 2, stage: 1, order_index: 0, page_title: 'ページX(失敗)', namespace: 0, matched_rule_indices: '[0]', status: 'pending' },
    { task_id: 2, stage: 1, order_index: 1, page_title: 'ページY', namespace: 0, matched_rule_indices: '[0]', status: 'pending' },
  ]);

  const editCallOrder = [];
  const mwClient = {
    async getPage(title) {
      return {
        title,
        exists: true,
        revid: 1,
        baseTimestamp: '2026-08-11T09:00:00Z',
        startTimestamp: '2026-08-11T09:00:01Z',
        wikitext: '本文 旧',
      };
    },
    async edit({ title }) {
      editCallOrder.push(title);
      throw new Error('保護されています');
    },
  };

  let result;
  await withStubbedDb(db.pool, async () => {
    const { runStagePipeline } = require('../src/worker/pipeline');
    result = await runStagePipeline({
      taskId: 2,
      stage: 1,
      mwClient,
      account: 'NanonaBot',
      replacements: [{ steps: [{ pattern: '旧', flags: 'g', replacement: '新' }] }],
      editSettings: { botFlag: true, minorEdit: true, editSummary: 'test', editIntervalSeconds: 0 },
      reviewSettings: { mode: 'auto', autoWaitSeconds: 0 },
      onFailure: 'pause',
    });
  });

  assert.equal(result.paused, true);
  assert.equal(db.tasks.get(2).status, 'paused');
  // ページYはまだ編集されていない（先読みでprepareはされ得るが、editまでは進まない）
  assert.deepEqual(editCallOrder, ['ページX(失敗)']);
});

// ---- フェーズ7: Category置換/除去に伴う {{リダイレクトの所属カテゴリ}} の自動編集 ----

test('applyRedirectCategoryTemplateEdits: categoryRenameルールがあれば該当カテゴリ引数も改名する', () => {
  withStubbedDb(createFakeDb().pool, () => {
    const { applyRedirectCategoryTemplateEdits } = require('../src/worker/pipeline');
    const wikitext = '{{リダイレクトの所属カテゴリ\n|redirect1=X\n|1-1=旧カテゴリ\n}}';
    const result = applyRedirectCategoryTemplateEdits(wikitext, [
      { templateType: 'categoryRename', from: '旧カテゴリ', to: '新カテゴリ' },
    ]);
    assert.match(result, /\|1-1=新カテゴリ/);
  });
});

test('applyRedirectCategoryTemplateEdits: categoryRemoveルールがあれば該当カテゴリ引数を除去する', () => {
  withStubbedDb(createFakeDb().pool, () => {
    const { applyRedirectCategoryTemplateEdits } = require('../src/worker/pipeline');
    const wikitext = '{{リダイレクトの所属カテゴリ\n|redirect1=X\n|1-1=除去対象\n|1-2=残す\n}}';
    const result = applyRedirectCategoryTemplateEdits(wikitext, [
      { templateType: 'categoryRemove', from: '除去対象' },
    ]);
    assert.doesNotMatch(result, /除去対象/);
    assert.match(result, /\|1-1=残す/);
  });
});

test('applyRedirectCategoryTemplateEdits: 該当が無いページ・無関係なルールは変更しない', () => {
  withStubbedDb(createFakeDb().pool, () => {
    const { applyRedirectCategoryTemplateEdits } = require('../src/worker/pipeline');
    const wikitext = '通常の記事本文。テンプレートなし。';
    const result1 = applyRedirectCategoryTemplateEdits(wikitext, [
      { templateType: 'categoryRename', from: 'A', to: 'B' },
    ]);
    assert.equal(result1, wikitext);

    const result2 = applyRedirectCategoryTemplateEdits(wikitext, [{ templateType: 'custom', steps: [] }]);
    assert.equal(result2, wikitext);
  });
});

test('prepareOnePage: categoryRenameで[[Category:X]]タグと{{リダイレクトの所属カテゴリ}}の両方を1回の準備で書き換える', async () => {
  const db = createFakeDb();
  db.seedTask({ id: 3, status: 'running', review_timeout_at: null, progress_current: 0 });
  db.seedPages([
    {
      task_id: 3,
      stage: 1,
      order_index: 0,
      page_title: '対象記事',
      namespace: 0,
      matched_rule_indices: '[0]',
      status: 'pending',
    },
  ]);

  const mwClient = {
    getPage: async (title) => ({
      title,
      exists: true,
      revid: 1,
      baseTimestamp: '2026-08-11T09:00:00Z',
      startTimestamp: '2026-08-11T09:00:01Z',
      wikitext: '[[Category:旧カテゴリ]]\n\n{{リダイレクトの所属カテゴリ\n|redirect1=X\n|1-1=旧カテゴリ\n}}',
    }),
  };

  await withStubbedDb(db.pool, async () => {
    const { prepareOnePage } = require('../src/worker/pipeline');
    const { buildStepsForTemplateType } = require('../src/worker/templatePresets');

    const rule = {
      templateType: 'categoryRename',
      from: '旧カテゴリ',
      to: '新カテゴリ',
      steps: buildStepsForTemplateType('categoryRename', { from: '旧カテゴリ', to: '新カテゴリ' }),
    };

    const [rows] = await db.pool.query('SELECT * FROM task_pages WHERE task_id = ? AND stage = ? AND status = ?', [
      3,
      1,
      'pending',
    ]);
    const result = await prepareOnePage(rows[0], { mwClient, replacements: [rule] });

    assert.equal(result.status, 'prepared');
    assert.match(result.newWikitext, /\[\[Category:新カテゴリ\]\]/);
    assert.match(result.newWikitext, /\|1-1=新カテゴリ/);
  });
});

'use strict';

// Shared in-memory database for pipeline and complete task-runner integration tests.
function createFakeDb() {
  const tasks = new Map();
  const taskPages = new Map();
  let nextPageId = 1;
  const editLogRows = [];
  const taskLogs = [];
  const calls = [];
  const state = { emergencyStopped: false };

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
      return [[{ emergency_stopped: state.emergencyStopped }]];
    }

    if (s.startsWith('SELECT * FROM task_pages WHERE task_id')) {
      const [taskId, stage] = params;
      const rows = [...taskPages.values()]
        .filter((p) => p.task_id === taskId && p.stage === stage && p.status === 'pending')
        .sort((a, b) => a.order_index - b.order_index);
      return [rows];
    }

    // 中断ページの復旧（resetInterruptedPages）: task_id/stage単位の一括更新
    if (s.startsWith("UPDATE task_pages SET status = 'pending' WHERE task_id")) {
      const [taskId, stage] = params;
      let affectedRows = 0;
      for (const p of taskPages.values()) {
        if (p.task_id === taskId && p.stage === stage && ['preparing', 'prepared', 'awaiting_review', 'approved'].includes(p.status)) {
          p.status = 'pending';
          affectedRows++;
        }
      }
      return [{ affectedRows }];
    }
    if (s.startsWith("UPDATE task_pages SET status = 'failed', error_message = ? WHERE task_id")) {
      const [message, taskId, stage] = params;
      let affectedRows = 0;
      for (const p of taskPages.values()) {
        if (p.task_id === taskId && p.stage === stage && p.status === 'editing') {
          p.status = 'failed';
          p.error_message = message;
          affectedRows++;
        }
      }
      return [{ affectedRows }];
    }

    if (s.startsWith('UPDATE task_pages SET namespace = ?')) {
      const row = taskPages.get(params[1]);
      if (row) row.namespace = params[0];
      return [{ affectedRows: row ? 1 : 0 }];
    }

    if (s.startsWith('UPDATE task_pages SET status = ?') === false && s.startsWith('UPDATE task_pages SET status')) {
      // 各種 UPDATE task_pages SET status = '...' ... WHERE id = ?
      const idParam = params[params.length - 1];
      const row = taskPages.get(idParam);
      if (!row) return [{ affectedRows: 0 }];

      if (s.includes("SET status = 'prepared', reviewed_at = NULL, error_message = ?")) {
        // 手動確認モードの編集競合で、作り直して確認待ちの手前に戻す
        row.status = 'prepared';
        row.error_message = params[0];
        return [{ affectedRows: 1 }];
      }
      if (s.includes("SET status = 'awaiting_review'")) {
        // 前もって承認・却下されたページは確認待ちに戻さない（WHERE status = 'prepared'）
        if (s.includes("AND status = 'prepared'") && row.status !== 'prepared') return [{ affectedRows: 0 }];
        row.status = 'awaiting_review';
        row.prepared_at = new Date();
      } else if (s.includes("status = 'preparing'")) {
        row.status = 'preparing';
      } else if (s.includes("status = 'skipped', error_message = ?, original_wikitext = ?")) {
        // 一括取り消しで取り消さなかったページ（理由つきのスキップ）
        row.status = 'skipped';
        [row.error_message, row.original_wikitext] = params;
      } else if (s.includes("status = 'skipped'")) {
        row.status = 'skipped';
        row.original_wikitext = params[0];
      } else if (s.includes("status = 'prepared'")) {
        row.status = 'prepared';
        [row.base_revid, row.base_timestamp, row.original_wikitext, row.new_wikitext] = params;
      } else if (s.includes("status = 'failed'")) {
        row.status = 'failed';
        row.error_message = params[0];

      } else if (s.includes("status = 'approved'")) {
        row.status = 'approved';
      } else if (s.includes("status = 'rejected'")) {
        if (row.status !== 'rejected') row.status = 'rejected';
      } else if (s.includes("status = 'editing'")) {
        row.status = 'editing';
      } else if (s.includes("status = 'edited'")) {
        row.status = 'edited';
      }
      if (s.includes('error_message = NULL')) row.error_message = null;
      return [{ affectedRows: 1 }];
    }

    if (s.startsWith('SELECT status FROM task_pages WHERE id')) {
      const row = taskPages.get(params[0]);
      return [[row ? { status: row.status } : undefined].filter(Boolean)];
    }

    if (s.startsWith('SELECT status, review_timeout_at')) {
      const t = tasks.get(params[0]);
      return [t ? [{ status: t.status, mode: t.mode, config_json: t.config_json, review_timeout_at: t.review_timeout_at || null }] : []];
    }

    if (s.startsWith('SELECT mode FROM tasks WHERE id')) {
      const t = tasks.get(params[0]);
      return [t ? [{ mode: t.mode || 'auto' }] : []];
    }

    if (s.startsWith('SELECT status, pause_requested FROM tasks WHERE id') || s.startsWith('SELECT status FROM tasks WHERE id')) {
      const t = tasks.get(params[0]);
      return [t ? [{ status: t.status, pause_requested: t.pause_requested || 0 }] : []];
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
      const [taskId] = params;
      const t = tasks.get(taskId);
      t.progress_current = [...taskPages.values()].filter(
        (p) => p.task_id === taskId && ['edited', 'skipped', 'failed', 'rejected'].includes(p.status)
      ).length;
      return [{ affectedRows: 1 }];
    }

    if (s.startsWith('UPDATE task_pages SET error_message = ? WHERE id = ?')) {
      const row = taskPages.get(params[1]);
      if (row) row.error_message = params[0];
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (s.startsWith('UPDATE task_pages SET base_revid = ?')) {
      const row = taskPages.get(params[4]);
      [row.base_revid, row.base_timestamp, row.original_wikitext, row.new_wikitext] = params;
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('INSERT INTO task_logs')) {
      taskLogs.push(params);
      return [{ insertId: taskLogs.length }];
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

  return { pool, seedTask, seedPages, taskPages, tasks, editLogRows, taskLogs, calls, state };
}

module.exports = { createFakeDb };

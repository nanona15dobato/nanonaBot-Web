/* NanonaBot Tool - ダッシュボード */
(function () {
  'use strict';

  const C = window.NanonaCommon;
  const user = window.NANONA_BOT || {};

  const newTaskBtn = new OO.ui.ButtonWidget({ label: '新規タスク作成', icon: 'add', href: '/tasks/new', flags: ['primary', 'progressive'] });
  const page = C.initPage({
    title: 'ダッシュボード',
    active: 'dashboard',
    actions: user.role === 'owner' ? [newTaskBtn] : [],
  });

  // admin_emergency_only は緊急停止の案内のみ（仕様書2章: 他は閲覧不可）
  if (!page.isOwner) {
    page.$main.append(C.buildEmergencyOnlyPanel(user));
    return;
  }

  /** タスク一覧の絞り込み（状態のまとまり） */
  const FILTERS = {
    all: { label: 'すべて', match: () => true },
    active: { label: '進行中', match: (t) => ['queued', 'running'].includes(t.status) },
    attention: {
      label: '要対応',
      match: (t) =>
        Number(t.awaiting_review_count) > 0 || ['paused', 'emergency_stopped', 'expired', 'failed', 'completed_with_failures'].includes(t.status),
    },
    done: { label: '完了', match: (t) => ['completed', 'completed_with_failures'].includes(t.status) },
    closed: { label: '中止・失敗', match: (t) => ['cancelled', 'failed', 'expired'].includes(t.status) },
  };

  /** 要対応一覧に出す理由（操作者が次に何をすればよいか）。 */
  function attentionReason(task) {
    const awaiting = Number(task.awaiting_review_count) || 0;
    if (awaiting > 0) return { type: 'notice', text: '確認待ちのページが' + awaiting + '件あります。' };
    switch (task.status) {
      case 'paused':
        return { type: 'error', text: '失敗により一時停止しています。原因を確認して再開してください。' };
      case 'emergency_stopped':
        return { type: 'error', text: '緊急停止で中断しています。解除後に再開できます。' };
      case 'expired':
        return { type: 'warning', text: '無操作タイムアウトで期限切れになりました。再開できます。' };
      case 'completed_with_failures':
        return { type: 'warning', text: '失敗したページがあります。失敗ページのみ再試行できます。' };
      case 'failed':
        return { type: 'error', text: 'タスクがエラーで終了しました。実行ログを確認してください。' };
      default:
        return null;
    }
  }

  function taskRow(task, reason) {
    const $row = $('<a>').addClass('nb-task-row').attr('href', '/tasks/' + task.id);
    const awaiting = Number(task.awaiting_review_count) || 0;

    const $main = $('<div>').addClass('nb-task-row__main');
    const $title = $('<div>').addClass('nb-task-row__title').append(
      $('<span>').addClass('nb-task-row__id').text('#' + task.id),
      C.taskStatusBadge(task.status)
    );
    if (awaiting > 0) $title.append($('<span>').addClass('nb-chip nb-chip--notice').text('確認待ち ' + awaiting));
    const $meta = $('<div>').addClass('nb-task-row__meta').append(
      $('<span>').text(task.account),
      $('<span>').text(task.mode === 'manual' ? '手動確認' : '自動更新'),
      $('<span>').text('作成: ' + (task.created_by || '-'))
    );
    $main.append($title, $meta);
    if (reason) $main.append($('<div>').addClass('nb-task-row__reason nb-task-row__reason--' + reason.type).text(reason.text));

    const $side = $('<div>').addClass('nb-task-row__side');
    const total = Number(task.progress_total) || 0;
    const current = Number(task.progress_current) || 0;
    $side.append(
      $('<div>').addClass('nb-task-row__progress-label').text(current + ' / ' + total),
      C.progressBar(current, total).$element.addClass('nb-task-row__progress'),
      $('<div>').addClass('nb-task-row__time').append('更新 ', C.timeElement(task.updated_at))
    );
    return $row.append($main, $side);
  }

  // ---- 集計 ----
  const $stats = $('<div>').addClass('nb-stats');
  function statCard(label, value, modifier, filterKey) {
    const $card = $('<button>').attr('type', 'button').addClass('nb-stat').addClass(modifier ? 'nb-stat--' + modifier : '');
    $card.append($('<span>').addClass('nb-stat__value').text(value), $('<span>').addClass('nb-stat__label').text(label));
    if (filterKey) {
      $card.attr('title', 'タスク一覧を「' + FILTERS[filterKey].label + '」で絞り込む');
      $card.on('click', () => {
        filterWidget.selectItemByData(filterKey);
        listSection.$element[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    return $card;
  }

  // ---- 要対応 ----
  const attentionSection = C.section({
    title: '要対応',
    hint: '確認待ち・停止中・失敗ページありのタスクです（古いタスクも含みます）。',
    className: 'nb-attention',
  });
  attentionSection.$element.hide();

  // ---- タスク一覧 ----
  const filterWidget = new OO.ui.ButtonSelectWidget({
    items: Object.entries(FILTERS).map(([key, f]) => new OO.ui.ButtonOptionWidget({ data: key, label: f.label })),
  });
  filterWidget.selectItemByData('all');
  const searchWidget = new OO.ui.SearchInputWidget({ placeholder: 'タスクID・アカウント・作成者で検索' });
  const listSection = C.section({ title: 'タスク一覧', hint: '新しい順・最大50件。行をクリックすると詳細を開きます。' });
  const $listTools = $('<div>').addClass('nb-toolbar').append(filterWidget.$element, searchWidget.$element.addClass('nb-toolbar__search'));
  const $list = $('<div>').addClass('nb-task-list').append(C.loading());
  listSection.$body.append($listTools, $list);

  page.$main.append($stats, attentionSection.$element, listSection.$element);

  let tasks = [];

  function renderList() {
    const filterKey = (filterWidget.findSelectedItem() && filterWidget.findSelectedItem().getData()) || 'all';
    const query = searchWidget.getValue().trim().toLowerCase().replace(/^#/, '');
    const visible = tasks.filter(
      (t) =>
        FILTERS[filterKey].match(t) &&
        (!query || [String(t.id), t.account, t.created_by].some((v) => String(v || '').toLowerCase().includes(query)))
    );
    $list.empty();
    if (tasks.length === 0) {
      $list.append(C.emptyState('タスクはまだありません。「新規タスク作成」から作成できます。'));
      return;
    }
    if (visible.length === 0) {
      $list.append(C.emptyState('条件に一致するタスクはありません。'));
      return;
    }
    visible.forEach((t) => $list.append(taskRow(t)));
  }
  filterWidget.on('choose', renderList);
  searchWidget.on('change', renderList);

  function renderStats(attention) {
    const count = (statuses) => tasks.filter((t) => statuses.includes(t.status)).length;
    const awaitingPages = attention.reduce((sum, t) => sum + (Number(t.awaiting_review_count) || 0), 0);
    $stats.empty().append(
      statCard('実行中', count(['running']), 'progressive', 'active'),
      statCard('待機中', count(['queued']), null, 'active'),
      statCard('要対応', attention.length, attention.length > 0 ? 'warning' : null, 'attention'),
      statCard('確認待ちページ', awaitingPages, awaitingPages > 0 ? 'notice' : null, null)
    );
  }

  function renderAttention(attention) {
    attentionSection.$body.empty();
    if (attention.length === 0) {
      attentionSection.$element.hide();
      return;
    }
    attentionSection.setTitle('要対応（' + attention.length + '件）');
    const $attentionList = $('<div>').addClass('nb-task-list');
    attention.forEach((t) => $attentionList.append(taskRow(t, attentionReason(t))));
    attentionSection.$body.append($attentionList);
    attentionSection.$element.show();
  }

  let lastErrorShown = false;
  C.poll(async () => {
    try {
      const [taskList, attention] = await Promise.all([C.fetchJson('/api/tasks'), C.fetchJson('/api/tasks/attention')]);
      tasks = taskList;
      renderStats(attention);
      renderAttention(attention);
      renderList();
      lastErrorShown = false;
    } catch (e) {
      if (!lastErrorShown) C.toast('タスク一覧の取得に失敗しました: ' + e.message, 'error');
      lastErrorShown = true;
    }
  }, 5000);
})();

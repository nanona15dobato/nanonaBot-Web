/* NanonaBot Tool - 共通クライアントJS（OOUI利用） */
(function () {
  'use strict';

  async function fetchJson(url, options) {
    const opts = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options);
    const res = await fetch(url, opts);
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      // ボディが無い/JSONでないレスポンス（204等）
    }
    if (!res.ok) {
      const message = (data && (data.message || (data.errors && data.errors.join(' / ')) || data.error)) ||
        `HTTPエラー (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function postJson(url, body) {
    return fetchJson(url, { method: 'POST', body: JSON.stringify(body || {}) });
  }

  const TASK_STATUS_LABELS = {
    queued: '待機中',
    running: '実行中',
    paused: '一時停止',
    completed: '完了',
    completed_with_failures: '完了（一部失敗）',
    failed: '失敗',
    cancelled: 'キャンセル',
    expired: '期限切れ',
    emergency_stopped: '緊急停止',
  };

  const PAGE_STATUS_LABELS = {
    pending: '待機中',
    preparing: '準備中',
    prepared: '準備完了',
    awaiting_review: '確認待ち',
    approved: '承認済み',
    rejected: '却下',
    editing: '編集中',
    edited: '編集済み',
    failed: '失敗',
    skipped: 'スキップ（変更なし）',
  };

  function taskStatusBadge(status) {
    const span = document.createElement('span');
    span.className = 'nb-status-badge nb-status-badge--' + status;
    span.textContent = TASK_STATUS_LABELS[status] || status;
    return span;
  }

  function pageStatusBadge(status) {
    const span = document.createElement('span');
    span.className = 'nb-page-status nb-page-status--' + status;
    span.textContent = PAGE_STATUS_LABELS[status] || status;
    return span;
  }

  /** OOUIのMessageWidgetでコンテナに通知を表示する（既存表示は消してから出す）。 */
  function showNotice($container, type, message) {
    $container.empty();
    const widget = new OO.ui.MessageWidget({ type, label: message });
    $container.append(widget.$element);
  }

  /**
   * 共通ヘッダーを構築する。タイトル・緊急停止ボタン・（ownerのみ）新規タスク作成リンク・ログアウトを含む。
   * @param {object} params
   * @param {string} params.title
   * @param {{username:string, role:string}} params.user
   * @returns {jQuery}
   */
  function buildHeader(params) {
    const $header = $('<div>').addClass('nb-header');
    const $title = $('<h1>').addClass('nb-header__title').text(params.title);

    const $right = $('<div>').addClass('nb-header__right');

    if (params.user && params.user.role === 'owner') {
      const dashboardBtn = new OO.ui.ButtonWidget({ label: 'ダッシュボード', href: '/', framed: false });
      const newTaskBtn = new OO.ui.ButtonWidget({ label: '＋ 新規タスク作成', href: '/tasks/new', flags: ['progressive'] });
      $right.append(dashboardBtn.$element, newTaskBtn.$element);
    }

    const emergencyBtn = new OO.ui.ButtonWidget({ label: '緊急停止', flags: ['destructive'], icon: 'alert' });
    emergencyBtn.on('click', async () => {
      if (!window.confirm('本当に緊急停止しますか？現在実行中の処理が停止します。')) return;
      try {
        await postJson('/api/emergency-stop', {});
        window.alert('緊急停止しました。');
        location.reload();
      } catch (e) {
        window.alert('緊急停止に失敗しました: ' + e.message);
      }
    });
    $right.append(emergencyBtn.$element);

    if (params.user) {
      const $who = $('<span>').text(params.user.username + ' (' + params.user.role + ')').css({ marginLeft: '8px', color: '#54595d' });
      const logoutForm = $('<form method="post" action="/oauth/logout" style="display:inline">');
      const logoutBtn = new OO.ui.ButtonWidget({ label: 'ログアウト', framed: false });
      logoutBtn.$element.on('click', () => logoutForm.trigger('submit'));
      $right.append($who, logoutForm.append(logoutBtn.$element));
    }

    return $header.append($title, $right);
  }

  /** 緊急停止状態パネル（admin_emergency_onlyユーザーに表示する最小UI）。 */
  function buildEmergencyOnlyPanel(user) {
    const $panel = $('<div>').addClass('nb-emergency-panel');
    $panel.append($('<p>').text(user.username + ' さんは管理者権限のため、緊急停止のみ操作できます。'));
    const btn = new OO.ui.ButtonWidget({ label: '緊急停止', flags: ['destructive', 'primary'], icon: 'alert' });
    btn.on('click', async () => {
      if (!window.confirm('本当に緊急停止しますか？')) return;
      try {
        await postJson('/api/emergency-stop', {});
        window.alert('緊急停止しました。');
        location.reload();
      } catch (e) {
        window.alert('失敗しました: ' + e.message);
      }
    });
    $panel.append(btn.$element);
    return $panel;
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('ja-JP');
  }

  window.NanonaCommon = {
    fetchJson,
    postJson,
    TASK_STATUS_LABELS,
    PAGE_STATUS_LABELS,
    taskStatusBadge,
    pageStatusBadge,
    showNotice,
    buildHeader,
    buildEmergencyOnlyPanel,
    formatDateTime,
  };
})();

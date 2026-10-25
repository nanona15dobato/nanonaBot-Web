/* NanonaBot Tool - 共通クライアントJS（Wikimedia OOUI利用） */
(function () {
  'use strict';

  const initialData = window.NANONA_BOT || {};

  // ===== API =====

  async function fetchJson(url, options) {
    const opts = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options);
    async function readResponse(res) {
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        // 成功応答の本文が途中で切れた場合も、変更操作を自動で再送しない。
        if (res.ok && res.status !== 204 && !['GET', 'HEAD'].includes((opts.method || 'GET').toUpperCase())) {
          const err = new Error('操作結果を確認できません。再送する前に対象画面で結果を確認してください。');
          err.resultUnknown = true;
          throw err;
        }
        // ボディが無い/JSONでないレスポンス（204等）
      }
      if (!res.ok) {
        const message =
          (data && (data.message || (data.errors && data.errors.join(' / ')) || data.error)) || `HTTPエラー (${res.status})`;
        const err = new Error(message);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    }
    return window.NanonaPwa ? window.NanonaPwa.request(url, opts, readResponse) : readResponse(await fetch(url, opts));
  }

  function postJson(url, body) {
    return fetchJson(url, { method: 'POST', body: JSON.stringify(body || {}) });
  }

  function putJson(url, body) {
    return fetchJson(url, { method: 'PUT', body: JSON.stringify(body || {}) });
  }

  // ===== 表示ラベル =====

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

  /** 置換ルールの種別名（タスク作成画面・設定内容の表示で共通） */
  const RULE_TYPE_LABELS = {
    custom: 'カスタム',
    linkRename: 'リンク置換',
    linkRename2: 'リンク置換（表示を保持）',
    linkRenameExact: 'リンク置換（節・表示名を指定）',
    categoryRename: 'Category置換',
    categoryRemove: 'Category除去',
    templateRename: 'テンプレート置換',
    unlinkPage: 'リンク解除',
    templateSubst: 'テンプレートのsubst化',
    urlRename: '外部リンクの付け替え',
    revertEdits: '編集の一括取り消し',
  };

  /** ウェーブ構成の説明（stage_count別） */
  const WAVE_DESCRIPTIONS = {
    2: ['Template名前空間', 'その他ページ（再取得）'],
    3: ['Template名前空間（編集後に使用ページを更新）', 'その他のカテゴリメンバー（再取得）', 'カテゴリ名の記述があるページ'],
  };

  function badge(className, label) {
    return $('<span>').addClass(className).text(label);
  }

  function taskStatusBadge(status) {
    return badge('nb-status-badge nb-status-badge--' + status, TASK_STATUS_LABELS[status] || status)[0];
  }

  function pageStatusBadge(status) {
    return badge('nb-page-status nb-page-status--' + status, PAGE_STATUS_LABELS[status] || status)[0];
  }

  // ===== 日時 =====

  function toDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatDateTime(value) {
    const d = toDate(value);
    if (!d) return value ? String(value) : '-';
    return d.toLocaleString('ja-JP');
  }

  /** 「3分前」のような相対表記。1日以上前は日時を表示する。 */
  function formatRelative(value) {
    const d = toDate(value);
    if (!d) return '-';
    const diff = Math.round((Date.now() - d.getTime()) / 1000);
    if (diff < 10) return 'たった今';
    if (diff < 60) return diff + '秒前';
    if (diff < 3600) return Math.floor(diff / 60) + '分前';
    if (diff < 86400) return Math.floor(diff / 3600) + '時間前';
    return d.toLocaleString('ja-JP');
  }

  /** 相対表記で表示し、マウスを乗せると正確な日時が出る<time>要素。 */
  function timeElement(value) {
    const d = toDate(value);
    return $('<time>')
      .addClass('nb-time')
      .attr('datetime', d ? d.toISOString() : '')
      .attr('title', formatDateTime(value))
      .text(formatRelative(value));
  }

  // ===== リンク =====

  function wikiUrl(title) {
    return 'https://' + (initialData.wikiHost || 'ja.wikipedia.org') + '/wiki/' + encodeURIComponent(String(title).replace(/ /g, '_'));
  }

  /** ウィキのページを別タブで開くリンク。 */
  function wikiLink(title) {
    return $('<a>').addClass('nb-wiki-link').attr({ href: wikiUrl(title), target: '_blank', rel: 'noopener' }).text(title);
  }

  // ===== 通知・ダイアログ =====

  let $toastArea = null;

  /**
   * 画面下部に一定時間だけ表示する通知。
   * @param {string} message
   * @param {'success'|'error'|'warning'|'notice'} [type]
   */
  function toast(message, type) {
    if (!$toastArea) $toastArea = $('<div>').addClass('nb-toast-area').attr('aria-live', 'polite').appendTo(document.body);
    const widget = new OO.ui.MessageWidget({ type: type || 'success', label: message, showClose: true });
    widget.$element.addClass('nb-toast');
    $toastArea.append(widget.$element);
    const remove = () => widget.$element.fadeOut(200, () => widget.$element.remove());
    widget.on('close', remove);
    setTimeout(remove, type === 'error' ? 10000 : 4000);
  }

  /**
   * OOUIの確認ダイアログ。OKならtrue。
   * @param {string|jQuery} message
   * @param {object} [options]
   * @param {string} [options.title]
   * @param {string} [options.okLabel]
   * @param {boolean} [options.destructive] - 取り消せない操作は赤いボタンにする
   */
  function confirm(message, options) {
    const opts = options || {};
    return OO.ui.confirm(message, {
      title: opts.title,
      actions: [
        { action: 'reject', label: 'キャンセル', flags: 'safe' },
        { action: 'accept', label: opts.okLabel || 'OK', flags: ['primary', opts.destructive ? 'destructive' : 'progressive'] },
      ],
    });
  }

  /**
   * 非同期処理の間ボタンを無効にし、失敗時はトーストで知らせる。
   * @returns {Promise<any>} 成功時は処理の戻り値、失敗時はundefined
   */
  async function withBusy(button, label, fn) {
    button.setDisabled(true);
    try {
      return await fn();
    } catch (e) {
      toast(e.resultUnknown ? e.message : label + 'に失敗しました: ' + e.message, 'error');
      return undefined;
    } finally {
      button.setDisabled(false);
    }
  }

  // ===== 自動更新 =====

  /**
   * タブが表示されている間だけ一定間隔で fn を呼ぶ。タブに戻ったときはすぐ更新する。
   * fn の実行中は次の呼び出しを重ねない。
   * @returns {{refresh: () => Promise<void>}}
   */
  function poll(fn, intervalMs) {
    let running = false;
    async function refresh() {
      if (running) return;
      running = true;
      try {
        await fn();
      } finally {
        running = false;
      }
    }
    setInterval(() => {
      if (!document.hidden) refresh();
    }, intervalMs);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
    window.addEventListener('nb:reconnect', () => refresh());
    refresh();
    return { refresh };
  }

  // ===== レイアウト =====

  /**
   * 見出し付きのカード（セクション）。
   * @param {object} params
   * @param {string} params.title
   * @param {string} [params.hint]
   * @param {Array<OO.ui.Widget|jQuery>} [params.actions] - 見出し右側に置くボタン等
   * @param {string} [params.className]
   * @returns {{$element: jQuery, $body: jQuery, setTitle: (title: string) => void}}
   */
  function section(params) {
    const $title = $('<h2>').addClass('nb-section__title').text(params.title);
    const $head = $('<div>').addClass('nb-section__head').append($title);
    if (params.actions && params.actions.length > 0) {
      $head.append(
        $('<div>').addClass('nb-section__actions').append(params.actions.map((a) => (a.$element ? a.$element : a)))
      );
    }
    const $body = $('<div>').addClass('nb-section__body');
    const $element = $('<section>').addClass('nb-section').addClass(params.className || '').append($head);
    if (params.hint) $element.append($('<p>').addClass('nb-section__hint').text(params.hint));
    $element.append($body);
    return { $element, $body, setTitle: (title) => $title.text(title) };
  }

  /** 空の状態の表示（「まだありません」等）。 */
  function emptyState(message) {
    return $('<p>').addClass('nb-empty').text(message);
  }

  /** 読み込み中の表示。 */
  function loading(message) {
    const bar = new OO.ui.ProgressBarWidget({ progress: false });
    return $('<div>').addClass('nb-loading').append($('<span>').text(message || '読み込み中…'), bar.$element);
  }

  /** 進捗バー（total=0のときは0%）。 */
  function progressBar(current, total) {
    const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
    return new OO.ui.ProgressBarWidget({ progress: percent });
  }

  async function triggerEmergencyStop() {
    const ok = await confirm('すべてのBot編集を直ちに停止します。実行中のタスクは中断され、解除はオーナーだけが行えます。', {
      title: '緊急停止しますか？',
      okLabel: '緊急停止する',
      destructive: true,
    });
    if (!ok) return;
    try {
      await postJson('/api/emergency-stop', {});
      toast('緊急停止しました。', 'warning');
      refreshEmergencyBanner();
    } catch (e) {
      toast(e.resultUnknown ? e.message : '緊急停止に失敗しました: ' + e.message, 'error');
    }
  }

  // ----- 緊急停止中の警告帯（全ページ共通） -----

  let $emergencyBanner = null;
  let currentUser = null;

  async function refreshEmergencyBanner() {
    if (!$emergencyBanner || !currentUser) return;
    try {
      const status = await fetchJson('/api/emergency-stop/status');
      $emergencyBanner.empty();
      if (!status.emergency_stopped) {
        $emergencyBanner.hide();
        $(document).trigger('nb:emergency', [false]);
        return;
      }
      const msg = new OO.ui.MessageWidget({
        type: 'error',
        label:
          '緊急停止中です（' + (status.emergency_stopped_by || '不明') + ' が ' + formatDateTime(status.emergency_stopped_at) +
          ' に実行）。Botは編集しません。',
      });
      $emergencyBanner.append(msg.$element);
      if (currentUser.role === 'owner') {
        const clearBtn = new OO.ui.ButtonWidget({ label: '緊急停止を解除', flags: ['progressive'] });
        clearBtn.on('click', async () => {
          const ok = await confirm('Botの編集を再開できる状態に戻します。緊急停止で中断したタスクは、各タスクの画面から再開してください。', {
            title: '緊急停止を解除しますか？',
            okLabel: '解除する',
          });
          if (!ok) return;
          await withBusy(clearBtn, '解除', async () => {
            await postJson('/api/emergency-stop/clear', {});
            toast('緊急停止を解除しました。');
            await refreshEmergencyBanner();
          });
        });
        msg.$element.append($('<div>').addClass('nb-banner__actions').append(clearBtn.$element));
      }
      $emergencyBanner.show();
      $(document).trigger('nb:emergency', [true, status]);
    } catch (e) {
      // 状態が取れないときは警告帯を変えない（各ページの処理は続ける）
    }
  }

  /**
   * ページの共通枠を作る（上部バー・緊急停止の警告帯・ページ見出し）。
   * @param {object} params
   * @param {string} params.title - ページ見出し
   * @param {'dashboard'|'new'|'editLog'|'settings'|null} [params.active] - ナビの現在位置
   * @param {Array<OO.ui.Widget|jQuery>} [params.actions] - 見出し右側の操作
   * @param {jQuery|Node|string} [params.subtitle]
   * @returns {{$main: jQuery, $titleLine: jQuery, user: object, isOwner: boolean}}
   */
  function initPage(params) {
    const user = { username: initialData.username, role: initialData.role };
    currentUser = user;
    const isOwner = user.role === 'owner';
    const $app = $('#app').addClass('nb-app');

    // ---- 上部バー ----
    const $bar = $('<header>').addClass('nb-appbar');
    const $brand = $('<a>').addClass('nb-appbar__brand').attr({ href: '/', 'aria-label': 'nanonaBot Web ホーム' }).append(
      $('<img>').addClass('nb-appbar__brand-icon').attr({ src: '/static/icons/icon-192.png', alt: '', width: 32, height: 32 }),
      $('<span>').addClass('nb-appbar__brand-label').text('nanonaBot Web')
    );
    const navButtons = [];
    let collapsed = false;
    const $nav = $('<nav>').addClass('nb-appbar__nav').attr({ id: 'nb-primary-nav', 'aria-label': 'メインメニュー' });
    const $menuButton = $('<button>').addClass('nb-appbar__menu-button').attr({
      type: 'button', 'aria-label': 'メニューを開く', 'aria-controls': 'nb-primary-nav', 'aria-expanded': 'false',
    }).append($('<span>').addClass('nb-appbar__menu-icon').attr('aria-hidden', 'true'));
    let menuOpen = false;
    function setMenu(open) {
      menuOpen = collapsed && isOwner && open;
      $nav.prop('hidden', !isOwner || (collapsed && !menuOpen));
      $menuButton.attr({ 'aria-expanded': String(menuOpen), 'aria-label': menuOpen ? 'メニューを閉じる' : 'メニューを開く' });
      $bar.toggleClass('nb-appbar--menu-open', menuOpen);
    }
    $menuButton.on('click', () => setMenu(!menuOpen));
    $nav.on('click', 'a', () => setMenu(false));
    document.addEventListener('click', (event) => {
      if (menuOpen && !$nav[0].contains(event.target) && !$menuButton[0].contains(event.target)) setMenu(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menuOpen) {
        setMenu(false);
        $menuButton.trigger('focus');
      }
    });
    if (isOwner) {
      [
        { key: 'dashboard', label: 'ホーム', href: '/', icon: 'home' },
        { key: 'new', label: '新規タスク', href: '/tasks/new', icon: 'add' },
        { key: 'editLog', label: '編集ログ', href: '/edit-log', icon: 'history' },
        { key: 'botreq', label: 'Bot作業依頼', href: '/botreq', icon: 'speechBubbles' },
        { key: 'settings', label: '設定', href: '/settings', icon: 'settings' },
      ].forEach((item) => {
        const btn = new OO.ui.ButtonWidget({
          label: item.label,
          href: item.href,
          icon: item.icon,
          framed: false,
          flags: item.key === params.active ? ['progressive'] : [],
        });
        if (item.key === params.active) {
          btn.$element.addClass('nb-appbar__nav-item--active');
          btn.$button.attr('aria-current', 'page');
        }
        if (item.key === 'dashboard') btn.$element.addClass('nb-appbar__home-link');
        btn.$button.attr('title', item.label);
        navButtons.push(btn);
        $nav.append(btn.$element);
      });
    }

    const $tools = $('<div>').addClass('nb-appbar__tools');
    const emergencyBtn = new OO.ui.ButtonWidget({ label: '緊急停止', icon: 'alert', flags: ['primary', 'destructive'] });
    emergencyBtn.$element.addClass('nb-appbar__emergency');
    emergencyBtn.$button.attr({ title: '緊急停止', 'aria-label': '緊急停止' });
    emergencyBtn.on('click', triggerEmergencyStop);
    $tools.append(emergencyBtn.$element);

    let userMenu = null;
    if (user.username) {
      const logoutForm = $('<form>').attr({ method: 'post', action: '/oauth/logout' });
      const logoutBtn = new OO.ui.ButtonWidget({ label: 'ログアウト', icon: 'logOut', framed: false });
      logoutBtn.on('click', () => logoutForm.trigger('submit'));
      logoutForm.append(logoutBtn.$element);
      const roleLabel = isOwner ? 'オーナー（全操作）' : user.role === 'admin_emergency_only' ? '管理者（緊急停止のみ）' : user.role;
      userMenu = new OO.ui.PopupButtonWidget({
        label: user.username,
        icon: 'userAvatar',
        framed: false,
        invisibleLabel: false,
        popup: {
          $content: $('<div>').addClass('nb-user-menu').append(
            $('<div>').addClass('nb-user-menu__name').text(user.username),
            $('<div>').addClass('nb-user-menu__role').text(roleLabel),
            logoutForm
          ),
          padded: true,
          align: 'backwards',
        },
      });
      userMenu.$element.addClass('nb-appbar__user-menu');
      userMenu.$button.attr({ title: '利用者メニュー: ' + user.username, 'aria-label': '利用者メニュー: ' + user.username });
      $tools.append(userMenu.$element);
    }
    const $inner = $('<div>').addClass('nb-appbar__inner').append(isOwner ? $menuButton : null, $brand, $nav, $tools);
    $bar.append($inner);
    if (params.active === 'dashboard') $brand.attr('aria-current', 'page');
    function setCompact(compact) {
      $bar.toggleClass('nb-appbar--compact', compact);
      emergencyBtn.setInvisibleLabel(compact);
      if (userMenu) userMenu.setInvisibleLabel(compact);
      navButtons.forEach((btn) => btn.setInvisibleLabel(compact));
    }
    function fitsHeader() {
      const style = window.getComputedStyle($inner[0]);
      const available = $inner[0].clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const widths = [$brand[0].getBoundingClientRect().width, $tools[0].getBoundingClientRect().width];
      if (isOwner) widths.push($nav[0].scrollWidth);
      const required = widths.reduce((sum, width) => sum + width, 0) + (parseFloat(style.columnGap) || 0) * (widths.length - 1);
      return required <= available + 0.5;
    }
    function syncHeader() {
      if (!$inner[0].isConnected) return;
      collapsed = false;
      $bar.removeClass('nb-appbar--collapsed');
      $menuButton.prop('hidden', true);
      setMenu(false);
      setCompact(false);
      if (!fitsHeader()) setCompact(true);
      if (isOwner && !fitsHeader()) {
        collapsed = true;
        $bar.addClass('nb-appbar--collapsed');
        $menuButton.prop('hidden', false);
        navButtons.forEach((btn) => btn.setInvisibleLabel(false));
        setMenu(false);
      }
      $bar.attr('data-layout', collapsed ? 'menu' : $bar.hasClass('nb-appbar--compact') ? 'icons' : 'labels');
    }
    let layoutFrame = null;
    function scheduleHeader() {
      if (layoutFrame !== null) window.cancelAnimationFrame(layoutFrame);
      layoutFrame = window.requestAnimationFrame(() => { layoutFrame = null; syncHeader(); });
    }
    window.addEventListener('resize', scheduleHeader);
    if (window.ResizeObserver) {
      let lastWidth = null;
      const observer = new window.ResizeObserver((entries) => {
        const width = entries[0].contentRect.width;
        if (width !== lastWidth) { lastWidth = width; scheduleHeader(); }
      });
      observer.observe($inner[0]);
    }
    if (document.fonts) document.fonts.ready.then(scheduleHeader);


    // ---- 緊急停止中の警告帯 ----
    $emergencyBanner = $('<div>').addClass('nb-banner').hide();

    // ---- 本文 ----
    const $main = $('<main>').addClass('nb-main');
    const $titleLine = $('<div>').addClass('nb-page-title');
    const $titleText = $('<div>').addClass('nb-page-title__text').append($('<h1>').text(params.title));
    if (params.subtitle) $titleText.append($('<div>').addClass('nb-page-title__subtitle').append(params.subtitle));
    $titleLine.append($titleText);
    if (params.actions && params.actions.length > 0) {
      $titleLine.append(
        $('<div>').addClass('nb-page-title__actions').append(params.actions.map((a) => (a.$element ? a.$element : a)))
      );
    }
    $main.append($titleLine);

    $app.empty().append($bar, $('<div>').addClass('nb-container').append($emergencyBanner, $main));
    syncHeader();

    if (user.role === 'owner' || user.role === 'admin_emergency_only') {
      refreshEmergencyBanner();
      setInterval(() => {
        if (!document.hidden) refreshEmergencyBanner();
      }, 15000);
    }
    return { $main, $titleLine, user, isOwner };
  }

  /** 管理者（緊急停止のみ）向けの案内。緊急停止ボタンは上部バーにある。 */
  function buildEmergencyOnlyPanel(user) {
    const s = section({ title: '緊急停止のみ操作できます' });
    s.$body.append(
      $('<p>').text(
        (user.username || '') +
          ' さんは管理者権限のため、このツールでは緊急停止のみ操作できます。Botの編集を止める必要がある場合は、画面上部の「緊急停止」を押してください。'
      )
    );
    if (window.NanonaPwa) s.$body.append(window.NanonaPwa.createInstallPanel());
    return s.$element;
  }

  /** キーボードショートカット（入力欄・ダイアログ操作中は無効）。 */
  function onShortcut(key, handler) {
    $(document).on('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
      if ($('.oo-ui-window-active').length > 0) return;
      if (e.key.toLowerCase() === key) {
        e.preventDefault();
        handler();
      }
    });
  }

  window.NanonaCommon = {
    fetchJson,
    postJson,
    putJson,
    TASK_STATUS_LABELS,
    PAGE_STATUS_LABELS,
    RULE_TYPE_LABELS,
    WAVE_DESCRIPTIONS,
    taskStatusBadge,
    pageStatusBadge,
    formatDateTime,
    formatRelative,
    timeElement,
    wikiUrl,
    wikiLink,
    toast,
    confirm,
    withBusy,
    poll,
    section,
    emptyState,
    loading,
    progressBar,
    initPage,
    buildEmergencyOnlyPanel,
    onShortcut,
    refreshEmergencyBanner,
  };
})();

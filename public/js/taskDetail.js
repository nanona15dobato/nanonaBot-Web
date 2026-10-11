/* NanonaBot Tool - タスク詳細/Diff確認画面（仕様書9.2節の1ページ先読みパイプラインに対応） */
(function () {
  'use strict';

  const C = window.NanonaCommon;
  const user = window.NANONA_BOT || {};
  const taskId = user.taskId;

  const $titleActions = $('<div>').addClass('nb-title-actions');
  const page = C.initPage({ title: 'タスク #' + taskId, actions: [$titleActions] });

  if (!page.isOwner) {
    page.$main.append(C.buildEmergencyOnlyPanel(user));
    return;
  }

  const PAGE_LIST_STEP = 200; // ページ一覧の一度に表示する件数（大量のページでも重くならないように）
  const REVIEWABLE_DIFF_STATUSES = ['prepared', 'awaiting_review', 'approved', 'editing', 'edited', 'failed', 'rejected'];

  // ===== 状態 =====
  const state = {
    task: null,
    pages: [],
    logs: [],
    warnings: null,
    pageFilter: { status: '', stage: '', query: '', limit: PAGE_LIST_STEP },
    logLevel: '',
    lastReviewKey: null,
    reviewing: null,
    clockOffset: 0, // サーバー時刻 − 端末時刻（ms）
  };
  const compareCache = new Map(); // pageId -> diff html（同じページを何度もaction=compareしないためのキャッシュ）

  /**
   * 差分はページIDと基準の版ごとにキャッシュする（編集競合で最新版から作り直されたら取り直す）。
   * @param {{id:number, base_revid:number}} p
   */
  function loadCompare(p) {
    const key = p.id + ':' + (p.base_revid || '');
    if (!compareCache.has(key)) {
      const promise = C.fetchJson('/api/tasks/' + taskId + '/pages/' + p.id + '/compare').then((r) => r.html);
      promise.catch(() => compareCache.delete(key)); // 失敗したら次回取り直す
      compareCache.set(key, promise);
    }
    return compareCache.get(key);
  }

  /** action=compareが返すHTMLはMediaWiki本体の差分テーブルそのもの（信頼できる自ウィキAPIの出力）。仕様書9章の設計どおり埋め込む。 */
  function diffTable(html) {
    if (!html) return C.emptyState('変更点がありません。');
    return $('<table>')
      .addClass('diff')
      .append(
        '<colgroup><col class="diff-marker"><col class="diff-content"><col class="diff-marker"><col class="diff-content"></colgroup>',
        $('<tbody>').html(html)
      );
  }

  // ===== 差分ダイアログ（ページ一覧から開く） =====
  function DiffDialog(config) {
    DiffDialog.super.call(this, config);
  }
  OO.inheritClass(DiffDialog, OO.ui.ProcessDialog);
  DiffDialog.static.name = 'nbDiffDialog';
  DiffDialog.static.title = '差分';
  DiffDialog.static.size = 'larger';
  DiffDialog.static.actions = [{ action: 'close', label: '閉じる', flags: ['safe', 'close'] }];
  DiffDialog.prototype.initialize = function () {
    DiffDialog.super.prototype.initialize.apply(this, arguments);
    this.content = new OO.ui.PanelLayout({ padded: true, expanded: false });
    this.$body.append(this.content.$element);
  };
  DiffDialog.prototype.getSetupProcess = function (data) {
    return DiffDialog.super.prototype.getSetupProcess.call(this, data).next(() => {
      this.title.setLabel(data.title);
      const $content = this.content.$element.empty().append(C.loading('差分を読み込み中…'));
      loadCompare(data.page)
        .then((html) => {
          $content.empty().append(
            $('<p>').append(C.wikiLink(data.title), ' の準備時点の版との差分'),
            $('<div>').addClass('nb-diff').append(diffTable(html))
          );
          this.updateSize();
        })
        .catch((e) => {
          $content.empty().append(new OO.ui.MessageWidget({ type: 'error', label: '差分の取得に失敗しました: ' + e.message }).$element);
        });
    }, this);
  };
  DiffDialog.prototype.getActionProcess = function (action) {
    if (action === 'close') return new OO.ui.Process(() => this.close());
    return DiffDialog.super.prototype.getActionProcess.call(this, action);
  };
  DiffDialog.prototype.getBodyHeight = function () {
    return Math.min(window.innerHeight * 0.7, this.content.$element.outerHeight(true) || 300);
  };
  const windowManager = new OO.ui.WindowManager();
  $(document.body).append(windowManager.$element);
  const diffDialog = new DiffDialog();
  windowManager.addWindows([diffDialog]);
  function openDiff(p) {
    windowManager.openWindow(diffDialog, { page: p, title: p.page_title });
  }

  // ===== 画面の骨組み =====
  const $summary = $('<div>');
  const summarySection = C.section({ title: 'タスク概要' });
  summarySection.$body.append($summary);
  const $review = $('<div>');

  const pagesPanel = new OO.ui.TabPanelLayout('pages', { label: 'ページ一覧', expanded: false });
  const logsPanel = new OO.ui.TabPanelLayout('logs', { label: '実行ログ', expanded: false });
  const warningsPanel = new OO.ui.TabPanelLayout('warnings', { label: '警告', expanded: false });
  const configPanel = new OO.ui.TabPanelLayout('config', { label: '設定内容', expanded: false });
  const tabs = new OO.ui.IndexLayout({ expanded: false, framed: true, autoFocus: false });
  tabs.addTabPanels([pagesPanel, logsPanel, warningsPanel, configPanel]);
  tabs.$element.addClass('nb-tabs');
  function setTabLabel(panel, label) {
    const item = panel.getTabItem();
    if (item) item.setLabel(label);
  }

  const $lastUpdated = $('<span>').addClass('nb-refresh-status');
  const refreshBtn = new OO.ui.ButtonWidget({ icon: 'reload', label: '更新', framed: false });
  $titleActions.append($lastUpdated, refreshBtn.$element);

  page.$main.append($review, summarySection.$element, tabs.$element);

  // ===== 概要 =====
  function buildModeWidget(task) {
    const reviewSettings = (task.config_json && task.config_json.reviewSettings) || {};
    const mode = reviewSettings.mode || task.mode;
    const widget = new OO.ui.DropdownInputWidget({
      // OOUIのDropdownInputWidgetは選択肢の値を data から読む（value では無視され空値になる）
      options: [
        { data: 'auto', label: '自動更新' },
        { data: 'manual', label: '手動確認' },
      ],
      value: mode,
    });
    let reverting = false;
    widget.on('change', async (nextMode) => {
      if (reverting || nextMode === mode) return; // 失敗時の値の巻き戻しで再送信しない
      widget.setDisabled(true);
      try {
        await C.postJson('/api/tasks/' + taskId + '/review-mode', { mode: nextMode });
        C.toast('確認モードを「' + (nextMode === 'auto' ? '自動更新' : '手動確認') + '」に切り替えました。');
        await poller.refresh();
      } catch (e) {
        C.toast('モード切替に失敗しました: ' + e.message, 'error');
        reverting = true;
        widget.setValue(mode);
        reverting = false;
        widget.setDisabled(false);
      }
    });
    return widget;
  }

  function actionButton(label, flags, icon, handler) {
    const btn = new OO.ui.ButtonWidget({ label, flags, icon });
    btn.on('click', () => handler(btn));
    return btn;
  }

  function renderTitleActions(task) {
    $titleActions.children('.oo-ui-buttonWidget').not(refreshBtn.$element).remove();
    const buttons = [];
    if (['paused', 'emergency_stopped', 'expired'].includes(task.status)) {
      buttons.push(
        actionButton('再開する', ['primary', 'progressive'], 'play', (btn) =>
          C.withBusy(btn, '再開', async () => {
            await C.postJson('/api/tasks/' + taskId + '/resume', {});
            C.toast('再開を要求しました。ワーカーが未処理のページから続行します。');
            await poller.refresh();
          })
        )
      );
    }
    if (task.status === 'completed_with_failures') {
      buttons.push(
        actionButton('失敗ページのみ再試行', ['progressive'], 'reload', async (btn) => {
          const ok = await C.confirm(
            '同じ置換ルール・編集設定を引き継ぎ、失敗したページだけを対象にした新しいタスクを作成します（仕様書9.3節）。',
            { title: '再試行タスクを作成しますか？', okLabel: '作成する' }
          );
          if (!ok) return;
          await C.withBusy(btn, '再試行タスクの作成', async () => {
            const result = await C.postJson('/api/tasks/' + taskId + '/retry-failed', {});
            C.toast(result.retriedPageCount + '件を対象に再試行タスク #' + result.id + ' を作成しました。');
            location.href = '/tasks/' + result.id;
          });
        })
      );
    }
    const config = task.config_json || {};
    const isRevertTask = (config.replacements || []).some((r) => r.templateType === 'revertEdits');
    if (['completed', 'completed_with_failures', 'failed', 'cancelled', 'paused', 'emergency_stopped', 'expired'].includes(task.status)) {
      buttons.push(actionButton('編集を一括で取り消す', ['destructive'], 'undo', (btn) => openRevertDialog(btn, task)));
    }
    if (!isRevertTask) {
      buttons.push(
        actionButton('複製', [], 'copy', () => {
          location.href = '/tasks/new?from=' + taskId;
        })
      );
    }
    if (['queued', 'running', 'paused'].includes(task.status)) {
      buttons.push(
        actionButton('中止', ['destructive'], 'cancel', async (btn) => {
          const ok = await C.confirm('このタスクを中止します。編集済みのページはそのまま残り、中止したタスクは再開できません。', {
            title: 'タスクを中止しますか？',
            okLabel: '中止する',
            destructive: true,
          });
          if (!ok) return;
          await C.withBusy(btn, 'タスクの中止', async () => {
            await C.postJson('/api/tasks/' + taskId + '/cancel', {});
            C.toast('タスクを中止しました。', 'warning');
            await poller.refresh();
          });
        })
      );
    }
    refreshBtn.$element.before(buttons.map((b) => b.$element));
  }

  /** 一括取り消しの確認ダイアログ（要約欄・確認モードを選んでから作る）。 */
  async function openRevertDialog(btn, task) {
    const summaryWidget = new OO.ui.TextInputWidget({ value: 'Bot: タスク #' + task.id + ' の編集を取り消し' });
    const modeWidget = new OO.ui.RadioSelectInputWidget({
      options: [
        { data: 'manual', label: '手動確認（1件ずつ差分を見て承認する）' },
        { data: 'auto', label: '自動更新（待機0秒ですぐ取り消す）' },
      ],
      value: 'manual',
    });
    const $content = $('<div>').addClass('nb-revert-dialog').append(
      $('<p>').text(
        'このタスクが編集したページを、編集前の版に戻す新しいタスクを作ります。' +
          'このタスクの編集がまだ最新版のページだけを取り消し、後に他の人の編集があるページは取り消さずに理由つきで残します。'
      ),
      new OO.ui.FieldLayout(summaryWidget, { label: '要約欄', align: 'top' }).$element,
      new OO.ui.FieldLayout(modeWidget, { label: '確認モード', align: 'top' }).$element
    );
    const ok = await C.confirm($content, { title: 'タスク #' + task.id + ' の編集を一括で取り消しますか？', okLabel: '取り消しタスクを作成', destructive: true });
    if (!ok) return;
    await C.withBusy(btn, '取り消しタスクの作成', async () => {
      const result = await C.postJson('/api/tasks/' + taskId + '/revert', {
        editSummary: summaryWidget.getValue(),
        mode: modeWidget.getValue(),
        autoWaitSeconds: 0,
      });
      C.toast(result.pageCount + 'ページを対象に取り消しタスク #' + result.id + ' を作成しました。');
      location.href = '/tasks/' + result.id;
    });
  }

  const STATUS_MESSAGES = {
    paused: { type: 'error', label: '失敗により一時停止しています。実行ログ・ページ一覧で原因を確認し、「再開する」で未処理のページから続行できます。' },
    emergency_stopped: { type: 'error', label: '緊急停止により中断しました。緊急停止を解除してから「再開する」で未処理のページから続行できます。' },
    expired: { type: 'warning', label: '無操作タイムアウトで期限切れになりました。「再開する」とタイムアウトを取り直して未処理のページから続行します。' },
    completed_with_failures: { type: 'warning', label: '一部のページで失敗しました。「失敗ページのみ再試行」で失敗したページだけの新しいタスクを作れます。' },
    failed: { type: 'error', label: 'タスクがエラーで終了しました。実行ログを確認してください。' },
    cancelled: { type: 'notice', label: 'このタスクは中止されました。' },
    completed: { type: 'success', label: 'タスクが完了しました。' },
  };

  function countByStatus(pages) {
    return pages.reduce((acc, p) => {
      acc[p.status] = (acc[p.status] || 0) + 1;
      return acc;
    }, {});
  }

  function waveSteps(task) {
    const descriptions = C.WAVE_DESCRIPTIONS[task.stage_count];
    if (!descriptions) return null;
    const $steps = $('<ol>').addClass('nb-waves');
    descriptions.forEach((text, i) => {
      const stage = i + 1;
      const done = stage < task.current_stage || ['completed', 'completed_with_failures'].includes(task.status);
      const $step = $('<li>')
        .addClass('nb-waves__step')
        .toggleClass('nb-waves__step--current', stage === task.current_stage && !done)
        .toggleClass('nb-waves__step--done', done)
        .append($('<span>').addClass('nb-waves__number').text(stage), $('<span>').addClass('nb-waves__text').text('ウェーブ' + stage + ': ' + text));
      $steps.append($step);
    });
    return $steps;
  }

  function renderSummary(task, pages) {
    renderTitleActions(task);
    $summary.empty();

    const message = STATUS_MESSAGES[task.status];
    if (message) $summary.append(new OO.ui.MessageWidget(message).$element.addClass('nb-summary__message'));

    const total = Number(task.progress_total) || 0;
    const current = Number(task.progress_current) || 0;
    const $progress = $('<div>').addClass('nb-summary__progress').append(
      $('<div>').addClass('nb-summary__progress-head').append(
        C.taskStatusBadge(task.status),
        $('<span>').addClass('nb-summary__progress-text').text('進捗 ' + current + ' / ' + total + (total > 0 ? '（' + Math.round((current / total) * 100) + '%）' : ''))
      ),
      C.progressBar(current, total).$element
    );
    $summary.append($progress);

    const $waves = waveSteps(task);
    if ($waves) $summary.append($waves);

    // ページ状態ごとの件数（クリックでページ一覧を絞り込む）
    const counts = countByStatus(pages);
    const $chips = $('<div>').addClass('nb-chips');
    ['awaiting_review', 'pending', 'edited', 'skipped', 'rejected', 'failed'].forEach((status) => {
      const n = counts[status] || 0;
      if (n === 0 && !['awaiting_review', 'edited', 'failed'].includes(status)) return;
      $('<button>')
        .attr('type', 'button')
        .addClass('nb-chip nb-chip--' + status)
        .text(C.PAGE_STATUS_LABELS[status] + ' ' + n)
        .attr('title', 'ページ一覧を「' + C.PAGE_STATUS_LABELS[status] + '」で絞り込む')
        .on('click', () => {
          statusFilter.setValue(status);
          tabs.setTabPanel('pages');
          tabs.$element[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
        })
        .appendTo($chips);
    });
    $summary.append($chips);

    // 設定の要点
    const config = task.config_json || {};
    const $facts = $('<dl>').addClass('nb-facts');
    const fact = (label, value) => $facts.append($('<dt>').text(label), $('<dd>').append(value));
    fact('アカウント', document.createTextNode(task.account));
    if (['queued', 'running'].includes(task.status)) {
      fact('確認モード', buildModeWidget(task).$element);
    } else {
      fact('確認モード', document.createTextNode(task.mode === 'manual' ? '手動確認' : '自動更新'));
    }
    fact('失敗時', document.createTextNode(config.onFailure === 'skipAndContinue' ? 'スキップして続行' : '一時停止'));
    fact('作成', $('<span>').append(document.createTextNode((task.created_by || '-') + '・'), C.timeElement(task.created_at)));
    fact('最終更新', C.timeElement(task.updated_at));
    if (task.retry_of_task_id) fact('再試行元', $('<a>').attr('href', '/tasks/' + task.retry_of_task_id).text('#' + task.retry_of_task_id));
    if (config.revertOfTaskId) fact('取り消し元', $('<a>').attr('href', '/tasks/' + config.revertOfTaskId).text('#' + config.revertOfTaskId + ' の編集を一括取り消し'));
    fact('編集ログ', $('<a>').attr('href', '/edit-log?task_id=' + taskId).text('このタスクの編集ログを見る'));
    $summary.append($facts);
  }

  // ===== 確認・編集の進行パネル =====
  // 優先順位: 確認待ち → 直前に編集が失敗したページ → 先読み済みの次のページ（編集中もこちらを表示） → 編集中のページ
  const IN_FLIGHT_STATUSES = ['approved', 'editing'];
  const seenInFlight = new Set(); // 画面で「編集中」を見たページ（失敗したらそのページに戻すため）
  const dismissedFailures = new Set();
  let countdown = null; // { deadline(端末時刻), total, $text, bar, format }

  /** サーバー時刻の文字列を端末の時刻（ms）に直す（clockOffset = サーバー − 端末）。 */
  function toClientTime(value) {
    const t = value ? new Date(value).getTime() : NaN;
    return Number.isNaN(t) ? null : t - state.clockOffset;
  }

  function byOrder(a, b) {
    return a.stage - b.stage || a.order_index - b.order_index;
  }

  /** 最後に編集が終わった時刻 + 編集間隔 ＝ ワーカーが次のページへ進む予定時刻（端末時刻）。 */
  function nextEditAt(task, pages) {
    const interval = Number((task.config_json && task.config_json.editSettings && task.config_json.editSettings.editIntervalSeconds) || 0);
    const lastEdited = pages.reduce((max, p) => Math.max(max, toClientTime(p.edited_at) || 0), 0);
    if (!lastEdited) return null;
    const at = lastEdited + interval * 1000;
    return at > Date.now() ? at : null;
  }

  function pickFocus(task, pages) {
    pages.filter((p) => IN_FLIGHT_STATUSES.includes(p.status)).forEach((p) => seenInFlight.add(p.id));
    const awaiting = pages.find((p) => p.status === 'awaiting_review');
    const inFlight = pages.filter((p) => IN_FLIGHT_STATUSES.includes(p.status)).sort(byOrder)[0] || null;
    const failed = pages.find((p) => p.status === 'failed' && seenInFlight.has(p.id) && !dismissedFailures.has(p.id));
    const next = pages.filter((p) => p.status === 'prepared').sort(byOrder)[0] || null;
    const lastEdited = pages.filter((p) => p.status === 'edited' && p.edited_at).sort((a, b) => toClientTime(b.edited_at) - toClientTime(a.edited_at))[0] || null;
    if (awaiting) return { kind: 'review', page: awaiting, inFlight, lastEdited };
    if (failed) return { kind: 'failed', page: failed, inFlight, lastEdited };
    if (next && ['queued', 'running'].includes(task.status)) return { kind: 'next', page: next, inFlight, lastEdited };
    if (inFlight) return { kind: 'editing', page: inFlight, inFlight: null, lastEdited };
    return null;
  }

  function renderReview(task, pages) {
    const focus = pickFocus(task, pages);
    state.reviewing = focus && ['review', 'next'].includes(focus.kind) ? focus.page : null;
    if (!focus) {
      $review.empty();
      state.lastReviewKey = null;
      countdown = null;
      return;
    }

    const reviewSettings = (task.config_json && task.config_json.reviewSettings) || {};
    const mode = reviewSettings.mode || task.mode;
    const p = focus.page;
    // 自動更新で毎回作り直すと、開いているドロップダウンが閉じたりDiffのスクロール位置が
    // 戻ったりするため、表示内容が変わったときだけ作り直す（カウントダウンは別タイマーで更新）。
    const key = [
      focus.kind, p.id, p.status, p.base_revid, p.error_message, mode, p.prepared_at, reviewSettings.autoWaitSeconds,
      focus.inFlight && focus.inFlight.id, focus.inFlight && focus.inFlight.error_message, focus.lastEdited && focus.lastEdited.id,
    ].join('|');
    if (key === state.lastReviewKey) return;
    state.lastReviewKey = key;

    const remaining = pages.filter((x) => ['awaiting_review', 'pending', 'prepared', 'preparing'].includes(x.status)).length;
    const LABELS = {
      review: '確認待ち（W' + p.stage + '・残り' + remaining + '件）',
      next: '次に編集するページ（準備完了・W' + p.stage + '・残り' + remaining + '件）',
      failed: '編集に失敗しました（W' + p.stage + '）',
      editing: '編集中（W' + p.stage + '）',
    };
    const $panel = $('<section>').addClass('nb-review nb-review--' + focus.kind).attr('aria-label', LABELS[focus.kind]);
    const $heading = $('<div>').addClass('nb-review__heading').append(
      $('<span>').addClass('nb-review__label').text(LABELS[focus.kind]),
      $('<h2>').addClass('nb-review__title').append(C.wikiLink(p.page_title), ' ', C.pageStatusBadge(p.status))
    );
    const $head = $('<div>').addClass('nb-review__head').append($heading);

    // 進行状況の1行（編集中のページ・直前に編集したページ）
    const $flow = $('<div>').addClass('nb-review__flow');
    if (focus.inFlight) {
      const viewBtn = new OO.ui.ButtonWidget({ label: '差分', icon: 'eye', framed: false, flags: ['progressive'] });
      viewBtn.on('click', () => openDiff(focus.inFlight));
      $flow.append(
        $('<span>').addClass('nb-review__flow-item').append(
          new OO.ui.ProgressBarWidget({ progress: false }).$element.addClass('nb-review__flow-bar'),
          '編集中: ',
          C.wikiLink(focus.inFlight.page_title),
          viewBtn.$element
        )
      );
      // 一時的な失敗で再試行を待っている（例: 「再試行待ち（1/3、約10秒後）: Edit conflict.」）
      if (focus.inFlight.error_message) {
        $flow.append($('<span>').addClass('nb-review__flow-item nb-review__flow-item--retry').text(focus.inFlight.error_message));
      }
    }
    if (focus.lastEdited && (!focus.inFlight || focus.lastEdited.id !== focus.inFlight.id)) {
      $flow.append($('<span>').addClass('nb-review__flow-item nb-review__flow-item--done').append('直前に編集: ', C.wikiLink(focus.lastEdited.page_title), ' （', C.timeElement(focus.lastEdited.edited_at), '）'));
    }

    // 操作ボタン
    const canDecide = focus.kind === 'review' || focus.kind === 'next';
    if (canDecide) {
      const early = focus.kind === 'next';
      const approveBtn = new OO.ui.ButtonWidget({
        label: early ? '前もって承認' : '承認して編集',
        icon: 'check',
        flags: ['primary', 'progressive'],
        title: (early ? '前のページの編集が終わったらすぐ編集します' : '承認') + '（キー: A）',
      });
      const rejectBtn = new OO.ui.ButtonWidget({ label: early ? '前もって却下' : '却下', icon: 'close', flags: ['destructive'], title: '却下（キー: R）' });
      const submit = async (action) => {
        if (approveBtn.isDisabled()) return;
        approveBtn.setDisabled(true);
        rejectBtn.setDisabled(true);
        try {
          await C.postJson('/api/tasks/' + taskId + '/pages/' + p.id + '/' + action, {});
          C.toast((action === 'approve' ? '承認しました: ' : '却下しました: ') + p.page_title, action === 'approve' ? 'success' : 'notice');
          await poller.refresh();
        } catch (e) {
          C.toast((action === 'approve' ? '承認' : '却下') + 'に失敗しました: ' + e.message, 'error');
          approveBtn.setDisabled(false);
          rejectBtn.setDisabled(false);
          await poller.refresh();
        }
      };
      approveBtn.on('click', () => submit('approve'));
      rejectBtn.on('click', () => submit('reject'));
      state.submitReview = submit;
      $head.append(
        $('<div>').addClass('nb-review__actions').append(
          $('<label>').addClass('nb-review__mode').append($('<span>').text('確認モード'), buildModeWidget(task).$element),
          rejectBtn.$element,
          approveBtn.$element
        )
      );
    } else if (focus.kind === 'failed') {
      const dismissBtn = new OO.ui.ButtonWidget({ label: '閉じて次へ', icon: 'next' });
      dismissBtn.on('click', () => {
        dismissedFailures.add(p.id);
        state.lastReviewKey = null;
        renderReview(state.task, state.pages);
      });
      $head.append($('<div>').addClass('nb-review__actions').append(dismissBtn.$element));
      state.submitReview = null;
    } else {
      state.submitReview = null;
    }
    $panel.append($head);
    if ($flow.children().length > 0) $panel.append($flow);

    if (focus.kind === 'failed' && p.error_message) {
      $panel.append(new OO.ui.MessageWidget({ type: 'error', label: p.error_message }).$element.addClass('nb-review__error'));
    }
    // 手動確認モードで編集競合が起き、最新版で作り直されて確認待ちに戻ったページ
    if ((focus.kind === 'review' || focus.kind === 'next') && p.error_message) {
      $panel.append(new OO.ui.MessageWidget({ type: 'warning', label: p.error_message }).$element.addClass('nb-review__error'));
    }
    if (focus.kind === 'editing' && p.error_message) {
      $panel.append(new OO.ui.MessageWidget({ type: 'warning', label: p.error_message }).$element.addClass('nb-review__error'));
    }

    // カウントダウン（自動承認／編集間隔が明けるまで）
    countdown = null;
    if (focus.kind === 'review' && mode === 'auto') {
      const autoWaitSeconds = Number(reviewSettings.autoWaitSeconds) || 0;
      const startedAt = toClientTime(p.prepared_at) || Date.now();
      countdown = { deadline: startedAt + autoWaitSeconds * 1000, total: autoWaitSeconds * 1000, format: (s) => (s > 0 ? 'あと約' + s + '秒で自動承認されます' : 'まもなく自動承認されます') };
    } else if (focus.kind === 'next' && !focus.inFlight) {
      // 前のページを編集中（再試行待ちを含む）の間は、番が来る時刻が決まらないので出さない
      const at = nextEditAt(task, pages);
      const interval = Number((task.config_json && task.config_json.editSettings && task.config_json.editSettings.editIntervalSeconds) || 0) * 1000;
      if (at) {
        countdown = {
          deadline: at,
          total: interval,
          format: (s) => (s > 0 ? '編集間隔をあけています。あと約' + s + '秒でこのページの番になります' : 'まもなくこのページの番になります'),
        };
      }
    }
    if (countdown) {
      countdown.bar = new OO.ui.ProgressBarWidget({ progress: 0 });
      countdown.$text = $('<span>');
      $panel.append($('<div>').addClass('nb-review__countdown').append(countdown.$text, countdown.bar.$element));
      updateCountdown();
    }
    if (canDecide) {
      $panel.append(
        $('<p>').addClass('nb-review__hint').text(
          (focus.kind === 'next' ? '前もって承認すると、確認待ちにならずにすぐ編集します。' : '') + 'キーボード: A＝承認 / R＝却下'
        )
      );
    }

    const $diff = $('<div>').addClass('nb-diff').append(C.loading('差分を読み込み中…'));
    $panel.append($diff);
    $review.empty().append($panel);

    // 取得済みのDiffはcompareCacheから返るため、パネルを作り直してもaction=compareは再実行されない
    loadCompare(p)
      .then((html) => $diff.empty().append(diffTable(html)))
      .catch((e) => $diff.empty().append(new OO.ui.MessageWidget({ type: 'error', label: '差分の取得に失敗しました: ' + e.message }).$element));
  }

  function updateCountdown() {
    if (!countdown || !countdown.$text) return;
    const remainMs = Math.max(0, countdown.deadline - Date.now());
    countdown.$text.text(countdown.format(Math.ceil(remainMs / 1000)));
    const elapsed = countdown.total > 0 ? 1 - remainMs / countdown.total : 1;
    countdown.bar.setProgress(Math.round(Math.min(1, Math.max(0, elapsed)) * 100));
  }
  setInterval(updateCountdown, 250);

  C.onShortcut('a', () => state.reviewing && state.submitReview && state.submitReview('approve'));
  C.onShortcut('r', () => state.reviewing && state.submitReview && state.submitReview('reject'));

  // ===== ページ一覧 =====
  const statusFilter = new OO.ui.DropdownInputWidget({ options: [{ data: '', label: 'すべての状態' }] });
  const stageFilter = new OO.ui.DropdownInputWidget({ options: [{ data: '', label: 'すべてのウェーブ' }] });
  const pageSearch = new OO.ui.SearchInputWidget({ placeholder: 'ページ名で絞り込み' });
  const $pageList = $('<div>').addClass('nb-page-list');
  const $pageMore = $('<div>').addClass('nb-more');
  pagesPanel.$element.append(
    $('<div>').addClass('nb-toolbar').append(statusFilter.$element, stageFilter.$element, pageSearch.$element.addClass('nb-toolbar__search')),
    $pageList,
    $pageMore
  );
  statusFilter.on('change', (v) => {
    state.pageFilter.status = v;
    state.pageFilter.limit = PAGE_LIST_STEP;
    renderPageList();
  });
  stageFilter.on('change', (v) => {
    state.pageFilter.stage = v;
    state.pageFilter.limit = PAGE_LIST_STEP;
    renderPageList();
  });
  pageSearch.on('change', (v) => {
    state.pageFilter.query = v.trim();
    state.pageFilter.limit = PAGE_LIST_STEP;
    renderPageList();
  });

  let filterOptionsKey = null;
  function updateFilterOptions(task, pages) {
    const counts = countByStatus(pages);
    const key = JSON.stringify([counts, task.stage_count]);
    if (key === filterOptionsKey) return;
    filterOptionsKey = key;
    statusFilter.setOptions(
      [{ data: '', label: 'すべての状態（' + pages.length + '）' }].concat(
        Object.keys(C.PAGE_STATUS_LABELS)
          .filter((s) => counts[s] || s === state.pageFilter.status)
          .map((s) => ({ data: s, label: C.PAGE_STATUS_LABELS[s] + '（' + (counts[s] || 0) + '）' }))
      )
    );
    statusFilter.setValue(state.pageFilter.status);
    const stages = [];
    for (let i = 1; i <= (task.stage_count || 1); i++) stages.push({ data: String(i), label: 'ウェーブ' + i });
    stageFilter.setOptions([{ data: '', label: 'すべてのウェーブ' }].concat(stages));
    stageFilter.setValue(state.pageFilter.stage);
    stageFilter.toggle((task.stage_count || 1) > 1);
    setTabLabel(pagesPanel, 'ページ一覧（' + pages.length + '）');
  }

  function renderPageList() {
    const f = state.pageFilter;
    const query = f.query.toLowerCase();
    const filtered = state.pages.filter(
      (p) =>
        (!f.status || p.status === f.status) &&
        (!f.stage || String(p.stage) === f.stage) &&
        (!query || p.page_title.toLowerCase().includes(query))
    );
    $pageList.empty();
    $pageMore.empty();
    if (state.pages.length === 0) {
      const finished = state.task && ['completed', 'completed_with_failures', 'failed', 'cancelled'].includes(state.task.status);
      const purged = finished && Number(state.task.progress_total) > 0;
      $pageList.append(
        C.emptyState(
          purged
            ? '終わってから保持期間が過ぎたため、ページの作業データは削除しました。編集結果は「このタスクの編集ログを見る」で確認できます。'
            : '対象ページはまだありません。ワーカーが対象ページを取得するとここに表示されます。'
        )
      );
      return;
    }
    if (filtered.length === 0) {
      $pageList.append(C.emptyState('条件に一致するページはありません。'));
      return;
    }
    filtered.slice(0, f.limit).forEach((p) => {
      const $row = $('<div>').addClass('nb-page-row');
      const $left = $('<div>').addClass('nb-page-row__main').append(
        $('<span>').addClass('nb-page-row__stage').text('W' + p.stage),
        C.wikiLink(p.page_title),
        C.pageStatusBadge(p.status)
      );
      $row.append($left);
      const $right = $('<div>').addClass('nb-page-row__side');
      if (p.error_message) $row.append($('<div>').addClass('nb-page-row__error').text(p.error_message));
      if (p.base_revid && REVIEWABLE_DIFF_STATUSES.includes(p.status)) {
        const diffBtn = new OO.ui.ButtonWidget({ label: '差分', icon: 'eye', framed: false, flags: ['progressive'] });
        diffBtn.on('click', () => openDiff(p));
        $right.append(diffBtn.$element);
      }
      $row.append($right);
      $pageList.append($row);
    });
    if (filtered.length > f.limit) {
      const moreBtn = new OO.ui.ButtonWidget({ label: 'さらに表示（残り' + (filtered.length - f.limit) + '件）', icon: 'expand' });
      moreBtn.on('click', () => {
        f.limit += PAGE_LIST_STEP;
        renderPageList();
      });
      $pageMore.append(moreBtn.$element);
    }
  }

  // ===== 実行ログ =====
  const logLevelFilter = new OO.ui.ButtonSelectWidget({
    items: [
      new OO.ui.ButtonOptionWidget({ data: '', label: 'すべて' }),
      new OO.ui.ButtonOptionWidget({ data: 'warning', label: '警告以上' }),
      new OO.ui.ButtonOptionWidget({ data: 'error', label: 'エラーのみ' }),
    ],
  });
  logLevelFilter.selectItemByData('');
  logLevelFilter.on('choose', (item) => {
    state.logLevel = item.getData();
    renderLogs();
  });
  const $logList = $('<div>').addClass('nb-task-log');
  logsPanel.$element.append(
    $('<div>').addClass('nb-toolbar').append(logLevelFilter.$element, $('<span>').addClass('nb-toolbar__note').text('新しい順・最新200件')),
    $logList
  );
  const LOG_LEVEL_LABELS = { info: '情報', warning: '警告', error: 'エラー' };

  function renderLogs() {
    const levels = state.logLevel === 'error' ? ['error'] : state.logLevel === 'warning' ? ['warning', 'error'] : null;
    const logs = state.logs.filter((l) => !levels || levels.includes(l.level)).slice().reverse();
    $logList.empty();
    if (state.logs.length === 0) {
      $logList.append(C.emptyState('まだ実行ログはありません。ワーカーがタスクを開始すると、対象取得やウェーブ遷移がここに記録されます。'));
      return;
    }
    if (logs.length === 0) {
      $logList.append(C.emptyState('該当するログはありません。'));
      return;
    }
    logs.forEach((log) => {
      const scope = [log.stage ? 'W' + log.stage : '', log.page_title || ''].filter(Boolean).join(' ');
      $logList.append(
        $('<div>').addClass('nb-task-log__row nb-task-log__row--' + log.level).append(
          C.timeElement(log.created_at).addClass('nb-task-log__time'),
          $('<span>').addClass('nb-task-log__level').text(LOG_LEVEL_LABELS[log.level] || log.level),
          $('<span>').addClass('nb-task-log__scope').text(scope),
          $('<span>').addClass('nb-task-log__message').text(log.message)
        )
      );
    });
    const problemCount = state.logs.filter((l) => l.level !== 'info').length;
    setTabLabel(logsPanel, '実行ログ' + (problemCount > 0 ? '（警告' + problemCount + '）' : ''));
  }

  // ===== 警告 =====
  function renderWarnings() {
    const warnings = state.warnings || [];
    warningsPanel.$element.empty();
    setTabLabel(warningsPanel, '警告（' + warnings.length + '）');
    if (warnings.length === 0) {
      warningsPanel.$element.append(C.emptyState('手動確認が必要な警告はありません。'));
      return;
    }
    warningsPanel.$element.append(
      new OO.ui.MessageWidget({
        type: 'warning',
        label:
          '以下のページには「リダイレクトの所属カテゴリ」と旧カテゴリ名の記載が見つかりましたが、テンプレートの引数として構造的に確認できなかったため自動編集していません' +
          '（例: 想定外の記法、コメントアウト等）。必要に応じて手動で確認・修正してください。構造的に一致するものは自動編集の対象になり、ここには表示されません。',
      }).$element
    );
    const $list = $('<div>').addClass('nb-warning-list');
    warnings.forEach((w) => {
      $list.append(
        $('<div>').addClass('nb-warning-item').append(
          $('<div>').addClass('nb-warning-item__title').append(C.wikiLink(w.page_title)),
          w.snippet ? $('<pre>').addClass('nb-warning-item__snippet').text(w.snippet) : null
        )
      );
    });
    warningsPanel.$element.append($list);
  }

  // ===== 設定内容 =====
  function linkSpec(title, anchor, label) {
    return (title || '') + (anchor ? '#' + anchor : '') + (label ? '|' + label : '');
  }

  function describeRule(rule) {
    const $rule = $('<div>').addClass('nb-rule-summary');
    $rule.append($('<div>').addClass('nb-rule-summary__type').text(C.RULE_TYPE_LABELS[rule.templateType] || rule.templateType));
    const $dl = $('<dl>').addClass('nb-facts nb-facts--compact');
    const fact = (label, value) => $dl.append($('<dt>').text(label), $('<dd>').text(value));
    if (rule.templateType === 'revertEdits') {
      fact('取り消すタスク', '#' + rule.revertOfTaskId);
      fact('対象', (rule.targets || []).length + 'ページ（そのタスクの編集が最新版のページだけを編集前の版に戻す）');
      return $rule.append($dl);
    }
    if (rule.templateType === 'custom') {
      (rule.steps || []).forEach((step, i) => fact('ステップ' + (i + 1), '/' + step.pattern + '/' + (step.flags || 'g') + ' → ' + step.replacement));
      const ts = rule.targetSource || {};
      const sourceText =
        ts.type === 'manualList'
          ? '手入力 ' + (ts.titles || []).length + '件'
          : ts.type + ': ' + (ts.category || ts.page || ts.query || '');
      fact('対象', sourceText);
    } else {
      fact('改名元', rule.templateType === 'linkRenameExact' ? linkSpec(rule.from, rule.fromAnchor, rule.fromLabel) : rule.from);
      if (rule.to) fact('改名先', rule.templateType === 'linkRenameExact' ? linkSpec(rule.to, rule.toAnchor, rule.toLabel) : rule.to);
      if (rule.namespaces !== undefined) fact('名前空間', rule.namespaces === null ? '全名前空間' : rule.namespaces.join(', '));
      if (rule.fixCategoryLinks) fact('追加', '「Category:旧」の記述も置換');
      if (rule.bothSchemes) fact('追加', 'http:// と https:// の両方の旧URLを付け替え');
      if (rule.forceTargets) fact('再試行対象', rule.forceTargets.length + '件');
    }
    return $rule.append($dl);
  }

  let configRendered = false;
  function renderConfig(task) {
    if (configRendered) return;
    configRendered = true;
    const config = task.config_json || {};
    const edit = config.editSettings || {};
    const review = config.reviewSettings || {};
    const $rules = $('<div>').addClass('nb-rule-summaries');
    (config.replacements || []).forEach((rule) => $rules.append(describeRule(rule)));
    const $dl = $('<dl>').addClass('nb-facts');
    const fact = (label, value) => $dl.append($('<dt>').text(label), $('<dd>').text(value));
    fact('要約欄', edit.editSummary || '-');
    fact('Botフラグ・細部の編集', (edit.botFlag ? 'Botフラグあり' : 'Botフラグなし') + '・' + (edit.minorEdit ? '細部の編集' : '通常の編集'));
    fact('編集間隔', (edit.editIntervalSeconds || '-') + '秒');
    if (edit.linkUpdateMethod) fact('使用ページの更新方法', edit.linkUpdateMethod === 'purge' ? 'purge＋forcelinkupdate' : 'null edit');
    fact('確認モード（作成時）', review.mode === 'manual' ? '手動確認（タイムアウト ' + review.manualTimeoutHours + '時間）' : '自動更新（' + (review.autoWaitSeconds || 0) + '秒後に承認）');
    configPanel.$element.empty().append(
      $('<h3>').addClass('nb-subheading').text('置換ルール（' + (config.replacements || []).length + '件）'),
      $rules,
      $('<h3>').addClass('nb-subheading').text('編集設定'),
      $dl
    );
  }

  // ===== 更新 =====
  let errorShown = false;
  async function refresh() {
    $lastUpdated.text('更新中…');
    try {
      const [task, pages, logs] = await Promise.all([
        C.fetchJson('/api/tasks/' + taskId),
        C.fetchJson('/api/tasks/' + taskId + '/pages'),
        C.fetchJson('/api/tasks/' + taskId + '/logs?limit=200'),
      ]);
      if (task.server_time) state.clockOffset = new Date(task.server_time).getTime() - Date.now();
      state.task = task;
      state.pages = pages;
      state.logs = logs;
      document.title = 'タスク #' + taskId + '（' + (C.TASK_STATUS_LABELS[task.status] || task.status) + '）- NanonaBot Tool';
      renderReview(task, pages);
      renderSummary(task, pages);
      updateFilterOptions(task, pages);
      renderPageList();
      renderLogs();
      renderConfig(task);
      if (state.warnings === null) {
        state.warnings = [];
        C.fetchJson('/api/tasks/' + taskId + '/warnings')
          .then((warnings) => {
            state.warnings = warnings;
            renderWarnings();
          })
          .catch(() => {
            state.warnings = null; // 失敗時は次回リトライできるようにする
          });
        renderWarnings();
      }
      $lastUpdated.text('最終更新 ' + new Date().toLocaleTimeString('ja-JP'));
      errorShown = false;
    } catch (e) {
      $lastUpdated.text('更新に失敗しました（自動で再試行します）');
      if (!errorShown && e.status !== 503) C.toast('読み込みに失敗しました: ' + e.message, 'error');
      errorShown = true;
    }
  }

  /**
   * 次に画面を更新するまでの時間。ワーカーの次の動き（自動承認の予定時刻・編集間隔が明ける時刻）が
   * 分かっていればその直後に合わせ、編集中は短い間隔、動きの無いタスクは長い間隔にする。
   */
  function nextRefreshDelay() {
    const task = state.task;
    if (!task) return 2000;
    const pages = state.pages;
    const now = Date.now();
    const base = ['queued', 'running'].includes(task.status) ? 2000 : 10000;
    const events = [];
    const reviewSettings = (task.config_json && task.config_json.reviewSettings) || {};
    const awaiting = pages.find((p) => p.status === 'awaiting_review');
    if (awaiting && (reviewSettings.mode || task.mode) === 'auto') {
      const startedAt = toClientTime(awaiting.prepared_at);
      if (startedAt) events.push(startedAt + (Number(reviewSettings.autoWaitSeconds) || 0) * 1000);
    }
    const editAt = nextEditAt(task, pages);
    if (editAt) events.push(editAt);
    if (pages.some((p) => IN_FLIGHT_STATUSES.includes(p.status) || p.status === 'preparing')) events.push(now + 700);
    const soonest = events.filter((t) => t > now - 1000).sort((a, b) => a - b)[0];
    // 予定時刻の少し後（ワーカーの反映を待つ分）に更新する
    const delay = soonest ? soonest - now + 400 : base;
    return Math.min(base, Math.max(300, delay));
  }

  let timer = null;
  let running = false;
  async function refreshNow() {
    if (running) return;
    running = true;
    clearTimeout(timer);
    try {
      await refresh();
    } finally {
      running = false;
      if (!document.hidden) timer = setTimeout(refreshNow, nextRefreshDelay());
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshNow();
    else clearTimeout(timer);
  });
  const poller = { refresh: refreshNow };
  refreshNow();
  refreshBtn.on('click', () => refreshNow());
})();

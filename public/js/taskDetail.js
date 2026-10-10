/* NanonaBot Tool - タスク詳細/Diff確認画面（仕様書9.2節の1ページ先読みパイプラインに対応） */
(function () {
  'use strict';

  const C = window.NanonaCommon;
  const user = window.NANONA_BOT || {};
  const taskId = window.NANONA_BOT && window.NANONA_BOT.taskId;
  const $app = $('#app');

  $app.append(C.buildHeader({ title: 'タスク #' + taskId, user }));

  if (user.role !== 'owner') {
    $app.append(C.buildEmergencyOnlyPanel(user));
    return;
  }

  const $notice = $('<div>');
  const $refreshStatus = $('<span>').css({ marginLeft: '8px', color: '#54595d', fontSize: '0.9em' });
  const $summarySection = $('<div>').addClass('nb-section');
  const $warningSection = $('<div>');
  const $reviewContainer = $('<div>');
  const $pageListSection = $('<div>').addClass('nb-section');
  const $logSection = $('<div>').addClass('nb-section');
  $app.append($notice, $summarySection, $warningSection, $reviewContainer, $pageListSection, $logSection);

  const compareCache = new Map(); // pageId -> diff html（同じページを何度もaction=compareしないためのキャッシュ）
  let lastReviewPanelKey = null;
  let warningsLoaded = false;
  let refreshInProgress = false;

  function updateCountdown($countdown) {
    const remain = Math.max(0, Math.ceil((Number($countdown.data('deadline')) - Date.now()) / 1000));
    $countdown.text('自動更新モード: あと約' + remain + '秒で自動承認されます（目安）。');
  }

  async function loadTask() {
    return C.fetchJson('/api/tasks/' + taskId);
  }
  async function loadPages() {
    return C.fetchJson('/api/tasks/' + taskId + '/pages');
  }
  async function loadWarnings() {
    return C.fetchJson('/api/tasks/' + taskId + '/warnings');
  }
  async function loadLogs() {
    return C.fetchJson('/api/tasks/' + taskId + '/logs?limit=200');
  }
  async function loadCompare(pageId) {
    if (compareCache.has(pageId)) return compareCache.get(pageId);
    const result = await C.fetchJson('/api/tasks/' + taskId + '/pages/' + pageId + '/compare');
    compareCache.set(pageId, result.html);
    return result.html;
  }

  function renderSummary(task) {
    $summarySection.empty();
    $summarySection.append($('<div>').addClass('nb-section__title').text('タスク概要'));

    const $line = $('<p>');
    $line.append(C.taskStatusBadge(task.status), ' ');
    $line.append(
      document.createTextNode(
        ' account=' + task.account + ' / mode=' + task.mode +
          ' / 進捗 ' + task.progress_current + '/' + task.progress_total +
          ' / onFailure=' + ((task.config_json && task.config_json.onFailure) || '-')
      )
    );
    $summarySection.append($line);

    if (['queued', 'running', 'paused'].includes(task.status)) {
      const cancelBtn = new OO.ui.ButtonWidget({ label: 'タスクを中止', flags: ['destructive'] });
      cancelBtn.on('click', async () => {
        if (!window.confirm('このタスクを中止しますか？')) return;
        cancelBtn.setDisabled(true);
        try {
          await C.postJson('/api/tasks/' + taskId + '/cancel', {});
          await refreshAll();
        } catch (e) {
          C.showNotice($notice, 'error', 'タスクの中止に失敗しました: ' + e.message);
          cancelBtn.setDisabled(false);
        }
      });
      $summarySection.append($('<div>').css('margin-top', '8px').append(cancelBtn.$element));
    }

    if (task.stage_count === 2) {
      $summarySection.append(
        $('<p>').css('color', '#54595d').text(
          'リンク置換系ルールを含むため2ウェーブ構成です（現在ウェーブ' + task.current_stage + '/2）。' +
            'ウェーブ1=Template名前空間、ウェーブ2=その他ページ（ウェーブ1完了後に再取得）。'
        )
      );
    }

    if (task.status === 'expired') {
      const msg = new OO.ui.MessageWidget({
        type: 'warning',
        label: '無操作タイムアウトによりこのタスクは期限切れになりました。編集は行われていません。',
      });
      $summarySection.append(msg.$element);
    }

    const RESUMABLE_MESSAGES = {
      paused: { type: 'error', label: 'エラーにより一時停止しています。' },
      emergency_stopped: {
        type: 'error',
        label: '緊急停止により中断しました。緊急停止を解除してから再開すると、未処理のページから続行します。',
      },
      expired: { type: 'warning', label: '再開すると無操作タイムアウトを取り直し、未処理のページから続行します。' },
    };
    if (RESUMABLE_MESSAGES[task.status]) {
      if (task.status !== 'expired') {
        $summarySection.append(new OO.ui.MessageWidget(RESUMABLE_MESSAGES[task.status]).$element);
      }
      const resumeBtn = new OO.ui.ButtonWidget({ label: '再開する', flags: ['primary', 'progressive'] });
      resumeBtn.on('click', async () => {
        resumeBtn.setDisabled(true);
        try {
          await C.postJson('/api/tasks/' + taskId + '/resume', {});
          await refreshAll();
        } catch (e) {
          C.showNotice($notice, 'error', '再開に失敗しました: ' + e.message);
          resumeBtn.setDisabled(false);
        }
      });
      $summarySection.append($('<div>').css('margin-top', '8px').append(resumeBtn.$element));
      if (task.status === 'expired') {
        $summarySection.append(
          $('<p>').css({ color: '#54595d', fontSize: '0.9em' }).text(RESUMABLE_MESSAGES.expired.label)
        );
      }
    }

    if (task.status === 'completed_with_failures') {
      const msg = new OO.ui.MessageWidget({ type: 'warning', label: '一部のページで編集が失敗しました。' });
      $summarySection.append(msg.$element);
      const retryBtn = new OO.ui.ButtonWidget({ label: '失敗ページのみを再試行', flags: ['progressive'] });
      retryBtn.on('click', async () => {
        retryBtn.setDisabled(true);
        try {
          const result = await C.postJson('/api/tasks/' + taskId + '/retry-failed', {});
          C.showNotice($notice, 'success', result.retriedPageCount + '件を対象に再試行タスク #' + result.id + ' を作成しました。移動します…');
          setTimeout(() => {
            location.href = '/tasks/' + result.id;
          }, 800);
        } catch (e) {
          C.showNotice($notice, 'error', '再試行タスクの作成に失敗しました: ' + e.message);
          retryBtn.setDisabled(false);
        }
      });
      $summarySection.append($('<div>').css('margin-top', '8px').append(retryBtn.$element));
      $summarySection.append(
        $('<p>').css({ color: '#54595d', fontSize: '0.9em' }).text(
          '同じ置換ルール・編集設定を引き継ぎ、失敗したページのみを対象にした新規タスクを作成します（仕様書9.3節）。'
        )
      );
    }
  }

  function renderReviewPanel(task, pages) {
    const reviewing = pages.find((p) => p.status === 'awaiting_review');

    if (!reviewing) {
      $reviewContainer.empty();
      lastReviewPanelKey = null;
      return;
    }

    const reviewSettings = (task.config_json && task.config_json.reviewSettings) || {};
    const mode = reviewSettings.mode || task.mode;

    // 3秒ごとの更新で毎回作り直すと、開いているドロップダウンが閉じたりDiffのスクロール位置が
    // 戻ったりするため、確認対象・モードが変わったときだけ作り直す（カウントダウンは別タイマーで更新）。
    const panelKey = [reviewing.id, mode, reviewing.prepared_at, reviewSettings.autoWaitSeconds].join('|');
    if (panelKey === lastReviewPanelKey) return;
    lastReviewPanelKey = panelKey;
    $reviewContainer.empty();

    const $panel = $('<div>').addClass('nb-review-panel');
    $panel.append($('<div>').addClass('nb-review-panel__title').text('確認中: ' + reviewing.page_title));

    const modeWidget = new OO.ui.DropdownInputWidget({
      options: [{ data: 'auto', label: '自動更新' }, { data: 'manual', label: '手動確認' }],
      value: mode,
    });
    let revertingMode = false;
    modeWidget.on('change', async (nextMode) => {
      if (revertingMode || nextMode === mode) return; // 失敗時の値の巻き戻しで再送信しない
      modeWidget.setDisabled(true);
      try {
        await C.postJson('/api/tasks/' + taskId + '/review-mode', { mode: nextMode });
        await refreshAll();
      } catch (e) {
        C.showNotice($notice, 'error', 'モード切替に失敗しました: ' + e.message);
        revertingMode = true;
        modeWidget.setValue(mode);
        revertingMode = false;
        modeWidget.setDisabled(false);
      }
    });

    const approveBtn = new OO.ui.ButtonWidget({ label: '承認', flags: ['primary', 'progressive'] });
    const rejectBtn = new OO.ui.ButtonWidget({ label: '却下', flags: ['destructive'] });
    const submitReview = async (action, button) => {
      approveBtn.setDisabled(true);
      rejectBtn.setDisabled(true);
      try {
        await C.postJson('/api/tasks/' + taskId + '/pages/' + reviewing.id + '/' + action, {});
        await refreshAll();
      } catch (e) {
        C.showNotice($notice, 'error', (action === 'approve' ? '承認' : '却下') + 'に失敗しました: ' + e.message);
        button.setDisabled(false);
        (button === approveBtn ? rejectBtn : approveBtn).setDisabled(false);
      }
    };
    approveBtn.on('click', () => submitReview('approve', approveBtn));
    rejectBtn.on('click', () => submitReview('reject', rejectBtn));
    $panel.append(
      $('<div>').css('margin-bottom', '8px').append(
        $('<span>').text('確認モード: '), modeWidget.$element, ' ', approveBtn.$element, ' ', rejectBtn.$element
      )
    );

    if (mode === 'auto') {
      const autoWaitSeconds = Number(reviewSettings.autoWaitSeconds) || 0;
      const preparedAt = reviewing.prepared_at ? new Date(reviewing.prepared_at).getTime() : Date.now();
      const $countdown = $('<span>').addClass('nb-countdown').data('deadline', preparedAt + autoWaitSeconds * 1000);
      updateCountdown($countdown);
      $panel.append($('<p>').append($countdown, $refreshStatus));
    } else {
      $panel.append($refreshStatus);
    }

    const $diffArea = $('<div>').text('Diffを読み込み中…');
    $panel.append($diffArea);
    $reviewContainer.append($panel);

    // 取得済みのDiffはcompareCacheから返るため、パネルを作り直してもaction=compareは再実行されない
    loadCompare(reviewing.id)
      .then((html) => {
        // action=compareが返すHTMLはMediaWiki本体の差分テーブルそのもの（信頼できる自ウィキAPIの出力）。
        // 仕様書9章の設計どおり、そのまま埋め込む。
        $diffArea.html(html || '<p>変更点がありません。</p>');
      })
      .catch((e) => {
        $diffArea.text('Diffの取得に失敗しました: ' + e.message);
      });
  }

  function renderPageList(pages) {
    $pageListSection.empty();
    $pageListSection.append($('<div>').addClass('nb-section__title').text('ページ一覧（' + pages.length + '件）'));

    if (pages.length === 0) {
      $pageListSection.append($('<p>').text('対象ページがありません。'));
      return;
    }

    const $list = $('<div>').addClass('nb-page-list');
    pages.forEach((p) => {
      const $row = $('<div>').addClass('nb-page-row');
      const $left = $('<span>').text('[W' + p.stage + '] ' + p.page_title + ' ');
      $left.append(C.pageStatusBadge(p.status));
      const $right = $('<span>').css('color', '#54595d').text(p.error_message || '');
      $list.append($row.append($left, $right));
    });
    $pageListSection.append($list);
  }

  function renderWarnings(warnings) {
    $warningSection.empty();
    if (!warnings || warnings.length === 0) return;

    const $panel = $('<div>').addClass('nb-warning-panel');
    $panel.append(
      $('<div>').css('font-weight', 'bold').text(
        '要手動確認: Template:リダイレクトの所属カテゴリ 関連（' + warnings.length + '件）'
      )
    );
    $panel.append(
      $('<p>').text(
        '以下のページには「リダイレクトの所属カテゴリ」と旧カテゴリ名の記載が見つかりましたが、' +
          'テンプレートの引数として構造的に確認できなかったため自動編集していません' +
          '（例: 想定外の記法、コメントアウト等）。必要に応じて手動で確認・修正してください。' +
          '構造的に一致するものは既に自動編集済みで、ここには表示されません。'
      )
    );
    warnings.forEach((w) => {
      const $item = $('<div>').css('margin-bottom', '8px');
      $item.append($('<strong>').text(w.page_title));
      if (w.snippet) {
        $item.append($('<div>').css({ fontFamily: 'monospace', fontSize: '0.85em', color: '#54595d' }).text(w.snippet));
      }
      $panel.append($item);
    });
    $warningSection.append($panel);
  }

  function renderLogs(logs) {
    $logSection.empty();
    $logSection.append($('<div>').addClass('nb-section__title').text('実行ログ（最新200件）'));

    if (!logs || logs.length === 0) {
      $logSection.append($('<p>').text('まだ実行ログはありません。ワーカーがタスクを開始すると、対象取得やウェーブ遷移がここに記録されます。'));
      return;
    }

    const $list = $('<div>').addClass('nb-task-log');
    logs.forEach((log) => {
      const timestamp = log.created_at ? new Date(log.created_at).toLocaleString('ja-JP') : '';
      const scope = [log.stage ? 'W' + log.stage : '', log.page_title || ''].filter(Boolean).join(' ');
      const $row = $('<div>').addClass('nb-task-log__row nb-task-log__row--' + log.level);
      $row.append($('<time>').addClass('nb-task-log__time').text(timestamp));
      $row.append($('<span>').addClass('nb-task-log__level').text(log.level));
      if (scope) $row.append($('<span>').addClass('nb-task-log__scope').text(scope));
      $row.append($('<span>').addClass('nb-task-log__message').text(log.message));
      $list.append($row);
    });
    $logSection.append($list);
  }

  async function refreshAll() {
    if (refreshInProgress) return;
    refreshInProgress = true;
    $refreshStatus.text('更新中…');
    try {
      const [task, pages, logs] = await Promise.all([loadTask(), loadPages(), loadLogs()]);
      renderSummary(task);
      renderReviewPanel(task, pages);
      renderPageList(pages);
      renderLogs(logs);

      if (!warningsLoaded) {
        warningsLoaded = true;
        loadWarnings()
          .then(renderWarnings)
          .catch((e) => {
            warningsLoaded = false; // 失敗時は次回リトライできるようにする
            console.warn('警告一覧の取得に失敗しました:', e.message);
          });
      }
    } catch (e) {
      if (e.status === 503) {
        $refreshStatus.text('更新に失敗しました。再試行します…');
      } else {
        $refreshStatus.text('更新に失敗しました。');
        C.showNotice($notice, 'error', '読み込みに失敗しました: ' + e.message);
      }
    } finally {
      refreshInProgress = false;
      if ($refreshStatus.text() === '更新中…') $refreshStatus.empty();
    }
  }

  refreshAll();
  setInterval(refreshAll, 3000);
  setInterval(() => {
    $reviewContainer.find('.nb-countdown').each(function () {
      updateCountdown($(this));
    });
  }, 1000);
})();

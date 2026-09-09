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
  const $summarySection = $('<div>').addClass('nb-section');
  const $warningSection = $('<div>');
  const $reviewContainer = $('<div>');
  const $pageListSection = $('<div>').addClass('nb-section');
  const $logSection = $('<div>').addClass('nb-section');
  $app.append($notice, $summarySection, $warningSection, $reviewContainer, $pageListSection, $logSection);

  const compareCache = new Map(); // pageId -> diff html（同じページを何度もaction=compareしないためのキャッシュ）
  let lastReviewPageId = null;
  let warningsLoaded = false;

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

    if (task.status === 'paused') {
      const msg = new OO.ui.MessageWidget({ type: 'error', label: 'エラーにより一時停止しています。' });
      const resumeBtn = new OO.ui.ButtonWidget({ label: '再開する', flags: ['primary', 'progressive'] });
      resumeBtn.on('click', async () => {
        try {
          await C.postJson('/api/tasks/' + taskId + '/resume', {});
          refreshAll();
        } catch (e) {
          C.showNotice($notice, 'error', '再開に失敗しました: ' + e.message);
        }
      });
      $summarySection.append(msg.$element, $('<div>').css('margin-top', '8px').append(resumeBtn.$element));
    }

    if (['queued', 'running'].includes(task.status)) {
      const settings = (task.config_json && task.config_json.reviewSettings) || {};
      const modeWidget = new OO.ui.DropdownInputWidget({
        options: [
          { data: 'manual', label: '手動確認' },
          { data: 'auto', label: '自動承認' },
        ],
        value: settings.mode || task.mode,
      });
      const autoWaitWidget = new OO.ui.NumberInputWidget({
        value: Number(settings.autoWaitSeconds) || 0,
        min: 0,
        step: 1,
      });
      const manualTimeoutWidget = new OO.ui.NumberInputWidget({
        value: Number(settings.manualTimeoutHours) || 72,
        min: 1,
        step: 1,
      });
      const $autoField = new OO.ui.FieldLayout(autoWaitWidget, { label: '自動承認まで（秒）', align: 'top' }).$element;
      const $manualField = new OO.ui.FieldLayout(manualTimeoutWidget, { label: '手動確認の期限（時間）', align: 'top' }).$element;
      const applyBtn = new OO.ui.ButtonWidget({ label: 'レビュー方式を反映', flags: ['progressive'] });
      const cancelBtn = new OO.ui.ButtonWidget({ label: 'タスクを中止', flags: ['destructive'] });

      function updateModeFields() {
        const isAuto = modeWidget.getValue() === 'auto';
        $autoField.toggle(isAuto);
        $manualField.toggle(!isAuto);
      }
      modeWidget.on('change', updateModeFields);
      updateModeFields();

      applyBtn.on('click', async () => {
        applyBtn.setDisabled(true);
        try {
          const mode = modeWidget.getValue();
          const reviewSettings =
            mode === 'auto'
              ? { mode, autoWaitSeconds: Number(autoWaitWidget.getValue()) }
              : { mode, manualTimeoutHours: Number(manualTimeoutWidget.getValue()) };
          await C.postJson('/api/tasks/' + taskId + '/review-settings', { reviewSettings });
          C.showNotice($notice, 'success', 'レビュー方式を反映しました。待機中のページにも適用されます。');
          refreshAll();
        } catch (e) {
          C.showNotice($notice, 'error', 'レビュー方式の変更に失敗しました: ' + e.message);
          applyBtn.setDisabled(false);
        }
      });
      cancelBtn.on('click', async () => {
        cancelBtn.setDisabled(true);
        try {
          await C.postJson('/api/tasks/' + taskId + '/cancel', {});
          C.showNotice($notice, 'success', 'タスクを中止しました。ワーカーは次の安全な確認地点で停止します。');
          refreshAll();
        } catch (e) {
          C.showNotice($notice, 'error', 'タスクの中止に失敗しました: ' + e.message);
          cancelBtn.setDisabled(false);
        }
      });

      const $settingsSection = $('<div>').addClass('nb-review-settings');
      $settingsSection.append(
        $('<div>').css('font-weight', 'bold').text('レビュー方式（実行中に変更可能）'),
        new OO.ui.FieldLayout(modeWidget, { label: '方式', align: 'top' }).$element,
        $autoField,
        $manualField,
        $('<div>').append(applyBtn.$element, ' ', cancelBtn.$element)
      );
      $summarySection.append($settingsSection);
    }

    if (task.status === 'cancelled') {
      $summarySection.append(new OO.ui.MessageWidget({ type: 'warning', label: 'このタスクは中止されました。未処理のページは編集されません。' }).$element);
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
    $reviewContainer.empty();

    if (!reviewing) {
      lastReviewPageId = null;
      return;
    }

    const $panel = $('<div>').addClass('nb-review-panel');
    $panel.append($('<div>').addClass('nb-review-panel__title').text('確認中: ' + reviewing.page_title));

    const mode = task.config_json && task.config_json.reviewSettings && task.config_json.reviewSettings.mode;
    if (mode === 'auto') {
      const $countdown = $('<p>').addClass('nb-countdown').attr('data-deadline', reviewing.review_deadline_at || '');
      $panel.append($countdown);
      updateCountdown($countdown);
    } else {
      $panel.append($('<p>').addClass('nb-countdown').text('手動確認モード: 承認または却下を待機しています。'));
    }

    // auto/manualを問わず、待機中なら操作者が直ちに確定できる。
    const approveBtn = new OO.ui.ButtonWidget({ label: '承認', flags: ['primary', 'progressive'] });
    const rejectBtn = new OO.ui.ButtonWidget({ label: '却下', flags: ['destructive'] });
    async function decide(decision) {
      approveBtn.setDisabled(true);
      rejectBtn.setDisabled(true);
      try {
        await C.postJson('/api/tasks/' + taskId + '/pages/' + reviewing.id + '/' + decision, {});
        refreshAll();
      } catch (e) {
        C.showNotice($notice, 'error', (decision === 'approve' ? '承認' : '却下') + 'に失敗しました: ' + e.message);
        approveBtn.setDisabled(false);
        rejectBtn.setDisabled(false);
      }
    }
    approveBtn.on('click', () => decide('approve'));
    rejectBtn.on('click', () => decide('reject'));
    $panel.append($('<div>').css('margin-bottom', '8px').append(approveBtn.$element, ' ', rejectBtn.$element));

    const $diffArea = $('<div>').text('Diffを読み込み中…');
    $panel.append($diffArea);
    $reviewContainer.append($panel);

    if (lastReviewPageId !== reviewing.id) {
      lastReviewPageId = reviewing.id;
      loadCompare(reviewing.id)
        .then((html) => {
          // action=compareが返すHTMLはMediaWiki本体の差分テーブルそのもの（信頼できる自ウィキAPIの出力）。
          // 仕様書9章の設計どおり、そのまま埋め込む。
          $diffArea.html(html || '<p>変更点がありません。</p>');
        })
        .catch((e) => {
          $diffArea.text('Diffの取得に失敗しました: ' + e.message);
        });
    } else if (compareCache.has(reviewing.id)) {
      $diffArea.html(compareCache.get(reviewing.id));
    }
  }

  function updateCountdown($countdown) {
    const deadline = new Date($countdown.attr('data-deadline')).getTime();
    if (!Number.isFinite(deadline)) {
      $countdown.text('自動承認の時刻を設定中です。');
      return;
    }
    const remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    $countdown.text('自動承認モード: あと' + remain + '秒で自動承認されます。承認・却下で直ちに確定できます。');
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
      C.showNotice($notice, 'error', '読み込みに失敗しました: ' + e.message);
    }
  }

  refreshAll();
  setInterval(refreshAll, 3000);
  setInterval(() => $reviewContainer.find('.nb-countdown[data-deadline]').each(function () { updateCountdown($(this)); }), 1000);
})();

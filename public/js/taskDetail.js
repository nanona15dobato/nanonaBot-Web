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
  $app.append($notice, $summarySection, $warningSection, $reviewContainer, $pageListSection);

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
    if (mode === 'manual') {
      const approveBtn = new OO.ui.ButtonWidget({ label: '承認', flags: ['primary', 'progressive'] });
      const rejectBtn = new OO.ui.ButtonWidget({ label: '却下', flags: ['destructive'] });
      approveBtn.on('click', async () => {
        approveBtn.setDisabled(true);
        rejectBtn.setDisabled(true);
        try {
          await C.postJson('/api/tasks/' + taskId + '/pages/' + reviewing.id + '/approve', {});
          refreshAll();
        } catch (e) {
          C.showNotice($notice, 'error', '承認に失敗しました: ' + e.message);
          approveBtn.setDisabled(false);
          rejectBtn.setDisabled(false);
        }
      });
      rejectBtn.on('click', async () => {
        approveBtn.setDisabled(true);
        rejectBtn.setDisabled(true);
        try {
          await C.postJson('/api/tasks/' + taskId + '/pages/' + reviewing.id + '/reject', {});
          refreshAll();
        } catch (e) {
          C.showNotice($notice, 'error', '却下に失敗しました: ' + e.message);
          approveBtn.setDisabled(false);
          rejectBtn.setDisabled(false);
        }
      });
      $panel.append($('<div>').css('margin-bottom', '8px').append(approveBtn.$element, ' ', rejectBtn.$element));
    } else {
      const autoWaitSeconds =
        (task.config_json && task.config_json.reviewSettings && task.config_json.reviewSettings.autoWaitSeconds) || 0;
      const preparedAt = reviewing.prepared_at ? new Date(reviewing.prepared_at).getTime() : Date.now();
      const remain = Math.max(0, Math.round((preparedAt + autoWaitSeconds * 1000 - Date.now()) / 1000));
      $panel.append(
        $('<p>').addClass('nb-countdown').text('自動更新モード: あと約' + remain + '秒で自動承認されます（目安）。')
      );
    }

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

  async function refreshAll() {
    try {
      const [task, pages] = await Promise.all([loadTask(), loadPages()]);
      renderSummary(task);
      renderReviewPanel(task, pages);
      renderPageList(pages);

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
})();

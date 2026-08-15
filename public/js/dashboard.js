/* NanonaBot Tool - ダッシュボード */
(function () {
  'use strict';

  const C = window.NanonaCommon;
  const user = window.NANONA_BOT || {};
  const $app = $('#app');

  const $header = C.buildHeader({ title: 'NanonaBot Tool ダッシュボード', user });
  $app.append($header);

  // admin_emergency_only は緊急停止パネルのみ（仕様書2章: 他は閲覧不可）。
  // 緊急停止ボタン自体はヘッダーに既にあるため、ここでは説明文のみ表示する。
  if (user.role === 'admin_emergency_only') {
    const $panel = $('<div>').addClass('nb-emergency-panel');
    $panel.append($('<p>').text(user.username + ' さんは管理者権限のため、緊急停止のみ操作できます（上部のボタンから実行できます）。'));
    $app.append($panel);
    return;
  }

  const $notice = $('<div>');
  const $statusSection = $('<div>').addClass('nb-section');
  const $taskListSection = $('<div>').addClass('nb-section');
  $app.append($notice, $statusSection, $taskListSection);

  async function refreshEmergencyStatus() {
    try {
      const status = await C.fetchJson('/api/emergency-stop/status');
      $statusSection.empty();
      $statusSection.append($('<div>').addClass('nb-section__title').text('システム状態'));
      if (status.emergency_stopped) {
        const msg = new OO.ui.MessageWidget({
          type: 'error',
          label:
            '緊急停止中です（' + (status.emergency_stopped_by || '不明') + ' が ' +
            C.formatDateTime(status.emergency_stopped_at) + ' に実行）。',
        });
        $statusSection.append(msg.$element);
        if (user.role === 'owner') {
          const clearBtn = new OO.ui.ButtonWidget({ label: '緊急停止を解除', flags: ['primary', 'progressive'] });
          clearBtn.on('click', async () => {
            try {
              await C.postJson('/api/emergency-stop/clear', {});
              refreshEmergencyStatus();
            } catch (e) {
              C.showNotice($notice, 'error', '解除に失敗しました: ' + e.message);
            }
          });
          $statusSection.append($('<div>').css('margin-top', '8px').append(clearBtn.$element));
        }
      } else {
        const msg = new OO.ui.MessageWidget({ type: 'success', label: '稼働中（緊急停止していません）' });
        $statusSection.append(msg.$element);
      }
    } catch (e) {
      C.showNotice($notice, 'error', 'システム状態の取得に失敗しました: ' + e.message);
    }
  }

  function taskRow(task) {
    const $row = $('<a>').addClass('nb-task-row').attr('href', '/tasks/' + task.id).css('text-decoration', 'none').css('color', 'inherit');
    const $left = $('<div>');
    $left.append($('<strong>').text('#' + task.id + ' '));
    $left.append(C.taskStatusBadge(task.status));
    $left.append(
      $('<div>').addClass('nb-task-row__meta')
        .text('account=' + task.account + ' / mode=' + task.mode + ' / 進捗 ' + task.progress_current + '/' + task.progress_total)
    );
    const $right = $('<div>').addClass('nb-task-row__meta').text(C.formatDateTime(task.updated_at));
    return $row.append($left, $right);
  }

  async function refreshTaskList() {
    try {
      const tasks = await C.fetchJson('/api/tasks');
      $taskListSection.empty();
      $taskListSection.append($('<div>').addClass('nb-section__title').text('タスク一覧（新しい順・最大50件）'));
      if (tasks.length === 0) {
        $taskListSection.append($('<p>').text('タスクはまだありません。'));
      } else {
        const $list = $('<div>').addClass('nb-task-list');
        tasks.forEach((t) => $list.append(taskRow(t)));
        $taskListSection.append($list);
      }
    } catch (e) {
      C.showNotice($notice, 'error', 'タスク一覧の取得に失敗しました: ' + e.message);
    }
  }

  function refreshAll() {
    refreshEmergencyStatus();
    refreshTaskList();
  }

  refreshAll();
  setInterval(refreshAll, 5000);
})();

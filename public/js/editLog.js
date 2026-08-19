/* NanonaBot Tool - 編集ログ画面（フェーズ6。仕様書9.4節） */
(function () {
  'use strict';

  const C = window.NanonaCommon;
  const user = window.NANONA_BOT || {};
  const $app = $('#app');

  $app.append(C.buildHeader({ title: '編集ログ', user }));

  if (user.role !== 'owner') {
    $app.append(C.buildEmergencyOnlyPanel(user));
    return;
  }

  const $notice = $('<div>');
  const $filterSection = $('<div>').addClass('nb-section');
  const $resultSection = $('<div>').addClass('nb-section');
  $app.append($notice, $filterSection, $resultSection);

  const taskIdWidget = new OO.ui.TextInputWidget({ placeholder: '例: 12（空欄で全タスク対象）' });
  const pageTitleWidget = new OO.ui.TextInputWidget({ placeholder: 'ページ名の一部一致（例: プタリン）' });
  const statusWidget = new OO.ui.DropdownInputWidget({
    options: [
      { data: '', label: 'すべて' },
      { data: 'edited', label: '成功のみ' },
      { data: 'failed', label: '失敗のみ' },
    ],
    value: '',
  });
  const searchBtn = new OO.ui.ButtonWidget({ label: '検索', flags: ['primary', 'progressive'] });

  $filterSection.append(
    $('<div>').addClass('nb-section__title').text('編集ログ検索'),
    new OO.ui.FieldLayout(taskIdWidget, { label: 'タスクID', align: 'top' }).$element,
    new OO.ui.FieldLayout(pageTitleWidget, { label: 'ページ名', align: 'top' }).$element,
    new OO.ui.FieldLayout(statusWidget, { label: '結果', align: 'top' }).$element,
    $('<div>').css('margin-top', '8px').append(searchBtn.$element)
  );

  function buildQuery() {
    const params = new URLSearchParams();
    const taskId = taskIdWidget.getValue().trim();
    const pageTitle = pageTitleWidget.getValue().trim();
    const status = statusWidget.getValue();
    if (taskId) params.set('task_id', taskId);
    if (pageTitle) params.set('page_title', pageTitle);
    if (status) params.set('status', status);
    params.set('limit', '100');
    return params.toString();
  }

  function renderRows(rows) {
    $resultSection.empty();
    $resultSection.append($('<div>').addClass('nb-section__title').text('結果（' + rows.length + '件、最大100件表示）'));

    if (rows.length === 0) {
      $resultSection.append($('<p>').text('該当する編集ログがありません。'));
      return;
    }

    const $list = $('<div>').addClass('nb-page-list');
    rows.forEach((r) => {
      const $row = $('<div>').addClass('nb-page-row');
      const $left = $('<span>');
      $left.append(
        $('<a>').attr('href', '/tasks/' + r.task_id).text('#' + r.task_id + ' '),
        document.createTextNode(r.page_title + ' ')
      );
      $left.append(C.pageStatusBadge(r.status === 'edited' ? 'edited' : 'failed'));
      const $right = $('<span>').css('color', '#54595d');
      $right.append(document.createTextNode(C.formatDateTime(r.edited_at) + ' / ' + r.account + ' '));
      if (r.diffUrl) {
        $right.append($('<a>').attr('href', r.diffUrl).attr('target', '_blank').attr('rel', 'noopener').text('差分を見る'));
      }
      if (r.error_message) {
        $right.append($('<div>').css({ color: '#b32424', fontSize: '0.85em' }).text(r.error_message));
      }
      $list.append($row.append($left, $right));
    });
    $resultSection.append($list);
  }

  async function search() {
    searchBtn.setDisabled(true);
    try {
      const rows = await C.fetchJson('/api/edit-log?' + buildQuery());
      renderRows(rows);
    } catch (e) {
      C.showNotice($notice, 'error', '検索に失敗しました: ' + e.message);
    } finally {
      searchBtn.setDisabled(false);
    }
  }

  searchBtn.on('click', search);
  search(); // 初回は無条件（直近100件）で表示
})();

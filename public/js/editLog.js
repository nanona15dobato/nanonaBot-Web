/* NanonaBot Tool - 編集ログ画面（フェーズ6。仕様書9.4節） */
(function () {
  'use strict';

  const C = window.NanonaCommon;
  const user = window.NANONA_BOT || {};

  const page = C.initPage({ title: '編集ログ', active: 'editLog' });
  if (!page.isOwner) {
    page.$main.append(C.buildEmergencyOnlyPanel(user));
    return;
  }

  // 検索条件はURLのクエリにも残す（タスク詳細からのリンク・再読み込み・共有用）
  const params = new URLSearchParams(location.search);

  const taskIdWidget = new OO.ui.TextInputWidget({ placeholder: '例: 12', value: params.get('task_id') || '', validate: /^\d*$/ });
  const pageTitleWidget = new OO.ui.SearchInputWidget({ placeholder: 'ページ名の一部', value: params.get('page_title') || '' });
  const statusWidget = new OO.ui.DropdownInputWidget({
    options: [
      { data: '', label: 'すべて' },
      { data: 'edited', label: '成功のみ' },
      { data: 'failed', label: '失敗のみ' },
    ],
    value: params.get('status') || '',
  });
  const limitWidget = new OO.ui.DropdownInputWidget({
    options: [
      { data: '50', label: '50件' },
      { data: '100', label: '100件' },
      { data: '200', label: '200件' },
    ],
    value: ['50', '100', '200'].includes(params.get('limit')) ? params.get('limit') : '100',
  });
  const searchBtn = new OO.ui.ButtonWidget({ label: '検索', icon: 'search', flags: ['primary', 'progressive'] });
  const resetBtn = new OO.ui.ButtonWidget({ label: '条件をクリア', framed: false });
  // CSV書き出し（フェーズ12）: 今の検索条件で最大10000件。表示件数の指定は使わない
  const csvBtn = new OO.ui.ButtonWidget({ label: 'CSVで書き出し', icon: 'download', title: '今の検索条件の編集ログ（最大10000件）をCSVで保存します' });
  csvBtn.on('click', () => {
    const q = currentQuery();
    q.delete('limit');
    location.href = '/api/edit-log.csv' + (q.toString() ? '?' + q.toString() : '');
  });

  const filterSection = C.section({ title: '検索条件', hint: '編集ログはタスクのページ情報が削除された後も残る恒久ログです。' });
  filterSection.$body.append(
    $('<div>').addClass('nb-filter-grid').append(
      new OO.ui.FieldLayout(taskIdWidget, { label: 'タスクID', align: 'top' }).$element,
      new OO.ui.FieldLayout(pageTitleWidget, { label: 'ページ名', align: 'top' }).$element,
      new OO.ui.FieldLayout(statusWidget, { label: '結果', align: 'top' }).$element,
      new OO.ui.FieldLayout(limitWidget, { label: '表示件数', align: 'top' }).$element
    ),
    $('<div>').addClass('nb-form-actions').append(searchBtn.$element, csvBtn.$element, resetBtn.$element)
  );

  const resultSection = C.section({ title: '結果' });
  page.$main.append(filterSection.$element, resultSection.$element);

  function currentQuery() {
    const q = new URLSearchParams();
    const taskId = taskIdWidget.getValue().trim();
    const pageTitle = pageTitleWidget.getValue().trim();
    if (taskId) q.set('task_id', taskId);
    if (pageTitle) q.set('page_title', pageTitle);
    if (statusWidget.getValue()) q.set('status', statusWidget.getValue());
    q.set('limit', limitWidget.getValue());
    return q;
  }

  function renderRows(rows, limit) {
    resultSection.setTitle('結果（' + rows.length + '件' + (rows.length >= limit ? '・上限まで表示' : '') + '）');
    resultSection.$body.empty();
    if (rows.length === 0) {
      resultSection.$body.append(C.emptyState('該当する編集ログがありません。'));
      return;
    }
    const $tbody = $('<tbody>');
    rows.forEach((r) => {
      const $result = $('<td>').append(C.pageStatusBadge(r.status === 'edited' ? 'edited' : 'failed'));
      const $detail = $('<td>').addClass('nb-table__detail');
      if (r.diffUrl) {
        $detail.append($('<a>').attr({ href: r.diffUrl, target: '_blank', rel: 'noopener' }).text('差分を見る'));
      }
      if (r.error_message) $detail.append($('<div>').addClass('nb-table__error').text(r.error_message));
      $tbody.append(
        $('<tr>').append(
          $('<td>').addClass('nb-table__nowrap').append(C.timeElement(r.edited_at)),
          $result,
          $('<td>').append(C.wikiLink(r.page_title)),
          $('<td>').append(r.task_id ? $('<a>').attr('href', '/tasks/' + r.task_id).text('#' + r.task_id) : '-'),
          $('<td>').text(r.account),
          $detail
        )
      );
    });
    const $table = $('<table>').addClass('nb-table').append(
      $('<thead>').append(
        $('<tr>').append(['日時', '結果', 'ページ', 'タスク', 'アカウント', '差分・エラー'].map((h) => $('<th>').attr('scope', 'col').text(h)))
      ),
      $tbody
    );
    resultSection.$body.append($('<div>').addClass('nb-table-wrap').append($table));
  }

  async function search() {
    const query = currentQuery();
    history.replaceState(null, '', location.pathname + (query.toString() ? '?' + query.toString() : ''));
    resultSection.$body.empty().append(C.loading('検索中…'));
    await C.withBusy(searchBtn, '検索', async () => {
      const rows = await C.fetchJson('/api/edit-log?' + query.toString());
      renderRows(rows, Number(query.get('limit')));
    });
  }

  searchBtn.on('click', search);
  taskIdWidget.on('enter', search);
  pageTitleWidget.on('enter', search);
  let resetting = false; // 条件クリア中は値の変更ごとに検索しない
  statusWidget.on('change', () => !resetting && search());
  limitWidget.on('change', () => !resetting && search());
  resetBtn.on('click', () => {
    resetting = true;
    taskIdWidget.setValue('');
    pageTitleWidget.setValue('');
    statusWidget.setValue('');
    resetting = false;
    search();
  });
  search(); // 初回はURLの条件（無ければ直近の100件）で表示
})();

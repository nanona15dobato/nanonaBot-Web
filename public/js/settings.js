/* NanonaBot Tool - 設定画面（フェーズ10: 通知先の設定・テスト送信） */
(function () {
  'use strict';

  const C = window.NanonaCommon;
  const user = window.NANONA_BOT || {};

  const page = C.initPage({ title: '設定', active: 'settings' });
  if (!page.isOwner) {
    page.$main.append(C.buildEmergencyOnlyPanel(user));
    return;
  }

  const EVENT_LABELS = {
    emergency_stop: '緊急停止が実行された',
    emergency_clear: '緊急停止が解除された',
    paused: 'タスクが失敗により一時停止した',
    failed: 'タスクがエラーで終了した',
    expired: 'タスクが無操作タイムアウトで期限切れになった',
    emergency_stopped: 'タスクが緊急停止で中断した',
    completed_with_failures: 'タスクが完了した（失敗ページあり）',
    completed: 'タスクが完了した',
  };
  const SOURCE_LABELS = { db: '画面で設定', env: '環境変数', none: '未設定' };

  const webhookWidget = new OO.ui.TextInputWidget({ placeholder: 'https://hooks.slack.com/services/… または https://discord.com/api/webhooks/…' });
  const mailToWidget = new OO.ui.TextInputWidget({ placeholder: '例: nanona15dobato@toolforge.org（カンマ区切りで複数）' });
  const mailFromWidget = new OO.ui.TextInputWidget({ placeholder: '例: "nanonaBotWeb:Error" <nanonabot01.weberror@toolforge.org>' });
  const eventsWidget = new OO.ui.CheckboxMultiselectInputWidget({ options: [] });

  const fields = {};
  function field(widget, name, label, help) {
    const layout = new OO.ui.FieldLayout(widget, { label, align: 'top', help, helpInline: true });
    const $source = $('<span>').addClass('nb-chip nb-setting-source');
    layout.$label.append(' ', $source);
    fields[name] = { layout, $source };
    return layout.$element;
  }

  const saveBtn = new OO.ui.ButtonWidget({ label: '保存', icon: 'check', flags: ['primary', 'progressive'] });
  const testBtn = new OO.ui.ButtonWidget({ label: 'テスト送信', icon: 'notice' });
  const resetBtn = new OO.ui.ButtonWidget({ label: '環境変数の値に戻す', framed: false, flags: ['destructive'] });

  const notifySection = C.section({
    title: '通知',
    hint:
      '緊急停止やタスクの停止・失敗・完了を通知します。ここで保存した値は環境変数（NOTIFY_*）より優先されます。' +
      'Webhook とメールの両方を設定すると両方に送ります。',
  });
  const $result = $('<div>');
  notifySection.$body.append(
    field(webhookWidget, 'webhookUrl', 'Webhook URL（Slack / Discord）', '空にすると Webhook には送りません。'),
    field(mailToWidget, 'mailTo', 'メールの宛先', '「利用者名@toolforge.org」宛ては、開発者アカウントに登録したメールアドレスへ転送されます。'),
    field(
      mailFromWidget,
      'mailFrom',
      'メールの送信元',
      'Toolforgeのメールサーバーは「ツール名.任意の文字列@toolforge.org」形式の送信元だけを受け付けます（Help:Toolforge/Email）。宛先と送信元の両方があるときだけメールを送ります。'
    ),
    field(eventsWidget, 'events', '通知する出来事', 'メールにはアドレスごとの送信数の上限があるため、多すぎる場合は「タスクが完了した」などを外してください。'),
    $('<div>').addClass('nb-form-actions').append(saveBtn.$element, testBtn.$element, resetBtn.$element),
    $result
  );
  page.$main.append(notifySection.$element);

  // ===== ワーカーの動作（フェーズ11） =====
  const WORKER_FIELDS = [
    { name: 'reviewPollMs', label: '承認待ちの確認間隔（ミリ秒）', help: '画面で承認してから編集が始まるまでの最大の遅れです。短いほど速く反応しますが、DBへの問い合わせが増えます。' },
    { name: 'editRetryCount', label: '一時的な失敗の再試行回数', help: '編集競合（自動更新モード）・サーバーエラー等で再試行する回数。0で再試行しません。' },
    { name: 'editRetryBaseMs', label: '1回目の再試行までの待ち時間（ミリ秒）', help: '2回目以降は倍々に延ばします（既定: 10秒・20秒・40秒）。' },
    { name: 'nullEditIntervalMs', label: 'null edit / purge の間隔（ミリ秒）', help: 'Category系ルールのウェーブ1後に、テンプレート使用ページを更新する間隔（purgeは50件ごと）。' },
    { name: 'taskPagesRetentionDays', label: '作業データの保持日数', help: '終わったタスクのページ単位の作業データを残す日数。0で削除しません。' },
  ];
  const SOURCE_LABELS_WORKER = { db: '画面で設定', env: '環境変数', default: '既定値' };
  const workerWidgets = {};
  const workerSection = C.section({
    title: 'ワーカーの動作',
    hint:
      '実環境で動かしながら調整するための設定です。ここで保存した値は環境変数より優先され、ワーカーには最大30秒で反映されます（再起動は不要）。',
  });
  const $workerFields = $('<div>');
  WORKER_FIELDS.forEach((f) => {
    const widget = new OO.ui.NumberInputWidget({ step: 1, isInteger: true });
    const layout = new OO.ui.FieldLayout(widget, { label: f.label, align: 'top', help: f.help, helpInline: true });
    const $source = $('<span>').addClass('nb-chip nb-setting-source');
    layout.$label.append(' ', $source);
    workerWidgets[f.name] = { widget, $source, layout };
    $workerFields.append(layout.$element);
  });
  const workerSaveBtn = new OO.ui.ButtonWidget({ label: '保存', icon: 'check', flags: ['primary', 'progressive'] });
  const workerResetBtn = new OO.ui.ButtonWidget({ label: '環境変数・既定値に戻す', framed: false, flags: ['destructive'] });
  const $workerResult = $('<div>');
  workerSection.$body.append(
    $workerFields,
    $('<div>').addClass('nb-form-actions').append(workerSaveBtn.$element, workerResetBtn.$element),
    $workerResult
  );
  page.$main.append(workerSection.$element);

  function renderWorker(data) {
    Object.entries(workerWidgets).forEach(([name, w]) => {
      const limit = data.limits[name];
      w.widget.setRange(limit.min, limit.max);
      w.widget.setValue(data.values[name]);
      const source = data.sources[name] || 'default';
      w.$source
        .text(SOURCE_LABELS_WORKER[source] + (source === 'default' ? '（' + limit.def + '）' : ''))
        .attr('data-source', source === 'default' ? 'none' : source)
        .attr('title', '環境変数: ' + limit.env + ' ／ 範囲: ' + limit.min + '〜' + limit.max);
    });
  }

  function showWorkerErrors(errors) {
    $workerResult.empty();
    if (!errors || errors.length === 0) return;
    $workerResult.append(new OO.ui.MessageWidget({ type: 'error', label: $('<ul>').append(errors.map((e) => $('<li>').text(e))) }).$element);
  }

  workerSaveBtn.on('click', () =>
    C.withBusy(workerSaveBtn, '保存', async () => {
      const body = {};
      Object.entries(workerWidgets).forEach(([name, w]) => {
        body[name] = Number(w.widget.getValue());
      });
      try {
        renderWorker(await C.putJson('/api/settings/worker', body));
        showWorkerErrors([]);
        C.toast('ワーカーの動作設定を保存しました（最大30秒で反映されます）。');
      } catch (e) {
        if (e.data && e.data.errors) showWorkerErrors(e.data.errors);
        else throw e;
      }
    })
  );
  workerResetBtn.on('click', async () => {
    const ok = await C.confirm('画面で保存したワーカーの動作設定を消し、環境変数（無ければ既定値）に戻します。', {
      title: '環境変数・既定値に戻しますか？',
      okLabel: '戻す',
      destructive: true,
    });
    if (!ok) return;
    await C.withBusy(workerResetBtn, '設定のリセット', async () => {
      const body = Object.fromEntries(Object.keys(workerWidgets).map((name) => [name, null]));
      renderWorker(await C.putJson('/api/settings/worker', body));
      showWorkerErrors([]);
      C.toast('環境変数・既定値に戻しました。');
    });
  });
  C.fetchJson('/api/settings/worker')
    .then(renderWorker)
    .catch((e) => C.toast('ワーカーの動作設定の読み込みに失敗しました: ' + e.message, 'error'));

  function render(settings) {
    webhookWidget.setValue(settings.webhookUrl || '');
    mailToWidget.setValue(settings.mailTo || '');
    mailFromWidget.setValue(settings.mailFrom || '');
    eventsWidget.setOptions(settings.allEvents.map((e) => ({ data: e, label: EVENT_LABELS[e] || e })));
    eventsWidget.setValue(settings.events);
    Object.entries(fields).forEach(([name, f]) => {
      const source = (settings.sources && settings.sources[name]) || 'none';
      f.$source.text(SOURCE_LABELS[source]).attr('data-source', source);
    });
  }

  function showErrors(errors) {
    $result.empty();
    if (!errors || errors.length === 0) return;
    $result.append(
      new OO.ui.MessageWidget({ type: 'error', label: $('<ul>').append(errors.map((e) => $('<li>').text(e))) }).$element
    );
  }

  async function load() {
    try {
      render(await C.fetchJson('/api/settings/notify'));
    } catch (e) {
      C.toast('設定の読み込みに失敗しました: ' + e.message, 'error');
    }
  }

  saveBtn.on('click', () =>
    C.withBusy(saveBtn, '保存', async () => {
      try {
        const settings = await C.putJson('/api/settings/notify', {
          webhookUrl: webhookWidget.getValue().trim(),
          mailTo: mailToWidget.getValue().trim(),
          mailFrom: mailFromWidget.getValue().trim(),
          events: eventsWidget.getValue(),
        });
        showErrors([]);
        render(settings);
        C.toast('通知設定を保存しました。');
      } catch (e) {
        if (e.data && e.data.errors) showErrors(e.data.errors);
        else throw e;
      }
    })
  );

  resetBtn.on('click', async () => {
    const ok = await C.confirm('画面で保存した通知設定を消し、環境変数（NOTIFY_*）の値に戻します。', {
      title: '環境変数の値に戻しますか？',
      okLabel: '戻す',
      destructive: true,
    });
    if (!ok) return;
    await C.withBusy(resetBtn, '設定のリセット', async () => {
      render(await C.putJson('/api/settings/notify', { webhookUrl: null, mailTo: null, mailFrom: null, events: null }));
      showErrors([]);
      C.toast('環境変数の値に戻しました。');
    });
  });

  testBtn.on('click', () =>
    C.withBusy(testBtn, 'テスト送信', async () => {
      const result = await C.postJson('/api/settings/notify/test', {});
      const describe = (label, value) =>
        label + ': ' + (value === null ? '未設定のため送っていません' : value ? '送信しました' : '送信に失敗しました（サーバーのログを確認してください）');
      const failed = result.webhook === false || result.mail === false;
      const nothing = result.webhook === null && result.mail === null;
      $result.empty().append(
        new OO.ui.MessageWidget({
          type: nothing ? 'warning' : failed ? 'error' : 'success',
          label: $('<div>').append(
            $('<div>').text(nothing ? '通知先が設定されていません。保存してからテストしてください。' : '保存済みの設定でテスト通知を送りました。'),
            $('<div>').text(describe('Webhook', result.webhook)),
            $('<div>').text(describe('メール', result.mail))
          ),
        }).$element
      );
    })
  );

  load();
})();

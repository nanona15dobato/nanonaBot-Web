/* NanonaBot Tool - タスク作成画面 */
(function () {
  'use strict';

  const C = window.NanonaCommon;
  const user = window.NANONA_BOT || {};
  const $app = $('#app');

  $app.append(C.buildHeader({ title: '新規タスク作成', user }));

  const $notice = $('<div>');
  $app.append($notice);

  // フェーズ2時点でバックエンドが対応しているのは templateType:"custom" + targetSource:"manualList" のみ。
  // 仕様書10章のUI設計に合わせ、選択肢自体は6種類とも表示するが、未対応の種別は選べないようにしておく
  // （フェーズ4以降で対応するテンプレート置換群が有効になったら、ここのdisabledを外す）。
  const RULE_TYPES = [
    { data: 'custom', label: 'カスタム（対応済み）' },
    { data: 'linkRename', label: 'リンク置換（フェーズ4で対応予定）' },
    { data: 'linkRename2', label: 'リンク置換2（フェーズ4で対応予定）' },
    { data: 'categoryRename', label: 'Category置換（フェーズ4で対応予定）' },
    { data: 'categoryRemove', label: 'Category除去（フェーズ4で対応予定）' },
    { data: 'templateRename', label: 'テンプレート置換（フェーズ4で対応予定）' },
  ];

  let ruleSeq = 0;
  let stepSeq = 0;
  const rules = []; // { id, typeWidget, titlesWidget, $card, steps: [{id, patternWidget, flagsWidget, replacementWidget, $row}] }

  const $rulesContainer = $('<div>');

  function addStepRow(rule) {
    const id = ++stepSeq;
    const patternWidget = new OO.ui.TextInputWidget({ placeholder: '正規表現（例: プタリン・ジャヤ・スタジアム）' });
    const flagsWidget = new OO.ui.TextInputWidget({ placeholder: 'flags', value: 'g' });
    const replacementWidget = new OO.ui.TextInputWidget({ placeholder: '置換後（例: ペタリン・ジャヤ・スタジアム）' });
    const removeBtn = new OO.ui.ButtonWidget({ icon: 'trash', flags: ['destructive'], framed: false, title: 'このステップを削除' });

    const $row = $('<div>').addClass('nb-step-row');
    $row.append(
      $('<div>').addClass('nb-step-row__pattern').append(patternWidget.$element),
      $('<div>').css('width', '70px').append(flagsWidget.$element),
      $('<div>').addClass('nb-step-row__replacement').append(replacementWidget.$element),
      removeBtn.$element
    );

    const step = { id, patternWidget, flagsWidget, replacementWidget, $row };
    removeBtn.on('click', () => {
      rule.steps = rule.steps.filter((s) => s.id !== id);
      $row.remove();
    });

    rule.steps.push(step);
    rule.$stepsContainer.append($row);
  }

  function addRuleCard() {
    const id = ++ruleSeq;
    const typeWidget = new OO.ui.DropdownInputWidget({ options: RULE_TYPES, value: 'custom' });
    const titlesWidget = new OO.ui.MultilineTextInputWidget({
      placeholder: '対象ページ名を1行に1つ（例: 利用者:Nanona15dobato/sandbox）',
      rows: 3,
    });
    const removeRuleBtn = new OO.ui.ButtonWidget({ label: 'このルールを削除', icon: 'trash', flags: ['destructive'], framed: false });
    const addStepBtn = new OO.ui.ButtonWidget({ label: '＋ ステップ追加', framed: false });

    const $stepsContainer = $('<div>');
    const $unsupportedNotice = $('<div>').css({ color: '#ac6600', fontSize: '0.9em', marginTop: '4px' });

    const $card = $('<div>').addClass('nb-rule-card');
    const $cardHeader = $('<div>').addClass('nb-rule-card__header');
    $cardHeader.append($('<strong>').text('ルール #' + id), removeRuleBtn.$element);

    const rule = { id, typeWidget, titlesWidget, steps: [], $card, $stepsContainer };

    function renderTypeDependentArea() {
      $stepsContainer.empty();
      $unsupportedNotice.empty();
      const type = typeWidget.getValue();
      if (type !== 'custom') {
        $unsupportedNotice.text(
          'この種別は現バージョンでは未対応です。作成する場合は種別を「カスタム」にして、' +
            '同等の正規表現を手動で設定してください。'
        );
        return;
      }
      rule.steps = [];
      addStepRow(rule);
    }

    typeWidget.on('change', renderTypeDependentArea);
    addStepBtn.on('click', () => addStepRow(rule));
    removeRuleBtn.on('click', () => {
      const idx = rules.findIndex((r) => r.id === id);
      if (idx !== -1) rules.splice(idx, 1);
      $card.remove();
    });

    $card.append(
      $cardHeader,
      new OO.ui.FieldLayout(typeWidget, { label: '種別', align: 'top' }).$element,
      $unsupportedNotice,
      $('<div>').append($('<strong>').text('置換ステップ')),
      $stepsContainer,
      $('<div>').css('margin', '4px 0').append(addStepBtn.$element),
      new OO.ui.FieldLayout(titlesWidget, {
        label: '対象ページ（手入力）',
        align: 'top',
        help: '仕様書フェーズ2時点では手入力（manualList）のみ対応しています。',
        helpInline: true,
      }).$element
    );

    renderTypeDependentArea();
    rules.push(rule);
    $rulesContainer.append($card);
  }

  const addRuleBtn = new OO.ui.ButtonWidget({ label: '＋ ルール追加', flags: ['progressive'] });
  addRuleBtn.on('click', addRuleCard);

  // ---- アカウント選択 ----
  const accountWidget = new OO.ui.DropdownInputWidget({
    options: [
      { data: 'NanonaBot', label: 'NanonaBot（既定）' },
      { data: 'Nanona15dobato', label: 'Nanona15dobato' },
      { data: 'NanonaBot3', label: 'NanonaBot3' },
    ],
    value: 'NanonaBot',
  });

  // ---- 編集設定 ----
  const botFlagWidget = new OO.ui.CheckboxInputWidget({ selected: true });
  const minorEditWidget = new OO.ui.CheckboxInputWidget({ selected: true });
  const editSummaryWidget = new OO.ui.TextInputWidget({ placeholder: '例: Bot: リンク修正' });
  const editIntervalWidget = new OO.ui.NumberInputWidget({ min: 5, step: 1, value: 10 });

  // ---- 実行モード ----
  const modeWidget = new OO.ui.RadioSelectInputWidget({
    options: [
      { data: 'auto', label: '自動更新' },
      { data: 'manual', label: '確認待機' },
    ],
    value: 'auto',
  });
  const autoWaitWidget = new OO.ui.NumberInputWidget({ min: 0, step: 1, value: 300 });
  const manualTimeoutWidget = new OO.ui.NumberInputWidget({ min: 1, step: 1, value: 72 });
  const $autoWaitField = new OO.ui.FieldLayout(autoWaitWidget, { label: '自動承認までの待機秒数', align: 'top' }).$element;
  const $manualTimeoutField = new OO.ui.FieldLayout(manualTimeoutWidget, {
    label: '無操作タイムアウト（時間）',
    align: 'top',
    help: 'この時間操作が無ければタスクを期限切れにします。',
    helpInline: true,
  }).$element;

  function renderModeFields() {
    const mode = modeWidget.getValue();
    $autoWaitField.toggle(mode === 'auto');
    $manualTimeoutField.toggle(mode === 'manual');
  }
  modeWidget.on('change', renderModeFields);

  // ---- 失敗時挙動 ----
  const onFailureWidget = new OO.ui.RadioSelectInputWidget({
    options: [
      { data: 'pause', label: '一時停止する' },
      { data: 'skipAndContinue', label: 'スキップして続行する' },
    ],
    value: 'pause',
  });

  // ---- 送信 ----
  const submitBtn = new OO.ui.ButtonWidget({ label: 'タスクを作成してキューに投入', flags: ['primary', 'progressive'] });

  function buildConfig() {
    const replacements = rules
      .filter((r) => r.typeWidget.getValue() === 'custom')
      .map((r) => {
        const titles = r.titlesWidget
          .getValue()
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        const steps = r.steps.map((s) => ({
          pattern: s.patternWidget.getValue(),
          flags: s.flagsWidget.getValue() || 'g',
          replacement: s.replacementWidget.getValue(),
        }));
        return {
          templateType: 'custom',
          steps,
          targetSource: { type: 'manualList', titles },
        };
      });

    const mode = modeWidget.getValue();
    const reviewSettings = { mode };
    if (mode === 'auto') reviewSettings.autoWaitSeconds = Number(autoWaitWidget.getValue());
    else reviewSettings.manualTimeoutHours = Number(manualTimeoutWidget.getValue());

    return {
      account: accountWidget.getValue(),
      replacements,
      editSettings: {
        botFlag: botFlagWidget.isSelected(),
        minorEdit: minorEditWidget.isSelected(),
        editSummary: editSummaryWidget.getValue(),
        editIntervalSeconds: Number(editIntervalWidget.getValue()),
      },
      reviewSettings,
      onFailure: onFailureWidget.getValue(),
    };
  }

  submitBtn.on('click', async () => {
    submitBtn.setDisabled(true);
    try {
      const config = buildConfig();
      const result = await C.postJson('/api/tasks', config);
      C.showNotice($notice, 'success', 'タスク #' + result.id + ' を作成しました。移動します…');
      setTimeout(() => {
        location.href = '/tasks/' + result.id;
      }, 800);
    } catch (e) {
      C.showNotice($notice, 'error', 'タスクの作成に失敗しました: ' + e.message);
      submitBtn.setDisabled(false);
    }
  });

  // ---- 組み立て ----
  const $accountSection = $('<div>').addClass('nb-section');
  $accountSection.append(
    $('<div>').addClass('nb-section__title').text('Botアカウント'),
    new OO.ui.FieldLayout(accountWidget, { label: 'アカウント', align: 'top' }).$element
  );

  const $rulesSection = $('<div>').addClass('nb-section');
  $rulesSection.append(
    $('<div>').addClass('nb-section__title').text('置換ルール'),
    $rulesContainer,
    $('<div>').css('margin-top', '8px').append(addRuleBtn.$element)
  );

  const $editSection = $('<div>').addClass('nb-section');
  $editSection.append(
    $('<div>').addClass('nb-section__title').text('編集設定'),
    new OO.ui.FieldLayout(botFlagWidget, { label: 'Botフラグを付与', align: 'inline' }).$element,
    new OO.ui.FieldLayout(minorEditWidget, { label: '細部の編集にする', align: 'inline' }).$element,
    new OO.ui.FieldLayout(editSummaryWidget, { label: '要約欄', align: 'top' }).$element,
    new OO.ui.FieldLayout(editIntervalWidget, { label: '編集間隔（秒・5以上）', align: 'top' }).$element
  );

  const $reviewSection = $('<div>').addClass('nb-section');
  $reviewSection.append(
    $('<div>').addClass('nb-section__title').text('実行モード'),
    new OO.ui.FieldLayout(modeWidget, { label: 'モード', align: 'top' }).$element,
    $autoWaitField,
    $manualTimeoutField
  );

  const $failureSection = $('<div>').addClass('nb-section');
  $failureSection.append(
    $('<div>').addClass('nb-section__title').text('失敗時の挙動'),
    new OO.ui.FieldLayout(onFailureWidget, { label: '失敗ページが出た場合', align: 'top' }).$element
  );

  $app.append($accountSection, $rulesSection, $editSection, $reviewSection, $failureSection, submitBtn.$element);

  renderModeFields();
  addRuleCard();
})();

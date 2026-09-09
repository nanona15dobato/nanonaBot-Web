/* NanonaBot Tool - タスク作成画面 */
(function () {
  'use strict';

  const C = window.NanonaCommon;
  const user = window.NANONA_BOT || {};
  const $app = $('#app');

  $app.append(C.buildHeader({ title: '新規タスク作成', user }));

  const $notice = $('<div>');
  $app.append($notice);

  // フェーズ4〜6: 8種類すべてのtemplateTypeが実際に機能する（仕様書6章・10章、フェーズ6でunlinkPage/templateSubstを追加）。
  const RULE_TYPES = [
    { data: 'custom', label: 'カスタム' },
    { data: 'linkRename', label: 'リンク置換' },
    { data: 'linkRename2', label: 'リンク置換2（表示保持）' },
    { data: 'categoryRename', label: 'Category置換' },
    { data: 'categoryRemove', label: 'Category除去' },
    { data: 'templateRename', label: 'テンプレート置換' },
    { data: 'unlinkPage', label: 'リンク解除' },
    { data: 'templateSubst', label: 'テンプレートのsubst化' },
  ];

  // toが不要な種別（fromのみで完結する）
  const TYPES_WITHOUT_TO = ['categoryRemove', 'unlinkPage', 'templateSubst'];

  const CUSTOM_TARGET_SOURCE_TYPES = [
    { data: 'manualList', label: '手入力' },
    { data: 'category', label: 'カテゴリメンバー' },
    { data: 'backlinks', label: 'リンク元（backlinks）' },
    { data: 'embeddedin', label: 'テンプレート使用ページ（embeddedin）' },
    { data: 'regexSearch', label: '正規表現検索（insource:）' },
  ];

  const NAMESPACE_OPTIONS = [
    { data: 0, label: '標準 (0)' },
    { data: 1, label: 'ノート (1)' },
    { data: 2, label: '利用者 (2)' },
    { data: 3, label: '利用者‐会話 (3)' },
    { data: 4, label: 'Wikipedia (4)' },
    { data: 10, label: 'Template (10)' },
    { data: 12, label: 'Help (12)' },
    { data: 14, label: 'Category (14)' },
    { data: 100, label: 'Portal (100)' },
  ];

  function buildNamespaceField(defaultSelected, help) {
    const widget = new OO.ui.CheckboxMultiselectInputWidget({ options: NAMESPACE_OPTIONS, value: defaultSelected || [] });
    const field = new OO.ui.FieldLayout(widget, {
      label: '名前空間（未選択=全名前空間）',
      align: 'top',
      help: help || '',
      helpInline: true,
    });
    return { widget, $element: field.$element };
  }

  /** namespaces配列（空なら null=全名前空間）を取得する共通ヘルパー。 */
  function namespacesOrNull(widget) {
    const v = widget.getValue();
    return v && v.length > 0 ? v.map(Number) : null;
  }

  let ruleSeq = 0;
  let stepSeq = 0;
  const rules = []; // { id, typeWidget, $card, getConfig(): object|null, steps?: [...] }

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
      rule.customSteps = rule.customSteps.filter((s) => s.id !== id);
      $row.remove();
    });

    rule.customSteps.push(step);
    rule.$stepsContainer.append($row);
  }

  /** targetType(custom用)に応じた入力欄一式を構築する。 */
  function buildCustomTargetArea(rule) {
    const $area = $('<div>');
    const sourceTypeWidget = new OO.ui.DropdownInputWidget({ options: CUSTOM_TARGET_SOURCE_TYPES, value: 'manualList' });
    const titlesWidget = new OO.ui.MultilineTextInputWidget({
      placeholder: '対象ページ名を1行に1つ（例: 利用者:Nanona15dobato/sandbox）',
      rows: 3,
    });
    const categoryWidget = new OO.ui.TextInputWidget({ placeholder: '例: 日本の橋（Category:は省略可）' });
    const pageWidget = new OO.ui.TextInputWidget({ placeholder: '例: プタリン・ジャヤ・スタジアム' });
    const queryWidget = new OO.ui.TextInputWidget({ placeholder: '例: insource:/旧テンプレ/' });
    const ns = buildNamespaceField(null, 'category/backlinks/embeddedin/regexSearchで使用');

    const $dynamic = $('<div>');

    function render() {
      $dynamic.empty();
      const t = sourceTypeWidget.getValue();
      if (t === 'manualList') {
        $dynamic.append(new OO.ui.FieldLayout(titlesWidget, { label: '対象ページ（1行に1つ）', align: 'top' }).$element);
      } else if (t === 'category') {
        $dynamic.append(new OO.ui.FieldLayout(categoryWidget, { label: 'カテゴリ名', align: 'top' }).$element, ns.$element);
      } else if (t === 'backlinks' || t === 'embeddedin') {
        $dynamic.append(
          new OO.ui.FieldLayout(pageWidget, { label: t === 'backlinks' ? 'リンク先ページ名' : 'テンプレート名', align: 'top' }).$element,
          ns.$element
        );
      } else if (t === 'regexSearch') {
        $dynamic.append(new OO.ui.FieldLayout(queryWidget, { label: '検索クエリ', align: 'top' }).$element, ns.$element);
      }
    }
    sourceTypeWidget.on('change', render);
    render();

    $area.append(new OO.ui.FieldLayout(sourceTypeWidget, { label: '対象ページ取得方法', align: 'top' }).$element, $dynamic);

    return {
      $element: $area,
      getTargetSource() {
        const t = sourceTypeWidget.getValue();
        if (t === 'manualList') {
          const titles = titlesWidget.getValue().split('\n').map((s) => s.trim()).filter(Boolean);
          return { type: 'manualList', titles };
        }
        if (t === 'category') {
          return { type: 'category', category: categoryWidget.getValue(), namespaces: namespacesOrNull(ns.widget) };
        }
        if (t === 'backlinks') {
          return { type: 'backlinks', page: pageWidget.getValue(), namespaces: namespacesOrNull(ns.widget) };
        }
        if (t === 'embeddedin') {
          return { type: 'embeddedin', page: pageWidget.getValue(), namespaces: namespacesOrNull(ns.widget) };
        }
        return { type: 'regexSearch', query: queryWidget.getValue(), namespaces: namespacesOrNull(ns.widget) };
      },
    };
  }

  /**
   * @param {{templateType?:string, from?:string, to?:string}} [prefill] - BOTREQ取り込み時の初期値
   */
  function addRuleCard(prefill) {
    const id = ++ruleSeq;
    const initialType = (prefill && prefill.templateType) || 'custom';
    const typeWidget = new OO.ui.DropdownInputWidget({ options: RULE_TYPES, value: initialType });
    const removeRuleBtn = new OO.ui.ButtonWidget({ label: 'このルールを削除', icon: 'trash', flags: ['destructive'], framed: false });

    const $body = $('<div>');
    const $card = $('<div>').addClass('nb-rule-card');
    const $cardHeader = $('<div>').addClass('nb-rule-card__header');
    $cardHeader.append($('<strong>').text('ルール #' + id), removeRuleBtn.$element);

    const rule = { id, typeWidget, $card, customSteps: [], $stepsContainer: null, getConfig: () => null };

    function renderBody() {
      // $body.empty()で子要素がDOMから除去されると、使い回しているウィジェットの
      // イベントハンドラがjQueryのクリーンアップで失われる恐れがあるため、
      // type依存のウィジェット（addStepBtn等）は毎回このrenderBody内で新規生成する。
      $body.empty();
      const type = typeWidget.getValue();

      if (type === 'custom') {
        rule.customSteps = [];
        const $stepsContainer = $('<div>');
        rule.$stepsContainer = $stepsContainer;
        const targetArea = buildCustomTargetArea(rule);
        const addStepBtn = new OO.ui.ButtonWidget({ label: '＋ ステップ追加', framed: false });
        addStepBtn.on('click', () => addStepRow(rule));

        $body.append(
          $('<div>').append($('<strong>').text('置換ステップ')),
          $stepsContainer,
          $('<div>').css('margin', '4px 0').append(addStepBtn.$element),
          targetArea.$element
        );
        addStepRow(rule);

        rule.getConfig = () => ({
          templateType: 'custom',
          steps: rule.customSteps.map((s) => ({
            pattern: s.patternWidget.getValue(),
            flags: s.flagsWidget.getValue() || 'g',
            replacement: s.replacementWidget.getValue(),
          })),
          targetSource: targetArea.getTargetSource(),
        });
        return;
      }

      const fromWidget = new OO.ui.TextInputWidget({
        placeholder: '改名元/除去対象（Category:・Template:プレフィックスは省略可）',
        value: (prefill && prefill.from) || '',
      });
      const toWidget = new OO.ui.TextInputWidget({ placeholder: '改名先', value: (prefill && prefill.to) || '' });
      const needsTo = !TYPES_WITHOUT_TO.includes(type);

      const fromLabels = {
        categoryRemove: '除去対象',
        unlinkPage: 'リンク解除対象',
        templateSubst: 'subst化するテンプレート',
      };
      $body.append(
        new OO.ui.FieldLayout(fromWidget, { label: fromLabels[type] || '改名元（from）', align: 'top' }).$element
      );
      if (needsTo) {
        $body.append(new OO.ui.FieldLayout(toWidget, { label: '改名先（to）', align: 'top' }).$element);
      }

      if (type === 'linkRename' || type === 'linkRename2') {
        const ns = buildNamespaceField(
          [0],
          'ウェーブ2（その他ページ）の対象名前空間。ウェーブ1はTemplate名前空間固定で自動的に処理されます。'
        );
        $body.append(
          $('<p>').css({ color: '#54595d', fontSize: '0.9em' }).text(
            'このルールは2ウェーブ構成で処理されます: ウェーブ1でTemplate名前空間を先に編集→対象を再取得→ウェーブ2でその他ページを編集。'
          ),
          ns.$element
        );
        rule.getConfig = () => ({
          templateType: type,
          from: fromWidget.getValue(),
          to: toWidget.getValue(),
          namespaces: namespacesOrNull(ns.widget),
        });
      } else if (type === 'categoryRename' || type === 'categoryRemove') {
        const ns = buildNamespaceField(null, '既定は全名前空間（原則すべてのカテゴリ呼び出し先が対象）。');
        $body.append(
          $('<p>').css({ color: '#54595d', fontSize: '0.9em' }).text(
            'カテゴリメンバー全体を対象にします。加えて、Template:リダイレクトの所属カテゴリ内で' +
              'このカテゴリ名を保持しているページも自動的に検出し、該当箇所を書き換えます。' +
              '構造的に確認できない緩い一致のみは、自動編集せず警告として表示します。'
          ),
          ns.$element
        );
        rule.getConfig = () =>
          type === 'categoryRename'
            ? { templateType: 'categoryRename', from: fromWidget.getValue(), to: toWidget.getValue(), namespaces: namespacesOrNull(ns.widget) }
            : { templateType: 'categoryRemove', from: fromWidget.getValue(), namespaces: namespacesOrNull(ns.widget) };
      } else if (type === 'templateRename') {
        const ns = buildNamespaceField([0], '既定は標準名前空間のみ。テンプレートの入れ子呼び出しまで洗い出したい場合はTemplateも追加してください。');
        $body.append(ns.$element);
        rule.getConfig = () => ({
          templateType: 'templateRename',
          from: fromWidget.getValue(),
          to: toWidget.getValue(),
          namespaces: namespacesOrNull(ns.widget),
        });
      } else if (type === 'unlinkPage') {
        const ns = buildNamespaceField([0], '既定は標準名前空間のみ。リンク元へのbacklinksを対象にします。');
        $body.append(
          $('<p>').css({ color: '#54595d', fontSize: '0.9em' }).text(
            '[[対象]]・[[対象|表示名]]・[[対象#アンカー]] を地の文に変換します（BOTREQのDELETE_PAGE相当）。' +
              'ハットノートテンプレート内の参照解除はフェーズ6では対象外です。'
          ),
          ns.$element
        );
        rule.getConfig = () => ({
          templateType: 'unlinkPage',
          from: fromWidget.getValue(),
          namespaces: namespacesOrNull(ns.widget),
        });
      } else if (type === 'templateSubst') {
        const ns = buildNamespaceField([0], '既定は標準名前空間のみ。テンプレート使用ページへのembeddedinを対象にします。');
        $body.append(
          $('<p>').css({ color: '#54595d', fontSize: '0.9em' }).text(
            '{{対象}} を {{subst:対象}} に変換します（BOTREQの Template:X→subst: 相当）。' +
              '既にsubst:/safesubst:済みのものは二重に付与しません。'
          ),
          ns.$element
        );
        rule.getConfig = () => ({
          templateType: 'templateSubst',
          from: fromWidget.getValue(),
          namespaces: namespacesOrNull(ns.widget),
        });
      }
    }

    typeWidget.on('change', renderBody);
    removeRuleBtn.on('click', () => {
      const idx = rules.findIndex((r) => r.id === id);
      if (idx !== -1) rules.splice(idx, 1);
      $card.remove();
    });

    $card.append($cardHeader, new OO.ui.FieldLayout(typeWidget, { label: '種別', align: 'top' }).$element, $body);

    renderBody();
    rules.push(rule);
    $rulesContainer.append($card);
  }

  const addRuleBtn = new OO.ui.ButtonWidget({ label: '＋ ルール追加', flags: ['progressive'] });
  addRuleBtn.on('click', addRuleCard);

  // ---- BOTREQ連携（仕様書7章）----
  const UNSUPPORTED_REASON_LABELS = {
    DELETE_PAGE: 'リンク解除指定（DELETE_PAGE）',
    REDIRECT_TARGET: 'リダイレクト解決指定（REDIRECT_TARGET）',
    subst: 'テンプレートのsubst化指定',
    URL: '外部URLの付け替え',
    anchor_or_label: 'アンカー/パイプラベル付き指定',
    namespace_mismatch: '改名元・改名先の名前空間が噛み合っていない',
  };
  const RULE_TYPE_LABEL_MAP = Object.fromEntries(RULE_TYPES.map((t) => [t.data, t.label]));

  const botreqBtn = new OO.ui.ButtonWidget({ label: 'Wikipedia:Bot作業依頼 から取得', icon: 'search' });
  const $botreqPanel = $('<div>');

  function renderBotreqProposals(proposals) {
    $botreqPanel.empty();
    if (!proposals || proposals.length === 0) {
      $botreqPanel.append($('<p>').text('{{リンク修正依頼/改名}}は見つかりませんでした。'));
      return;
    }
    proposals.forEach((p) => {
      const $card = $('<div>').addClass('nb-rule-card');
      $card.append(
        $('<div>').css('font-weight', 'bold').text(
          '提案 #' + (p.index + 1) + (p.proposal ? '（' + p.proposal + '）' : '（提案先の記載なし）')
        )
      );
      const $pairList = $('<div>').css('margin', '6px 0');
      p.pairs.forEach((pair) => {
        const $row = $('<div>').css({ fontFamily: 'monospace', fontSize: '0.9em' });
        if (pair.type === 'unsupported') {
          $row.css('color', '#ac6600').text(
            '[未対応: ' + (UNSUPPORTED_REASON_LABELS[pair.reason] || pair.reason) + '] ' + pair.rawFrom + ' → ' + pair.rawTo
          );
        } else if (pair.to === undefined) {
          $row.text('[' + RULE_TYPE_LABEL_MAP[pair.type] + '] ' + pair.from);
        } else {
          $row.text('[' + RULE_TYPE_LABEL_MAP[pair.type] + '] ' + pair.from + ' → ' + pair.to);
        }
        $pairList.append($row);
      });

      const supportedCount = p.pairs.filter((pair) => pair.type !== 'unsupported').length;
      const importBtn = new OO.ui.ButtonWidget({
        label: '対応済みの' + supportedCount + '件をルールとして取り込む',
        flags: ['progressive'],
        disabled: supportedCount === 0,
      });
      importBtn.on('click', () => {
        p.pairs
          .filter((pair) => pair.type !== 'unsupported')
          .forEach((pair) => addRuleCard({ templateType: pair.type, from: pair.from, to: pair.to }));
        C.showNotice($notice, 'success', supportedCount + '件のルールを追加しました。内容を確認してから送信してください。');
        window.scrollTo(0, document.body.scrollHeight);
      });

      $card.append($pairList, $('<div>').css('margin-top', '8px').append(importBtn.$element));
      $botreqPanel.append($card);
    });
  }

  botreqBtn.on('click', async () => {
    botreqBtn.setDisabled(true);
    $botreqPanel.empty().append($('<p>').text('読み込み中…'));
    try {
      const data = await C.fetchJson('/api/botreq/proposals');
      renderBotreqProposals(data.proposals);
    } catch (e) {
      $botreqPanel.empty();
      C.showNotice($notice, 'error', 'BOTREQの取得に失敗しました: ' + e.message);
    } finally {
      botreqBtn.setDisabled(false);
    }
  });

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
    const replacements = rules.map((r) => r.getConfig()).filter(Boolean);

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
    $('<div>').css('margin-bottom', '12px').append(botreqBtn.$element),
    $botreqPanel,
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

/* NanonaBot Tool - タスク作成画面 */
(function () {
  'use strict';

  const C = window.NanonaCommon;
  const user = window.NANONA_BOT || {};

  const page = C.initPage({ title: '新規タスク作成', active: 'new' });
  if (!page.isOwner) {
    page.$main.append(C.buildEmergencyOnlyPanel(user));
    return;
  }

  // 入力エラーの一覧（送信前チェック・サーバー側の検証エラー）
  const $notice = $('<div>').addClass('nb-form-errors');
  page.$main.append($notice);

  // 入力途中でページを離れる前に確認する（タスクを作成したら解除）
  let dirty = false;
  let submitted = false;
  $(document).on('input change', '.nb-app', () => {
    dirty = true;
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty && !submitted) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // フェーズ4〜6: 8種類すべてのtemplateTypeが実際に機能する（仕様書6章・10章、フェーズ6でunlinkPage/templateSubstを追加）。
  // リンク置換・リンク置換2・リンク置換（節・表示名指定）は、画面では「リンク置換」の1種類にまとめる。
  // 保存するときは、カードの選択（表示を保持・節や表示名の指定）から従来の templateType を決める（既存のタスク・複製と互換）
  const LINK_RENAME_TYPES = ['linkRename', 'linkRename2', 'linkRenameExact'];
  const RULE_TYPES = [
    { data: 'custom', label: 'カスタム' },
    { data: 'linkRename', label: 'リンク置換' },
    { data: 'categoryRename', label: 'Category置換' },
    { data: 'categoryRemove', label: 'Category除去' },
    { data: 'templateRename', label: 'テンプレート置換' },
    { data: 'unlinkPage', label: 'リンク解除' },
    { data: 'templateSubst', label: 'テンプレートのsubst化' },
    { data: 'urlRename', label: '外部リンクの付け替え' },
  ];

  /** 「ページ名#節|表示名」形式で表示する（節・表示名は省略可）。 */
  function formatLinkSpec(title, anchor, label) {
    return title + (anchor ? '#' + anchor : '') + (label ? '|' + label : '');
  }

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

  // 複製・取り込みで、カードを作るときの名前空間の初期値（addRuleCard が最初の描画の間だけ設定する）
  let namespacePrefill;

  function buildNamespaceField(defaultSelected, help) {
    const initial = namespacePrefill !== undefined ? namespacePrefill || [] : defaultSelected || [];
    const widget = new OO.ui.CheckboxMultiselectInputWidget({ options: NAMESPACE_OPTIONS, value: initial });
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
  const ruleCountLabel = new OO.ui.LabelWidget({ label: '' });

  function addStepRow(rule, initial) {
    const id = ++stepSeq;
    const step0 = initial || {};
    const patternWidget = new OO.ui.TextInputWidget({ placeholder: '正規表現（例: プタリン・ジャヤ・スタジアム）', value: step0.pattern || '' });
    const flagsWidget = new OO.ui.TextInputWidget({ placeholder: 'flags', value: step0.flags || 'g' });
    const replacementWidget = new OO.ui.TextInputWidget({ placeholder: '置換後（例: ペタリン・ジャヤ・スタジアム）', value: step0.replacement || '' });
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
  function buildCustomTargetArea(rule, initial) {
    const ts = initial || {};
    const $area = $('<div>');
    const sourceTypeWidget = new OO.ui.DropdownInputWidget({ options: CUSTOM_TARGET_SOURCE_TYPES, value: ts.type || 'manualList' });
    const titlesWidget = new OO.ui.MultilineTextInputWidget({
      placeholder: '対象ページ名を1行に1つ（例: 利用者:Nanona15dobato/sandbox）',
      rows: 3,
      value: (ts.titles || []).join('\n'),
    });
    const categoryWidget = new OO.ui.TextInputWidget({ placeholder: '例: 日本の橋（Category:は省略可）', value: ts.category || '' });
    const pageWidget = new OO.ui.TextInputWidget({ placeholder: '例: プタリン・ジャヤ・スタジアム', value: ts.page || '' });
    const queryWidget = new OO.ui.TextInputWidget({ placeholder: '例: insource:/旧テンプレ/', value: ts.query || '' });
    if (initial) namespacePrefill = ts.namespaces === undefined ? undefined : ts.namespaces;
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
   * リンク置換のカード（リンク置換・リンク置換2・節・表示名指定を1つにまとめたもの）。
   * - 「表示を保持する」: [[旧]] を [[新|旧]] にする（linkRename2）
   * - 「節・表示名を指定する」: 指定した節・表示名のリンクだけを付け替える（linkRenameExact）
   * - どちらも無し: すべての [[旧…]] のリンク先を変える（linkRename）
   * BOTREQ の取り込み・複製では、元の templateType に合わせて選択を復元する。
   */
  function buildLinkRenameFields(rule, $body, fromWidget, toWidget, prefill) {
    const prefillType = prefill && prefill.templateType;
    const textField = (value, placeholder) => new OO.ui.TextInputWidget({ value: value || '', placeholder });
    // 改名元の節: 節なしのリンクだけ（既定）／節を問わない／指定した節だけ
    const anchorModeWidget = new OO.ui.DropdownInputWidget({
      options: [
        { data: 'none', label: '節なしのリンクだけ（[[旧]]・[[旧|…]]）' },
        { data: 'any', label: '節を問わない（[[旧#どの節でも|…]] も対象）' },
        { data: 'specific', label: '指定した節へのリンクだけ' },
      ],
      value: prefill && prefill.fromAnchor ? 'specific' : prefill && prefill.fromAnchorAny ? 'any' : 'none',
    });
    const fromAnchorWidget = textField(prefill && prefill.fromAnchor, '改名元の節');
    const toAnchorWidget = textField(prefill && prefill.toAnchor, '未入力=節なし（「節を問わない」のときは元の節のまま）');
    const fromLabelWidget = textField(prefill && prefill.fromLabel, '未入力=表示名を問わない（表示名は残す）');
    const toLabelWidget = textField(prefill && prefill.toLabel, '未入力=元の表示名のまま');
    const hasExactFields = Boolean(
      prefill && (prefill.fromAnchor || prefill.fromAnchorAny || prefill.toAnchor || prefill.fromLabel || prefill.toLabel)
    );

    const keepDisplayWidget = new OO.ui.CheckboxInputWidget({ selected: prefillType === 'linkRename2' });
    const exactWidget = new OO.ui.CheckboxInputWidget({ selected: prefillType === 'linkRenameExact' || hasExactFields });
    const searchWidget = new OO.ui.CheckboxInputWidget({ selected: Boolean(prefill && prefill.searchNarrowing) });
    const keepDisplayField = new OO.ui.FieldLayout(keepDisplayWidget, {
      label: '表示を保持する（[[旧]] を [[新|旧]] にして、見た目を変えない）',
      align: 'inline',
      help: '改名元に無い括弧（曖昧さ回避など）が改名先に付く場合に使います（従来の「リンク置換2」）。表示名付きのリンクは表示名をそのまま残します。',
      helpInline: true,
    });
    const fromAnchorField = new OO.ui.FieldLayout(fromAnchorWidget, { label: '改名元の節（名前）', align: 'top' });
    const syncAnchorMode = () => fromAnchorField.toggle(anchorModeWidget.getValue() === 'specific');
    anchorModeWidget.on('change', syncAnchorMode);
    syncAnchorMode();
    const $exactFields = $('<div>').addClass('nb-link-exact').append(
      new OO.ui.FieldLayout(anchorModeWidget, { label: '改名元の節', align: 'top' }).$element,
      fromAnchorField.$element,
      new OO.ui.FieldLayout(fromLabelWidget, { label: '改名元の表示名', align: 'top' }).$element,
      new OO.ui.FieldLayout(toAnchorWidget, { label: '改名先の節', align: 'top' }).$element,
      new OO.ui.FieldLayout(toLabelWidget, { label: '改名先の表示名', align: 'top' }).$element,
      $('<p>').addClass('nb-hint').text(
        '[[改名元#節|表示名]] の形のリンクだけを [[改名先#節|表示名]] に付け替えます（BOTREQの「改名元#節{{!}}ラベル」形式）。' +
          '「節を問わない」は表示名だけで絞りたいときに使います（改名先の節が空なら元の節を残します）。ハットノートのテンプレートは直しません。'
      )
    );
    const ns = buildNamespaceField([0], 'ウェーブ2（その他ページ）の対象名前空間。ウェーブ1はTemplate名前空間固定で自動的に処理されます。');

    function syncExact() {
      const exact = exactWidget.isSelected();
      $exactFields.toggle(exact);
      // 節・表示名を指定するときは、表示名は「改名先の表示名」で決めるため「表示を保持」は使わない
      keepDisplayWidget.setDisabled(exact);
    }
    exactWidget.on('change', syncExact);

    $body.append(
      keepDisplayField.$element,
      new OO.ui.FieldLayout(exactWidget, { label: '節・表示名を指定する', align: 'inline' }).$element,
      $exactFields,
      $('<p>').addClass('nb-hint').text(
        'このルールは2ウェーブ構成で処理されます: ウェーブ1でTemplate名前空間を先に編集→対象を再取得→ウェーブ2でその他ページを編集。'
      ),
      ns.$element,
      new OO.ui.FieldLayout(searchWidget, {
        label: '検索で絞り込む（リンク元が多いとき）',
        align: 'inline',
        help:
          'ウェーブ2の対象を、リンク元のうち本文に旧リンクの記述がある（全文検索 linksto: + insource: に一致する）ページだけにして、変更不要（スキップ）のページを減らします。' +
          '検索が時間切れ・1万件超・エラーのときや、標準名前空間以外のページ名・リンク元が50件未満のときは絞り込まず、リンク元のすべてを対象にします（実行ログに表示）。' +
          '検索の索引に未反映の最近の編集は拾えないことがあるため、取りこぼしが心配なときはオフのままにしてください。',
        helpInline: true,
      }).$element
    );
    syncExact();

    const orNull = (widget) => widget.getValue().trim() || null;
    rule.getConfig = () => {
      const base = { from: fromWidget.getValue(), to: toWidget.getValue(), namespaces: namespacesOrNull(ns.widget) };
      if (searchWidget.isSelected()) base.searchNarrowing = true;
      if (exactWidget.isSelected()) {
        const anchorMode = anchorModeWidget.getValue();
        if (anchorMode === 'any') base.fromAnchorAny = true;
        return Object.assign(base, {
          templateType: 'linkRenameExact',
          fromAnchor: anchorMode === 'specific' ? orNull(fromAnchorWidget) : null,
          toAnchor: orNull(toAnchorWidget),
          fromLabel: orNull(fromLabelWidget),
          toLabel: orNull(toLabelWidget),
        });
      }
      return Object.assign(base, { templateType: keepDisplayWidget.isSelected() ? 'linkRename2' : 'linkRename' });
    };
  }

  /**
   * @param {{templateType?:string, from?:string, to?:string}} [prefill] - BOTREQ取り込み時の初期値
   */
  function addRuleCard(prefill) {
    const id = ++ruleSeq;
    const prefillType = (prefill && prefill.templateType) || 'custom';
    const initialType = LINK_RENAME_TYPES.includes(prefillType) ? 'linkRename' : prefillType;
    const typeWidget = new OO.ui.DropdownInputWidget({ options: RULE_TYPES, value: initialType });
    const removeRuleBtn = new OO.ui.ButtonWidget({ icon: 'trash', flags: ['destructive'], framed: false, title: 'このルールを削除', label: '削除' });
    const moveUpBtn = new OO.ui.ButtonWidget({ icon: 'arrowUp', framed: false, invisibleLabel: true, label: '上へ移動', title: '上へ移動' });
    const moveDownBtn = new OO.ui.ButtonWidget({ icon: 'arrowDown', framed: false, invisibleLabel: true, label: '下へ移動', title: '下へ移動' });

    const $body = $('<div>');
    const $card = $('<div>').addClass('nb-rule-card');
    const $cardHeader = $('<div>').addClass('nb-rule-card__header');
    const $cardTitle = $('<strong>').addClass('nb-rule-card__title');
    $cardHeader.append(
      $cardTitle,
      $('<span>').addClass('nb-rule-card__tools').append(moveUpBtn.$element, moveDownBtn.$element, removeRuleBtn.$element)
    );

    const rule = { id, typeWidget, $card, $cardTitle, moveUpBtn, moveDownBtn, customSteps: [], $stepsContainer: null, getConfig: () => null };

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
        const targetArea = buildCustomTargetArea(rule, prefill && prefill.templateType === 'custom' ? prefill.targetSource : undefined);
        const addStepBtn = new OO.ui.ButtonWidget({ label: 'ステップを追加', icon: 'add', framed: false });
        addStepBtn.on('click', () => addStepRow(rule));

        $body.append(
          $('<div>').append($('<strong>').text('置換ステップ')),
          $stepsContainer,
          $('<div>').css('margin', '4px 0').append(addStepBtn.$element),
          targetArea.$element
        );
        const initialSteps = prefill && prefill.templateType === 'custom' && prefill.steps && prefill.steps.length ? prefill.steps : [undefined];
        initialSteps.forEach((step) => addStepRow(rule, step));

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

      if (type === 'linkRename') {
        buildLinkRenameFields(rule, $body, fromWidget, toWidget, prefill);
      } else if (type === 'urlRename') {
        fromWidget.$input.attr('placeholder', '例: http://old.example.org/path');
        toWidget.$input.attr('placeholder', '例: https://new.example.org/path');
        const ns = buildNamespaceField(
          [0],
          'ウェーブ2（その他ページ）の対象名前空間。ウェーブ1はTemplate名前空間固定で自動的に処理されます。'
        );
        $body.append(
          $('<p>').css({ color: '#54595d', fontSize: '0.9em' }).text(
            '改名元のURLで始まる外部リンク・URLを改名先に置き換えます（[URL 表示]・素のURL・テンプレート引数のいずれも対象）。' +
              '改名元が「/」で終わる場合はその配下のURLすべて、それ以外はそのURLと続きが / ? # のURLだけを対象にします。' +
              '対象ページはSpecial:LinkSearchと同じ外部リンク検索で取得し、リンク置換と同じく2ウェーブ構成で処理されます。'
          ),
          ns.$element
        );
        const bothSchemesWidget = new OO.ui.CheckboxInputWidget({
          selected: prefill && prefill.bothSchemes !== undefined ? Boolean(prefill.bothSchemes) : true,
        });
        $body.append(
          new OO.ui.FieldLayout(bothSchemesWidget, {
            label: 'http:// と https:// の両方の旧URLを付け替える',
            align: 'inline',
            help: '改名元が http://旧 でも、https://旧 で書かれたリンクも同じ旧URLとして付け替えます（サイトの移転ではどちらの書き方も残っていることが多いため既定でオン）。',
            helpInline: true,
          }).$element
        );
        rule.getConfig = () => ({
          templateType: 'urlRename',
          from: fromWidget.getValue().trim(),
          to: toWidget.getValue().trim(),
          namespaces: namespacesOrNull(ns.widget),
          bothSchemes: bothSchemesWidget.isSelected(),
        });
      } else if (type === 'categoryRename' || type === 'categoryRemove') {
        const ns = buildNamespaceField(null, '既定は全名前空間（原則すべてのカテゴリ呼び出し先が対象）。');
        $body.append(
          $('<p>').css({ color: '#54595d', fontSize: '0.9em' }).text(
            'このルールは3ウェーブ構成で処理されます: ' +
              'ウェーブ1でTemplate名前空間のカテゴリメンバーを先に編集し、編集したテンプレートの使用ページをnull edit → ' +
              'ウェーブ2でカテゴリメンバーを取り直して残りを編集 → ' +
              'ウェーブ3で標準名前空間のうちTemplate:リダイレクトの所属カテゴリでこのカテゴリ名を保持しているページを書き換えます。' +
              '構造的に確認できない緩い一致のみは、自動編集せず警告として表示します。'
          ),
          ns.$element
        );
        let fixLinksWidget = null;
        if (type === 'categoryRename') {
          fixLinksWidget = new OO.ui.CheckboxInputWidget({ selected: Boolean(prefill && prefill.fixCategoryLinks) });
          $body.append(
            new OO.ui.FieldLayout(fixLinksWidget, {
              label: '「Category:旧」の記述も置換する',
              align: 'inline',
              help:
                'ウェーブ3で、標準名前空間のうち「Category:旧」という記述があるページ（カテゴリのリンク元と本文検索で取得）を対象に加え、' +
                'リンクの形かどうかを問わず「Category:新」に置換します。「Category:旧橋梁」のように別カテゴリ名の一部になっている箇所は変更しません。',
              helpInline: true,
            }).$element
          );
        }
        rule.getConfig = () =>
          type === 'categoryRename'
            ? {
                templateType: 'categoryRename',
                from: fromWidget.getValue(),
                to: toWidget.getValue(),
                namespaces: namespacesOrNull(ns.widget),
                fixCategoryLinks: fixLinksWidget.isSelected(),
              }
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
              '一覧型のハットノート（{{See also}}・{{Main}}・{{混同}}）内の参照も取り除きます（他に引数が無ければテンプレートごと除去。名前付き引数を含む呼び出しは変更しません）。'
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
      renumberRules();
      C.toast('ルールを削除しました。', 'notice');
    });
    const moveRule = (delta) => {
      const idx = rules.findIndex((r) => r.id === id);
      const target = idx + delta;
      if (idx === -1 || target < 0 || target >= rules.length) return;
      rules.splice(target, 0, rules.splice(idx, 1)[0]);
      if (delta < 0) $card.insertBefore(rules[target + 1].$card);
      else $card.insertAfter(rules[target - 1].$card);
      renumberRules();
    };
    moveUpBtn.on('click', () => moveRule(-1));
    moveDownBtn.on('click', () => moveRule(1));

    $card.append($cardHeader, new OO.ui.FieldLayout(typeWidget, { label: '種別', align: 'top' }).$element, $body);

    // 最初の描画だけ、複製元・取り込み元の名前空間を初期値にする（種別を変えたら各種別の既定値）
    namespacePrefill = prefill && Object.prototype.hasOwnProperty.call(prefill, 'namespaces') ? prefill.namespaces : undefined;
    renderBody();
    namespacePrefill = undefined;
    rules.push(rule);
    $rulesContainer.append($card);
    renumberRules();
  }

  /** ルールの並び順に合わせて番号と上下移動ボタンの有効/無効を更新する（上から順に適用される）。 */
  function renumberRules() {
    rules.forEach((rule, i) => {
      rule.$cardTitle.text('ルール ' + (i + 1));
      rule.moveUpBtn.setDisabled(i === 0);
      rule.moveDownBtn.setDisabled(i === rules.length - 1);
    });
    ruleCountLabel.setLabel('ルール ' + rules.length + '件');
  }

  const addRuleBtn = new OO.ui.ButtonWidget({ label: 'ルールを追加', icon: 'add', flags: ['progressive'] });
  addRuleBtn.on('click', () => {
    addRuleCard();
    rules[rules.length - 1].$card[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ---- BOTREQ連携（仕様書7章）----
  const UNSUPPORTED_REASON_LABELS = {
    DELETE_PAGE: 'リンク解除指定（DELETE_PAGE）',
    REDIRECT_TARGET: 'リダイレクト解決指定（REDIRECT_TARGET）',
    REDIRECT_TARGET_NOT_REDIRECT: 'REDIRECT_TARGET指定だが改名元がリダイレクトではない（または存在しない）',
    subst: 'テンプレートのsubst化指定',
    URL: '片方だけが外部URLの指定',
    anchor_or_label: 'Category/Template・同一ページ内の節を含むアンカー/パイプラベル付き指定',
    namespace_mismatch: '改名元・改名先の名前空間が噛み合っていない',
  };
  const RULE_TYPE_LABEL_MAP = Object.assign(Object.fromEntries(RULE_TYPES.map((t) => [t.data, t.label])), {
    linkRename2: 'リンク置換（表示を保持）',
    linkRenameExact: 'リンク置換（節・表示名を指定）',
  });

  const botreqBtn = new OO.ui.ButtonWidget({ label: 'Bot作業依頼から取り込む', icon: 'download', title: 'Wikipedia:Bot作業依頼 の {{リンク修正依頼/改名}} を読み込みます' });
  const $botreqPanel = $('<div>');
  // Bot作業依頼の画面から来たとき（/tasks/new?botreq=h-…）は、その依頼の提案だけを取り込み、タスクを依頼に紐づける（フェーズ13）
  const botreqParam = new URLSearchParams(location.search).get('botreq');
  const botreqThreadId = botreqParam && botreqParam.startsWith('h-') ? botreqParam : null;
  let botreqLink = null; // { threadId, name }
  // 着手時に botreq.js（または Bot作業依頼の画面）が作業記録に書いた Bot の要約。紐づけている間は、アカウントを切り替えても要約欄に残す
  let botreqSummary = null;
  const $botreqLinkBox = $('<div>');
  const linkBtn = new OO.ui.ButtonWidget({ label: '依頼に紐づける', icon: 'link', title: 'Bot作業依頼の依頼を選んでタスクに紐づけ、要約欄に作業記録の要約を入れます' });
  linkBtn.on('click', () => openBotreqPicker());

  /**
   * タスクを依頼に紐づける（null で外す）。link.botSummary があれば要約欄に入れる。
   * link.botSummary が undefined（複製元のタスクの紐づけ等）のときは、要約欄には触れない。
   */
  /**
   * 依頼を選んでタスクに紐づける（{{リンク修正依頼/改名}} の無い依頼も選べる）。選ぶと、着手時の Bot の要約を要約欄に入れる。
   */
  async function openBotreqPicker() {
    linkBtn.setDisabled(true);
    $botreqLinkBox.empty().append(C.loading('Bot作業依頼の一覧を読み込み中…'));
    let requests;
    try {
      requests = (await C.fetchJson('/api/botreq/link-candidates')).requests || [];
    } catch (e) {
      C.toast('依頼の一覧を読み込めませんでした: ' + e.message, 'error');
      renderBotreqLinkBox(); // 元の表示に戻す
      linkBtn.setDisabled(false);
      return;
    }
    linkBtn.setDisabled(false);
    if (!requests.length) {
      $botreqLinkBox.empty().append(C.emptyState('紐づけられる依頼がありません。'));
      return;
    }
    const statusText = (r) =>
      r.status === 'resolved' ? '閉じられた依頼' : r.status === 'open' ? '未着手' : r.statusLabel || r.status;
    const dropdown = new OO.ui.DropdownInputWidget({
      options: requests.map((r) => ({
        data: r.threadId,
        label: r.name + '（' + statusText(r) + (r.botSummary ? '' : '・作業記録なし') + '）',
      })),
      value: botreqLink && requests.some((r) => r.threadId === botreqLink.threadId) ? botreqLink.threadId : requests[0].threadId,
    });
    const okBtn = new OO.ui.ButtonWidget({ label: '紐づける', flags: ['primary', 'progressive'] });
    const cancelBtn = new OO.ui.ButtonWidget({ label: 'キャンセル', framed: false });
    okBtn.on('click', () => {
      const picked = requests.find((r) => r.threadId === dropdown.getValue());
      setBotreqLink(picked);
      C.toast('依頼「' + picked.name + '」に紐づけました。');
    });
    cancelBtn.on('click', () => renderBotreqLinkBox());
    $botreqLinkBox.empty().append(
      new OO.ui.ActionFieldLayout(dropdown, okBtn, {
        label: '紐づける依頼',
        align: 'top',
        help: '作業記録（着手済み）のある依頼は、その要約（Bot:[[…#botreq-n-N|作業依頼]] - 依頼名）を要約欄に入れます。',
        helpInline: true,
      }).$element,
      cancelBtn.$element
    );
  }

  // 紐づけ時の要約の扱い（undefined: 触れていない／null: 作業記録が無く変えていない／文字列: 入れた要約）
  let botreqSummaryShown;

  function setBotreqLink(link) {
    botreqLink = link && link.threadId ? { threadId: link.threadId, name: link.name || '' } : null;
    botreqSummary = botreqLink && link.botSummary ? link.botSummary : null;
    botreqSummaryShown = botreqLink && link.botSummary !== undefined ? botreqSummary : undefined;
    if (botreqSummary) editSummaryWidget.setValue(botreqSummary);
    renderBotreqLinkBox();
  }

  /** 紐づけの表示（状態は変えない。依頼の選択をやめたときにも使う）。 */
  function renderBotreqLinkBox() {
    $botreqLinkBox.empty();
    if (!botreqLink) return;
    const unlinkBtn = new OO.ui.ButtonWidget({ label: '紐づけない', framed: false, flags: ['destructive'] });
    unlinkBtn.on('click', () => setBotreqLink(null));
    const message = new OO.ui.MessageWidget({
      type: 'notice',
      inline: true,
      label: $('<span>').append(
        '依頼「',
        $('<a>').attr({ href: '/botreq', target: '_blank' }).text(botreqLink.name || botreqLink.threadId),
        '」のタスクとして作成します（Bot作業依頼の画面に表示され、完了時の編集の内訳の確認に使います）。 '
      ),
    });
    const changeBtn = new OO.ui.ButtonWidget({ label: '別の依頼に変更', framed: false });
    changeBtn.on('click', openBotreqPicker);
    message.$label.append(changeBtn.$element, unlinkBtn.$element);
    $botreqLinkBox.append(message.$element);
    if (botreqSummaryShown !== undefined) {
      $botreqLinkBox.append(
        new OO.ui.MessageWidget({
          type: botreqSummaryShown ? 'success' : 'warning',
          inline: true,
          label: botreqSummaryShown
            ? $('<span>').append('要約欄に、作業記録の要約を入れました: ', $('<code>').text(botreqSummaryShown))
            : $('<span>').append(
                'この依頼はまだ着手の記録が無いため、要約欄は変えていません（',
                $('<a>').attr({ href: '/botreq', target: '_blank' }).text('Bot作業依頼の画面'),
                'または botreq.js で着手すると、要約が作られます）。'
              ),
        }).$element
      );
    }
  }


  function renderBotreqProposals(proposals, topicProgress) {
    $botreqPanel.empty();
    if (topicProgress && topicProgress.length > 0) {
      const $progressPanel = $('<div>').addClass('nb-botreq-progress');
      $progressPanel.append($('<strong>').text('topic listの依頼進捗'));
      const $progressList = $('<div>').addClass('nb-botreq-progress__list');
      topicProgress.forEach((entry) => {
        $progressList.append(
          $('<div>').addClass('nb-botreq-progress__row').append(
            $('<span>').text(entry.title),
            $('<span>').addClass('nb-botreq-progress__status').text(entry.progress)
          )
        );
      });
      $progressPanel.append($progressList);
      $botreqPanel.append($progressPanel);
    }
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
      if (p.request) {
        $card.append(
          $('<div>').addClass('nb-botreq-proposal-request').text(
            '依頼: ' + p.request.name + (p.request.botSummary ? '（要約欄: ' + p.request.botSummary + '）' : '（未着手のため要約なし）')
          )
        );
      }
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
          const fromText = formatLinkSpec(pair.from, pair.fromAnchor, pair.fromLabel);
          const toText = formatLinkSpec(pair.to, pair.toAnchor, pair.toLabel);
          if (pair.redirectResolved) {
            // 解決先は取得時点のもの。取り込むとこの値がルールの改名先に固定される
            $row.text('[' + RULE_TYPE_LABEL_MAP[pair.type] + '（リダイレクト解決）] ' + fromText + ' → ' + toText);
            $row.append($('<span>').css({ color: '#54595d', marginLeft: '6px' }).text('※取得時点の解決先'));
          } else {
            $row.text('[' + RULE_TYPE_LABEL_MAP[pair.type] + '] ' + fromText + ' → ' + toText);
          }
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
          .forEach((pair) =>
            addRuleCard({
              templateType: pair.type,
              from: pair.from,
              to: pair.to,
              fromAnchor: pair.fromAnchor,
              toAnchor: pair.toAnchor,
              fromLabel: pair.fromLabel,
              toLabel: pair.toLabel,
            })
          );
        // 提案が書かれた依頼にタスクを紐づけ、着手時に作った Bot の要約を要約欄に入れる
        if (p.request && (!botreqLink || botreqLink.threadId !== p.request.threadId || p.request.botSummary)) setBotreqLink(p.request);
        C.toast(supportedCount + '件のルールを追加しました。内容を確認してから送信してください。');
        rules[rules.length - 1].$card[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      $card.append($pairList, $('<div>').css('margin-top', '8px').append(importBtn.$element));
      $botreqPanel.append($card);
    });
  }

  botreqBtn.on('click', async () => {
    botreqBtn.setDisabled(true);
    $botreqPanel.empty().append(C.loading('Wikipedia:Bot作業依頼を読み込み中…'));
    try {
      const data = await C.fetchJson('/api/botreq/proposals' + (botreqThreadId ? '?threadId=' + encodeURIComponent(botreqThreadId) : ''));
      if (data.request) setBotreqLink(data.request);
      renderBotreqProposals(data.proposals, data.topicProgress);
    } catch (e) {
      $botreqPanel.empty();
      C.toast('BOTREQの取得に失敗しました: ' + e.message, 'error');
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
  const linkUpdateMethodWidget = new OO.ui.DropdownInputWidget({
    options: [
      { data: 'nullEdit', label: 'null edit（1件ずつ・既定）' },
      { data: 'purge', label: 'purge＋forcelinkupdate（50件ずつ一括）' },
    ],
    value: 'nullEdit',
  });

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
  const saveDefaultsBtn = new OO.ui.ButtonWidget({ label: 'このアカウントのデフォルトとして保存' });
  let accountDefaults = {};

  function applyAccountDefaults(account) {
    const defaults = accountDefaults[account];
    if (!defaults) return;
    const edit = defaults.editSettings || {};
    const review = defaults.reviewSettings || {};
    botFlagWidget.setSelected(edit.botFlag !== false);
    minorEditWidget.setSelected(edit.minorEdit !== false);
    editSummaryWidget.setValue(botreqSummary || edit.editSummary || '');
    editIntervalWidget.setValue(Number(edit.editIntervalSeconds) || 10);
    linkUpdateMethodWidget.setValue(edit.linkUpdateMethod || 'nullEdit');
    modeWidget.setValue(review.mode || 'auto');
    autoWaitWidget.setValue(Number(review.autoWaitSeconds) || 0);
    manualTimeoutWidget.setValue(Number(review.manualTimeoutHours) || 72);
    renderModeFields();
  }

  accountWidget.on('change', (account) => applyAccountDefaults(account));
  saveDefaultsBtn.on('click', async () => {
    saveDefaultsBtn.setDisabled(true);
    try {
      const config = buildConfig();
      await C.putJson('/api/bot-accounts/' + encodeURIComponent(config.account) + '/defaults', {
        editSettings: config.editSettings,
        reviewSettings: config.reviewSettings,
      });
      accountDefaults[config.account] = { editSettings: config.editSettings, reviewSettings: config.reviewSettings };
      C.toast('アカウント ' + config.account + ' のデフォルト設定を保存しました。');
    } catch (e) {
      C.toast('デフォルト設定の保存に失敗しました: ' + e.message, 'error');
    } finally {
      saveDefaultsBtn.setDisabled(false);
    }
  });
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
  const submitBtn = new OO.ui.ButtonWidget({ label: 'タスクを作成してキューに投入', icon: 'check', flags: ['primary', 'progressive'] });

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
        linkUpdateMethod: linkUpdateMethodWidget.getValue(),
      },
      reviewSettings,
      onFailure: onFailureWidget.getValue(),
      botreq: botreqLink || undefined,
    };
  }

  /** 送信前の入力チェック（サーバー側でも同じ内容を検証する）。問題のあるルールのカードに印を付ける。 */
  const TYPES_REQUIRING_TO = ['linkRename', 'linkRename2', 'linkRenameExact', 'categoryRename', 'templateRename', 'urlRename'];
  function validate(config) {
    const errors = [];
    rules.forEach((rule) => rule.$card.removeClass('nb-rule-card--error'));
    if (config.replacements.length === 0) errors.push('置換ルールを1件以上追加してください。');
    config.replacements.forEach((r, i) => {
      const label = 'ルール ' + (i + 1) + '（' + (C.RULE_TYPE_LABELS[r.templateType] || r.templateType) + '）';
      const before = errors.length;
      if (r.templateType === 'custom') {
        if (!r.steps.length) errors.push(label + ': 置換ステップを1件以上入力してください。');
        r.steps.forEach((step, si) => {
          if (!step.pattern) errors.push(label + ': ステップ' + (si + 1) + 'の正規表現が空です。');
          else {
            try {
              // eslint-disable-next-line no-new
              new RegExp(step.pattern, step.flags);
            } catch (e) {
              errors.push(label + ': ステップ' + (si + 1) + 'の正規表現が不正です（' + e.message + '）。');
            }
          }
        });
        const ts = r.targetSource;
        const sourceValue = ts.type === 'manualList' ? ts.titles.length : ts.category || ts.page || ts.query;
        if (!sourceValue || (typeof sourceValue === 'string' && !sourceValue.trim())) errors.push(label + ': 対象ページの指定が空です。');
      } else {
        if (!String(r.from || '').trim()) errors.push(label + ': 改名元（対象）を入力してください。');
        if (TYPES_REQUIRING_TO.includes(r.templateType) && !String(r.to || '').trim()) errors.push(label + ': 改名先を入力してください。');
        if (r.templateType === 'urlRename') {
          [r.from, r.to].forEach((url, k) => {
            if (url && !/^https?:\/\/[^\s/?#]+/i.test(url)) errors.push(label + ': ' + (k === 0 ? '改名元' : '改名先') + 'は http:// または https:// で始まるURLにしてください。');
          });
        }
      }
      if (errors.length > before && rules[i]) rules[i].$card.addClass('nb-rule-card--error');
    });
    if (!config.editSettings.editSummary.trim()) errors.push('要約欄を入力してください。');
    if (!(config.editSettings.editIntervalSeconds >= 5)) errors.push('編集間隔は5秒以上にしてください。');
    return errors;
  }

  function showErrors(errors) {
    $notice.empty();
    if (errors.length === 0) return;
    const $list = $('<ul>').append(errors.map((e) => $('<li>').text(e)));
    $notice.append(
      new OO.ui.MessageWidget({ type: 'error', label: $('<div>').append($('<strong>').text('入力内容を確認してください'), $list) }).$element
    );
    $notice[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function describeForConfirm(config) {
    const $list = $('<ul>').addClass('nb-confirm-list');
    config.replacements.forEach((r, i) => {
      const type = C.RULE_TYPE_LABELS[r.templateType] || r.templateType;
      const detail =
        r.templateType === 'custom'
          ? r.steps.length + 'ステップ'
          : formatLinkSpec(r.from, r.fromAnchorAny ? '（どの節でも）' : r.fromAnchor, r.fromLabel) + (r.to ? ' → ' + formatLinkSpec(r.to, r.toAnchor, r.toLabel) : '');
      $list.append($('<li>').text('ルール' + (i + 1) + ': [' + type + '] ' + detail));
    });
    const review = config.reviewSettings;
    return $('<div>').append(
      $('<p>').text(
        'アカウント ' + config.account + ' で、次の内容のタスクをキューに投入します。' +
          (review.mode === 'auto' ? '自動更新（' + review.autoWaitSeconds + '秒後に承認）' : '手動確認（タイムアウト ' + review.manualTimeoutHours + '時間）') +
          '・編集間隔 ' + config.editSettings.editIntervalSeconds + '秒。'
      ),
      $list
    );
  }

  submitBtn.on('click', async () => {
    const config = buildConfig();
    const errors = validate(config);
    showErrors(errors);
    if (errors.length > 0) return;
    const ok = await C.confirm(describeForConfirm(config), { title: 'タスクを作成しますか？', okLabel: '作成してキューに投入' });
    if (!ok) return;
    submitBtn.setDisabled(true);
    try {
      const result = await C.postJson('/api/tasks', config);
      submitted = true;
      C.toast('タスク #' + result.id + ' を作成しました。');
      location.href = '/tasks/' + result.id;
    } catch (e) {
      showErrors(e.data && e.data.errors ? e.data.errors : ['タスクの作成に失敗しました: ' + e.message]);
      submitBtn.setDisabled(false);
    }
  });

  // ---- 組み立て ----
  const accountSection = C.section({ title: 'Botアカウント', hint: '編集に使用するBotアカウントを選択してください。選ぶと、そのアカウントのデフォルト設定が読み込まれます。' });
  accountSection.$body.append(new OO.ui.FieldLayout(accountWidget, { label: 'アカウント', align: 'top' }).$element);

  const rulesSection = C.section({
    title: '置換ルール',
    hint: '上から順にルールを適用します。同じページに複数ルールが該当する場合はまとめて準備します。',
    actions: [linkBtn, botreqBtn],
  });
  rulesSection.$body.append($botreqLinkBox, $botreqPanel, $rulesContainer, $('<div>').addClass('nb-form-actions').append(addRuleBtn.$element));

  const editSection = C.section({ title: '編集設定', hint: 'Botフラグと編集間隔は、実際の編集処理にも適用されます。', actions: [saveDefaultsBtn] });
  editSection.$body.append(
    new OO.ui.FieldLayout(botFlagWidget, { label: 'Botフラグを付与', align: 'inline' }).$element,
    new OO.ui.FieldLayout(minorEditWidget, { label: '細部の編集にする', align: 'inline' }).$element,
    new OO.ui.FieldLayout(editSummaryWidget, { label: '要約欄', align: 'top' }).$element,
    new OO.ui.FieldLayout(editIntervalWidget, { label: '編集間隔（秒・5以上）', align: 'top' }).$element,
    new OO.ui.FieldLayout(linkUpdateMethodWidget, {
      label: 'テンプレート使用ページの更新方法（Category系ルールのウェーブ1後）',
      align: 'top',
      help:
        'ウェーブ1で編集したテンプレートの使用ページのカテゴリ所属を更新する方法です。' +
        '使用ページが多いテンプレートではpurge（50件ずつ一括）の方が速く終わります。',
      helpInline: true,
    }).$element
  );

  const reviewSection = C.section({
    title: '実行モード',
    hint: '自動更新は指定秒数後に承認、確認待機は画面から承認・却下します。実行中にも切り替えできます。',
  });
  reviewSection.$body.append(new OO.ui.FieldLayout(modeWidget, { label: 'モード', align: 'top' }).$element, $autoWaitField, $manualTimeoutField);

  const failureSection = C.section({ title: '失敗時の挙動', hint: '一時停止すると原因確認後に再開できます。' });
  failureSection.$body.append(new OO.ui.FieldLayout(onFailureWidget, { label: '失敗ページが出た場合', align: 'top' }).$element);

  // 画面下部に固定する送信バー
  const $submitBar = $('<div>').addClass('nb-submit-bar').append(
    $('<div>').addClass('nb-submit-bar__inner').append(ruleCountLabel.$element, submitBtn.$element)
  );

  page.$main.append(
    accountSection.$element,
    rulesSection.$element,
    editSection.$element,
    reviewSection.$element,
    failureSection.$element,
    $submitBar
  );

  renderModeFields();

  // ===== Bot作業依頼の画面から来たとき（フェーズ13）: /tasks/new?botreq=h-… で、その依頼の取り込みを開く =====
  if (botreqParam) botreqBtn.emit('click');

  // ===== タスクの複製（フェーズ12）: /tasks/new?from=タスクID =====
  const duplicateFrom = Number(new URLSearchParams(location.search).get('from')) || null;

  /** 複製元のタスクの設定をフォームに入れる（アカウントの既定値を読み込んだあとに呼ぶ）。 */
  function applyDuplicate(task) {
    const config = task.config_json || {};
    const edit = config.editSettings || {};
    const review = config.reviewSettings || {};
    if (config.account) accountWidget.setValue(config.account);
    botFlagWidget.setSelected(edit.botFlag !== false);
    minorEditWidget.setSelected(edit.minorEdit !== false);
    editSummaryWidget.setValue(edit.editSummary || '');
    editIntervalWidget.setValue(Number(edit.editIntervalSeconds) || 10);
    linkUpdateMethodWidget.setValue(edit.linkUpdateMethod || 'nullEdit');
    modeWidget.setValue(review.mode || 'auto');
    if (review.autoWaitSeconds !== undefined) autoWaitWidget.setValue(Number(review.autoWaitSeconds));
    if (review.manualTimeoutHours !== undefined) manualTimeoutWidget.setValue(Number(review.manualTimeoutHours));
    onFailureWidget.setValue(config.onFailure || 'pause');
    if (config.botreq) setBotreqLink(config.botreq);
    renderModeFields();
    (config.replacements || [])
      .filter((r) => r.templateType !== 'revertEdits')
      .forEach((r) => {
        const copy = Object.assign({}, r);
        delete copy.forceTargets; // 失敗ページの再試行タスクを複製したときは、元のルールの対象取得に戻す
        addRuleCard(copy);
      });
    if (rules.length === 0) addRuleCard();
    dirty = false;
    C.toast('タスク #' + task.id + ' の設定を読み込みました。内容を確認してから作成してください。');
  }

  if (!duplicateFrom) addRuleCard();
  const defaultsLoaded = C.fetchJson('/api/bot-accounts/defaults')
    .then((defaults) => {
      accountDefaults = Object.fromEntries(defaults.map((item) => [item.account, item]));
      applyAccountDefaults(accountWidget.getValue());
    })
    .catch((e) => C.toast('アカウントデフォルト設定の取得に失敗しました: ' + e.message, 'error'));
  if (duplicateFrom) {
    Promise.all([C.fetchJson('/api/tasks/' + duplicateFrom), defaultsLoaded])
      .then(([task]) => {
        // アカウントを切り替えると既定値が読み込まれるため、先にアカウントだけ切り替えてから他の値を入れる
        if (task.config_json && task.config_json.account) {
          accountWidget.setValue(task.config_json.account);
          applyAccountDefaults(task.config_json.account);
        }
        applyDuplicate(task);
      })
      .catch((e) => {
        C.toast('複製元のタスクを読み込めませんでした: ' + e.message, 'error');
        if (rules.length === 0) addRuleCard();
      });
  }
})();

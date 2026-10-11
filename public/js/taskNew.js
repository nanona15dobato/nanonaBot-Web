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
  const RULE_TYPES = [
    { data: 'custom', label: 'カスタム' },
    { data: 'linkRename', label: 'リンク置換' },
    { data: 'linkRename2', label: 'リンク置換2（表示保持）' },
    { data: 'linkRenameExact', label: 'リンク置換（節・表示名指定）' },
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
  const ruleCountLabel = new OO.ui.LabelWidget({ label: '' });

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
        const targetArea = buildCustomTargetArea(rule);
        const addStepBtn = new OO.ui.ButtonWidget({ label: 'ステップを追加', icon: 'add', framed: false });
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

      if (type === 'linkRenameExact') {
        const textField = (value, placeholder) => new OO.ui.TextInputWidget({ value: value || '', placeholder });
        const fromAnchorWidget = textField(prefill && prefill.fromAnchor, '未入力=節なしのリンクだけが対象');
        const toAnchorWidget = textField(prefill && prefill.toAnchor, '未入力=節なし');
        const fromLabelWidget = textField(prefill && prefill.fromLabel, '未入力=表示名を問わない（表示名は残す）');
        const toLabelWidget = textField(prefill && prefill.toLabel, '未入力=元の表示名のまま');
        const ns = buildNamespaceField(
          [0],
          'ウェーブ2（その他ページ）の対象名前空間。ウェーブ1はTemplate名前空間固定で自動的に処理されます。'
        );
        $body.append(
          new OO.ui.FieldLayout(fromAnchorWidget, { label: '改名元の節', align: 'top' }).$element,
          new OO.ui.FieldLayout(fromLabelWidget, { label: '改名元の表示名', align: 'top' }).$element,
          new OO.ui.FieldLayout(toAnchorWidget, { label: '改名先の節', align: 'top' }).$element,
          new OO.ui.FieldLayout(toLabelWidget, { label: '改名先の表示名', align: 'top' }).$element,
          $('<p>').css({ color: '#54595d', fontSize: '0.9em' }).text(
            '[[改名元#節|表示名]] の形のリンクだけを [[改名先#節|表示名]] に付け替えます（BOTREQの「改名元#節{{!}}ラベル」形式）。' +
              'リンク置換と同じく2ウェーブ構成で処理されます。'
          ),
          ns.$element
        );
        const orNull = (widget) => widget.getValue().trim() || null;
        rule.getConfig = () => ({
          templateType: 'linkRenameExact',
          from: fromWidget.getValue(),
          to: toWidget.getValue(),
          fromAnchor: orNull(fromAnchorWidget),
          toAnchor: orNull(toAnchorWidget),
          fromLabel: orNull(fromLabelWidget),
          toLabel: orNull(toLabelWidget),
          namespaces: namespacesOrNull(ns.widget),
        });
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
        rule.getConfig = () => ({
          templateType: 'urlRename',
          from: fromWidget.getValue().trim(),
          to: toWidget.getValue().trim(),
          namespaces: namespacesOrNull(ns.widget),
        });
      } else if (type === 'linkRename' || type === 'linkRename2') {
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
          fixLinksWidget = new OO.ui.CheckboxInputWidget({ selected: false });
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

    renderBody();
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
  const RULE_TYPE_LABEL_MAP = Object.fromEntries(RULE_TYPES.map((t) => [t.data, t.label]));

  const botreqBtn = new OO.ui.ButtonWidget({ label: 'Bot作業依頼から取り込む', icon: 'download', title: 'Wikipedia:Bot作業依頼 の {{リンク修正依頼/改名}} を読み込みます' });
  const $botreqPanel = $('<div>');

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
      const data = await C.fetchJson('/api/botreq/proposals');
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
    editSummaryWidget.setValue(edit.editSummary || '');
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
          : formatLinkSpec(r.from, r.fromAnchor, r.fromLabel) + (r.to ? ' → ' + formatLinkSpec(r.to, r.toAnchor, r.toLabel) : '');
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
    actions: [botreqBtn],
  });
  rulesSection.$body.append($botreqPanel, $rulesContainer, $('<div>').addClass('nb-form-actions').append(addRuleBtn.$element));

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
  addRuleCard();
  C.fetchJson('/api/bot-accounts/defaults')
    .then((defaults) => {
      accountDefaults = Object.fromEntries(defaults.map((item) => [item.account, item]));
      applyAccountDefaults(accountWidget.getValue());
    })
    .catch((e) => C.toast('アカウントデフォルト設定の取得に失敗しました: ' + e.message, 'error'));
})();

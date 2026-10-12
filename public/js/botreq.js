/* NanonaBot Tool - Bot作業依頼の着手・完了・解決（フェーズ13）
 * 利用者スクリプト（userscripts/botreq.js）と同じ操作を、ツールの画面から行う。
 * 保存する内容はサーバーが作り（/api/botreq/prepare）、ここで確認・修正してから保存する。 */
(function () {
  'use strict';

  const C = window.NanonaCommon;
  const user = window.NANONA_BOT || {};
  const REQUEST_PAGE = 'Wikipedia:Bot作業依頼';

  const ACTION_LABELS = { start: '着手', complete: '完了', resolve: '解決' };
  const STATUS_LABELS = { open: '未着手', started: '着手', completed: '完了', resolved: '閉じられた依頼', other: 'その他' };
  const LOG_LABELS = { none: 'なし', started: '着手済み', finished: '完了済み' };

  const reloadBtn = new OO.ui.ButtonWidget({ label: '読み込み直す', icon: 'reload' });
  const accountBtn = new OO.ui.ButtonWidget({ label: '保存に使うアカウントを確認', icon: 'userAvatar', framed: false });
  const page = C.initPage({
    title: 'Bot作業依頼',
    active: 'botreq',
    subtitle: $('<span>').append('依頼への着手・完了・解決を記録します（', C.wikiLink(REQUEST_PAGE), '）'),
    actions: [accountBtn, reloadBtn],
  });
  if (!page.isOwner) {
    page.$main.append(C.buildEmergencyOnlyPanel(user));
    return;
  }

  const filterWidget = new OO.ui.ButtonSelectWidget({
    items: [
      new OO.ui.ButtonOptionWidget({ data: 'active', label: '未解決', title: '{{解決済み}}・{{済み}}・{{失効}} の無い依頼' }),
      new OO.ui.ButtonOptionWidget({ data: 'all', label: 'すべて' }),
    ],
  });
  filterWidget.selectItemByData('active');
  const listSection = C.section({
    title: '依頼',
    hint:
      '状態は依頼の節の {{解決済み}} と最後の {{BOTREQ|…}} から読み取ります。作業記録（利用者:nanonaBot/依頼/YYYY年）の編集と依頼への返信は、' +
      '運用者のアカウントで行います。どの操作も、保存する前にプレビュー・差分で確認できます。',
    actions: [filterWidget],
  });
  const $list = $('<div>');
  listSection.$body.append($list);
  page.$main.append(listSection.$element);

  let requests = [];

  /** 次に行う操作（作業記録の状態も見る）。 */
  function nextAction(r) {
    if (r.status === 'resolved') return null;
    if (r.status === 'completed' || r.logState === 'finished') return 'resolve';
    if (r.status === 'started' || r.logState === 'started') return 'complete';
    return 'start';
  }

  function statusBadge(r) {
    // 閉じたテンプレート名（解決済み・済み・失効）や「作業中」などはそのまま出す。完了（完了・済…）は「完了」にそろえる
    const label = (r.status !== 'completed' && r.statusLabel) || STATUS_LABELS[r.status];
    return $('<span>').addClass('nb-status-badge nb-status-badge--botreq-' + r.status).text(label);
  }

  function requestLink(r) {
    return $('<a>')
      .addClass('nb-wiki-link')
      .attr({ href: C.wikiUrl('特別:GoToComment/' + r.threadId), target: '_blank', rel: 'noopener' })
      .text(r.name);
  }

  function render() {
    const filter = filterWidget.findSelectedItem().getData();
    const shown = requests.filter((r) => filter === 'all' || r.status !== 'resolved').slice().reverse(); // 新しい依頼を上に
    $list.empty();
    if (!shown.length) {
      $list.append(C.emptyState(filter === 'all' ? '依頼はありません。' : '未解決の依頼はありません。'));
      return;
    }
    const $tbody = $('<tbody>');
    shown.forEach((r) => $tbody.append(renderRow(r)));
    $list.append(
      $('<div>').addClass('nb-table-wrap').append(
        $('<table>').addClass('nb-table nb-botreq-table').append(
          $('<thead>').append(
            $('<tr>').append(['依頼', '状態', '依頼者', '依頼日時', '作業記録', 'タスク', '操作'].map((h) => $('<th>').text(h)))
          ),
          $tbody
        )
      )
    );
  }

  /** この依頼に紐づけたタスク（新しい順に最大3件）。 */
  function taskLinks(tasks) {
    if (!tasks || !tasks.length) return $('<span>').addClass('nb-botreq-none').text('—');
    const $box = $('<div>').addClass('nb-botreq-tasks');
    tasks.slice(0, 3).forEach((t) => {
      $box.append(
        $('<a>').addClass('nb-botreq-task').attr('href', '/tasks/' + t.id).append($('<span>').text('#' + t.id + ' '), C.taskStatusBadge(t.status))
      );
    });
    if (tasks.length > 3) $box.append($('<span>').addClass('nb-botreq-none').text('ほか' + (tasks.length - 3) + '件'));
    return $box;
  }

  function renderRow(r) {
    const next = nextAction(r);
    const $actions = $('<div>').addClass('nb-botreq-actions');
    if (next) {
      const mainBtn = new OO.ui.ButtonWidget({ label: ACTION_LABELS[next], flags: ['progressive'] });
      mainBtn.on('click', () => runAction(next, r, mainBtn));
      $actions.append(mainBtn.$element);
    }
    const menu = new OO.ui.ButtonMenuSelectWidget({
      icon: 'ellipsis',
      label: 'その他の操作',
      invisibleLabel: true,
      title: 'その他の操作',
      framed: false,
      $overlay: true,
      menu: {
        horizontalPosition: 'end',
        items: Object.keys(ACTION_LABELS)
          .filter((kind) => kind !== next)
          .map((kind) => new OO.ui.MenuOptionWidget({ data: kind, label: ACTION_LABELS[kind] }))
          .concat([new OO.ui.MenuOptionWidget({ data: 'task', label: 'この依頼からタスクを作成', icon: 'add' })]),
      },
    });
    menu.getMenu().on('choose', (item) => {
      if (item.getData() === 'task') window.location.href = '/tasks/new?botreq=' + encodeURIComponent(r.threadId);
      else runAction(item.getData(), r, menu);
    });
    $actions.append(menu.$element);

    const $log = $('<span>').addClass('nb-chip' + (r.logState === 'none' ? '' : r.logState === 'finished' ? ' nb-chip--edited' : ' nb-chip--notice'));
    if (r.logState === 'none' || !r.logTitle) $log.text(LOG_LABELS.none);
    else $log.append($('<a>').attr({ href: C.wikiUrl(r.logTitle), target: '_blank', rel: 'noopener' }).text(LOG_LABELS[r.logState]));

    return $('<tr>').append(
      $('<td>').append(requestLink(r), r.level > 2 ? $('<span>').addClass('nb-botreq-sub').text('（小見出し）') : null),
      $('<td>').append(statusBadge(r)),
      $('<td>').append(r.requester ? C.wikiLink('利用者:' + r.requester).text(r.requesterName || r.requester) : '—'),
      $('<td>').addClass('nb-table__nowrap').append(r.requestedAt ? C.timeElement(r.requestedAt) : '—'),
      $('<td>').append($log),
      $('<td>').append(taskLinks(r.tasks)),
      $('<td>').append($actions)
    );
  }

  async function load() {
    reloadBtn.setDisabled(true);
    if (!requests.length) $list.empty().append(C.loading('Wikipedia:Bot作業依頼を読み込み中…'));
    try {
      const data = await C.fetchJson('/api/botreq/requests');
      requests = data.requests || [];
      render();
    } catch (e) {
      $list.empty().append(new OO.ui.MessageWidget({ type: 'error', label: '読み込めませんでした: ' + e.message }).$element);
    } finally {
      reloadBtn.setDisabled(false);
    }
  }

  reloadBtn.on('click', load);

  /** 保存に使うアカウントの確認（用途ごとに、ログインした名前・このセッションの権限・ページごとに編集が許されるか）。 */
  accountBtn.on('click', () =>
    C.withBusy(accountBtn, 'アカウントの確認', async () => {
      const { accounts } = await C.fetchJson('/api/botreq/account-check');
      const yes = (ok, labels) => $('<strong>').css('color', ok ? 'var(--nb-color-success)' : 'var(--nb-color-error)').text(ok ? labels[0] : labels[1]);
      const $body = $('<div>').addClass('nb-botreq-account');
      accounts.forEach((r) => {
        $body.append(
          $('<h3>').text(r.role + ': ' + r.account),
          $('<table>').addClass('nb-table').append(
            $('<tbody>').append(
              $('<tr>').append($('<th>').text('BotPassword のログイン名'), $('<td>').text(r.loginName || '（未設定）')),
              $('<tr>').append($('<th>').text('ログインした利用者'), $('<td>').text(r.userName || '（ログインしていない）')),
              $('<tr>').append($('<th>').text('このセッションの edit・createpage'), $('<td>').append(yes(r.rights.edit, ['あり', 'なし']), '・', yes(r.rights.createpage, ['あり', 'なし']))),
              r.pages.map((p) =>
                $('<tr>').append(
                  $('<th>').text(p.title + (p.action === 'create' ? '（作成）' : '（編集）')),
                  $('<td>').append(yes(p.allowed, ['可', '不可']), p.allowed ? '' : ' ' + p.reasons.join(' / '))
                )
              )
            )
          )
        );
      });
      $body.append(
        $('<p>').addClass('nb-section__hint').text(
          '作業記録（利用者:nanonaBot/…）は、その利用者空間の持ち主のアカウントで編集します。jawiki では他人の利用者ページの編集に editalluserpages の権限が要り、' +
            'この権限は BotPassword では付けられないためです（BOTREQ_LOG_ACCOUNT で変更できます）。依頼ページの編集と返信は運用者のアカウント（BOTREQ_ACCOUNT）で行います。'
        )
      );
      await OO.ui.alert($body, { title: '保存に使うアカウントの確認', size: 'large' });
    })
  );

  filterWidget.on('choose', render);

  // ---------- 操作 ----------

  let busy = false;

  async function runAction(kind, r, button) {
    if (busy) return;
    busy = true;
    button.setDisabled(true);
    const label = ACTION_LABELS[kind];
    C.toast(label + 'の準備をしています…（' + r.name + '）', 'notice');
    try {
      const plan = await C.postJson('/api/botreq/prepare', { kind, threadId: r.threadId });
      const saved = await openDialog(label + ': ' + r.name, plan);
      if (saved) await load();
    } catch (e) {
      C.toast(label + 'できませんでした: ' + e.message, 'error');
    } finally {
      busy = false;
      button.setDisabled(false);
    }
  }

  function composeText(plan, text) {
    return plan.before + text.trim() + plan.after;
  }

  function copyToClipboard(text, quiet) {
    return navigator.clipboard.writeText(text).then(
      () => {
        if (!quiet) C.toast('コピーしました。');
      },
      () => {
        if (!quiet) C.toast('クリップボードへのコピーに失敗しました。', 'error');
      }
    );
  }

  /** ウィキの描画結果のリンク・画像を、ウィキ側を指すようにする。 */
  function absolutizeWikiHtml(html) {
    const host = 'https://' + (user.wikiHost || 'ja.wikipedia.org');
    const $html = $('<div>').append($.parseHTML(html));
    $html.find('a[href^="/"]').each(function () {
      const href = this.getAttribute('href');
      if (!href.startsWith('//')) this.setAttribute('href', host + href);
      this.setAttribute('target', '_blank');
      this.setAttribute('rel', 'noopener');
    });
    $html.find('a[href^="#"]').removeAttr('href');
    return $html.contents();
  }

  function diffTable(body) {
    if (!body) return $('<p>').text('差分はありません。');
    return $('<table>').addClass('diff').append(
      $('<colgroup>').append(
        $('<col>').addClass('diff-marker'),
        $('<col>').addClass('diff-content'),
        $('<col>').addClass('diff-marker'),
        $('<col>').addClass('diff-content')
      ),
      $('<tbody>').html(body)
    );
  }

  function BotreqDialog(config) {
    BotreqDialog.super.call(this, config);
  }
  OO.inheritClass(BotreqDialog, OO.ui.ProcessDialog);
  BotreqDialog.static.name = 'botreqDialog';
  BotreqDialog.static.size = 'larger';
  BotreqDialog.static.actions = [
    { action: 'save', label: '保存', flags: ['primary', 'progressive'] },
    { label: 'キャンセル', flags: ['safe', 'close'] },
  ];

  BotreqDialog.prototype.initialize = function () {
    BotreqDialog.super.prototype.initialize.apply(this, arguments);
    this.content = new OO.ui.PanelLayout({ padded: true, expanded: false });
    this.$body.append(this.content.$element);
    this.$element.addClass('nb-botreq-dialog');
  };

  BotreqDialog.prototype.getSetupProcess = function (data) {
    return BotreqDialog.super.prototype.getSetupProcess.call(this, data).next(function () {
      this.plan = data.plan;
      this.saved = false;
      this.build();
    }, this);
  };

  BotreqDialog.prototype.getReadyProcess = function (data) {
    return BotreqDialog.super.prototype.getReadyProcess.call(this, data).next(function () {
      this.summaryInput.focus();
    }, this);
  };

  BotreqDialog.prototype.build = function () {
    const plan = this.plan;
    const $c = this.content.$element.empty();
    (plan.notes || []).forEach((note) => {
      $c.append(new OO.ui.MessageWidget({ type: note.type, label: note.text, inline: true, classes: ['nb-botreq-note'] }).$element);
    });
    if (plan.workSummary) {
      $c.append(
        new OO.ui.MessageWidget({
          type: 'notice',
          inline: true,
          classes: ['nb-botreq-note'],
          label: `着手してからの ${plan.workSummary.count} 編集（${C.formatDateTime(plan.workSummary.oldest)} 〜 ${C.formatDateTime(plan.workSummary.newest)}）を記録します。`,
        }).$element
      );
      if (plan.workSummary.breakdown && plan.workSummary.breakdown.length) {
        const $breakdown = $('<div>').addClass('nb-botreq-breakdown').append($('<span>').text('内訳: '));
        plan.workSummary.breakdown.forEach((b, i) => {
          if (i > 0) $breakdown.append('、');
          if (b.taskId === null) $breakdown.append($('<span>').text('ツール以外の編集 ' + b.count + '件'));
          else $breakdown.append($('<a>').attr({ href: '/tasks/' + b.taskId, target: '_blank' }).text('タスク #' + b.taskId), ' ' + b.count + '件');
        });
        $c.append($breakdown);
      }
    }

    this.textInput = new OO.ui.MultilineTextInputWidget({ value: plan.text, rows: 14, classes: ['nb-botreq-wikitext'] });
    this.summaryInput = new OO.ui.TextInputWidget({ value: plan.summary });
    this.dirty = { preview: true, diff: true };
    this.textInput.on('change', () => {
      this.dirty = { preview: true, diff: true };
    });

    const fields = [
      new OO.ui.FieldLayout(new OO.ui.LabelWidget({ label: C.wikiLink(plan.title) }), {
        label: '編集するページ',
        align: 'left',
      }),
    ];
    if (plan.saveAccount) {
      fields.push(
        new OO.ui.FieldLayout(new OO.ui.LabelWidget({ label: plan.saveAccount + (plan.commentAccount && plan.commentAccount !== plan.saveAccount ? '（返信は ' + plan.commentAccount + '）' : '') }), {
          label: '保存するアカウント',
          align: 'left',
        })
      );
    }
    if (plan.links && plan.links.length) {
      const dropdown = new OO.ui.DropdownInputWidget({
        options: plan.links
          .map((l, i) => ({ data: String(i), label: l.label }))
          .concat([{ data: '', label: '（なし・ウィキテキストで入力）' }]),
        value: '0',
        $overlay: this.$overlay,
      });
      dropdown.on('change', (value) => {
        this.replaceLine(/^\* 議論場所 - .*$/m, '* 議論場所 - ' + (value === '' ? '' : plan.links[Number(value)].wikitext));
      });
      fields.push(
        new OO.ui.FieldLayout(dropdown, {
          label: '議論場所',
          align: 'top',
          help: '依頼の節にあるリンクから選びます。ウィキテキストで直接書き換えることもできます。',
          helpInline: true,
        })
      );
    }
    fields.push(new OO.ui.FieldLayout(this.summaryInput, { label: '要約', align: 'top' }));
    $c.append(new OO.ui.FieldsetLayout({ items: fields }).$element);

    this.previewPanel = new OO.ui.TabPanelLayout('preview', { label: 'プレビュー', expanded: false });
    this.diffPanel = new OO.ui.TabPanelLayout('diff', { label: '差分', expanded: false });
    const textPanel = new OO.ui.TabPanelLayout('text', { label: 'ウィキテキスト', expanded: false });
    this.$preview = $('<div>').addClass('nb-botreq-render').appendTo(this.previewPanel.$element);
    this.$diff = $('<div>').addClass('nb-botreq-render nb-diff').appendTo(this.diffPanel.$element);
    textPanel.$element.append(this.textInput.$element);
    this.tabs = new OO.ui.IndexLayout({ expanded: false, autoFocus: false, classes: ['nb-botreq-tabs'] });
    this.tabs.addTabPanels([this.previewPanel, this.diffPanel, textPanel]);
    this.tabs.on('set', (panel) => this.refresh(panel.getName()));
    $c.append(this.tabs.$element);

    const extra = [];
    this.commentInput = null;
    this.postCheckbox = null;
    if (plan.copy) {
      extra.push(this.copyField(new OO.ui.TextInputWidget({ value: plan.copy.value, readOnly: true }), plan.copy.label, '保存するときにも自動でコピーします。'));
    }
    if (plan.comment) {
      this.commentInput = new OO.ui.MultilineTextInputWidget({ value: plan.comment.text, rows: 3, autosize: true });
      this.postCheckbox = new OO.ui.CheckboxInputWidget({ selected: false });
      extra.push(this.copyField(this.commentInput, '依頼の節へのコメント', plan.comment.help));
      extra.push(
        new OO.ui.FieldLayout(this.postCheckbox, {
          label: '保存と同時に、依頼のコメントへの返信として投稿する',
          align: 'inline',
          help: '投稿しない場合は、保存するときにコメントをコピーします。',
          helpInline: true,
        })
      );
    }
    if (extra.length) $c.append(new OO.ui.FieldsetLayout({ items: extra, classes: ['nb-botreq-extra'] }).$element);

    this.refresh('preview');
  };

  BotreqDialog.prototype.copyField = function (input, label, help) {
    const button = new OO.ui.ButtonWidget({ label: 'コピー', icon: 'copy' });
    button.on('click', () => copyToClipboard(input.getValue()));
    return new OO.ui.ActionFieldLayout(input, button, { label, align: 'top', help, helpInline: true });
  };

  BotreqDialog.prototype.replaceLine = function (re, line) {
    const value = this.textInput.getValue();
    this.textInput.setValue(re.test(value) ? value.replace(re, () => line) : value + '\n' + line);
    this.refresh(this.tabs.getCurrentTabPanelName());
  };

  BotreqDialog.prototype.refresh = function (name) {
    if (!this.dirty[name]) return;
    this.dirty[name] = false;
    const plan = this.plan;
    const text = this.textInput.getValue();
    const $box = name === 'preview' ? this.$preview : this.$diff;
    const token = (this.token = (this.token || 0) + 1);
    $box.empty().append(C.loading(name === 'preview' ? 'プレビューを作成中…' : '差分を作成中…'));
    this.updateSize();
    const request =
      name === 'preview'
        ? C.postJson('/api/botreq/render', { title: plan.title, text }).then((d) => absolutizeWikiHtml(d.html))
        : C.postJson('/api/botreq/diff', { title: plan.title, oldText: plan.oldText, newText: composeText(plan, text) }).then((d) =>
            diffTable(d.html)
          );
    request
      .then(
        ($html) => {
          if (token === this.token) $box.empty().append($html);
        },
        (err) => {
          if (token === this.token) {
            $box.empty().append(new OO.ui.MessageWidget({ type: 'error', inline: true, label: '表示できませんでした: ' + err.message }).$element);
          }
          this.dirty[name] = true;
        }
      )
      .then(() => this.updateSize());
  };

  BotreqDialog.prototype.getBodyHeight = function () {
    return this.content.$element.outerHeight(true);
  };

  BotreqDialog.prototype.getActionProcess = function (action) {
    if (action !== 'save') return BotreqDialog.super.prototype.getActionProcess.call(this, action);
    const plan = this.plan;
    const text = this.textInput.getValue();
    const summary = this.summaryInput.getValue();
    const post = Boolean(this.postCheckbox && this.postCheckbox.isSelected());
    const commentText = this.commentInput ? this.commentInput.getValue().trim() : '';
    // クリックの直後でないとコピーできないため、保存の前にコピーする
    const copyText = plan.copy ? plan.copy.value : !post ? commentText : '';
    if (copyText) copyToClipboard(copyText, true);
    return new OO.ui.Process(() => {
      const d = $.Deferred();
      this.save(text, summary, post && commentText ? { text: commentText, commentId: plan.comment.commentId } : null).then(d.resolve, d.reject);
      return d.promise();
    });
  };

  BotreqDialog.prototype.save = async function (text, summary, comment) {
    const plan = this.plan;
    let result;
    try {
      result = await C.postJson('/api/botreq/save', {
        title: plan.title,
        text: plan.section ? text : composeText(plan, text),
        section: plan.section || undefined,
        summary,
        baseTimestamp: plan.baseTimestamp,
        startTimestamp: plan.startTimestamp,
        createOnly: plan.createOnly,
        comment: comment || undefined,
      });
    } catch (err) {
      throw new OO.ui.Error(err.message, { recoverable: err.status !== 409 });
    }
    this.saved = true;
    this.close({ action: 'save' });
    C.toast(result.nochange ? '「' + plan.title + '」に変更はありませんでした。' : '「' + plan.title + '」を保存しました。');
    if (result.comment && !result.comment.ok) {
      C.toast('コメントの投稿に失敗しました: ' + result.comment.error + '（手動で投稿してください）', 'error');
      copyToClipboard(comment.text, true);
    } else if (result.comment) {
      C.toast('依頼の節にコメントを投稿しました。');
    }
  };

  function openDialog(title, plan) {
    const manager = new OO.ui.WindowManager();
    $(document.body).append(manager.$element);
    const dialog = new BotreqDialog();
    manager.addWindows([dialog]);
    const instance = manager.openWindow(dialog, { title, plan });
    return instance.closed.then(() => {
      const saved = dialog.saved;
      manager.destroy();
      return saved;
    });
  }

  load();
})();

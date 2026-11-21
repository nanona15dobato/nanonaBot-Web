/* Standalone documentation planner. Models phases; does not execute a task or call any API. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.WorkflowComposer = api; api.mount(JSON.parse(document.getElementById('workflow-data').textContent)); }
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  function buildPlan(reference, selected, options) {
    const map = new Map(reference.map(rule => [rule.id, rule]));
    const rules = [...new Set(selected)].map(id => map.get(id)).filter(Boolean);
    if (!rules.length) return [];
    const manual = rule => rule.id === 'custom' && options.source === 'manualList';
    const category = rule => ['categoryRename', 'categoryRemove'].includes(rule.id);
    const templates = rules.filter(rule => rule.priority || options.scope !== 'main' || manual(rule));
    const main = rules.filter(rule => options.scope !== 'template' || category(rule) || manual(rule));
    const plan = [{ id: 'template', kind: 'edit', label: 'ウェーブ1：Template優先のまとめ編集', rules: templates }];
    if (options.refresh && templates.length) plan.push({ id: 'refresh', kind: 'refresh', label: '編集したTemplateの呼び出し先を更新', rules: templates });
    plan.push({ id: 'main', kind: 'edit', label: 'ウェーブ2：通常ページのまとめ編集', rules: main });
    const residual = rules.filter(rule => !manual(rule));
    if (options.residual && residual.length) plan.push({ id: 'residual', kind: 'purge', label: '残る参照候補を再取得してpurge', rules: residual });
    return plan;
  }
  function mount(data) {
    const form = document.getElementById('combine-form');
    if (!form) return;
    const reference = data.ruleReference;
    const choices = document.getElementById('combine-choices'), order = document.getElementById('combine-order');
    const result = document.getElementById('combine-result'), stage = document.getElementById('combine-current');
    let selected = ['linkRename', 'templateRename'], plan = [], position = 0, timer = null;
    const byId = new Map(reference.map(rule => [rule.id, rule]));
    function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
    function button(text, action) { const n = el('button', text); n.type = 'button'; n.addEventListener('click', action); return n; }
    function value(id) { return document.getElementById(id).value; }
    function checked(id) { return document.getElementById(id).checked; }
    function stop() { clearInterval(timer); timer = null; const b = document.getElementById('combine-play'); b.textContent = '順番に再生'; b.setAttribute('aria-pressed', 'false'); }
    function options() { return { scope: value('combine-scope'), source: value('combine-source'), refresh: checked('combine-refresh'), residual: checked('combine-residual') }; }
    function move(id, direction) {
      const index = selected.indexOf(id), next = index + direction;
      if (next < 0 || next >= selected.length) return;
      [selected[index], selected[next]] = [selected[next], selected[index]];
      render();
      order.querySelector(`[data-rule="${id}"] button:not(:disabled)`)?.focus({ preventScroll: true });
    }
    reference.forEach(rule => {
      const label = el('label', undefined, 'combine-choice'), input = document.createElement('input');
      input.type = 'checkbox'; input.value = rule.id; input.checked = selected.includes(rule.id);
      input.addEventListener('change', () => { selected = input.checked ? [...selected, rule.id] : selected.filter(id => id !== rule.id); render(); });
      label.append(input, el('span', rule.label)); choices.append(label);
    });
    function renderOrder() {
      order.replaceChildren();
      selected.forEach((id, index) => {
        const row = el('li'); row.dataset.rule = id;
        const up = button('↑', () => move(id, -1)), down = button('↓', () => move(id, 1));
        up.setAttribute('aria-label', byId.get(id).label + 'を上へ'); down.setAttribute('aria-label', byId.get(id).label + 'を下へ');
        up.disabled = index === 0; down.disabled = index === selected.length - 1;
        row.append(el('span', `${index + 1}. ${byId.get(id).label}`), up, down); order.append(row);
      });
    }
    function describe(item) {
      if (item.id === 'refresh') return `${value('combine-method') === 'purge' ? 'purge＋forcelinkupdate（50件ずつ）' : 'null edit（1件ずつ）'}で、実際に編集されたTemplateを呼び出すページのリンク表・カテゴリ所属の再計算を促します。候補になっただけ・変更なしのTemplateは起点にしません。本文の置換は行いません。`;
      if (item.id === 'residual') return '本編集後、旧リンク元・旧カテゴリメンバー・旧テンプレート使用ページなどを再取得して重複を除き、purgeします。手入力のカスタム対象は再取得しません。';
      if (!item.rules.length) return 'この選択では取得対象を作るルールはありません。0件でも次のウェーブへ進みます。';
      const scope = item.id === 'template' ? 'Template名前空間の候補' : '選択した通常名前空間の候補（Templateを除く）';
      return scope + 'をルールごとに抽出し、ページ名で集約します。' + (item.id === 'main' ? '呼び出し先更新が終わってから取り直します。Category系は標準名前空間の特殊な所属カテゴリ参照も合流させます。' : 'リンク系・外部リンク・Category系は通常名前空間の選択にかかわらずTemplateを優先します。');
    }
    function showPosition() {
      const current = plan[position]; stage.replaceChildren();
      if (!current) stage.append(el('p', '見たい種別を1つ以上選んでください。'));
      else {
        stage.append(el('p', `${position + 1} / ${plan.length} · ${current.label}`, 'eyebrow'), el('p', describe(current)));
        if (current.kind === 'edit' && current.rules.length) stage.append(el('p', value('combine-review') === 'manual' ? '各ページの差分を確認 → 承認 → まとめて1回保存。確認中は次のページを先読みします。' : '各ページを準備 → 自動承認の待機 → まとめて1回保存。編集間隔の間は次のページを先読みします。'));
      }
      [...result.children].forEach((card, index) => { card.classList.toggle('plan-current', index === position); if (index === position) card.setAttribute('aria-current', 'step'); else card.removeAttribute('aria-current'); });
      document.getElementById('combine-prev').disabled = !plan.length || position === 0;
      document.getElementById('combine-next').disabled = !plan.length || position === plan.length - 1;
      document.getElementById('combine-play').disabled = !plan.length;
    }
    function render() {
      stop(); position = 0; renderOrder(); plan = buildPlan(reference, selected, options()); result.replaceChildren();
      document.getElementById('combine-source-field').hidden = !selected.includes('custom');
      document.getElementById('combine-method').disabled = !checked('combine-refresh');
      document.getElementById('combine-summary').textContent = selected.length ? `${selected.length}種別・共通2ウェーブ／更新を含む${plan.length}区間` : '種別を1つ以上選択してください';
      plan.forEach((item, index) => {
        const card = el('li', undefined, 'plan-card'); card.dataset.phase = item.id;
        card.append(el('h3', `${index + 1}. ${item.label}`), el('p', describe(item)));
        const list = el('ul');
        item.rules.forEach(rule => {
          const line = el('li'), a = el('a', rule.label); a.href = '#syntax-' + rule.id;
          line.append(a, el('span', ' — ' + (rule.id === 'custom' ? value('combine-source') : rule.resolver))); list.append(line);
        });
        card.append(list);
        if (item.kind === 'edit' && item.rules.length) {
          const overlap = checked('combine-overlap');
          card.append(el('p', overlap ? `例：同じページに上の${item.rules.length}種別が該当 → 差分を1つにまとめ、保存は1回。` : `例：種別ごとに別の1ページだけが該当 → ${item.rules.length}ページをそれぞれ1回保存。`, 'merge-example'));
          card.append(el('p', '実際は、そのページを候補として取得したルールだけを設定順に適用します。本文に変更がなければ保存をスキップします。', 'sim-note'));
        }
        result.append(card);
      });
      showPosition();
    }
    form.addEventListener('submit', event => event.preventDefault());
    form.addEventListener('change', event => { if (!choices.contains(event.target)) render(); });
    document.getElementById('combine-prev').addEventListener('click', () => { stop(); position = Math.max(0, position - 1); showPosition(); });
    document.getElementById('combine-next').addEventListener('click', () => { stop(); position = Math.min(plan.length - 1, position + 1); showPosition(); });
    document.getElementById('combine-reset').addEventListener('click', () => { stop(); position = 0; showPosition(); });
    document.getElementById('combine-play').addEventListener('click', () => {
      if (timer !== null) { stop(); return; }
      if (position === plan.length - 1) position = 0;
      showPosition(); const b = document.getElementById('combine-play'); b.textContent = '再生を止める'; b.setAttribute('aria-pressed', 'true');
      timer = setInterval(() => { position = Math.min(plan.length - 1, position + 1); showPosition(); if (position === plan.length - 1) stop(); }, 2800);
    });
    window.addEventListener('workflow:view', event => { if (event.detail !== 'composer') stop(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    window.addEventListener('beforeprint', stop); window.addEventListener('pagehide', stop);
    render();
  }
  return { buildPlan, mount };
});

/* Compact namespace selector shared by task forms and target search. */
(function () {
  'use strict';
  const C = window.NanonaCommon;
  const common = [{ id:0,name:'標準' },{ id:14,name:'カテゴリ' },{ id:10,name:'テンプレート' }];
  const fallback = [...common, ...[[1,'ノート'],[2,'利用者'],[3,'利用者‐会話'],[4,'Wikipedia'],[12,'Help'],[100,'Portal']].map(([id,name]) => ({ id,name }))];
  let metadata;
  C.getWikiNamespaces = function () {
    if (!metadata) metadata = C.fetchJson('/api/wiki/namespaces').then(rows => {
      if (!Array.isArray(rows) || !rows.length) throw new Error('名前空間一覧を取得できませんでした。');
      return rows;
    }).catch(error => { metadata = null; throw error; });
    return metadata;
  };
  function NamespaceSelector(config) {
    config = config || {}; NamespaceSelector.super.call(this, config);
    this.rows = fallback; this.setting = false;
    this.quick = new OO.ui.CheckboxMultiselectInputWidget({ options:common.map(n => ({ data:String(n.id),label:`${n.name} (${n.id})` })) });
    this.extra = new OO.ui.MenuTagMultiselectWidget({ options:[], allowArbitrary:false, allowReordering:false, input:{ placeholder:'その他の名前空間を検索' }, $overlay:config.$overlay === undefined ? true : config.$overlay });
    this.extra.input.$input.attr('aria-label',config.lookupLabel || 'その他の名前空間を検索');
    this.$hint = $('<div>').addClass('nb-namespace-hint').attr('role','status');
    this.$element.addClass('nb-namespace-select').append(this.quick.$element.addClass('nb-namespace-common'),this.extra.$element,this.$hint);
    const changed = () => { if (!this.setting) this.emit('change',this.getValue()); };
    this.quick.on('change',changed);this.extra.on('change',changed);
    this.setValue(config.value || []);
    this.ready = C.getWikiNamespaces().then(rows => { const values=this.getValue();this.rows=rows;this.setValue(values);return rows; }).catch(() => {
      this.$hint.text('名前空間一覧を取得できません。既知の項目を表示しています。');return this.rows;
    });
  }
  OO.inheritClass(NamespaceSelector,OO.ui.Widget);
  NamespaceSelector.prototype.getValue = function () { return [...new Set([...this.quick.getValue(),...this.extra.getValue()].map(Number))]; };
  NamespaceSelector.prototype.setValue = function (values) {
    values = [...new Set(values.map(Number))];this.setting=true;
    const rows = new Map(this.rows.map(n=>[n.id,n]));
    values.forEach(id => { if(!rows.has(id)) rows.set(id,{id,name:'名前空間'}); });
    const options = [...rows.values()].filter(n=>![0,10,14].includes(n.id)).sort((a,b)=>a.id-b.id).map(n=>({data:String(n.id),label:[n.name,n.canonical,...(n.aliases||[])].filter((v,i,a)=>v&&a.indexOf(v)===i).join(' / ')+` (${n.id})`}));
    this.extra.clearItems();this.extra.menu.clearItems();this.extra.addOptions(options);
    this.quick.setValue(values.filter(n=>[0,10,14].includes(n)).map(String));
    this.extra.setValue(values.filter(n=>![0,10,14].includes(n)).map(String));this.setting=false;return this;
  };
  NamespaceSelector.prototype.focus = function () { this.extra.input.focus();return this; };
  C.createNamespaceSelector = config => new NamespaceSelector(config);
})();

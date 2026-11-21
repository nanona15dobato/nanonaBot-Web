/* Search, select and stage target changes. The server applies one revision atomically. */
(function () {
  'use strict';
  const C = window.NanonaCommon;
  const LIMIT = 1000;
  function PageLookup(config) {
    PageLookup.super.call(this, config);this.profile=config.profile;
    OO.ui.mixin.LookupElement.call(this, config);
  }
  OO.inheritClass(PageLookup,OO.ui.TextInputWidget);OO.mixinClass(PageLookup,OO.ui.mixin.LookupElement);
  PageLookup.prototype.getLookupRequest = function () {
    const deferred=$.Deferred(),controller=new AbortController(),text=this.getValue(),profile=this.profile();
    const timer=setTimeout(()=>C.fetchJson('/api/wiki/page-search',{method:'POST',body:JSON.stringify({query:text,namespaces:profile}),signal:controller.signal}).then(data=>deferred.resolve(data),error=>deferred.reject(error)),250);
    const promise=deferred.promise();promise.abort=()=>{clearTimeout(timer);controller.abort();deferred.reject();};return promise;
  };
  PageLookup.prototype.getLookupCacheDataFromResponse = data => data.results || [];
  PageLookup.prototype.getLookupMenuOptionsFromData = rows => rows.map(row=>new OO.ui.MenuOptionWidget({data:row.title,label:row.title}));
  let manager;
  function TargetsDialog(config) {
    TargetsDialog.super.call(this,config);this.task=config.task;this.pages=config.pages;this.overrides=config.overrides;
    this.staged=new Map((config.excludeTitles||[]).map(title=>[title,'exclude']));this.closedSearch=false;this.searchEpoch=0;this.saved=false;
  }
  OO.inheritClass(TargetsDialog,OO.ui.ProcessDialog);
  TargetsDialog.static.name='nbTaskTargets';TargetsDialog.static.title='対象ページの追加・除外';TargetsDialog.static.size='larger';
  TargetsDialog.static.actions=[{action:'close',label:'キャンセル',flags:['safe','close']},{action:'apply',label:'対象の変更を保存',flags:['primary','progressive']}];
  TargetsDialog.prototype.initialize=function () {
    TargetsDialog.super.prototype.initialize.apply(this,arguments);
    const content=new OO.ui.PanelLayout({padded:true,expanded:false});this.content=content;this.$body.append(content.$element);
    this.$element.addClass('nb-target-dialog');this.$review=$('<div>').attr('role','status');this.$staged=$('<div>');
    const tabs=new OO.ui.ButtonSelectWidget({items:[['search','検索して追加'],['current','現在の対象を選択'],['manual','リスト入力']].map(([data,label])=>new OO.ui.ButtonOptionWidget({data,label}))});
    const panels={search:$('<div>'),current:$('<div>'),manual:$('<div>')};
    tabs.on('select',item=>{if(item){Object.entries(panels).forEach(([id,panel])=>panel.toggle(id===item.getData()));this.updateSize();}});
    this.buildSearch(panels.search);this.buildCurrent(panels.current);this.buildManual(panels.manual);
    content.$element.append($('<p>').text('未処理分を変更します。追加ページには全置換ルールを適用します。編集済みの結果は維持します。1回1000ページまで。'),tabs.$element,...Object.values(panels),this.$staged,this.$review);
    tabs.selectItemByData(this.staged.size?'current':'search');this.renderStaged();
    content.$element.on('input change',()=>this.invalidate());
  };
  TargetsDialog.prototype.invalidate=function () {
    this.confirmed=null;this.$review.empty();this.actions.get({actions:'apply'}).forEach(action=>action.setLabel('対象の変更を保存'));
  };
  TargetsDialog.prototype.stage=function (action,titles) {
    if(new Set([...this.staged.keys(),...titles]).size>LIMIT){C.toast('1回に変更できるのは1000ページまでです。範囲を絞ってください。','warning');return;}
    titles.forEach(title=>this.staged.set(title,action));this.invalidate();this.renderStaged();
  };
  TargetsDialog.prototype.renderStaged=function () {
    this.$staged.empty().append($('<h3>').text('変更予定（'+this.staged.size+'ページ）'));
    const list=$('<ul>').addClass('nb-target-staged');const names={add:'追加',exclude:'除外',restore:'除外解除'};
    this.staged.forEach((action,title)=>{
      const remove=new OO.ui.ButtonWidget({label:title+'の変更を取り消す',icon:'close',invisibleLabel:true,framed:false});
      remove.on('click',()=>{this.staged.delete(title);this.invalidate();this.renderStaged();});
      list.append($('<li>').append($('<span>').text(names[action]+': '+title),remove.$element));
    });this.$staged.append(list);this.updateSize();
  };
  TargetsDialog.prototype.buildSearch=function ($panel) {
    const method=new OO.ui.DropdownInputWidget({options:[['backlinks','リンク元（backlinks）'],['embeddedin','テンプレート使用ページ（embeddedin）'],['category','カテゴリメンバー'],['prefix','ページ名で検索'],['search','本文・検索式で検索']].map(([data,label])=>({data,label}))});
    const ns=C.createNamespaceSelector({value:[],lookupLabel:'追加検索のその他の名前空間', $overlay:this.$element});
    const source=new PageLookup({placeholder:'ページ名や検索語を入力',profile:()=>method.getValue()==='embeddedin'?[10]:method.getValue()==='category'?[14]:null,$overlay:this.$element});this.source=source;
    ns.$element.attr('data-namespace-role','candidate-filter');
    const search=new OO.ui.ButtonWidget({label:'対象候補を検索',icon:'search',flags:['progressive']});
    const more=new OO.ui.ButtonWidget({label:'検索結果をさらに取得'}),$results=$('<div>'),$status=$('<p>').attr('role','status');
    let rows=[],next=null,busy=false;
    const render=()=>{this.renderSelection($results,rows,'add');more.toggle(Boolean(next)&&rows.length<LIMIT);};
    const reset=clearLookup=>{this.searchEpoch++;rows=[];next=null;render();$status.text('');if(clearLookup){source.requestCache={};source.closeLookupMenu();}};
    method.on('change',()=>reset(true));ns.on('change',()=>reset(true));source.on('change',()=>reset(false));
    const run=async append=>{
      if(busy)return;busy=true;const epoch=++this.searchEpoch;search.setDisabled(true);more.setDisabled(true);$status.text('検索中…');
      try{
        const result=await C.postJson('/api/tasks/'+this.task.id+'/target-search',{method:method.getValue(),query:source.getValue(),namespaces:ns.getValue().length?ns.getValue():null,...(append?{continue:next}:{})});
        if(this.closedSearch||epoch!==this.searchEpoch)return;
        rows=[...new Map([...(append?rows:[]),...result.results].map(p=>[p.title,p])).values()].slice(0,LIMIT);next=result.continue;
        $status.text(rows.length+'件を取得'+(next?'（続きあり）':'')+(rows.length>=LIMIT?'。上限1000件です。範囲を絞ってください。':''));render();this.updateSize();
      }catch(error){if(!this.closedSearch&&epoch===this.searchEpoch)$status.text('検索できませんでした: '+error.message);}
      finally{busy=false;search.setDisabled(false);more.setDisabled(false);}
    };
    search.on('click',()=>run(false));more.on('click',()=>run(true));source.$input.on('keydown',event=>{if(event.key==='Enter'&&!source.lookupMenu.isVisible()){event.preventDefault();run(false);}});
    $panel.append(new OO.ui.FieldLayout(method,{label:'対象の検索方法',align:'top'}).$element,new OO.ui.FieldLayout(source,{label:'検索元のページ・検索語',align:'top'}).$element,new OO.ui.FieldLayout(ns,{label:'候補の名前空間（未選択=すべて）',align:'top'}).$element,search.$element,$status,$results,more.$element);
    more.toggle(false);render();
  };
  TargetsDialog.prototype.renderSelection=function ($container,rows,action) {
    $container.empty();const selected=$container.data('selection')||new Set();$container.data('selection',selected);
    const available=new Set(rows.filter(row=>!row.alreadyEdited&&row.status!=='edited').map(row=>row.title));
    for(const title of selected)if(!available.has(title))selected.delete(title);
    const $list=$('<div>').addClass('nb-target-results'),$count=$('<span>').attr('role','status');
    const all=new OO.ui.ButtonWidget({label:'表示対象を全選択'}),none=new OO.ui.ButtonWidget({label:'選択解除'}),apply=new OO.ui.ButtonWidget({label:action==='add'?'選択したページを追加予定へ':action==='restore'?'選択したページの除外を解除予定へ':'選択したページを除外予定へ'});
    const items=[];const update=()=>{$count.text(selected.size+'件選択');apply.setDisabled(!selected.size);};
    const eligible=rows.filter(row=>!row.alreadyEdited&&row.status!=='edited');
    all.on('click',()=>{if(eligible.length>LIMIT){C.toast('1000件以内になるよう絞り込んでください。','warning');return;}eligible.forEach(row=>selected.add(row.title));items.forEach(([row,box])=>{if(!box.isDisabled())box.setSelected(true);});update();});
    none.on('click',()=>{items.forEach(([,box])=>box.setSelected(false));selected.clear();update();});
    apply.on('click',()=>this.stage(action,[...selected]));
    let rendered=0;
    const more=new OO.ui.ButtonWidget({label:'一覧をさらに表示'});
    const draw=()=>{const end=Math.min(rows.length,rendered+200);
    rows.slice(rendered,end).forEach(row=>{
      const box=new OO.ui.CheckboxInputWidget({selected:selected.has(row.title),disabled:Boolean(row.alreadyEdited||row.status==='edited')});
      const label=row.title+(row.alreadyEdited||row.status==='edited'?'（編集済み）':'');
      box.on('change',on=>{if(on)selected.add(row.title);else selected.delete(row.title);update();});
      const field=new OO.ui.FieldLayout(box,{label,align:'inline'});field.$element.attr('data-title',row.title);$list.append(field.$element);items.push([row,box]);
    });rendered=end;more.toggle(rendered<rows.length);};
    more.on('click',()=>{draw();this.updateSize();});draw();
    $container.append($('<div>').addClass('nb-target-tools').append(all.$element,none.$element,apply.$element,$count),$list,more.$element);update();
  };
  TargetsDialog.prototype.buildCurrent=function ($panel) {
    const text=new OO.ui.TextInputWidget({placeholder:'ページ名で絞り込み'}),ns=C.createNamespaceSelector({value:[],lookupLabel:'対象一覧のその他の名前空間',$overlay:this.$element});
    ns.$element.attr('data-namespace-role','current-filter');
    const status=new OO.ui.DropdownInputWidget({options:[{data:'unfinished',label:'未編集のみ'},{data:'all',label:'すべて'},{data:'failed',label:'失敗'},{data:'excluded',label:'明示除外済み'}]});
    const merged=new Map(this.pages.map(p=>[p.page_title,{title:p.page_title,namespace:p.namespace,status:p.status}]));
    this.overrides.forEach(p=>merged.set(p.page_title,{...(merged.get(p.page_title)||{}),title:p.page_title,namespace:p.namespace,excluded:Boolean(p.excluded)}));
    const $rows=$('<div>'),$total=$('<p>').attr('role','status'),restore=new OO.ui.CheckboxInputWidget();
    const render=()=>{
      const ids=ns.getValue(),q=text.getValue().trim().toLocaleLowerCase();
      const found=[...merged.values()].filter(p=>(!q||p.title.toLocaleLowerCase().includes(q))&&(!ids.length||ids.includes(p.namespace))&&(status.getValue()==='all'||status.getValue()==='excluded'&&p.excluded||status.getValue()==='failed'&&p.status==='failed'||status.getValue()==='unfinished'&&p.status!=='edited'));
      $total.text(found.length+'件'+(found.length>LIMIT?'（先頭1000件を表示。さらに絞り込んでください）':''));
      this.renderSelection($rows,found.slice(0,LIMIT),restore.isSelected()?'restore':'exclude');this.updateSize();
    };
    [text,ns,status].forEach(widget=>widget.on('change',render));restore.on('change',render);
    this.excludeNs=C.createNamespaceSelector({value:this.task.config_json.targetExcludedNamespaces||[],lookupLabel:'除外するその他の名前空間',$overlay:this.$element});this.excludeNs.$element.attr('data-namespace-role','exclusion-policy');this.excludeNs.on('change',()=>this.invalidate());
    $panel.append(new OO.ui.FieldLayout(text,{label:'対象ページ名の絞り込み',align:'top'}).$element,new OO.ui.FieldLayout(ns,{label:'一覧の名前空間フィルター',align:'top'}).$element,new OO.ui.FieldLayout(status,{label:'対象の状態',align:'top'}).$element,new OO.ui.FieldLayout(restore,{label:'選択ページは除外解除を予定する',align:'inline'}).$element,$total,$rows,$('<h3>').text('名前空間をまとめて除外'),$('<p>').text('下で選んだ名前空間は、今後取得するページとpurge対象からも除外します。解除するにはチェックまたは選択タグを外して保存してください。'),this.excludeNs.$element);
    render();
  };
  TargetsDialog.prototype.buildManual=function ($panel) {
    this.manual={};[['add','追加するページ'],['exclude','除外するページ'],['restore','除外を解除するページ']].forEach(([key,label])=>{
      const widget=new OO.ui.MultilineTextInputWidget({rows:3,placeholder:'1行に1ページ名'});this.manual[key]=widget;
      $panel.append(new OO.ui.FieldLayout(widget,{label,align:'top'}).$element);
    });
  };
  TargetsDialog.prototype.payload=function () {
    const changes=new Map(this.staged);
    Object.entries(this.manual).forEach(([action,widget])=>widget.getValue().split(/\r?\n/).map(v=>v.trim()).filter(Boolean).forEach(title=>{
      if(changes.has(title)&&changes.get(title)!==action)throw new Error('同じページに異なる操作が指定されています: '+title);
      changes.set(title,action);
    }));
    if(changes.size>LIMIT)throw new Error('1回の変更は1000ページまでです。');
    const payload={revision:Number(this.task.control_revision||0),add:[],exclude:[],restore:[]};changes.forEach((action,title)=>payload[action].push(title));
    const old=this.task.config_json.targetExcludedNamespaces||[],next=this.excludeNs.getValue();
    const excludeNamespaces=next.filter(n=>!old.includes(n)),restoreNamespaces=old.filter(n=>!next.includes(n));
    if(excludeNamespaces.length)payload.excludeNamespaces=excludeNamespaces;if(restoreNamespaces.length)payload.restoreNamespaces=restoreNamespaces;
    if(!changes.size&&!excludeNamespaces.length&&!restoreNamespaces.length)throw new Error('変更するページまたは名前空間を選んでください。');return payload;
  };
  TargetsDialog.prototype.getActionProcess=function (action) {
    if(action==='close')return new OO.ui.Process(()=>this.close());
    if(action==='apply')return new OO.ui.Process(async()=>{
      try{
        const payload=this.payload(),key=JSON.stringify(payload);
        if(this.confirmed!==key){this.confirmed=key;this.$review.empty().append(new OO.ui.MessageWidget({type:'notice',label:`追加${payload.add.length}件・除外${payload.exclude.length}件・除外解除${payload.restore.length}件／名前空間除外${(payload.excludeNamespaces||[]).length}件・解除${(payload.restoreNamespaces||[]).length}件。確認後、もう一度保存してください。`}).$element);this.actions.get({actions:'apply'}).forEach(a=>a.setLabel('この内容で保存'));this.updateSize();return;}
        await C.postJson('/api/tasks/'+this.task.id+'/targets',payload);this.saved=true;this.close();
      }catch(error){throw new OO.ui.Error(error.message,{recoverable:true});}
    });
    return TargetsDialog.super.prototype.getActionProcess.call(this,action);
  };
  TargetsDialog.prototype.getBodyHeight=function () {return Math.min(window.innerHeight*0.75,this.content.$element.outerHeight(true)||400);};
  C.openTaskTargets=async function (config) {
    const overrides=await C.fetchJson('/api/tasks/'+config.task.id+'/targets');
    if(!manager){manager=new OO.ui.WindowManager();$(document.body).append(manager.$element);}
    const dialog=new TargetsDialog({...config,overrides});manager.addWindows([dialog]);
    await manager.openWindow(dialog).closed;dialog.closedSearch=true;dialog.searchEpoch++;dialog.source.abortLookupRequest();manager.removeWindows([dialog]);return dialog.saved;
  };
})();

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createFakeDb } = require('./helpers/memoryTaskDb');
const waves = require('../src/worker/globalWaves');
const { validateTaskConfig, validateLinkRefreshSettings } = require('../src/worker/taskConfig');
function stub(name, exports) {
  const id = require.resolve(name); const entry = new Module(id); entry.loaded = true; entry.exports = exports; require.cache[id] = entry;
}
let currentDb, currentWiki;
stub('../src/db', { pool: { query: (...args) => currentDb.pool.query(...args) } });
stub('../src/bot/accounts', { getClient: async () => currentWiki });
stub('../src/services/settings', { getWorkerSettings: async () => ({ reviewPollMs: 1, editRetryCount: 0, editRetryBaseMs: 0, nullEditIntervalMs: 0 }) });
const { runTask } = require('../src/worker/taskRunner');
const refresh = require('../src/worker/linkRefresh');

function database(config) {
  const db = createFakeDb();
  const task = { id: 1, status: 'running', mode: 'auto', account: 'NanonaBot', config_json: JSON.stringify(config), target_titles_json: '{}', progress_total: 0 };
  db.seedTask(task);
  const baseQuery = db.pool.query;
  db.pool.query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim(), row = db.tasks.get(1);
    if (s.startsWith('SELECT COUNT(*) AS cnt FROM task_pages')) return [[{ cnt: [...db.taskPages.values()].filter(p => p.task_id === params[0] && (s.includes("status = 'failed'") ? p.status === 'failed' : params.length === 1 || p.stage === params[1]) && (!s.includes("status IN ('pending'") || ['pending','preparing','prepared','awaiting_review','approved','editing'].includes(p.status))).length }]];
    if (s.startsWith('UPDATE tasks SET progress_total')) { row.progress_total=params[0];return [{affectedRows:1}]; }
    if (s.startsWith('SELECT COUNT(*) AS cnt FROM task_warnings')) return [[{ cnt: 0 }]];
    if (s.startsWith('SELECT target_titles_json')) return [[{ target_titles_json: row.target_titles_json, progress_total: row.progress_total }]];
    if (s.startsWith('UPDATE tasks SET target_titles_json')) { row.target_titles_json = params[0]; if (params.length > 2) { row.progress_total = params[1]; row.current_stage = params[2]; } return [{ affectedRows: 1 }]; }
    if (s.startsWith('UPDATE tasks SET stage_count')) { row.stage_count = params[0]; return [{ affectedRows: 1 }]; }
    if (s.startsWith('UPDATE tasks SET current_stage')) { row.current_stage = params[0]; return [{ affectedRows: 1 }]; }
    if (s.startsWith('UPDATE tasks SET status = ?')) { row.status = params[0]; return [{ affectedRows: 1 }]; }
    if (s.startsWith("UPDATE tasks SET status = 'emergency_stopped'")) { if (row.status === 'running') row.status = 'emergency_stopped'; return [{ affectedRows: 1 }]; }
    if (s.startsWith('INSERT INTO task_pages')) { db.seedPages(params[0].map(p => ({ task_id: p[0], stage: p[1], order_index: p[2], page_title: p[3], namespace: p[4], matched_rule_indices: p[5], status: p[6] }))); return [{}]; }
    if (s.startsWith('SELECT page_title FROM task_pages')) return [[...db.taskPages.values()].filter(p => p.stage === 1 && p.namespace === 10 && p.status === 'edited').map(p => ({ page_title: p.page_title }))];
    return baseQuery(sql, params);
  };
  return db;
}
function fixture({ rules, pages = {}, discover, options = {}, purge } = {}) {
  const events = [];
  const config = { workflowVersion: waves.VERSION, account: 'NanonaBot', replacements: rules,
    editSettings: { editSummary: 'test', editIntervalSeconds: 5, ...options }, reviewSettings: { mode: 'auto', autoWaitSeconds: 0 }, onFailure: 'pause' };
  const db = database(config);currentDb = db;
  currentWiki = {
    getPage: async title => ({ title, exists: !!pages[title], namespace: pages[title]?.namespace ?? 0, wikitext: pages[title]?.text || '', revid: 100, baseTimestamp: '2026-11-21T00:00:00Z', startTimestamp: '2026-11-21T00:00:01Z' }),
    edit: async ({title,text}) => { events.push('edit:'+title); pages[title].text=text; return { revid: 101 }; },
    purgeWithLinkUpdate: async titles => { events.push('purge:'+titles.join(',')); if (purge) await purge(titles, db); return { purged: titles, failed: [] }; },
    nullEdit: async title => { events.push('null:'+title); },
  };
  global.fetch = async url => {
    const q = Object.fromEntries(new URL(url).searchParams);
    events.push('query:'+q.list+':'+(q.blnamespace ?? q.einamespace ?? q.cmnamespace ?? '*'));
    const items = discover ? await discover(q, pages, events) : [];
    return { ok: true, json: async () => ({ query: { [q.list]: items } }) };
  };
  return { db, pages, events, task: db.tasks.get(1), wiki: currentWiki };
}

test('global plan: fixed retry/revert stay single-wave; normal kinds share two phases', () => {
  assert.equal(waves.stageCount([{templateType:'templateRename'}]),2);
  assert.equal(waves.stageCount([{templateType:'categoryRename'},{templateType:'linkRename'}]),2);
  assert.equal(waves.stageCount([{templateType:'linkRename',forceTargets:['A']}]),1);
  assert.equal(waves.stageCount([{templateType:'revertEdits'}]),1);
  assert.equal(waves.isGlobalConfig({}),false);
});

test('global plan: template and link replacements on an article are saved in ONE edit', async () => {
  const f=fixture({rules:[{templateType:'templateRename',from:'旧',to:'新',namespaces:[0]},{templateType:'linkRename',from:'A',to:'B',namespaces:[0]}],pages:{記事:{namespace:0,text:'{{旧}} [[A]]'}},discover:q => q.eititle==='Template:旧'||q.list==='backlinks' ? [{title:'記事',ns:0}] : []});
  await runTask(f.task);
  assert.equal(f.pages.記事.text,'{{新}} [[B]]');
  assert.deepEqual(f.events.filter(e=>e.startsWith('edit:')),['edit:記事']);
  assert.equal(f.task.stage_count,2);assert.equal(f.task.status,'completed');
  assert.deepEqual(JSON.parse([...f.db.taskPages.values()][0].matched_rule_indices),[0,1]);
});

test('global plan: edit Template -> purge CALLER -> rediscover main targets -> edit main', async () => {
  let propagated=false;
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B',namespaces:[0]}],pages:{'Template:T':{namespace:10,text:'[[A]]'},記事:{namespace:0,text:'[[A]]'}},discover:q => {
    if(q.list==='embeddedin')return [{title:'記事',ns:0}];
    if(q.list==='backlinks')return q.blnamespace==='10'?[{title:'Template:T',ns:10}]:[{title:'記事',ns:0}];return [];
  },purge:()=>{propagated=true;}});
  await runTask(f.task);
  assert.equal(propagated,true);
  const editT=f.events.indexOf('edit:Template:T'),purge=f.events.indexOf('purge:記事'),lookup=f.events.lastIndexOf('query:backlinks:0'),editA=f.events.indexOf('edit:記事');
  assert.ok(editT<purge&&purge<lookup&&lookup<editA,f.events.join('\n'));
  assert.ok(!f.events.includes('purge:Template:T'));
});

test('global plan: normal Category tags and redirect-category arguments change in the SAME edit', async () => {
  const f=fixture({rules:[{templateType:'categoryRename',from:'旧',to:'新',namespaces:[0]}],pages:{記事:{namespace:0,text:'[[Category:旧]]\n{{リダイレクトの所属カテゴリ|redirect1=X|1-1=旧}}'}},discover:q=>q.list==='categorymembers'||q.list==='backlinks'?[{title:'記事',ns:0}]:[]});
  await runTask(f.task);
  assert.match(f.pages.記事.text,/\[\[Category:新\]\]/);assert.match(f.pages.記事.text,/1-1=新/);
  assert.deepEqual(f.events.filter(e=>e.startsWith('edit:')),['edit:記事']);assert.equal(f.task.stage_count,2);
});

test('global plan: initial caller refresh can be disabled independently of final purge', async () => {
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B'}],pages:{'Template:T':{namespace:10,text:'[[A]]'},記事:{namespace:0,text:'[[A]]'}},options:{refreshTemplateTransclusions:false},discover:q=>q.list==='backlinks'?(q.blnamespace==='10'?[{title:'Template:T',ns:10}]:[{title:'記事',ns:0}]):[]});
  await runTask(f.task);assert.equal(f.events.some(e=>e.startsWith('purge:')||e.startsWith('null:')),false);assert.equal(f.task.status,'completed');
});

test('global plan: optional final purge rediscoveries happen AFTER edits and are deduplicated', async () => {
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B'}],pages:{記事:{namespace:0,text:'[[A]]'}},options:{purgeRemainingTargets:true},discover:q=>q.list==='backlinks'?[{title:'記事',ns:0}]:[]});
  await runTask(f.task);
  assert.equal(f.events.filter(e=>e==='purge:記事').length,1);
  assert.ok(f.events.indexOf('edit:記事')<f.events.indexOf('purge:記事'));
  assert.equal(JSON.parse(f.task.target_titles_json).remainingRefresh.complete,true);
});

test('global refresh: checkpoint resumes caller purge after emergency without repeating completed batches', async () => {
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B'}],discover:q=>q.list==='embeddedin'?Array.from({length:51},(_,i)=>({title:'記事'+i,ns:0})):[],purge:(_,db)=>{db.state.emergencyStopped=true;}});
  f.db.seedPages([{task_id:1,stage:1,namespace:10,page_title:'Template:T',status:'edited'}]);
  const first=await refresh.refreshTemplateCallers(f.task,f.wiki);assert.equal(first.stopped,'emergency');assert.equal(JSON.parse(f.task.target_titles_json).templateRefresh.done,50);
  f.db.state.emergencyStopped=false;f.wiki.purgeWithLinkUpdate=async titles=>{f.events.push('purge:'+titles.join(','));return {failed:[]};};
  await refresh.refreshTemplateCallers(f.task,f.wiki);
  assert.equal(f.events.filter(e=>e.startsWith('query:embeddedin')).length,1);
  assert.equal(f.events.filter(e=>e.startsWith('purge:')).length,2);assert.equal(f.events.at(-1),'purge:記事50');
  assert.equal(JSON.parse(f.task.target_titles_json).templateRefresh.complete,true);
});

test('global refresh: interrupted discovery is NOT persisted as a complete partial list', async () => {
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B'}],discover:q=>{f.db.state.emergencyStopped=true;return [{title:'記事',ns:0}];}});
  f.db.seedPages(['Template:T','Template:U'].map(page_title=>({task_id:1,stage:1,namespace:10,page_title,status:'edited'})));
  assert.equal((await refresh.refreshTemplateCallers(f.task,f.wiki)).stopped,'emergency');assert.equal(JSON.parse(f.task.target_titles_json).templateRefresh,undefined);
});

test('global refresh: 50-title batches; failed purge is logged separately from page edit failures', async () => {
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B'}]});
  f.wiki.purgeWithLinkUpdate=async titles=>({failed:titles.filter(t=>t==='P3')});
  await refresh.refresh(f.task,f.wiki,{key:'testRefresh',stage:2,label:'test',method:'purge',discover:async()=>Array.from({length:51},(_,i)=>'P'+i)});
  assert.deepEqual(JSON.parse(f.task.target_titles_json).testRefresh,{complete:true,total:51,failed:1,method:'purge'});
  assert.equal(f.db.taskPages.size,0);assert.ok(f.db.taskLogs.some(p=>p[2]==='P3'));
});

test('global settings: malformed refresh options are rejected in tasks and account defaults validation', () => {
  for(const key of ['refreshTemplateTransclusions','purgeRemainingTargets']){
    const errors=[];validateLinkRefreshSettings({[key]:'true'},errors);assert.equal(errors.length,1);
    const config={account:'NanonaBot',replacements:[{templateType:'linkRename',from:'A',to:'B'}],editSettings:{editSummary:'test',editIntervalSeconds:5,[key]:1},reviewSettings:{mode:'auto',autoWaitSeconds:0},onFailure:'pause'};
    assert.equal(validateTaskConfig(config).valid,false);
  }
});

test('global plan: empty Template phase is checkpointed and completed edits are not repeated on resume', async () => {
  const f=fixture({rules:[{templateType:'templateRename',from:'旧',to:'新'}],pages:{記事:{namespace:0,text:'{{旧}}'}},discover:q=>q.list==='embeddedin'?[{title:'記事',ns:0}]:[]});
  await runTask(f.task);assert.deepEqual(JSON.parse(f.task.target_titles_json)['1'],[]);
  const count=f.events.length;f.task.status='running';await runTask(f.task);
  assert.deepEqual(f.events.slice(count),[]);assert.equal(f.events.filter(e=>e.startsWith('edit:')).length,1);
});

test('global plan: legacy tasks keep their stored type-specific waves', async () => {
  const f=fixture({rules:[{templateType:'templateRename',from:'旧',to:'新'},{templateType:'linkRename',from:'A',to:'B'}],pages:{記事:{namespace:0,text:'{{旧}} [[A]]'}},discover:q=>q.list==='embeddedin'||q.list==='backlinks'&&q.blnamespace!=='10'?[{title:'記事',ns:0}]:[]});
  const config=JSON.parse(f.task.config_json);delete config.workflowVersion;f.task.config_json=JSON.stringify(config);
  await runTask(f.task);assert.equal(f.events.filter(e=>e==='edit:記事').length,2);
});

test('global plan: fixed retry targets use one editing phase and never invoke caller/final refresh', async () => {
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B',forceTargets:['記事']}],pages:{記事:{namespace:0,text:'[[A]]'}},options:{purgeRemainingTargets:true}});
  await runTask(f.task);assert.equal(f.task.stage_count,1);assert.deepEqual(f.events,['edit:記事']);
});

test('global targets: unknown namespaces fail discovery rather than editing a Template in the main phase', async () => {
  const options={namespaceCache:new Map(),resolveLegacy:async()=>({results:[{title:'Unknown'}],error:null}),resolveMentions:async()=>({results:[],error:null})};
  await assert.rejects(()=>waves.resolveGlobalTargets({templateType:'custom',targetSource:{type:'manualList'}},2,{getPage:async()=>({})},options),/名前空間/);
});

test('tasks API: a new task stores the global workflow version, including requests from an old client', async () => {
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B'}]});
  let stored;
  f.db.pool.query=async(sql,params)=>{if(sql.includes('INSERT INTO tasks'))stored=JSON.parse(params[3]);return [{insertId:9}];};
  const router=require('../src/routes/tasks');const handle=router.stack.find(s=>s.route?.path==='/api/tasks'&&s.route.methods.post).route.stack.at(-1).handle;
  const body=JSON.parse(f.task.config_json);delete body.workflowVersion;
  const res={status(){return this;},json(){}};
  await handle({body,session:{username:'owner'}},res,error=>{throw error;});
  assert.equal(stored.workflowVersion,waves.VERSION);assert.equal(body.workflowVersion,undefined);
});

test('global final purge: stale Category backlinks are purged even after their text reference has disappeared', async () => {
  const f=fixture({rules:[{templateType:'categoryRename',from:'旧',to:'新',namespaces:[0]}],pages:{参照だけ:{namespace:0,text:'既にカテゴリ記述はない'}},options:{purgeRemainingTargets:true},discover:q=>q.list==='backlinks'?[{title:'参照だけ',ns:0}]:[]});
  await runTask(f.task);
  assert.deepEqual(f.events.filter(e=>e.startsWith('edit:')),[]);
  assert.deepEqual(f.events.filter(e=>e.startsWith('purge:')),['purge:参照だけ']);
});

test('global refresh: explicit nullEdit updates callers without purge', async () => {
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B'}],discover:q=>q.list==='embeddedin'?[{title:'記事',ns:0}]:[]});
  f.db.seedPages([{task_id:1,stage:1,namespace:10,page_title:'Template:T',status:'edited'}]);
  await refresh.refreshTemplateCallers(f.task,f.wiki,'nullEdit');
  assert.deepEqual(f.events.filter(e=>e.startsWith('null:')||e.startsWith('purge:')),['null:記事']);
  assert.equal(JSON.parse(f.task.target_titles_json).templateRefresh.method,'nullEdit');
});

test('global refresh: discovery errors are recorded and do not checkpoint an incomplete target list', async () => {
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B'}],discover:()=>{throw new Error('lookup failed');}});
  f.db.seedPages([{task_id:1,stage:1,namespace:10,page_title:'Template:T',status:'edited'}]);
  await assert.rejects(()=>refresh.refreshTemplateCallers(f.task,f.wiki),/lookup failed/);
  assert.equal(JSON.parse(f.task.target_titles_json).templateRefresh,undefined);
  assert.ok(f.db.taskLogs.some(row=>row[3]==='error'&&row[4].includes('対象取得')));
});

test('manual pause between purge batches saves checkpoint and resumes without repeating work', async()=>{
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B'}]});
  let calls=0;
  f.wiki.purgeWithLinkUpdate=async titles=>{calls++;f.task.pause_requested=1;return {failed:[]};};
  const options={key:'templateRefresh',stage:1,method:'purge',label:'test',discover:async()=>Array.from({length:53},(_,i)=>'P'+i)};
  assert.equal((await refresh.refresh(f.task,f.wiki,options)).stopped,'paused');
  assert.equal(JSON.parse(f.task.target_titles_json).templateRefresh.done,50);
  f.task.pause_requested=0;
  f.wiki.purgeWithLinkUpdate=async titles=>{calls++;assert.equal(titles.length,3);return {failed:[]};};
  await refresh.refresh(f.task,f.wiki,options);assert.equal(calls,2);
});

test('replanned task excludes pages, adds all rules explicitly, and preserves edited history',async()=>{
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B',namespaces:[0]},{templateType:'templateRename',from:'旧',to:'新',namespaces:[0]}],pages:{済:{text:'[[B]] {{新}}'},除外:{text:'[[A]] {{旧}}'},追加:{text:'[[A]] {{旧}}'},候補:{text:'[[A]] {{旧}}'}},discover:q=>q.list==='backlinks'&&q.blnamespace==='0'?[{title:'済',ns:0},{title:'除外',ns:0},{title:'候補',ns:0}]:[]});
  f.task.control_revision=1;f.task.target_titles_json=JSON.stringify({replan:true,enumeratedStages:[]});
  f.db.seedPages([{task_id:1,stage:2,order_index:0,page_title:'済',namespace:0,matched_rule_indices:'[0,1]',status:'edited'}]);
  const base=f.db.pool.query;
  f.db.pool.query=async(sql,p=[])=>{
    if(sql.startsWith('SELECT page_title, namespace, added, excluded FROM task_target_overrides'))return [[{page_title:'除外',namespace:0,excluded:1,added:0},{page_title:'追加',namespace:0,excluded:0,added:1}]];
    if(sql.includes("status IN ('edited','skipped','rejected','failed')"))return [[...f.db.taskPages.values()].filter(x=>['edited','skipped','rejected','failed'].includes(x.status)).map(x=>({page_title:x.page_title}))];
    return base(sql,p);
  };
  await runTask(f.task);
  assert.deepEqual(f.events.filter(e=>e.startsWith('edit:')).sort(),['edit:候補','edit:追加']);
  assert.equal(f.pages.除外.text,'[[A]] {{旧}}');assert.equal(f.pages.追加.text,'[[B]] {{新}}');
  assert.equal([...f.db.taskPages.values()].filter(x=>x.page_title==='済').length,1);assert.equal(f.task.status,'completed');
});


test('restart between candidate insertion and replan checkpoint does not duplicate targets',async()=>{
  const f=fixture({rules:[{templateType:'linkRename',from:'A',to:'B',namespaces:[0]}],pages:{記事:{text:'[[A]]'}},discover:q=>q.list==='backlinks'&&q.blnamespace==='0'?[{title:'記事',ns:0}]:[]});
  f.task.control_revision=1;f.task.target_titles_json=JSON.stringify({replan:true,enumeratedStages:[1]});
  f.db.seedPages([{task_id:1,stage:2,order_index:0,page_title:'記事',namespace:0,matched_rule_indices:'[0]',status:'pending'}]);
  const base=f.db.pool.query;f.db.pool.query=async(sql,p)=>sql.startsWith('SELECT page_title, namespace, added, excluded')?[[]]:base(sql,p);
  await runTask(f.task);
  assert.equal(f.db.taskPages.size,1);assert.deepEqual(f.events.filter(e=>e.startsWith('edit:')),['edit:記事']);assert.equal(f.task.progress_total,1);assert.ok(JSON.parse(f.task.target_titles_json).enumeratedStages.includes(2));
});

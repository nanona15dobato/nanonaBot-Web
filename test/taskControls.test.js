'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const dbPath = require.resolve('../src/db');
const entry = new Module(dbPath); entry.loaded = true; entry.exports = { pool: {} }; require.cache[dbPath] = entry;
const { createTaskControls } = require('../src/services/taskControls');
const sample = () => ({ workflowVersion:'global-v1', account:'NanonaBot', replacements:[{templateType:'linkRename',from:'旧',to:'新',namespaces:[0]}],editSettings:{editSummary:'test',editIntervalSeconds:5},reviewSettings:{mode:'auto',autoWaitSeconds:0},onFailure:'pause' });
function fixture(taskChanges = {}) {
  const state = {task:{id:1,status:'paused',worker_active:0,pause_requested:0,control_revision:0,config_json:JSON.stringify(sample()),...taskChanges},pages:[{page_title:'済',status:'edited'},{page_title:'待',status:'approved'}],overrides:[],logs:[]};
  let tail = Promise.resolve();
  const db = {async getConnection() {
    const previous = tail; let unlock; tail = new Promise(r => {unlock = r;}); await previous;
    let backup;
    return {async beginTransaction(){backup=structuredClone(state);},async commit(){},async rollback(){Object.assign(state,backup);},release(){unlock();},async query(sql,p=[]) {
      const s=sql.replace(/\s+/g,' ').trim(),t=state.task;
      if(s.startsWith('SELECT * FROM tasks'))return [[structuredClone(t)]];
      if(s.startsWith('INSERT INTO task_logs')){state.logs.push(p[2]);return [{}];}
      if(s.startsWith("UPDATE tasks SET status = 'paused'")){t.status='paused';t.pause_requested=0;return [{}];}
      if(s.startsWith('UPDATE tasks SET pause_requested')){t.pause_requested=1;return [{}];}
      if(s.startsWith('UPDATE task_pages')){state.pages.filter(x=>x.status==='editing').forEach(x=>x.status='failed');return [{}];}
      if(s.startsWith('DELETE FROM task_pages')){state.pages=state.pages.filter(x => s.includes('page_title COLLATE') ? !(x.page_title===p[1]&&['failed','skipped','rejected'].includes(x.status)) : !['pending','preparing','prepared','awaiting_review','approved'].includes(x.status));return [{}];}
      if(s.startsWith('DELETE FROM task_warnings'))return [{}];
      if(s.startsWith('SELECT COUNT'))return [[{cnt:state.pages.length}]];
      if(s.startsWith('SELECT page_title FROM task_pages'))return [state.pages.filter(x=>x.status==='edited'&&p[1].includes(x.page_title))];
      if(s.startsWith('UPDATE tasks SET config_json')){Object.assign(t,{config_json:p[0],account:p[1],mode:p[2],target_titles_json:p[3],control_revision:p[4],current_stage:1,stage_count:p[5],progress_current:p[6],progress_total:p[7]});return [{}];}
      if(s.startsWith('INSERT INTO task_target_overrides')){let x=state.overrides.find(x=>x.page_title===p[1]);if(!x){x={page_title:p[1],namespace:p[2],added:0};state.overrides.push(x);}if(s.includes('VALUES (?,?,?,1,0,?)')){x.added=1;x.excluded=0;}else x.excluded=1;return [{}];}
      if(s.startsWith('UPDATE task_target_overrides')){const x=state.overrides.find(x=>x.page_title===p[2]);if(x)x.excluded=0;return [{}];}
      throw Error('Unexpected SQL '+s);
    }};
  }};
  const controls=createTaskControls({db,lookup:async names=>names.map(n=>({title:n.replaceAll('_',' '),namespace:n.startsWith('Template:')?10:0,exists:n!=='不存在'}))});
  return {state,controls};
}
test('pause is a request while worker owns running task; queued task pauses immediately',async()=>{
  let f=fixture({status:'running',worker_active:1});assert.equal((await f.controls.pause(1,'User')).paused,false);assert.equal(f.state.task.status,'running');assert.equal(f.state.task.pause_requested,1);
  f=fixture({status:'queued'});assert.equal((await f.controls.pause(1,'User')).paused,true);assert.equal(f.state.task.status,'paused');
});
test('mutations require quiescence and current revision',async()=>{
  for(const change of [{status:'running'},{worker_active:1},{pause_requested:1},{status:'completed'}]){
    const f=fixture(change);await assert.rejects(f.controls.updateConfig(1,'User',sample(),0),e=>e.code==='task_busy');assert.equal(f.state.logs.length,0);
  }
  const f=fixture({control_revision:2});await assert.rejects(f.controls.updateConfig(1,'User',sample(),1),e=>e.code==='revision_conflict');
});
test('config editing keeps completed history, invalidates unprocessed approvals, regenerates plan',async()=>{
  const f=fixture();const next=sample();next.replacements[0].to='変更先';next.reviewSettings.mode='manual';next.reviewSettings.manualTimeoutHours=72;
  assert.equal((await f.controls.updateConfig(1,'User',next,0)).revision,1);
  assert.deepEqual(f.state.pages,[{page_title:'済',status:'edited'}]);assert.equal(JSON.parse(f.state.task.config_json).replacements[0].to,'変更先');assert.equal(JSON.parse(f.state.task.target_titles_json).replan,true);assert.equal(f.state.task.stage_count,2);assert.equal(f.state.task.status,'paused');
});
test('concurrent configuration writes cannot overwrite another accepted revision',async()=>{
  const f=fixture();const results=await Promise.allSettled([f.controls.updateConfig(1,'A',sample(),0),f.controls.updateConfig(1,'B',sample(),0)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'revision_conflict');assert.equal(f.state.task.control_revision,1);assert.equal(f.state.logs.length,1);
});
test('add/exclude/restore canonical names; explicit retry revives only unfinished terminal pages',async()=>{
  const f=fixture();f.state.pages.push({page_title:'再試行',status:'failed'});
  await f.controls.updateTargets(1,'User',{revision:0,add:['追加_記事','再試行'],exclude:['除外']});
  assert.deepEqual(f.state.pages,[{page_title:'済',status:'edited'}]);assert.equal(f.state.overrides[0].page_title,'追加 記事');assert.equal(f.state.overrides[2].excluded,1);
  await f.controls.updateTargets(1,'User',{revision:1,restore:['除外']});assert.equal(f.state.overrides[2].excluded,0);assert.equal(f.state.task.control_revision,2);
});
test('invalid target operations roll back without changing history or revision',async()=>{
  for(const [body,code] of [[{add:['済']},'already_edited'],[{add:['不存在']},'missing_page'],[{add:['同_名'],exclude:['同 名']},'conflicting_targets'],[{add:false},'invalid_titles'],[{add:['記事#節']},'invalid_titles']]){
    const f=fixture();const before=structuredClone(f.state);await assert.rejects(f.controls.updateTargets(1,'User',{revision:0,...body}),e=>e.code===code);assert.deepEqual(f.state,before);
  }
});
test('fixed retries keep original rules while edit/review settings remain editable',async()=>{
  const old=sample();old.replacements[0].forceTargets=['記事'];const f=fixture({config_json:JSON.stringify(old)});
  await f.controls.updateConfig(1,'User',{...old,editSettings:{...old.editSettings,editSummary:'変更'}},0);assert.equal(f.state.task.stage_count,1);
  const next=structuredClone(old);next.replacements[0].to='別';await assert.rejects(f.controls.updateConfig(1,'User',next,1),e=>e.code==='fixed_rules');
});

test('worker acknowledges pause only on release, preserving cancellation/completion',async()=>{
  let task={status:'running',worker_active:1,pause_requested:1};
  entry.exports.pool.query=async(sql)=>{
    if(sql.includes('SELECT emergency_stopped'))return [[{emergency_stopped:0}]];
    if(sql.startsWith('SELECT status, pause_requested'))return [[task]];
    if(sql.startsWith('UPDATE tasks SET')){if(task.status==='running'&&task.pause_requested)task.status='paused';task.worker_active=0;task.pause_requested=0;return [{}];}
    throw Error(sql);
  };
  const control=require('../src/worker/taskControl');
  assert.equal(await control.stopReason(1),'paused');assert.equal(task.status,'running');assert.equal(task.worker_active,1);
  await control.releaseTask(1);assert.equal(task.status,'paused');assert.equal(task.worker_active,0);
  for(const status of ['cancelled','completed']){task={status,worker_active:1,pause_requested:1};await control.releaseTask(1);assert.equal(task.status,status);}
});

function request(router,method,url,session,body){
  return new Promise((resolve,reject)=>{
    const res={statusCode:200,status(n){this.statusCode=n;return this;},json(body){resolve({status:this.statusCode,body});return this;}};
    router.handle({method,url,session,body,headers:{}},res,e=>reject(e||Error('Unmatched route')));
  });
}
test('new control APIs require owner permission and reject malformed task IDs',async()=>{
  const router=require('../src/routes/taskControls');
  for(const [method,url]of [['POST','/api/tasks/1/pause'],['PUT','/api/tasks/1/config'],['POST','/api/tasks/1/targets'],['GET','/api/tasks/1/targets'],['POST','/api/tasks/1/target-search'],['GET','/api/wiki/namespaces'],['POST','/api/wiki/page-search']]){
    for(const role of ['admin_emergency_only','denied',undefined])assert.equal((await request(router,method,url,{username:'Other',role},{})).status,403);
  }
  assert.equal((await request(router,'POST','/api/tasks/0/pause',{role:'owner'},{})).status,400);
});
test('API maps revision conflict and passes owner name and exact revision to service',async()=>{
  const router=require('../src/routes/taskControls'),controls=require('../src/services/taskControls');const previous=controls.updateConfig;
  controls.updateConfig=async(id,user,config,revision)=>{assert.equal(id,1);assert.equal(user,'Owner');assert.equal(revision,7);throw new controls.TaskControlError(409,'revision_conflict','更新してください');};
  try{const response=await request(router,'PUT','/api/tasks/1/config',{role:'owner',username:'Owner'},{revision:7,config:sample()});assert.equal(response.status,409);assert.equal(response.body.error,'revision_conflict');}finally{controls.updateConfig=previous;}
});

test('namespace-wide exclusion and restoration are atomic and replan future discovery',async()=>{
 const f=fixture();await f.controls.updateTargets(1,'User',{revision:0,excludeNamespaces:[10,14]});
 assert.deepEqual(JSON.parse(f.state.task.config_json).targetExcludedNamespaces,[10,14]);assert.equal(f.state.task.control_revision,1);
 await assert.rejects(f.controls.updateTargets(1,'User',{revision:1,add:['Template:追加']}),e=>e.code==='namespace_excluded');assert.equal(f.state.task.control_revision,1);
 await f.controls.updateTargets(1,'User',{revision:1,restoreNamespaces:[10],add:['Template:追加']});assert.deepEqual(JSON.parse(f.state.task.config_json).targetExcludedNamespaces,[14]);
 await assert.rejects(f.controls.updateTargets(1,'User',{revision:2,excludeNamespaces:[0],restoreNamespaces:[0]}),e=>e.code==='conflicting_namespaces');
});
test('bulk target mutation accepts 1000 titles in one transaction but rejects a larger list',async()=>{
 const f=fixture();const titles=Array.from({length:1000},(_,i)=>'候補'+i);
 await f.controls.updateTargets(1,'User',{revision:0,add:titles});assert.equal(f.state.overrides.length,1000);assert.equal(f.state.task.control_revision,1);assert.equal(f.state.logs.length,1);
 await assert.rejects(f.controls.updateTargets(1,'User',{revision:1,add:[...titles,'超過']}),e=>e.code==='invalid_titles');assert.equal(f.state.task.control_revision,1);
});

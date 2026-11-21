'use strict';
// All routes are local fixtures. No live wiki or database is accessed.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {renderShell}=require('../src/views/shell');
const root=path.join(__dirname,'..'),origin='https://task-controls-preview.invalid';
const sample={workflowVersion:'global-v1',account:'NanonaBot',replacements:[{templateType:'linkRename',from:'旧',to:'新',namespaces:[0]}],editSettings:{editSummary:'test',editIntervalSeconds:5},reviewSettings:{mode:'auto',autoWaitSeconds:0},onFailure:'pause'};
async function main(){
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const results=[];
 try{for(const width of [390,1280])for(const fixed of [false,true]){
  const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'}),page=await context.newPage(),errors=[],writes=[];
  const task={id:1,status:'running',worker_active:1,pause_requested:0,control_revision:0,account:'NanonaBot',mode:'auto',stage_count:2,current_stage:1,progress_total:0,progress_current:0,config_json:structuredClone(sample)};
  if(fixed)task.config_json.replacements[0].forceTargets=['記事'];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());assert.equal(u.origin,origin);
   if(u.pathname.startsWith('/api/')){
    let body={};
    if(req.method()!=='GET'){
     const value=req.postDataJSON();writes.push({path:u.pathname,method:req.method(),body:value});body={ok:true};
     if(u.pathname.endsWith('/pause'))task.pause_requested=1;
     if(u.pathname.endsWith('/targets')){assert.equal(value.revision,0);task.control_revision++;}
     if(u.pathname.endsWith('/config')){assert.equal(value.revision,1);task.config_json=value.config;task.control_revision++;}
     if(u.pathname.endsWith('/resume')){task.status='queued';}
    }else if(u.pathname==='/api/tasks/1')body=task;
    else if(/\/(pages|logs|warnings|targets)$/.test(u.pathname))body=[];
    else if(u.pathname==='/api/whoami')body={username:'Owner',role:'owner'};
    else if(u.pathname==='/api/bot-accounts/defaults')body=[{account:'NanonaBot',editSettings:sample.editSettings,reviewSettings:sample.reviewSettings}];
    return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
   }
   if(['/tasks/1','/tasks/new'].includes(u.pathname))return route.fulfill({contentType:'text/html',body:renderShell({title:'タスク',script:u.pathname==='/tasks/1'?'taskDetail.js':'taskNew.js',initialData:{username:'Owner',role:'owner',taskId:1}})});
   for(const [prefix,folder]of [['/static/','public/'],['/vendor/jquery/','node_modules/jquery/dist/'],['/vendor/oojs/','node_modules/oojs/dist/'],['/vendor/oojs-ui/','node_modules/oojs-ui/dist/']]){
    if(!u.pathname.startsWith(prefix))continue;const base=path.resolve(root,folder),file=path.resolve(base,u.pathname.slice(prefix.length));if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())break;
    return route.fulfill({contentType:({'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
   }
   return route.fulfill({status:404,body:''});
  });
  await page.goto(origin+'/tasks/1');
  const targetButton=()=>page.getByRole('button',{name:'対象の追加・除外',exact:true});
  await targetButton().waitFor();assert.equal(await targetButton().isDisabled(),true);
  await page.getByRole('button',{name:'一時停止',exact:true}).click();await page.getByRole('button',{name:'一時停止処理中',exact:true}).waitFor();assert.equal(await targetButton().isDisabled(),true);
  task.status='paused';task.worker_active=0;task.pause_requested=0;
  await page.getByRole('button',{name:'更新',exact:true}).click();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.oo-ui-buttonWidget')).some(b=>b.textContent.includes('対象の追加・除外')&&!b.classList.contains('oo-ui-widget-disabled')));
  await targetButton().click();await page.getByLabel('追加するページ',{exact:true}).fill('追加記事');await page.getByLabel('除外するページ',{exact:true}).fill('除外記事');
  await page.getByRole('button',{name:'対象の変更を保存',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.oo-ui-window-active'));
  await page.getByRole('button',{name:'タスク設定を編集',exact:true}).click();await page.waitForURL('**/tasks/new?edit=1');
  const summary=page.getByLabel('要約欄',{exact:true});await summary.waitFor();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.oo-ui-buttonWidget')).some(b=>b.textContent.includes('タスク設定を保存')&&!b.classList.contains('oo-ui-widget-disabled')));
  await summary.fill('変更した要約');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'edit form overflow '+width);
  if(fixed)assert.equal(await page.locator('.nb-rule-card:visible').count(),0);else assert.equal(await page.locator('.nb-rule-card:visible').count(),1);
  await page.getByRole('button',{name:'タスク設定を保存',exact:true}).click();await page.getByRole('button',{name:'設定を保存',exact:true}).click();await page.waitForURL('**/tasks/1');
  assert.equal(task.config_json.editSettings.editSummary,'変更した要約');if(fixed)assert.deepEqual(task.config_json.replacements[0].forceTargets,['記事']);
  await page.getByRole('button',{name:'再開する',exact:true}).click();
  await page.getByRole('button',{name:'一時停止',exact:true}).waitFor();
  const targetWrite=writes.find(r=>r.path.endsWith('/targets'));assert.deepEqual(targetWrite.body,{revision:0,add:['追加記事'],exclude:['除外記事'],restore:[]});
  assert.ok(writes.some(r=>r.method==='PUT'&&r.path==='/api/tasks/1/config'));assert.ok(!writes.some(r=>r.path==='/api/tasks'));assert.deepEqual(errors,[]);
  results.push({width,fixed,ok:true});await context.close();
 }}finally{await browser.close();}console.log(JSON.stringify(results));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

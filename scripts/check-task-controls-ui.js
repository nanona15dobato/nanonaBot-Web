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
  const pages=[{id:1,page_title:'通常',namespace:0,status:'pending',stage:2},{id:2,page_title:'Template:除外',namespace:10,status:'pending',stage:1},{id:3,page_title:'カテゴリ:除外',namespace:14,status:'failed',stage:2},{id:4,page_title:'既編集',namespace:0,status:'edited',stage:2}];
  if(fixed)task.config_json.replacements[0].forceTargets=['記事'];
  page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message);});
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());assert.equal(u.origin,origin);
   if(u.pathname.startsWith('/api/')){
    let body={};
    if(req.method()!=='GET'){
     const value=req.postDataJSON();writes.push({path:u.pathname,method:req.method(),body:value});body={ok:true};
     if(u.pathname==='/api/wiki/page-search')body={results:[{title:'Template:旧T',namespace:10}]};
     if(u.pathname.endsWith('/target-search'))body={results:value.continue?[{title:'候補B',namespace:0}]:[{title:'候補A',namespace:0},{title:'Template:候補',namespace:10},{title:'既編集',namespace:0,alreadyEdited:true}],continue:value.continue?null:{eicontinue:'next'}};
     if(u.pathname.endsWith('/pause'))task.pause_requested=1;
     if(u.pathname.endsWith('/targets')){assert.equal(value.revision,0);task.control_revision++;}
     if(u.pathname.endsWith('/config')){assert.equal(value.revision,1);task.config_json=value.config;task.control_revision++;}
     if(u.pathname.endsWith('/resume')){task.status='queued';}
    }else if(u.pathname==='/api/tasks/1')body=task;
    else if(u.pathname==='/api/tasks/1/pages')body=pages;
    else if(/\/(logs|warnings|targets)$/.test(u.pathname))body=[];
    else if(u.pathname==='/api/wiki/namespaces')body=[{id:0,name:''},{id:10,name:'テンプレート',canonical:'Template'},{id:14,name:'カテゴリ',canonical:'Category'},{id:4,name:'Wikipedia'},{id:828,name:'モジュール',canonical:'Module',aliases:[]}];
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
  await targetButton().click();
  if(!fixed){
   const method=page.getByLabel('対象の検索方法',{exact:true});await method.click();await page.getByRole('option',{name:'テンプレート使用ページ（embeddedin）',exact:true}).click();
   await page.getByRole('combobox',{name:'検索元のページ・検索語',exact:true}).fill('旧T');
   await page.getByRole('option',{name:'Template:旧T',exact:true}).click();
   await page.getByRole('button',{name:'対象候補を検索',exact:true}).click();
   const dialog=page.locator('.nb-target-dialog:visible');
   await dialog.getByLabel('候補A',{exact:true}).check();assert.equal(await dialog.getByLabel('既編集（編集済み）',{exact:true}).isDisabled(),true);
   await page.getByRole('button',{name:'検索結果をさらに取得',exact:true}).click();await dialog.getByLabel('候補B',{exact:true}).waitFor();
   assert.equal(await dialog.getByLabel('候補A',{exact:true}).isChecked(),true,'selection survives pagination');
   await page.getByRole('button',{name:'表示対象を全選択',exact:true}).click();await page.getByRole('button',{name:'選択したページを追加予定へ',exact:true}).click();
   await page.getByRole('button',{name:'現在の対象を選択',exact:true}).click();
   await dialog.locator('[data-namespace-role="current-filter"]').getByLabel('テンプレート (10)',{exact:true}).check();
   await page.getByRole('button',{name:'表示対象を全選択',exact:true}).click();await page.getByRole('button',{name:'選択したページを除外予定へ',exact:true}).click();
   await dialog.locator('[data-namespace-role="exclusion-policy"]').getByLabel('カテゴリ (14)',{exact:true}).check();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'target dialog overflow');
   if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'target-dialog-'+width+'.png')});
  }
  await page.getByRole('button',{name:'リスト入力',exact:true}).click();await page.getByLabel('追加するページ',{exact:true}).fill('追加記事');await page.getByLabel('除外するページ',{exact:true}).fill('除外記事');
  await page.getByRole('button',{name:'対象の変更を保存',exact:true}).click();await page.getByRole('button',{name:'この内容で保存',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.oo-ui-window-active'));
  await page.getByRole('button',{name:'タスク設定を編集',exact:true}).click();await page.waitForURL('**/tasks/new?edit=1');
  const summary=page.getByLabel('要約欄',{exact:true});await summary.waitFor();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.oo-ui-buttonWidget')).some(b=>b.textContent.includes('タスク設定を保存')&&!b.classList.contains('oo-ui-widget-disabled')));
  await summary.fill('変更した要約');
  if(!fixed){
   await page.getByLabel('その他の名前空間を検索',{exact:true}).fill('Module');
   await page.getByRole('option',{name:'モジュール / Module (828)',exact:true}).click();
   await page.getByLabel('カテゴリ (14)',{exact:true}).check();
   const commonHeight=await page.locator('.nb-namespace-common').first().evaluate(el=>el.getBoundingClientRect().height);assert.ok(commonHeight<85,'common namespace choices should wrap compactly');
   if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'namespace-form-'+width+'.png')});
  }
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'edit form overflow '+width);
  if(fixed)assert.equal(await page.locator('.nb-rule-card:visible').count(),0);else assert.equal(await page.locator('.nb-rule-card:visible').count(),1);
  await page.getByRole('button',{name:'タスク設定を保存',exact:true}).click();await page.getByRole('button',{name:'設定を保存',exact:true}).click();await page.waitForURL('**/tasks/1');
  assert.equal(task.config_json.editSettings.editSummary,'変更した要約');if(!fixed){assert.ok(task.config_json.replacements[0].namespaces.includes(828));assert.ok(task.config_json.replacements[0].namespaces.includes(14));}if(fixed)assert.deepEqual(task.config_json.replacements[0].forceTargets,['記事']);
  if(!fixed){
   await page.getByRole('checkbox',{name:'通常を選択',exact:true}).check();
   await page.getByRole('checkbox',{name:'Template:除外を選択',exact:true}).check();
   await page.getByRole('button',{name:'選択した対象をまとめて除外',exact:true}).click();
   const dialog=page.locator('.nb-target-dialog:visible');
   assert.match(await dialog.locator('.nb-target-staged').textContent(),/通常/);
   assert.match(await dialog.locator('.nb-target-staged').textContent(),/Template:除外/);
   await dialog.getByRole('button',{name:'キャンセル',exact:true}).click();
  }
  await page.getByRole('button',{name:'再開する',exact:true}).click();
  await page.getByRole('button',{name:'一時停止',exact:true}).waitFor();
  const targetWrite=writes.find(r=>r.path.endsWith('/targets'));assert.deepEqual(targetWrite.body,fixed?{revision:0,add:['追加記事'],exclude:['除外記事'],restore:[]}:{revision:0,add:['候補A','Template:候補','候補B','追加記事'],exclude:['Template:除外','除外記事'],restore:[],excludeNamespaces:[14]});
  assert.ok(writes.some(r=>r.method==='PUT'&&r.path==='/api/tasks/1/config'));assert.ok(!writes.some(r=>r.path==='/api/tasks'));assert.deepEqual(errors,[]);
  results.push({width,fixed,ok:true});await context.close();
 }}finally{await browser.close();}console.log(JSON.stringify(results));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

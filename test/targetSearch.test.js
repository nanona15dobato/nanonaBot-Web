'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
const entry=new Module(require.resolve('../src/db'));entry.loaded=true;entry.exports={pool:{}};require.cache[entry.id]=entry;
const {createTargetSearch}=require('../src/services/targetSearch');
const info={query:{namespaces:{0:{id:0,name:'',canonical:''},10:{id:10,name:'テンプレート',canonical:'Template'},14:{id:14,name:'カテゴリ',canonical:'Category'},828:{id:828,name:'モジュール',canonical:'Module'}},namespacealiases:[{id:10,alias:'T'}]}};
test('namespace metadata includes localized names/aliases and is cached',async()=>{
 let calls=0;const service=createTargetSearch({request:async()=>{calls++;return info;}});
 assert.equal((await service.namespaces()).find(n=>n.id===10).aliases[0],'T');await service.namespaces();assert.equal(calls,1);
});
test('target search uses only allowed API parameters and preserves continuation',async()=>{
 const requests=[];const service=createTargetSearch({request:async p=>{requests.push(p);return p.meta?info:{query:{[p.list]:[{title:'記事',ns:0},{title:'記事',ns:0},{title:'Template:X',ns:10}]},continue:{continue:'-||',blcontinue:'next',action:'edit'}};}});
 const first=await service.search({method:'backlinks',query:'旧',namespaces:[0,10]});assert.equal(first.results.length,2);assert.deepEqual(first.continue,{continue:'-||',blcontinue:'next'});
 await service.search({method:'backlinks',query:'旧',namespaces:[0],continue:first.continue});assert.equal(requests.at(-1).blcontinue,'next');assert.equal(requests.at(-1).action,'query');
 await assert.rejects(service.search({method:'backlinks',query:'旧',continue:{action:'edit'}}),e=>e.code==='invalid_continue');
 await assert.rejects(service.search({method:'backlinks',query:'旧',namespaces:['0']}),e=>e.code==='invalid_namespaces');
 await assert.rejects(service.search({method:'edit',query:'旧'}),e=>e.code==='invalid_method');
});
test('template/category roots are normalized using wiki namespace names, and empty namespace search spans all',async()=>{
 const requests=[];const service=createTargetSearch({request:async p=>{requests.push(p);return p.meta?info:{query:{[p.list]:[]}};}});
 await service.search({method:'embeddedin',query:'旧'});assert.equal(requests.at(-1).eititle,'Template:旧');
 await service.search({method:'embeddedin',query:'T:旧'});assert.equal(requests.at(-1).eititle,'T:旧');
 await service.search({method:'category',query:'旧'});assert.equal(requests.at(-1).cmtitle,'Category:旧');
 await service.search({method:'prefix',query:'記事',namespaces:[]});assert.equal(requests.at(-1).psnamespace,'*');
 await service.search({method:'search',query:'insource:/旧|別/',namespaces:null});assert.equal(requests.at(-1).srnamespace,'*');
});
test('task search marks edited candidates and rejects an unknown task',async()=>{
 const service=createTargetSearch({db:{query:async sql=>sql.startsWith('SELECT id')?[[{id:1}]]:[[{page_title:'済'}]]},request:async()=>({query:{backlinks:[{title:'済',ns:0},{title:'未',ns:0}]}})});
 const result=await service.forTask(1,{method:'backlinks',query:'旧'});assert.equal(result.results[0].alreadyEdited,true);assert.equal(result.results[1].alreadyEdited,false);
 const missing=createTargetSearch({db:{query:async()=>[[]]},request:async()=>assert.fail('should not query wiki')});await assert.rejects(missing.forTask(9,{method:'backlinks',query:'旧'}),e=>e.status===404);
});

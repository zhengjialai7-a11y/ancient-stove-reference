import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const source=readFileSync(new URL('../queue.js',import.meta.url),'utf8');
const id='608a619faa7c385c8d943087';
const task=(taskId,sourceId=id)=>({id:taskId,source_type:'SUHA',source_id:sourceId,queue_order:0,display_title:'same-title',live_status:'pending',phase:'pending',candidate_count:0,master_count:0,verified_count:0,draft_count:0,published_count:0,masters:[]});
class Element {
 constructor(){this.value='';this.textContent='';this.children=[];this.disabled=false;this.style={};}
 append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;}
 add(node){this.children.push(node);} querySelector(){return this.option??=(new Element());} click(){this.clicked=true;}
}
function setup(){
 const elements=new Map(),reads=[],rpcCalls=[],downloads=[];
 const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};$('filter').value='all';
 const tables={reference_capture_status:[task('existing')],artwork_projects:[],artwork_masters:[],artwork_crops:[],reference_capture_imports:[]};
 const state={error:null,result:{id:'archive',added_count:1,existing_count:1,duplicate_count:1,invalid_count:1,new_task_ids:['new'],reused_archive:false},session:{user:{id:'owner',email:'owner@example.test'}}};
 const db={
  rpc:async(name,args)=>{rpcCalls.push({name,args});if(!state.error){tables.reference_capture_status.push(task('new','ffffffffffffffffffffff01'));tables.reference_capture_imports=[{id:'archive',file_name:args.p_file_name,item_count:2,added_count:1,existing_count:1,invalid_count:1,duplicate_count:1,new_task_ids:['new'],created_at:'2026-10-11T00:00:00Z'}];}return {data:state.result,error:state.error};},
  from:table=>{const q={select(columns){reads.push({table,columns});return this;},order(){return this;},range(){return this;},limit(){return this;},eq(){return this;},single:async()=>({data:{payload:{items:[{sourceId:id,sourceType:'SUHA'}],albumId:'saved-album'},file_name:'saved.json'}}),then(resolve,reject){return Promise.resolve({data:tables[table],error:null}).then(resolve,reject);}};return q;},
  channel:()=>({on(){return this;},subscribe(){}}),removeChannel(){},
  auth:{getSession:async()=>({data:{session:state.session}}),onAuthStateChange(){},signOut(){}}
 };
 const ctx=vm.createContext({supabase:{createClient:()=>db},document:{getElementById:$,createElement:()=>new Element(),addEventListener(){},hidden:false},window:{addEventListener(){}},setTimeout:()=>0,clearTimeout(){},setInterval(){},URLSearchParams,Option:function(text,value){return {textContent:text,value};},Blob:class {constructor(parts){downloads.push(JSON.parse(parts[0]));}},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},location:{origin:'https://example.test'},crypto:{randomUUID:()=> 'request'}});
 vm.runInContext(readFileSync(new URL('../capture-common.js',import.meta.url),'utf8'),ctx);
 vm.runInContext(source.replace(/refreshAuth\(\)\.catch\(e=>say\('初始化失败：'\+e.message\)\);\s*$/,''),ctx);
 const run=code=>vm.runInContext(code,ctx);
 return {ctx,run,$,state,tables,reads,rpcCalls,downloads};
}
test('login loads cloud queue and saved incremental IDs without selecting or reimporting a file',async()=>{
 const s=setup();s.tables.reference_capture_imports=[{id:'previous',file_name:'previous.json',new_task_ids:['existing'],added_count:1,item_count:1,existing_count:0,invalid_count:0,duplicate_count:0,created_at:'2026-10-11T00:00:00Z'}];
 await s.run('refreshAuth()');assert.match(s.$('cloudState').textContent,/云端 1 条收藏.*无需重新提交/);
 assert.equal(s.rpcCalls.length,0);assert.equal(s.run('newIds.has("existing")'),true);
 assert.equal(s.reads.some(r=>r.columns.includes('payload')),false);
});
test('import sends full JSON to one atomic RPC and filters actual server-reported additions',async()=>{
 const s=setup();await s.run('refreshAuth()');const original={albumId:'keep-metadata',items:[{sourceId:id,sourceType:'SUHA'},{sourceId:'ffffffffffffffffffffff01',sourceType:'SUHA'},{sourceId:id,sourceType:'SUHA'},null]};s.ctx.input=original;
 await s.run('importData(input,"new-collection.json")');
 assert.equal(s.rpcCalls.length,1);assert.equal(s.rpcCalls[0].name,'import_reference_capture_json');assert.equal(s.rpcCalls[0].args.p_payload,original);assert.equal(s.rpcCalls[0].args.p_file_name,'new-collection.json');
 assert.match(s.$('msg').textContent,/新增 1 条，已存在 1 条，文件内重复 1 条，无效 1 条/);
 assert.equal(s.$('filter').value,'new');assert.equal(s.run('allFiltered().map(r=>r.id).join(",")'),'new');assert.equal(s.$('jsonFile').disabled,false);
 s.$('batch').value='5';s.$('nextBatch').onclick();assert.equal(s.run('[...batchIds].join(",")'),'new');assert.equal(s.$('filter').value,'new');
});
test('failed archive RPC leaves local selection intact and allows retry',async()=>{
 const s=setup();await s.run('refreshAuth()');s.state.error={message:'cloud unavailable'};s.ctx.input={items:[{sourceId:id,sourceType:'SUHA'}]};
 await assert.rejects(s.run('importData(input)'),e=>e.message==='cloud unavailable');
 assert.equal(s.run('queue.length'),1);assert.equal(s.run('newIds.size'),0);assert.equal(s.$('jsonFile').disabled,false);assert.equal(s.run('importing'),false);
});
test('archive downloads preserve original collection content and historical additions remain selectable',async()=>{
 const s=setup();await s.run('refreshAuth()');s.ctx.input={items:[{sourceId:id,sourceType:'SUHA'}]};await s.run('importData(input)');
 const actions=s.$('importHistory').children[0].children[1].children;
 await actions[0].onclick();assert.equal(s.downloads[0].albumId,'saved-album');
 s.$('filter').value='all';await actions[1].onclick();assert.equal(s.$('filter').value,'new');assert.equal(s.run('newLabel'),'此清单首次新增');
});
test('invalid entries are counted, while another account cannot inherit previous incremental selection',async()=>{
 const s=setup();await s.run('refreshAuth()');s.ctx.input={items:[null,42,[],{sourceId:id,sourceType:'SUHA'}]};assert.equal(s.run('C.parseJSON(input).invalid'),3);
 s.run('newIds=new Set(["existing"]);newSelection=true;');s.state.session=null;await s.run('refreshAuth()');assert.equal(s.run('newIds.size'),0);assert.equal(s.run('queue.length'),0);assert.equal(s.run('imports.length'),0);
});

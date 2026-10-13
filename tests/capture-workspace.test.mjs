import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const source='https://g2.ltfc.net/view/SUHA/608a619faa7c385c8d943087';
const row={id:'11111111-1111-1111-1111-111111111111',source_type:'SUHA',source_id:'608a619faa7c385c8d943087',source_url:source,candidate_count:1,resolved_project_id:'project',display_title:'十八学士图',live_status:'uploaded_unverified',master_count:2,verified_count:0,draft_count:2,published_count:1};
function setup(){
 const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',open:true});return elements.get(id)};
 const state={task:{...row},project:{id:'project',source_url:source},initializations:0};
 const query={select(){return this},eq(){return this},single:async()=>({data:state.task}),then:resolve=>Promise.resolve({data:[state.task]}).then(resolve)};
 const ctx=vm.createContext({URLSearchParams,location:{search:'?capture_task='+row.id},$,setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,window:{addEventListener:()=>{}},db:{from:()=>query},document:{hidden:false},refreshAuth:async()=>state.initializations++,message:()=>{}});
 vm.runInContext(readFileSync(new URL('../capture-common.js',import.meta.url),'utf8'),ctx);
 vm.runInContext('let user={id:"owner"},projects=[],master=null,busy=false,multiRunning=false,navigationRunning=false;',ctx);
 vm.runInContext(readFileSync(new URL('../capture-workspace.js',import.meta.url),'utf8'),ctx);
 ctx.fixtureProject=state.project;ctx.fixtureTask=state.task;
 vm.runInContext('projects=[fixtureProject];incomingCaptureTask=fixtureTask;',ctx);$('projectSelect').value='project';$('sourceUrl').value=source;
 return {state,$,ctx,run:code=>vm.runInContext(code,ctx)};
}
test('workbench startup and source guard run after both scripts initialize',async()=>{
 const s=setup();assert.equal(s.state.initializations,1);await s.run('assertCaptureContext()');
 s.state.task.paused=true;await assert.rejects(s.run('assertCaptureContext()'),/暂停/);
 s.state.task.paused=false;s.state.project.source_url=source.replace('608a619faa7c385c8d943087','6566ed76e6b01a05377b3943');await assert.rejects(s.run('assertCaptureContext()'),/作品 ID/);
});
test('ambiguity prevents auto association and summary reflects linked multipart facts',async()=>{
 const s=setup();s.state.task.candidate_count=3;await assert.rejects(s.run('assertCaptureContext()'),/多个古画/);
 s.state.task.candidate_count=1;await s.run('refreshCaptureSummary()');assert.match(s.$('captureSummary').textContent,/母图 2 \/ 已核验 0/);assert.match(s.$('captureSummary').textContent,/草稿 2/);
});
test('master deep link opens the exact owned original without modifying its project or crops',async()=>{
 const s=setup(),m={id:'22222222-2222-2222-2222-222222222222',created_by:'owner',project_id:null,source_url:source};
 s.ctx.location.search='?master_id='+m.id;s.ctx.fixtureMaster=m;s.ctx.opened=[];s.ctx.selectMaster=async master=>s.ctx.opened.push(master.id);
 s.ctx.db.from=()=>({select(){return this},eq(){return this},single:async()=>({data:m})});
 await s.run('initCaptureTask()');assert.deepEqual([...s.ctx.opened],[m.id]);assert.equal(m.project_id,null);
});
test('master deep link refuses invalid ids and another owner before opening pixels',async()=>{
 const s=setup();s.ctx.location.search='?master_id=invalid';await assert.rejects(s.run('initCaptureTask()'),/母图 ID 无效/);
 const m={id:'22222222-2222-2222-2222-222222222222',created_by:'other',project_id:null,source_url:source};s.ctx.location.search='?master_id='+m.id;
 s.ctx.selectMaster=async()=>assert.fail('Foreign pixels must not open');s.ctx.db.from=()=>({select(){return this},eq(){return this},single:async()=>({data:m})});
 await assert.rejects(s.run('initCaptureTask()'),/没有读取权限/);
});

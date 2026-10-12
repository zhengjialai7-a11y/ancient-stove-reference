import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {flow,tasks,QUEUE} from './local-flow-helper.mjs';

class Element{
 constructor(tag='',text=''){this.tag=tag;this.textContent=text;this.children=[];this.dataset={};this.style={};this.value='';this.hidden=false;this.disabled=false;}
 append(...nodes){for(const n of nodes){n.parentElement=this;this.children.push(n);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 remove(){this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
 querySelectorAll(selector){const all=this.children.flatMap(n=>[n,...n.querySelectorAll(selector)]);return all.filter(n=>selector==='[data-local-task-id]'?n.dataset.localTaskId:n.tag==='input'&&n.dataset.taskId);}
}
function queueUI(flowOptions={}){
 const owner='ui-owner',f=flow({acceptance:true,owner,...flowOptions}),elements=new Map(),handlers=new Map(),exports=[],commands=[];let runtimeMessage,authChange;const overrides={};
 for(const [,id] of readFileSync(new URL('../queue.html',import.meta.url),'utf8').matchAll(/\bid="([^"]+)"/g))elements.set(id,new Element());
 const $=id=>{assert.ok(elements.has(id),'Missing UI element '+id);return elements.get(id);};
 const window={addEventListener(name,handler){if(!handlers.has(name))handlers.set(name,[]);handlers.get(name).push(handler);},postMessage(data,origin){queueMicrotask(()=>{for(const handler of handlers.get('message')||[])handler({source:window,origin,data});});}};
 const rows=tasks.map(t=>({...t,source_type:'SUHA',source_url:t.source,display_title:t.title,master_count:0}));
 const ctx=vm.createContext({$,el:(tag,text)=>new Element(tag,text),user:{id:owner},queue:rows,batchIds:new Set(),allFiltered:()=>rows,render(){},downloadJSON:(report,name)=>exports.push({report:structuredClone(report),name}),location:{origin:new URL(QUEUE).origin,pathname:new URL(QUEUE).pathname},window,db:{auth:{getSession:async()=>({data:{session:{user:{id:owner},access_token:'ephemeral-ui-session'}}}),onAuthStateChange(fn){authChange=fn;}}},crypto:{randomUUID},setTimeout:(fn,ms)=>ms>1000?randomUUID():setTimeout(fn,ms),clearTimeout(){},scheduleRefresh(){},URL,chrome:{runtime:{sendMessage:async message=>{commands.push(message);if(overrides[message.command])return overrides[message.command];return f.adapter.handle(message,{tab:{url:QUEUE},frameId:0});},onMessage:{addListener(fn){runtimeMessage=fn;}}}}});
 f.chrome.tabs.query=async()=>[{id:9999,url:QUEUE}];f.chrome.tabs.sendMessage=async(_id,message)=>runtimeMessage?.(message);
 vm.runInContext(readFileSync(new URL('../extension/local_bridge.js',import.meta.url),'utf8'),ctx);
 vm.runInContext(readFileSync(new URL('../capture-local.js',import.meta.url),'utf8'),ctx);
 return {f,$,ctx,exports,commands,window,overrides,authChange:(event,session)=>authChange(event,session)};
}
test('page button sends the authenticated validation request through the real bridge and renders/export actual results',async()=>{
 const ui=queueUI();await ui.$('localPrepare').onclick();const done=ui.f.waitForValidation();await ui.$('localValidate').onclick();await done;await new Promise(setImmediate);
 const command=ui.commands.find(m=>m.command==='validate');assert.equal(command.ownerId,'ui-owner');assert.equal(command.accessToken,'ephemeral-ui-session');assert.equal(command.tasks.length,2);
 assert.equal(ui.$('localValidationReport').children.length,6);assert.match(ui.$('localValidationMessage').textContent,/自动验收结束/);assert.match(ui.$('localValidationMessage').textContent,/验收批次：百鹊图卷、罗汉图/);assert.equal(ui.$('localValidationResume').hidden,true);assert.equal(ui.$('localValidationExport').disabled,false);
 const rows=ui.$('localValidationReport').children.map(e=>e.textContent);assert.ok(rows.some(t=>t.includes('多张母图 · 通过')));assert.ok(rows.some(t=>t.includes('浏览器重启保留 · 待验证')));
 await ui.$('localValidationExport').onclick();assert.equal(ui.exports.length,1);assert.equal(ui.exports[0].report.checks.repeat.status,'passed');assert.equal(JSON.stringify(ui.exports).includes('ephemeral-ui-session'),false);assert.match(ui.exports[0].name,/验收报告.*json$/);
});
test('queue ignores a different account validation progress and keeps its own report intact',async()=>{
 const ui=queueUI();ui.$('localValidationMessage').textContent='本账号报告';ui.window.postMessage({type:'ART_LOCAL_PROGRESS',state:{owner:'other-owner',validation:{owner:'other-owner',status:'finished',checks:{fake:{label:'秘密作品',status:'passed',detail:'secret'}}}}},new URL(QUEUE).origin);await new Promise(setImmediate);assert.equal(ui.$('localValidationMessage').textContent,'本账号报告');assert.equal(ui.$('localValidationReport').children.length,0);
});

test('an old plugin returns an immediate upgrade message instead of timing out on new validation commands',async()=>{
 const ui=queueUI();ui.overrides.status={ok:true,result:{owner:'ui-owner',tasks:[],history:[]}};await ui.$('localValidate').onclick();assert.match(ui.$('localMessage').textContent,/完整更新至 v0.9.1/);assert.equal(ui.commands.some(m=>m.command==='validate'),false);
});
test('an account change clears the visible acceptance report and disables its export',async()=>{
 const ui=queueUI();await ui.$('localPrepare').onclick();const done=ui.f.waitForValidation();await ui.$('localValidate').onclick();await done;await new Promise(setImmediate);assert.equal(ui.$('localValidationReport').children.length,6);ui.authChange('SIGNED_IN',{user:{id:'other-owner'}});assert.equal(ui.$('localValidationReport').children.length,0);assert.equal(ui.$('localValidationExport').disabled,true);
});
test('the current dashboard separates a stopped multipart work from collapsed historical failures and old reports',async()=>{
 const ui=queueUI(),task={id:tasks[0].id,title:'五百罗汉图合集',source:tasks[0].source,status:'failed',error:'读取分段进度失败（ABORT_ERR）',errorStage:'uploading',errorDetail:{stage:'读取分段进度'},count:100,files:[{part:1,complete:true},{part:2,complete:true}],failures:[]};
 ui.window.postMessage({type:'ART_LOCAL_PROGRESS',state:{owner:'ui-owner',mode:'collect',running:false,phase:'blocked',taskId:task.id,tasks:[task],history:[task,{id:'old-task',title:'历史作品',status:'failed',error:'NETWORK_FAILED',failures:[]}],validation:{owner:'ui-owner',id:'old-report',status:'finished',taskIds:['old-task'],tasks:[],checks:{}}}},new URL(QUEUE).origin);await new Promise(setImmediate);
 assert.equal(ui.$('localSummaryState').textContent,'已停止，需要继续');assert.equal(ui.$('localCurrentWork').textContent,'五百罗汉图合集');assert.match(ui.$('localCurrentCount').textContent,/2 \/ 100/);assert.equal(ui.$('localCurrentStep').textContent,'读取分段进度');assert.equal(ui.$('localResume').textContent,'继续采集');assert.equal(ui.$('localLog').children.length,1);assert.equal(ui.$('localHistory').children.length,1);assert.equal(ui.$('localMessage').textContent,'云端请求超时');
});
test('the single resume action continues the blocked acceptance report rather than starting ordinary capture',async()=>{
 const ui=queueUI({nativeError:{command:'file',taskId:tasks[1].id,part:1,message:'读取分段进度失败（ECONNRESET）'}});await ui.$('localPrepare').onclick();const done=ui.f.waitForValidation();await ui.$('localValidate').onclick();const report=await done;await new Promise(setImmediate);assert.equal(report.status,'blocked');assert.equal(ui.$('localResume').textContent,'继续验收');assert.equal(ui.$('localSummaryState').textContent,'已停止，需要继续');
 ui.f.configure({nativeError:null});const resumed=ui.f.waitForValidation();await ui.$('localResume').onclick();const next=await resumed;assert.equal(next.id,report.id);assert.equal(next.status,'finished');assert.equal(ui.commands.filter(m=>m.command==='validation_resume').length,1);assert.equal(ui.commands.some(m=>m.command==='resume'),false);
});
test('a selected mode remains selected when status is refreshed and an old helper is blocked before starting',async()=>{
 const ui=queueUI();await ui.$('localPrepare').onclick();ui.$('localMode').value='validation';ui.$('localMode').onchange();await ui.$('localStatus').onclick();assert.equal(ui.$('localMode').value,'validation');assert.equal(ui.$('localStart').textContent,'开始一键验收');ui.overrides.hello={ok:true,result:{version:'0.7.1'}};await ui.$('localStart').onclick();assert.match(ui.$('localMessage').textContent,/更新至 0.7.3/);assert.equal(ui.commands.some(m=>m.command==='validate'),false);
});
test('refreshed same-account tokens pass through the bridge once without changing progress or storing credentials',async()=>{
 const ui=queueUI();await ui.f.start([tasks[0]]);await ui.f.done;await new Promise(setImmediate);
 const state={owner:'ui-owner',phase:'uploading',running:true,taskId:tasks[0].id,part:95,count:100,tasks:[{...tasks[0],count:100,status:'running',files:Array.from({length:94},(_,i)=>({part:i+1,complete:true}))}],message:'上传并核验第 95 / 100 张'};
 ui.window.postMessage({type:'ART_LOCAL_PROGRESS',state},new URL(QUEUE).origin);await new Promise(setImmediate);
 const refreshed={user:{id:'ui-owner'},access_token:'rotated-ephemeral-token'};ui.authChange('TOKEN_REFRESHED',refreshed);await new Promise(r=>setTimeout(r,20));ui.authChange('TOKEN_REFRESHED',refreshed);await new Promise(r=>setTimeout(r,20));
 assert.equal(ui.commands.filter(m=>m.command==='refresh_session').length,1);assert.equal(ui.f.events.find(e=>e[0]==='native'&&e[1]==='refresh_session')[2].accessToken,'rotated-ephemeral-token');assert.match(ui.$('localCurrentCount').textContent,/94 \/ 100.*95/);assert.equal(JSON.stringify(ui.f.stored).includes('rotated-ephemeral-token'),false);
 ui.authChange('TOKEN_REFRESHED',{user:{id:'ui-owner'},access_token:'next-ephemeral-token'});await new Promise(r=>setTimeout(r,20));assert.equal(ui.commands.filter(m=>m.command==='refresh_session').length,2);
 ui.authChange('TOKEN_REFRESHED',{user:{id:'another-owner'},access_token:'wrong-account-token'});await new Promise(r=>setTimeout(r,20));assert.equal(ui.commands.filter(m=>m.command==='refresh_session').length,2);
 ui.window.postMessage({type:'ART_LOCAL_PROGRESS',state:{...state,phase:'paused',running:false}},new URL(QUEUE).origin);await new Promise(setImmediate);ui.authChange('TOKEN_REFRESHED',{user:{id:'ui-owner'},access_token:'paused-token'});await new Promise(r=>setTimeout(r,20));assert.equal(ui.commands.filter(m=>m.command==='refresh_session').length,2);
});
test('full acceptance readback is labelled as a recheck of a completed image',async()=>{
 const ui=queueUI();ui.window.postMessage({type:'ART_LOCAL_PROGRESS',state:{owner:'ui-owner',phase:'checking',running:true,tasks:[{...tasks[0],count:100,files:[]}],upload:{command:'task',verification:'readback',phase:'verifying',part:21,bytes:60,total:1000}}},new URL(QUEUE).origin);await new Promise(setImmediate);assert.match(ui.$('localCurrentCount').textContent,/验收复查已完成第 21 张/);assert.equal(ui.$('localProgress').textContent,'回读核验 6%');
});

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
 const owner='ui-owner',f=flow({acceptance:true,owner,...flowOptions}),elements=new Map(),handlers=new Map(),exports=[],commands=[];let runtimeMessage,authChange;const overrides={},sessionResult={data:{session:{user:{id:owner},access_token:'ephemeral-ui-session'}}};
 for(const [,id] of readFileSync(new URL('../queue.html',import.meta.url),'utf8').matchAll(/\bid="([^"]+)"/g))elements.set(id,new Element());
 const $=id=>{assert.ok(elements.has(id),'Missing UI element '+id);return elements.get(id);};
 const window={addEventListener(name,handler){if(!handlers.has(name))handlers.set(name,[]);handlers.get(name).push(handler);},postMessage(data,origin){queueMicrotask(()=>{for(const handler of handlers.get('message')||[])handler({source:window,origin,data});});}};
 const rows=flowOptions.queueRows||tasks.map(t=>({...t,source_type:'SUHA',source_url:t.source,display_title:t.title,master_count:0}));
 const ctx=vm.createContext({$,el:(tag,text)=>new Element(tag,text),user:{id:owner},queue:rows,batchIds:new Set(),allFiltered:()=>rows,render(){},downloadJSON:(report,name)=>exports.push({report:structuredClone(report),name}),location:{origin:new URL(QUEUE).origin,pathname:new URL(QUEUE).pathname},window,db:{auth:{getSession:async()=>sessionResult,onAuthStateChange(fn){authChange=fn;}}},crypto:{randomUUID},setTimeout:(fn,ms)=>ms>1000?randomUUID():setTimeout(fn,ms),clearTimeout(){},scheduleRefresh(){},URL,chrome:{runtime:{sendMessage:async message=>{commands.push(message);if(overrides[message.command])return overrides[message.command];return f.adapter.handle(message,{tab:{url:QUEUE},frameId:0});},onMessage:{addListener(fn){runtimeMessage=fn;}}}}});
 f.chrome.tabs.query=async()=>[{id:9999,url:QUEUE}];f.chrome.tabs.sendMessage=async(_id,message)=>runtimeMessage?.(message);
 vm.runInContext(readFileSync(new URL('../extension/local_bridge.js',import.meta.url),'utf8'),ctx);
 vm.runInContext(readFileSync(new URL('../capture-local.js',import.meta.url),'utf8'),ctx);
 return {f,$,ctx,rows,exports,commands,window,overrides,sessionResult,authChange:(event,session)=>authChange(event,session)};
}
function batchRows(count){return Array.from({length:count},(_,i)=>{const source_id=(i+1).toString(16).padStart(24,'0'),source='https://g2.ltfc.net/view/SUHA/'+source_id;return {id:randomUUID(),source_id,source,source_url:source,source_type:'SUHA',title:'批量作品 '+(i+1),display_title:'批量作品 '+(i+1),master_count:0};});}
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
 const ui=queueUI();ui.overrides.status={ok:true,result:{owner:'ui-owner',tasks:[],history:[]}};await ui.$('localValidate').onclick();assert.match(ui.$('localMessage').textContent,/完整更新至 v0.9.4/);assert.equal(ui.commands.some(m=>m.command==='validate'),false);
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
 const ui=queueUI({nativeError:{command:'file',taskId:tasks[1].id,part:1,message:'云端回读 SHA-256 或字节数不一致'}});await ui.$('localPrepare').onclick();const done=ui.f.waitForValidation();await ui.$('localValidate').onclick();const report=await done;await new Promise(setImmediate);assert.equal(report.status,'blocked');assert.equal(ui.$('localResume').textContent,'继续验收');assert.equal(ui.$('localSummaryState').textContent,'已停止，需要继续');
 ui.f.configure({nativeError:null});const resumed=ui.f.waitForValidation();await ui.$('localResume').onclick();const next=await resumed;assert.equal(next.id,report.id);assert.equal(next.status,'finished');assert.equal(ui.commands.filter(m=>m.command==='validation_resume').length,1);assert.equal(ui.commands.some(m=>m.command==='resume'),false);
});
test('a selected mode remains selected when status is refreshed and an old helper is blocked before starting',async()=>{
 const ui=queueUI();await ui.$('localPrepare').onclick();ui.$('localMode').value='validation';ui.$('localMode').onchange();await ui.$('localStatus').onclick();assert.equal(ui.$('localMode').value,'validation');assert.equal(ui.$('localStart').textContent,'开始一键验收');ui.overrides.hello={ok:true,result:{version:'0.7.1'}};await ui.$('localStart').onclick();assert.match(ui.$('localMessage').textContent,/更新至 0.7.4/);assert.equal(ui.commands.some(m=>m.command==='validate'),false);
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
test('automatic cleanup is opt-in, saved for its account and passed to uploads through the real UI bridge',async()=>{
 const ui=queueUI({acceptance:false});await ui.$('localStatus').onclick();assert.equal(ui.$('localAutoCleanup').checked,false);ui.$('localAutoCleanup').checked=true;await ui.$('localAutoCleanup').onchange();assert.equal(ui.f.stored.localCaptureCleanupPrefs['ui-owner'],true);
 await ui.$('localPrepare').onclick();await ui.$('localStart').onclick();await ui.f.done;await new Promise(setImmediate);assert.equal(ui.commands.find(m=>m.command==='start').autoCleanup,true);assert.equal(ui.f.events.filter(e=>e[0]==='native'&&e[1]==='file').every(e=>e[2].file.autoCleanup),true);assert.equal(ui.f.stored.localCaptureTasks.every(t=>t.files.every(f=>f.localDeleted)),true);assert.match(ui.$('localLog').children[0].children[1].textContent,/本地已清理 2 张/);
 const status=await ui.f.command('status',{ownerId:'other-owner'});assert.equal(status.result.autoCleanup,false);
});
test('manual cleanup uses authenticated commands and reports freed space without changing capture results',async()=>{
 const ui=queueUI();await ui.$('localCleanupCompleted').onclick();const command=ui.commands.find(m=>m.command==='cleanup');assert.equal(command.ownerId,'ui-owner');assert.equal(command.accessToken,'ephemeral-ui-session');assert.match(ui.$('localCleanupStatus').textContent,/已删除 2 张/);assert.equal(ui.f.stored.localCaptureTasks,undefined);assert.equal(JSON.stringify(ui.f.stored).includes('ephemeral-ui-session'),false);
});
test('cleanup progress remains separate from capture and ignores another account',async()=>{
 const ui=queueUI();ui.window.postMessage({type:'ART_LOCAL_CLEANUP_PROGRESS',state:{owner:'ui-owner',phase:'verifying',stage:'回读核验母图',index:21,totalFiles:100,bytes:6,total:100}},new URL(QUEUE).origin);await new Promise(setImmediate);assert.match(ui.$('localCleanupStatus').textContent,/清理 21 \/ 100.*6%/);assert.equal(ui.$('localSummaryState').textContent,'正在清理本地原图');assert.equal(ui.$('localStart').disabled,true);assert.equal(ui.$('localPause').disabled,false);
 ui.window.postMessage({type:'ART_LOCAL_CLEANUP_PROGRESS',state:{owner:'other-owner',phase:'finished',stage:'秘密记录'}},new URL(QUEUE).origin);await new Promise(setImmediate);assert.equal(ui.$('localStart').disabled,true);assert.equal(ui.$('localCleanupStatus').textContent.includes('秘密记录'),false);
 ui.window.postMessage({type:'ART_LOCAL_CLEANUP_PROGRESS',state:{owner:'ui-owner',phase:'finished'}},new URL(QUEUE).origin);await new Promise(setImmediate);assert.equal(ui.$('localStart').disabled,false);
});
test('an old plugin refuses the cleanup option immediately with its upgrade instruction',async()=>{
 const ui=queueUI();ui.overrides.status={ok:true,result:{version:'0.9.1',owner:'ui-owner',tasks:[],history:[]}};ui.$('localAutoCleanup').checked=true;await ui.$('localAutoCleanup').onchange();assert.match(ui.$('localCleanupStatus').textContent,/v0.9.4/);assert.equal(ui.commands.some(m=>m.command==='cleanup_settings'),false);
});
test('manual cleanup refreshes its own credentials and pauses on account change even without a prior capture batch',async()=>{
 let release;const blocker=new Promise(r=>{release=r;});const ui=queueUI({nativeWait:{command:'cleanup',promise:blocker}});const cleaning=ui.$('localCleanupCompleted').onclick();await new Promise(r=>setTimeout(r,20));assert.ok(ui.f.events.some(e=>e[0]==='native'&&e[1]==='cleanup'));
 ui.authChange('TOKEN_REFRESHED',{user:{id:'ui-owner'},access_token:'cleanup-refreshed-token'});await new Promise(r=>setTimeout(r,20));assert.ok(ui.f.events.some(e=>e[0]==='native'&&e[1]==='refresh_session'&&e[2].ownerId==='ui-owner'));assert.equal(JSON.stringify(ui.f.stored).includes('cleanup-refreshed-token'),false);
 ui.authChange('SIGNED_IN',{user:{id:'other-owner'}});await new Promise(setImmediate);assert.ok(ui.f.events.some(e=>e[0]==='native'&&e[1]==='pause'));release();await cleaning;
});
test('default all prepares and executes every eligible work instead of the old three-work slice',async()=>{
 const rows=batchRows(25),ui=queueUI({queueRows:rows,acceptance:false,fileCount:1,instantDownloads:true});assert.equal(ui.$('localBatchSize').value,'all');await ui.$('localPrepare').onclick();assert.equal(ui.$('localTasks').children.length,25);await ui.$('localStart').onclick();await ui.f.done;await new Promise(setImmediate);assert.equal(ui.commands.find(m=>m.command==='start').tasks.length,25);assert.equal(ui.f.stored.localCaptureTasks.filter(t=>t.status==='complete').length,25);assert.match(ui.$('localBatchProgress').textContent,/本批 25 幅 · 已完成 25 幅/);assert.equal(ui.$('localLog').children.length,5,'last-page rendering is bounded instead of rebuilding all 25 rows');
});
test('a saved twenty-work limit remains account scoped and changing it invalidates only the prepared selection',async()=>{
 const ui=queueUI({queueRows:batchRows(60),acceptance:false});ui.$('localBatchSize').value='20';await ui.$('localBatchSize').onchange();await ui.$('localPrepare').onclick();assert.equal(ui.$('localTasks').children.length,20);assert.equal(ui.f.stored.localCaptureBatchPrefs['ui-owner'],'20');await ui.$('localStatus').onclick();assert.equal(ui.$('localBatchSize').value,'20');assert.equal((await ui.f.command('status',{ownerId:'other-owner'})).result.batchSize,'all');ui.$('localBatchSize').value='50';await ui.$('localBatchSize').onchange();assert.equal(ui.$('localTasks').children.length,0);assert.equal(ui.f.stored.localCaptureTasks,undefined);await ui.$('localPrepare').onclick();assert.equal(ui.$('localTasks').children.length,50);
});
test('the saved count is restored before preparation even before the first runtime poll',async()=>{
 const ui=queueUI({queueRows:batchRows(60),initialStored:{localCaptureBatchPrefs:{'ui-owner':'20'}}});assert.equal(ui.$('localBatchSize').value,'all');await ui.$('localPrepare').onclick();assert.equal(ui.$('localBatchSize').value,'20');assert.equal(ui.$('localTasks').children.length,20);
});
test('all selection excludes completed, paused, unsupported and ambiguous works but preserves known partial work',async()=>{
 const rows=batchRows(8);rows[0].paused=true;rows[1].source_type='OTHER';rows[2].candidate_count=2;rows[3].master_count=1;const ui=queueUI({queueRows:rows,initialStored:{localCaptureHistory:[{...rows[4],owner:'ui-owner',status:'complete'},{...rows[5],owner:'ui-owner',status:'failed',count:2,files:[{part:1,complete:true}]}]}});rows[5].master_count=1;await ui.$('localPrepare').onclick();const ids=ui.$('localTasks').children.map(row=>row.children[0].dataset.localTaskId);assert.deepEqual(ids,[rows[6].id,rows[7].id,rows[5].id]);
});
test('an explicitly selected subset remains the capture scope even when quantity is all',async()=>{
 const rows=batchRows(30),ui=queueUI({queueRows:rows});vm.runInContext('batchIds.add(queue[8].id);batchIds.add(queue[22].id)',ui.ctx);await ui.$('localPrepare').onclick();assert.equal(ui.$('localTasks').children.length,2);assert.match(ui.$('localMessage').textContent,/所选作品/);
});
test('changing to validation clears a large prepared batch and still runs at most three works',async()=>{
 const ui=queueUI({queueRows:batchRows(12),fileCount:1,instantDownloads:true});await ui.$('localPrepare').onclick();assert.equal(ui.$('localTasks').children.length,12);ui.$('localMode').value='validation';ui.$('localMode').onchange();assert.equal(ui.$('localTasks').children.length,0);assert.equal(ui.$('localBatchSize').disabled,true);const done=ui.f.waitForValidation();await ui.$('localStart').onclick();const report=await done;assert.equal(report.tasks.length,3);assert.equal(ui.commands.find(m=>m.command==='validate').tasks.length,3);
});
test('large-batch records follow the active page and can be browsed without moving the current task',async()=>{
 const rows=batchRows(50),ui=queueUI({queueRows:rows}),work=rows.map((t,i)=>({...t,status:i<10?'complete':i===10||i===11?'failed':i===25?'running':'pending',files:[]}));ui.window.postMessage({type:'ART_LOCAL_PROGRESS',state:{owner:'ui-owner',phase:'opening',running:true,tasks:work,taskId:rows[25].id}},new URL(QUEUE).origin);await new Promise(setImmediate);assert.equal(ui.$('localLog').children.length,20);assert.match(ui.$('localRecordsPage').textContent,/第 2 \/ 3 页/);assert.match(ui.$('localBatchProgress').textContent,/50 幅.*已完成 10 幅.*失败 2 幅.*待处理 37 幅/);ui.$('localRecordsPrev').onclick();assert.match(ui.$('localRecordsPage').textContent,/第 1 \/ 3 页/);ui.window.postMessage({type:'ART_LOCAL_PROGRESS',state:{owner:'ui-owner',phase:'opening',running:true,tasks:work,taskId:rows[40].id}},new URL(QUEUE).origin);await new Promise(setImmediate);assert.match(ui.$('localRecordsPage').textContent,/第 1 \/ 3 页/);ui.$('localRecordsFollow').onclick();assert.match(ui.$('localRecordsPage').textContent,/第 3 \/ 3 页/);assert.equal(ui.$('localLog').children.length,10);assert.equal(ui.$('localCurrentWork').textContent,rows[40].title);
});
test('five-minute recovery obtains a fresh session through the real page bridge and finishes without repeating completed files',async()=>{
 const ui=queueUI({recoveryClock:true,nativeError:{command:'file',taskId:tasks[0].id,part:2,info:{code:'ART_NETWORK',retryable:true}}});await ui.$('localPrepare').onclick();await ui.$('localStart').onclick();await ui.f.done;await new Promise(setImmediate);
 assert.equal(ui.$('localSummaryState').textContent,'网络中断，等待自动恢复');assert.match(ui.$('localProgress').textContent,/下次尝试：/);assert.equal(ui.$('localResume').textContent,'立即重试');assert.equal(ui.$('localPause').disabled,false);assert.equal(ui.$('localPrepare').disabled,true);
 ui.sessionResult.data.session.access_token='fresh-recovery-session';ui.f.configure({nativeError:null});const done=ui.f.waitForFinish();ui.f.advance(300000);await ui.f.adapter.retryNetworkDue();await done;await new Promise(setImmediate);
 assert.equal(ui.commands.find(m=>m.command==='network_retry').accessToken,'fresh-recovery-session');assert.equal(ui.commands.some(m=>m.command==='resume'),false);assert.equal(ui.f.stored.localCaptureTasks.every(t=>t.status==='complete'),true);assert.equal(ui.f.events.filter(e=>e[0]==='click-original'&&e[1]===1&&e[2]===tasks[0].source).length,1);assert.equal(JSON.stringify(ui.f.stored).includes('fresh-recovery-session'),false);
});
test('retry now handles an initial offline session without needing a previously saved batch',async()=>{
 const ui=queueUI({recoveryClock:true,nativeError:{command:'session',info:{code:'ART_NETWORK',retryable:true}}});await ui.$('localPrepare').onclick();await ui.$('localStart').onclick();await new Promise(setImmediate);assert.equal(ui.$('localResume').textContent,'立即重试');assert.equal(ui.f.stored.localCaptureTasks,undefined);
 ui.f.configure({nativeError:null});const done=ui.f.waitForFinish();await ui.$('localResume').onclick();await done;await new Promise(setImmediate);assert.equal(ui.commands.filter(m=>m.command==='network_retry_now').length,1);assert.equal(ui.f.stored.localCaptureTasks.length,2);assert.equal(ui.f.stored.localCaptureNetworkRetry,null);
});
test('temporary session refresh failure stays scheduled, while signed-out login stops recovery clearly',async()=>{
 const ui=queueUI({recoveryClock:true,nativeError:{command:'file',part:1,info:{code:'ART_NETWORK',retryable:true}}});await ui.$('localPrepare').onclick();await ui.$('localStart').onclick();await ui.f.done;await new Promise(setImmediate);
 ui.sessionResult.error={name:'AuthRetryableFetchError',message:'Failed to fetch'};ui.sessionResult.data.session=null;ui.f.advance(300000);await ui.f.adapter.retryNetworkDue();await new Promise(setImmediate);assert.equal(ui.f.stored.localCaptureNetworkRetry.phase,'waiting');assert.equal(ui.f.events.filter(e=>e[0]==='native'&&e[1]==='file').length,1);
 ui.sessionResult.error=null;ui.f.advance(300000);await ui.f.adapter.retryNetworkDue();await new Promise(setImmediate);assert.equal(ui.f.stored.localCaptureNetworkRetry,null);assert.match(ui.$('localMessage').textContent,/登录/);assert.equal(ui.$('localResume').textContent,'继续采集');assert.equal(ui.$('localPrepare').disabled,false);
});
test('account change cancels a queued retry before it can obtain a token for the other account',async()=>{
 const ui=queueUI({recoveryClock:true,nativeError:{command:'file',part:1,info:{code:'ART_NETWORK',retryable:true}}});await ui.$('localPrepare').onclick();await ui.$('localStart').onclick();await ui.f.done;await new Promise(setImmediate);ui.authChange('SIGNED_IN',{user:{id:'other-owner'}});await new Promise(setImmediate);assert.equal(ui.f.stored.localCaptureNetworkRetry,null);assert.equal(ui.f.alarms.size,0);ui.f.advance(300000);assert.equal(await ui.f.adapter.retryNetworkDue(),false);assert.equal(ui.commands.some(m=>m.command==='network_retry'),false);
});
test('duplicate image errors display the stopped part and do not suggest that restoring the network can fix them',async()=>{
 const ui=queueUI(),task={...tasks[0],title:'道子墨宝',status:'failed',count:51,error:'此原图与另一分段完全相同，请核对是否切换到了下一张',errorStage:'uploading',files:Array.from({length:44},(_,i)=>({part:i+1,complete:true}))};ui.window.postMessage({type:'ART_LOCAL_PROGRESS',state:{owner:'ui-owner',phase:'blocked',running:false,taskId:task.id,part:45,tasks:[task]}},new URL(QUEUE).origin);await new Promise(setImmediate);assert.match(ui.$('localCurrentCount').textContent,/44 \/ 51.*第 45 张/);assert.match(ui.$('localActionHint').textContent,/重复原图已拦截/);assert.equal(ui.$('localActionHint').textContent.includes('网络恢复'),false);
});

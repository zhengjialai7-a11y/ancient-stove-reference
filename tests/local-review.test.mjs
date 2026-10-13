import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {flow,tasks,QUEUE} from './local-flow-helper.mjs';

test('a storage limit is retained for review while the next artwork completes',async()=>{
 const f=flow({nativeError:{command:'file',taskId:tasks[0].id,part:2,message:'R2 母图服务尚未启用，本地原图已保留',info:{code:'ART_STORAGE_LIMIT'}}});await f.start(tasks);await f.done;await new Promise(setImmediate);
 const failed=f.stored.localCaptureTasks[0];assert.equal(failed.status,'failed');assert.equal(failed.review.kind,'storage');assert.equal(failed.files.filter(x=>x.complete).length,1);assert.equal(failed.failures.length,1);assert.equal(f.stored.localCaptureTasks[1].status,'complete');assert.equal(f.stored.localCaptureNetworkRetry,null);
});
test('HTTP 413 is a storage issue rather than a repeated network retry',()=>{
 const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../extension/capture_issues.js',import.meta.url),'utf8')+';globalThis.issues=CaptureIssues;',context);
 assert.equal(context.issues.kind({code:'ART_HTTP',status:413},'uploading'),'storage');assert.equal(context.issues.global({code:'ART_HTTP',status:413},'uploading'),false);
});

test('manual review errors at upload or cloud checking are retained and the next artwork finishes',async()=>{
 for(const command of ['task','file'])for(const message of ['此原图与另一分段完全相同，请核对是否切换到了下一张','来源关联需要人工确认','云端回读 SHA-256 或字节数不一致','相同原图已属于其他项目，需要人工确认']){
  const f=flow({nativeError:{command,taskId:tasks[0].id,message}});await f.start(tasks);await f.done;await new Promise(setImmediate);assert.equal(f.stored.localCaptureTasks[0].status,'failed');assert.equal(f.stored.localCaptureTasks[0].failures.length,1);assert.equal(f.stored.localCaptureTasks[0].review.status,'pending');assert.equal(f.stored.localCaptureTasks[1].status,'complete');assert.equal(f.stored.localCaptureState.phase,'finished');assert.equal(f.stored.localCaptureNetworkRetry,null);assert.equal(f.tabs.size,0);
 }
});
test('duplicate IDs and invalid sources are skipped before transfer without aborting valid works',async()=>{
 const f=flow();await f.start([tasks[0],tasks[0],tasks[1],{id:'cccccccc-cccc-cccc-cccc-cccccccccccc',source:'https://example.test/unbound',source_id:'bad'}]);await f.done;assert.equal(f.stored.localCaptureTasks.length,3);assert.equal(f.stored.localCaptureTasks.filter(t=>t.status==='complete').length,1);assert.equal(f.stored.localCaptureTasks.filter(t=>t.review?.status==='pending').length,2);assert.equal(f.events.filter(e=>e[0]==='open').length,1);assert.equal(f.events.filter(e=>e[0]==='native'&&e[1]==='file').every(e=>e[2].file.taskId===tasks[1].id),true);
});
test('45 of a 51-part collection can be redownloaded while its 44 completed parts and failure history remain intact',async()=>{
 const completed=Array.from({length:44},(_,i)=>i+1),f=flow({fileCount:51,instantDownloads:true,completed:id=>id===tasks[0].id?completed:[],nativeError:{command:'file',taskId:tasks[0].id,part:45,message:'此原图与另一分段完全相同，请核对是否切换到了下一张'}});await f.start(tasks);await f.done;await new Promise(setImmediate);const task=f.stored.localCaptureTasks.find(t=>t.id===tasks[0].id);assert.equal(task.review.part,45);assert.equal(task.files.filter(f=>f.complete).length,44);assert.equal(f.stored.localCaptureTasks[1].status,'complete');
 f.configure({nativeError:null});const done=f.waitForFinish();assert.equal((await f.command('review_redownload',{taskIds:[task.id],part:45})).ok,true);await done;await new Promise(setImmediate);const repaired=f.stored.localCaptureTasks[0];assert.equal(repaired.status,'complete');assert.equal(repaired.files.filter(f=>f.complete).length,51);assert.equal(repaired.review.status,'resolved');assert.equal(repaired.failures.length,1);assert.equal(repaired.repairs[0].part,45);assert.equal(f.events.filter(e=>e[0]==='click-original'&&e[1]===45&&e[2]===task.source).length,2);assert.equal(f.events.some(e=>e[0]==='click-original'&&e[1]<45&&e[2]===task.source),false);assert.equal(f.events.filter(e=>e[0]==='open'&&e[1]===tasks[1].source).length,1);
 const reset=f.events.find(e=>e[0]==='native'&&e[1]==='reset_failed_part')[2].file;assert.equal(reset.taskId,task.id);assert.equal(reset.source,task.source);assert.equal(reset.count,51);
});
test('ordinary resume leaves manual problems pending; selected review retry uses the saved download',async()=>{
 const f=flow({nativeError:{command:'file',taskId:tasks[0].id,part:2,message:'云端回读 SHA-256 或字节数不一致'}});await f.start(tasks);await f.done;await new Promise(setImmediate);const opens=f.events.filter(e=>e[0]==='open').length,clicks=f.events.filter(e=>e[0]==='click-original').length;f.configure({nativeError:null,completed:id=>id===tasks[0].id?[1]:[1,2]});let done=f.waitForFinish();await f.command('resume');await done;assert.equal(f.events.filter(e=>e[0]==='open').length,opens);
 done=f.waitForFinish();await f.command('review_retry',{taskIds:[tasks[0].id]});await done;assert.equal(f.events.filter(e=>e[0]==='click-original').length,clicks);assert.equal(f.stored.localCaptureTasks[0].status,'complete');assert.equal(f.stored.localCaptureTasks[0].failures.length,1);
});
test('completed part reset, foreign owner retry and stale failure part are refused before repair',async()=>{
 const f=flow({owner:'owner-a',nativeError:{command:'file',taskId:tasks[0].id,part:2,message:'人工核对'}});await f.start(tasks);await f.done;await new Promise(setImmediate);const result=await f.command('review_redownload',{taskIds:[tasks[0].id],part:1});assert.equal(result.ok,false);assert.equal(f.events.some(e=>e[0]==='native'&&e[1]==='reset_failed_part'),false);f.configure({owner:'owner-b'});assert.equal((await f.command('review_retry',{taskIds:[tasks[0].id]})).ok,false);assert.equal(f.stored.localCaptureOwner,'owner-a');
});
test('review notes and deferred state persist per account and do not erase failures',async()=>{
 const f=flow({nativeError:{command:'file',taskId:tasks[0].id,message:'人工核对'}});await f.start(tasks);await f.done;await new Promise(setImmediate);const failureAt=f.stored.localCaptureTasks[0].failedAt;await f.command('review_update',{taskId:tasks[0].id,reviewStatus:'deferred',failureAt,note:'稍后核对重复的分段'});const restored=flow({initialStored:f.stored});const status=(await restored.command('status')).result;assert.equal(status.reviewChoices[tasks[0].id].note,'稍后核对重复的分段');assert.equal(status.history.find(t=>t.id===tasks[0].id).failures.length,1);assert.deepEqual(structuredClone((await restored.command('status',{ownerId:'other'})).result.reviewChoices),{});
});
test('pausing a delayed repair does not restart downloads or overwrite saved file evidence',async()=>{
 let release;const wait=new Promise(r=>release=r),f=flow({nativeWait:{command:'reset_failed_part',promise:wait},nativeError:{command:'file',taskId:tasks[0].id,part:2,message:'人工核对'}});await f.start(tasks);await f.done;await new Promise(setImmediate);const filename=f.stored.localCaptureTasks[0].files.find(f=>f.part===2).filename,clicks=f.events.filter(e=>e[0]==='click-original').length;
 const repairing=f.command('review_redownload',{taskIds:[tasks[0].id],part:2});await new Promise(setImmediate);await f.command('pause');release();assert.equal((await repairing).ok,false);assert.equal(f.events.filter(e=>e[0]==='click-original').length,clicks);assert.equal(f.stored.localCaptureTasks[0].files.find(f=>f.part===2).filename,filename);
});
test('a new batch preserves a completed artwork when its count is mistyped and still collects the next artwork',async()=>{
 const file={part:1,count:1,filename:'C:/Downloads/verified.jpg',complete:true,masterId:'verified-master',projectId:'verified-project',localDeleted:true,cleanup:{status:'deleted'}},completedAt='2026-10-13T10:00:00.000Z',completed={...tasks[0],owner:'test-owner',count:1,status:'complete',files:[file],completedAt,failures:[]},initialStored={localCaptureOwner:'test-owner',localCaptureTasks:[completed],localCaptureHistory:[completed]},f=flow({fileCount:1,instantDownloads:true,initialStored});assert.equal((await f.start([{...tasks[0],count:2},{...tasks[1],count:1}])).ok,true);await f.done;const preserved=f.stored.localCaptureTasks.find(t=>t.id===tasks[0].id);assert.equal(preserved.status,'complete');assert.equal(preserved.count,1);assert.equal(preserved.completedAt,completedAt);assert.deepEqual(preserved.files,[file]);assert.equal(preserved.review.kind,'count');assert.equal(preserved.review.status,'resolved');assert.equal(preserved.failures.at(-1).preservedComplete,true);assert.equal(f.stored.localCaptureTasks.find(t=>t.id===tasks[1].id).status,'complete');assert.equal(f.events.some(e=>e[0]==='open'&&e[1]===tasks[0].source),false);assert.equal(f.events.filter(e=>e[0]==='native'&&e[1]==='file').length,1);
});
test('Chrome download network errors have accurate review labels without changing global upload safety',()=>{
 const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../extension/capture_issues.js',import.meta.url),'utf8')+';globalThis.issues=CaptureIssues;',context);for(const code of ['NETWORK_FAILED','NETWORK_TIMEOUT','NETWORK_DISCONNECTED','NETWORK_SERVER_DOWN','SERVER_FAILED','SERVER_UNREACHABLE']){assert.equal(context.issues.kind({code},'downloading'),'network');assert.equal(context.issues.global({code},'downloading'),false);assert.equal(context.issues.global({code},'uploading'),true);}assert.equal(context.issues.global({code:'ART_AUTH'},'downloading'),true);assert.equal(context.issues.global({code:'ENOSPC'},'uploading'),true);
});
test('review deep links accept the exact queue page with query or hash fragments',async()=>{
 const f=flow();for(const url of [QUEUE+'#review',QUEUE+'?filter=needs_review#review'])assert.equal((await f.adapter.handle({type:'localCaptureCommand',command:'status',ownerId:'test-owner'},{tab:{url},frameId:0})).ok,true);
});
test('lookalike paths and foreign origins cannot dispatch collection commands through a review link',async()=>{
 const f=flow();for(const url of [QUEUE+'/evil#review',QUEUE.replace('/queue.html','/queue.html.evil')+'#review',QUEUE.replace('zhengjialai7-a11y.github.io','evil.example')+'#review','https://user:password@zhengjialai7-a11y.github.io/ancient-stove-reference/queue.html#review']){const result=await f.adapter.handle({type:'localCaptureCommand',command:'hello'},{tab:{url},frameId:0});assert.equal(result.ok,false);assert.match(result.error,/只允许收藏队列/);}assert.equal(f.events.some(e=>e[0]==='native'),false);
});
test('review commands are refused from child frames even when their URL is the queue page',async()=>{
 const f=flow();for(const frameId of [1,undefined])assert.equal((await f.adapter.handle({type:'localCaptureCommand',command:'hello'},{tab:{url:QUEUE+'#review'},frameId})).ok,false);assert.equal(f.events.some(e=>e[0]==='native'),false);
});

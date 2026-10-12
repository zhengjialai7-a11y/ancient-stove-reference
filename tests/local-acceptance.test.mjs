import test from 'node:test';
import assert from 'node:assert/strict';
import {flow,tasks} from './local-flow-helper.mjs';

async function runValidation(options={}){const f=flow({acceptance:true,...options});const finished=f.waitForValidation();assert.equal((await f.command('validate',{tasks})).ok,true);return {f,report:await finished};}
function reorderKeys(value){if(Array.isArray(value))return value.map(reorderKeys);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,reorderKeys(value[key])]));return value;}
test('one click runs real cancel/skip, multi-image pause/resume and duplicate cloud-readback reuse',async()=>{
 const {f,report}=await runValidation();
 assert.equal(report.status,'finished');for(const key of ['pipeline','multi','skip','pause','repeat'])assert.equal(report.checks[key].status,'passed',key+' '+report.checks[key].detail);
 assert.equal(report.checks.restart.status,'pending');assert.equal(report.probe.observed,true);assert.equal(f.events.filter(e=>e[0]==='cancel').length,1);
 const cancelled=f.events.find(e=>e[0]==='cancel')[1];assert.equal(report.downloads.some(d=>d.downloadId===cancelled),false);
 assert.equal(report.uploads.length,4);assert.equal(report.checks.repeat.evidence.downloads,0);assert.equal(report.checks.repeat.evidence.uploads,0);assert.equal(report.reuses.some(r=>r.taskId===report.pauseProbe.taskId&&r.part===report.pauseProbe.part),true);
 assert.ok(f.events.some(e=>e[0]==='native'&&e[1]==='pause'));assert.equal(report.tasks.length,2);assert.equal(f.tabs.size,0,'automatic pause and resume must close their own artwork tabs');
 assert.equal(JSON.stringify(report).includes('test-session-in-memory'),false);assert.equal(JSON.stringify(report).includes('C:\\Downloads'),false);assert.equal(JSON.stringify(report).includes('blob:https'),false);
});
test('single-image works and downloads that finish before cancellation stay pending instead of claiming coverage',async()=>{
 const {report}=await runValidation({fileCount:1,instantDownloads:true});assert.equal(report.checks.pipeline.status,'passed');assert.equal(report.checks.multi.status,'pending');assert.equal(report.checks.pause.status,'pending');assert.equal(report.checks.skip.status,'pending');assert.equal(report.checks.repeat.status,'passed');
});
test('a cancellation API failure does not fake an interrupted download or block normal collection',async()=>{
 const {report}=await runValidation({cancelError:true});assert.equal(report.probe.observed,false);assert.match(report.probe.cancelError,/取消操作失败/);assert.equal(report.checks.skip.status,'pending');assert.equal(report.checks.pipeline.status,'passed');
});
test('manual pause during the acceptance checkpoint halts automation until explicit resume',async()=>{
 const {f,report}=await runValidation({pauseAtCheckpoint:true});assert.equal(report.status,'paused');assert.equal(report.pauseProbe.resumedAt,null);const opens=f.events.filter(e=>e[0]==='open').length;await Promise.resolve();assert.equal(f.events.filter(e=>e[0]==='open').length,opens);
 await new Promise(setImmediate);f.configure({pauseAtCheckpoint:false});const done=f.waitForValidation();assert.equal((await f.command('validation_resume')).ok,true);const resumed=await done;assert.equal(resumed.id,report.id);assert.equal(resumed.status,'finished');assert.equal(resumed.checks.pause.status,'passed');assert.equal(resumed.probe.observed,true);assert.equal(f.events.filter(e=>e[0]==='cancel').length,1);
});
test('native upload errors stop acceptance with retained reasons, not an automatic success',async()=>{
 const {report}=await runValidation({nativeError:{command:'file',taskId:tasks[1].id,part:1}});assert.equal(report.status,'blocked');assert.match(report.error,/本机助手连接或云端上传失败/);assert.notEqual(report.checks.pipeline.status,'passed');assert.notEqual(report.checks.repeat.status,'passed');
});
test('the repeat check fails when cloud completion receipts disappear and native upload is invoked again',async()=>{
 const {report}=await runValidation({missingVerified:true});assert.equal(report.checks.repeat.status,'failed');assert.ok(report.checks.repeat.evidence.uploads>0);
});
test('extension worker reload alone cannot pass a real browser startup retention check',async()=>{
 const {f,report}=await runValidation();const reloaded=flow({acceptance:true,initialStored:f.stored});const status=await reloaded.command('validation_status');assert.equal(status.result.report.id,report.id);const checked=await reloaded.command('validation_restart');assert.equal(checked.ok,true);assert.equal(checked.result.report.checks.restart.status,'pending');assert.equal(checked.result.report.tasks.length,2);
});
test('browser startup plus retained parts and failure history passes restart retention',async()=>{
 const {f}=await runValidation();const restarted=flow({acceptance:true,initialStored:f.stored});await restarted.acceptanceAPI.browserStarted();const result=await restarted.command('validation_restart');assert.equal(result.ok,true);assert.equal(result.result.report.checks.restart.status,'passed');assert.equal(result.result.report.tasks.length,2);
});
test('browser storage property order and multipart record order do not falsely fail restart retention',async()=>{
 const {f}=await runValidation();const saved=reorderKeys(f.stored);for(const task of saved.localCaptureHistory)task.files.reverse();const restarted=flow({acceptance:true,initialStored:saved});await restarted.acceptanceAPI.browserStarted();const checked=await restarted.command('validation_restart');assert.equal(checked.ok,true);assert.equal(checked.result.report.checks.restart.status,'passed');assert.equal(checked.result.report.checks.restart.evidence.differences.length,0);
});
test('a stored repeat baseline with reordered JSON keys can resume and reuse the same masters',async()=>{
 const {f}=await runValidation();const saved=reorderKeys(f.stored);saved.localCaptureValidation.status='paused';saved.localCaptureValidation.phase='repeat';const restored=flow({acceptance:true,initialStored:saved}),done=restored.waitForValidation();assert.equal((await restored.command('validation_resume')).ok,true);const report=await done;assert.equal(report.checks.repeat.status,'passed');assert.equal(report.checks.repeat.evidence.uploads,0);assert.equal(restored.events.some(e=>e[0]==='click-original'),false);
});
test('changed master IDs still fail restart retention and identify the affected part records',async()=>{
 const {f}=await runValidation();const saved=reorderKeys(f.stored);saved.localCaptureHistory.find(t=>t.id===tasks[1].id).files[0].masterId='changed-master';const restarted=flow({acceptance:true,initialStored:saved});await restarted.acceptanceAPI.browserStarted();const checked=await restarted.command('validation_restart');assert.equal(checked.result.report.checks.restart.status,'failed');assert.deepEqual(checked.result.report.checks.restart.evidence.differences,[{taskId:tasks[1].id,fields:['files']}]);
});
test('losing historical failure records after browser startup fails retention',async()=>{
 const {f}=await runValidation();const saved=structuredClone(f.stored);saved.localCaptureHistory.find(t=>t.id===tasks[0].id).failures=[];const restarted=flow({acceptance:true,initialStored:saved});await restarted.acceptanceAPI.browserStarted();const checked=await restarted.command('validation_restart');assert.equal(checked.result.report.checks.restart.status,'failed');
});
test('another account cannot read or resume an acceptance report',async()=>{
 const {f}=await runValidation();const other=flow({acceptance:true,owner:'other-owner',initialStored:f.stored});assert.equal((await other.command('validation_status')).result.report,null);const resume=await other.command('validation_resume');assert.equal(resume.ok,false);assert.match(resume.error,/其他账号/);assert.equal((await other.command('validation_restart')).ok,false);
});

test('one selected work cannot prove that a different artwork continued after the test failure',async()=>{
 const f=flow({acceptance:true}),done=f.waitForValidation();assert.equal((await f.command('validate',{tasks:[tasks[0]]})).ok,true);const report=await done;assert.equal(report.checks.pipeline.status,'passed');assert.equal(report.checks.skip.status,'pending');assert.equal(report.tasks.length,1);
});
test('already completed multipart work is verified but cannot claim newly exercised multi-download coverage',async()=>{
 const {f}=await runValidation();const reused=flow({acceptance:true,initialStored:f.stored}),done=reused.waitForValidation();assert.equal((await reused.command('validate',{tasks})).ok,true);const report=await done;assert.equal(report.downloads.length,0);assert.equal(report.checks.multi.status,'pending');assert.equal(report.checks.skip.status,'pending');assert.equal(report.checks.repeat.status,'passed');assert.match(report.checks.pipeline.detail,/上传 0 张/);
});
test('ordinary capture cannot replace the active acceptance batch',async()=>{
 const f=flow({acceptance:true}),done=f.waitForValidation();assert.equal((await f.command('validate',{tasks})).ok,true);const start=await f.command('start',{tasks:[tasks[0]]});assert.equal(start.ok,false);assert.match(start.error,/正在运行/);assert.equal((await done).tasks.length,2);
});
test('exports redact native error URLs and full Windows paths while retaining the failure stage',async()=>{
 const {report}=await runValidation({nativeError:{command:'file',taskId:tasks[1].id,part:1,message:"错误 https://example.test/object?token=secret C:\\Users\\PrivateName\\Downloads\\原图.jpg"}});assert.equal(report.status,'blocked');const content=JSON.stringify(report);assert.equal(content.includes('PrivateName'),false);assert.equal(content.includes('token=secret'),false);assert.match(report.error,/本机路径/);assert.ok(report.events.some(e=>e.type==='stopped'&&e.stage==='uploading'));
});
test('resume rejects a changed artwork source before opening a page',async()=>{
 const {f}=await runValidation({pauseAtCheckpoint:true});await new Promise(setImmediate);const saved=structuredClone(f.stored);saved.localCaptureTasks[0].source=tasks[1].source;const restored=flow({acceptance:true,initialStored:saved});const resumed=await restored.command('validation_resume');assert.equal(resumed.ok,false);assert.match(resumed.error,/批次已改变/);assert.equal(restored.events.some(e=>e[0]==='open'),false);
});

test('an interrupted acceptance resumes its persisted checkpoint in a new extension worker without repeating cancellation',async()=>{
 const {f,report}=await runValidation({pauseAtCheckpoint:true});await new Promise(setImmediate);const restored=flow({acceptance:true,initialStored:f.stored});await restored.acceptanceAPI.browserStarted();const done=restored.waitForValidation();assert.equal((await restored.command('validation_resume')).ok,true);const resumed=await done;assert.equal(resumed.id,report.id);assert.equal(resumed.status,'finished');assert.equal(resumed.checks.pause.status,'passed');assert.equal(resumed.checks.repeat.status,'passed');assert.equal(restored.events.filter(e=>e[0]==='cancel').length,0);
});

test('a browser restart during an interrupted run does not prove retention of the final post-resume result',async()=>{
 const {f}=await runValidation({pauseAtCheckpoint:true});await new Promise(setImmediate);const restored=flow({acceptance:true,initialStored:f.stored});await restored.acceptanceAPI.browserStarted();const done=restored.waitForValidation();await restored.command('validation_resume');await done;await new Promise(setImmediate);const beforeNewRestart=await restored.command('validation_restart');assert.equal(beforeNewRestart.result.report.checks.restart.status,'pending');await restored.acceptanceAPI.browserStarted();const afterNewRestart=await restored.command('validation_restart');assert.equal(afterNewRestart.result.report.checks.restart.status,'passed');
});

test('a fast blob transfer can be cancelled through exact bound download events before the polling loop',async()=>{
 const {f,report}=await runValidation({fastEventDownloads:true});assert.equal(report.probe.observed,true);assert.equal(report.checks.skip.status,'passed');assert.equal(f.events.filter(e=>e[0]==='cancel').length,1);assert.equal(report.checks.pipeline.status,'passed');assert.equal(report.checks.repeat.status,'passed');
});

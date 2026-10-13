import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {flow,tasks} from './local-flow-helper.mjs';

const context=vm.createContext({});
vm.runInContext(readFileSync(new URL('../extension/network_retry.js',import.meta.url),'utf8')+';globalThis.retryAPI=CaptureNetworkRetry;',context);
const API=context.retryAPI,network=Object.assign(Error('读取进度失败（ECONNRESET）'),{code:'ART_NETWORK',retryable:true});
function fixture(options={}){
 let clock=10000,ids=0;const stored={},alarms=new Map(),requests=[],views=[],runs=[];
 const dependencies={storage:{async get(key){return {[key]:structuredClone(stored[key])};},async set(value){Object.assign(stored,structuredClone(value));}},alarms:{async create(name,value){alarms.set(name,value);},async clear(name){alarms.delete(name);}},now:()=>clock,uuid:()=>String(++ids),publish:async(...args)=>views.push(args),requestSession:async request=>requests.push(request),run:async(job,token)=>{runs.push({job,token});return {ok:true};},...options};
 const manager=API.create(dependencies),intent={owner:'owner',mode:'collect',batch:'batch',intent:{command:'resume'},taskId:tasks[0].id,autoCleanup:true};
 const message=()=>({ownerId:'owner',retryId:stored[API.KEY].id,retryNonce:stored[API.KEY].requestNonce,accessToken:'memory-only-token'});
 return {manager,stored,alarms,requests,views,runs,intent,message,advance:ms=>clock+=ms,restart:()=>API.create(dependencies)};
}
test('only transient network failures qualify; auth, hash, source and cancellation remain manual',()=>{
 for(const error of [network,{code:'NETWORK_DISCONNECTED'},{code:'ART_HTTP',status:503,retryable:true},{message:'fetch failed'}])assert.equal(API.isNetworkError(error),true);
 for(const error of [{code:'ART_AUTH'},{code:'ART_PAUSED'},{code:'ART_NATIVE_MISSING'},{code:'USER_CANCELED'},{code:'ART_HTTP',status:401,retryable:true},{code:'ART_HTTP',status:400,retryable:true},{code:'ART_NETWORK',retryable:false},{message:'云端回读 SHA-256 或字节数不一致'},{message:'此原图与另一分段完全相同，请核对是否切换到了下一张'},{message:'作品来源地址不匹配'}])assert.equal(API.isNetworkError(error),false);
});
test('alarm waits a full five minutes and requests a fresh same-owner token without storing it',async()=>{
 const f=fixture();await f.manager.schedule(f.intent,network);assert.equal(f.stored[API.KEY].nextAttemptAt,310000);assert.equal(f.alarms.get(API.ALARM).when,310000);
 f.advance(299999);assert.equal(await f.manager.due(),false);assert.equal(f.requests.length,0);f.advance(1);assert.equal(await f.manager.due(),true);assert.equal(f.requests.length,1);
 assert.equal((await f.manager.accept(f.message())).ok,true);assert.equal(f.runs.length,1);assert.equal(f.runs[0].token,'memory-only-token');assert.equal(f.stored[API.KEY],null);assert.equal(f.alarms.size,0);assert.equal(JSON.stringify(f.views).includes('memory-only-token'),false);assert.equal(JSON.stringify(f.stored).includes('memory-only-token'),false);
});
test('continued disconnection schedules the next attempt another five minutes later',async()=>{
 const f=fixture({run:async()=>({ok:false,error:'读取进度失败（ECONNRESET）',errorInfo:{code:'ART_NETWORK',retryable:true}})});await f.manager.schedule(f.intent,network);f.advance(300000);await f.manager.due();await f.manager.accept(f.message());assert.equal(f.stored[API.KEY].attempt,1);assert.equal(f.stored[API.KEY].nextAttemptAt,610000);f.advance(299999);assert.equal(await f.manager.due(),false);f.advance(1);await f.manager.due();assert.equal(f.requests.length,2);
});
test('service worker restart reconstructs the alarm from persisted intent; batch changes cancel it',async()=>{
 let valid=true;const f=fixture({validate:async()=>valid});await f.manager.schedule(f.intent,network);f.alarms.clear();const restarted=f.restart();await restarted.restore();assert.equal(f.alarms.get(API.ALARM).when,310000);valid=false;f.advance(300000);assert.equal(await restarted.due(),false);assert.equal(f.stored[API.KEY],null);assert.equal(f.requests.length,0);
});
test('pause invalidates delayed credentials and simultaneous queue pages can only launch once',async()=>{
 const f=fixture();await f.manager.schedule(f.intent,network);f.advance(300000);await f.manager.due();const stale=f.message();await f.manager.cancel();assert.equal((await f.manager.accept(stale)).ok,false);assert.equal(f.runs.length,0);
 await f.manager.schedule(f.intent,network);f.advance(300000);await f.manager.due();const replies=await Promise.all([f.manager.accept(f.message()),f.manager.accept(f.message())]);assert.equal(replies.filter(r=>r.ok).length,1);assert.equal(f.runs.length,1);
});
test('wrong-owner tokens are refused and expired login stops retries with a clear terminal error',async()=>{
 const f=fixture();await f.manager.schedule(f.intent,network);f.advance(300000);await f.manager.due();assert.equal((await f.manager.accept({...f.message(),ownerId:'other'})).ok,false);assert.equal(f.runs.length,0);
 await f.manager.accept({...f.message(),unavailable:true,network:false});assert.equal(f.stored[API.KEY],null);assert.match(f.views.at(-1)[2].terminalError,/登录已失效/);
});
test('pause during token response publishing cannot recreate a cancelled retry plan',async()=>{
 let cancellation;const f=fixture({publish:async(_view,job)=>{if(job?.phase==='starting')cancellation=f.manager.cancel();}});await f.manager.schedule(f.intent,network);f.advance(300000);await f.manager.due();await f.manager.accept({...f.message(),unavailable:true,network:true});await cancellation;assert.equal(f.stored[API.KEY],null);assert.equal(f.alarms.size,0);assert.equal(f.runs.length,0);
});
test('a newly scheduled failure is retained when the old start command returns success',async()=>{
 const f=fixture({run:async job=>{await f.manager.schedule({...job},network);return {ok:true};}});await f.manager.schedule(f.intent,network);f.advance(300000);await f.manager.due();const old=f.message();await f.manager.accept(old);assert.notEqual(f.stored[API.KEY].id,old.retryId);assert.equal(f.stored[API.KEY].phase,'waiting');
});
test('upload network recovery reuses the saved file, skips completed parts and continues the same batch',async()=>{
 const f=flow({recoveryClock:true,nativeError:{command:'file',taskId:tasks[0].id,part:2,info:{code:'ART_NETWORK',retryable:true}}});await f.start(tasks);await f.done;await new Promise(setImmediate);assert.ok(f.stored.localCaptureNetworkRetry);assert.equal(f.stored.localCaptureTasks[0].files[0].complete,true);const firstClicks=f.events.filter(e=>e[0]==='click-original').length;
 f.configure({nativeError:null,completed:id=>id===tasks[0].id?[1]:[]});f.advance(300000);await f.adapter.retryNetworkDue();const job=f.stored.localCaptureNetworkRetry,done=f.waitForFinish();assert.equal((await f.command('network_retry',{retryId:job.id,retryNonce:job.requestNonce})).ok,true);await done;await new Promise(setImmediate);
 assert.equal(f.stored.localCaptureNetworkRetry,null);assert.equal(f.stored.localCaptureTasks.every(t=>t.status==='complete'),true);assert.equal(f.events.filter(e=>e[0]==='click-original').length-firstClicks,2);assert.equal(f.events.filter(e=>e[0]==='native'&&e[1]==='file'&&e[2].file.taskId===tasks[0].id&&e[2].file.part===1).length,1);
});
test('failed downloads allow other works to finish first and only network failures are retried',async()=>{
 const f=flow({recoveryClock:true,interruptedDownload:true});await f.start(tasks);await f.done;await new Promise(setImmediate);assert.equal(f.stored.localCaptureTasks[1].status,'complete');assert.deepEqual(f.stored.localCaptureNetworkRetry.intent.retryIds,[tasks[0].id]);assert.equal(f.stored.localCaptureTasks[0].failures.length,1);
 f.configure({interruptedDownload:false});f.advance(300000);await f.adapter.retryNetworkDue();const job=f.stored.localCaptureNetworkRetry,done=f.waitForFinish();await f.command('network_retry',{retryId:job.id,retryNonce:job.requestNonce});await done;await new Promise(setImmediate);assert.equal(f.events.filter(e=>e[0]==='open'&&e[1]===tasks[1].source).length,1);assert.equal(f.stored.localCaptureTasks[0].failures.length,1);
});
test('initial network auth failure saves only the intended work and resumes after a worker restart',async()=>{
 const f=flow({recoveryClock:true,nativeError:{command:'session',info:{code:'ART_NETWORK',retryable:true}}});assert.equal((await f.start(tasks)).result.waiting,true);assert.equal(f.stored.localCaptureOwner,undefined);assert.equal(JSON.stringify(f.stored).includes('test-session-in-memory'),false);
 const restarted=flow({recoveryClock:true,initialStored:f.stored});await restarted.adapter.restoreNetworkRetry();restarted.advance(300000);await restarted.adapter.retryNetworkDue();const job=restarted.stored.localCaptureNetworkRetry;await restarted.command('network_retry',{retryId:job.id,retryNonce:job.requestNonce});await restarted.done;await new Promise(setImmediate);assert.equal(restarted.stored.localCaptureTasks.every(t=>t.status==='complete'),true);
});
test('manual pause cancels the pending alarm and content validation failures do not create a retry job',async()=>{
 const f=flow({recoveryClock:true,nativeError:{command:'file',part:1,info:{code:'ART_NETWORK',retryable:true}}});await f.start(tasks);await f.done;await new Promise(setImmediate);await f.command('pause');assert.equal(f.stored.localCaptureNetworkRetry,null);assert.equal(f.alarms.size,0);f.advance(300000);assert.equal(await f.adapter.retryNetworkDue(),false);
 f.configure({nativeError:{command:'file',part:1,message:'此原图与另一分段完全相同，请核对是否切换到了下一张'}});const stopped=f.waitForFinish();await f.command('resume');await stopped;await new Promise(setImmediate);assert.equal(f.stored.localCaptureNetworkRetry,null);assert.equal(f.stored.localCaptureState.phase,'blocked');
});

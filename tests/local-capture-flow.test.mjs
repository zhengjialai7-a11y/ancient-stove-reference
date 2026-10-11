import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';

const QUEUE='https://zhengjialai7-a11y.github.io/ancient-stove-reference/queue.html';
const source='https://g2.ltfc.net/view/SUHA/608a61b2aa7c385c8d9448d5';
const tasks=[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',source,source_id:'608a61b2aa7c385c8d9448d5',title:'百鹊图卷'},{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',source:'https://g2.ltfc.net/view/SUHA/608a623142b4355c93c903e6',source_id:'608a623142b4355c93c903e6',title:'罗汉图'}];

function flow({errorAtPart=null,errorAtList=false,completed=[],wrongFilename=false,interruptedDownload=false,missingDownload=false,stalledDownload=false,slowDownloadChecks=0,closeError=false,checkLateProof=false,nativeError=null,pauseAtPart=null,pauseDuringSession=false,owner='test-owner',initialStored={}}={}){
 const events=[],stored=structuredClone(initialStored),tabs=new Map(),downloads=[],lateProofs=[];let nonce,tabId=0,adapter,messageListener,currentDownload;
 const timed=missingDownload||stalledDownload||slowDownloadChecks>0;let clock=Date.now();const startClock=clock;
 class AdvancingDate extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
 const finished=[];const waitForFinish=()=>new Promise(resolve=>{finished.push(resolve);});const done=waitForFinish();
 const originalList={count:2,files:[1,2].map(part=>({part,filename:`清_查士标_百鹊图卷_${part}.jpg`,original:true,ready:true}))};
 const chrome={
  runtime:{connectNative(){return {onMessage:{addListener(fn){messageListener=fn;}},onDisconnect:{addListener(){}},postMessage(m){events.push(['native',m.command,m]);queueMicrotask(async()=>{if(pauseDuringSession&&m.command==='session')assert.equal((await command('pause')).ok,true);const failed=nativeError&&m.command===nativeError.command&&(!nativeError.taskId||(m.task?.taskId||m.file?.taskId)===nativeError.taskId)&&(!nativeError.part||m.file?.part===nativeError.part);messageListener(failed?{id:m.id,ok:false,error:'测试：本机助手连接或云端上传失败'}:{id:m.id,ok:true,result:m.command==='session'?{owner}:m.command==='task'?{parts:typeof completed==='function'?completed(m.task.taskId):completed}:m.command==='file'?{master_id:'master-'+m.file.part}:{}});});}};}},
  storage:{local:{async get(keys){if(typeof keys==='string')return {[keys]:stored[keys]};return Object.fromEntries(keys.map(k=>[k,stored[k]]));},async set(values){Object.assign(stored,structuredClone(values));if(values.localCaptureState?.phase==='finished'||(values.localCaptureState?.phase==='paused'&&/原文件与进度保留/.test(values.localCaptureState.message)))for(const resolve of finished.splice(0))resolve(stored.localCaptureState);}}},
  tabs:{async create({url}){const id=++tabId;if(checkLateProof&&id===2)lateProofs.push(await adapter.handle({type:'localCaptureProof',nonce,source:tasks[0].source,href:'blob:https://g2.ltfc.net/late-original'},{tab:{id:1}}));tabs.set(id,{id,url,modal:false});events.push(['open',url,clock]);return {id,url};},async query(){return [];},async get(id){return tabs.get(id);},async remove(id){events.push(['close',id]);if(closeError)throw Error('测试：标签页已由用户关闭');tabs.delete(id);},async sendMessage(){}},
  scripting:{async executeScript({target,world,args}){
   const tab=tabs.get(target.tabId);
   if(world==='MAIN'){nonce=args[0];events.push(['arm',nonce]);return [{result:undefined}];}
   const [action,part,count]=args;events.push(['page',action,part,count,tab.url]);
   const firstWork=tab.url===tasks[0].source;
   const result={url:tab.url,title:'百鹊图卷',count:null,downloadCount:1,labels:['下载']};
   if(action==='next')throw Error('The project-wide list must not turn viewer pages');
   if(action==='download'){tab.modal=true;return [{result:{...result,clicked:true}}];}
   if(tab.modal)result.originalList=firstWork&&errorAtList?{count:null,files:[],error:'测试：原始文件列表未就绪'}:originalList;
   if(action==='original'){
    assert.equal(tab.modal,true);assert.equal(count,2);
    if(firstWork&&part===errorAtPart)return [{result:{...result,error:'测试：原图文件尚未就绪'}}];
    const downloadId=downloads.length+1;
    currentDownload={id:downloadId,url:'blob:https://g2.ltfc.net/original-'+downloadId,finalUrl:'blob:https://g2.ltfc.net/original-'+downloadId,state:'in_progress',exists:false,source:tab.url,filename:'C:\\Downloads\\'+(firstWork&&wrongFilename?'无关作品_'+part+'.jpg':originalList.files[part-1].filename),checks:0,bytesReceived:0};downloads.push(currentDownload);
    events.push(['click-original',part,tab.url]);
    const wrong=await adapter.handle({type:'localCaptureProof',nonce:'incorrect-nonce',source:tab.url,href:'blob:https://g2.ltfc.net/unrelated'},{tab:{id:tab.id}});assert.equal(wrong.ok,false);
    const otherFile=await adapter.handle({type:'localCaptureProof',nonce,source:tab.url,href:'blob:https://g2.ltfc.net/unrelated',filename:'清_查士标_其他作品_1.jpg'},{tab:{id:tab.id}});assert.equal(otherFile.ok,false);
    const proof=await adapter.handle({type:'localCaptureProof',nonce,source:tab.url,href:currentDownload.url,filename:originalList.files[part-1].filename},{tab:{id:tab.id}});assert.equal(proof.ok,true);
    if(firstWork&&part===pauseAtPart)assert.equal((await command('pause')).ok,true);
    return [{result:{...result,clicked:true,filename:originalList.files[part-1].filename}}];
   }
   return [{result}];
  }},
  downloads:{async search(){currentDownload.checks++;const firstWork=currentDownload.source===tasks[0].source;const unrelated={id:999,url:'blob:https://g2.ltfc.net/unrelated',state:'complete',exists:true,filename:'C:\\Downloads\\wrong.jpg'};if(firstWork&&missingDownload)return [unrelated];if(firstWork&&interruptedDownload){currentDownload.state='interrupted';currentDownload.error='NETWORK_FAILED';events.push(['interrupted-download',currentDownload.id]);}else if(firstWork&&stalledDownload){if(currentDownload.checks===1)events.push(['in-progress',currentDownload.id]);}else if(firstWork&&currentDownload.checks<=slowDownloadChecks){currentDownload.bytesReceived+=1000;if(currentDownload.checks===1)events.push(['in-progress',currentDownload.id]);}else if(currentDownload.checks===1){events.push(['in-progress',currentDownload.id]);}else{currentDownload.state='complete';currentDownload.exists=true;events.push(['complete-download',currentDownload.id]);}return [unrelated,...downloads];}}
 };
 const ctx=vm.createContext({chrome,crypto:{randomUUID},Map,Date:timed?AdvancingDate:Date,structuredClone,setTimeout:(fn,ms)=>{if(ms<=1000)queueMicrotask(()=>{if(timed)clock+=ms;fn();});return randomUUID();},clearTimeout(){},queueMicrotask,window:{},location:{},document:{}});
 vm.runInContext(readFileSync(new URL('../extension/automation.js',import.meta.url),'utf8')+';globalThis.adapter=CaptureAutomation;',ctx);adapter=ctx.adapter;
 const command=(name,values={})=>adapter.handle({type:'localCaptureCommand',command:name,accessToken:'test-session-in-memory',...values},{tab:{url:QUEUE},frameId:0});
 const start=items=>command('start',{tasks:items});
 const configure=values=>{if('errorAtPart' in values)errorAtPart=values.errorAtPart;if('completed' in values)completed=values.completed;if('owner' in values)owner=values.owner;};
 return {events,stored,done,start,adapter,command,waitForFinish,tabs,configure,lateProofs,elapsed:()=>clock-startClock};
}

test('capture opens the normal toolbar and serial original rows using the project-wide list count',async()=>{
 const f=flow();assert.equal((await f.start([tasks[0]])).ok,true);await f.done;
 const page=f.events.filter(e=>e[0]==='page');assert.equal(page.filter(e=>e[1]==='download').length,1);assert.equal(page.some(e=>e[1]==='next'),false);
 assert.deepEqual(f.events.filter(e=>e[0]==='click-original').map(e=>e[1]),[1,2]);
 const task=f.events.find(e=>e[0]==='native'&&e[1]==='task')[2];assert.equal(task.task.count,2);
 const file=f.events.filter(e=>e[0]==='native'&&e[1]==='file').map(e=>e[2].file);assert.deepEqual(file.map(e=>[e.part,e.count]),[[1,2],[2,2]]);
 assert.equal(f.stored.localCaptureTasks[0].status,'complete');assert.equal(f.stored.localCaptureTasks[0].files.length,2);assert.match(f.stored.localCaptureState.message,/完成 1 幅/);
});

test('a file is sent to native upload only after its exact normal download is complete',async()=>{
 const f=flow();await f.start([tasks[0]]);await f.done;
 for(const part of [1,2]){
  const pending=f.events.findIndex(e=>e[0]==='in-progress'&&e[1]===part),complete=f.events.findIndex(e=>e[0]==='complete-download'&&e[1]===part),upload=f.events.findIndex(e=>e[0]==='native'&&e[1]==='file'&&e[2].file.part===part);
  assert.ok(pending>=0&&complete>pending&&upload>complete);
  if(part===1){const next=f.events.findIndex(e=>e[0]==='click-original'&&e[1]===2);assert.ok(next>upload,'the next original must wait until the prior native upload resolves');}
 }
 assert.equal(f.events.filter(e=>e[0]==='native'&&e[1]==='file').every(e=>!e[2].file.filename.endsWith('wrong.jpg')),true);
});

test('an artwork download failure retains its reason and continues with the next work',async()=>{
 const f=flow({errorAtPart:1});await f.start(tasks);await f.done;
 assert.deepEqual(f.events.filter(e=>e[0]==='open').map(e=>e[1]),tasks.map(t=>t.source));
 const failed=f.stored.localCaptureTasks.find(t=>t.id===tasks[0].id),success=f.stored.localCaptureTasks.find(t=>t.id===tasks[1].id);
 assert.equal(failed.status,'failed');assert.match(failed.error,/原图文件尚未就绪/);assert.ok(failed.errorStage);assert.ok(Number.isFinite(Date.parse(failed.failedAt)));
 assert.equal(success.status,'complete');assert.equal(success.files.length,2);
 assert.equal(f.events.filter(e=>e[0]==='native'&&e[1]==='file').every(e=>e[2].file.taskId===tasks[1].id),true);
 assert.deepEqual(f.events.filter(e=>e[0]==='close').map(e=>e[1]),[1,2]);assert.match(f.stored.localCaptureState.message,/完成 1 幅/);
});

test('an unavailable original list is recorded and does not block another artwork',async()=>{
 const f=flow({errorAtList:true});await f.start(tasks);await f.done;
 const failed=f.stored.localCaptureTasks.find(t=>t.id===tasks[0].id);
 assert.equal(failed.status,'failed');assert.match(failed.error,/原始文件列表未就绪/);assert.ok(failed.errorStage);assert.ok(failed.failedAt);
 assert.equal(f.stored.localCaptureTasks.find(t=>t.id===tasks[1].id).status,'complete');assert.deepEqual(f.events.filter(e=>e[0]==='close').map(e=>e[1]),[1,2]);
});

test('completed parts are retained when a later original fails and another artwork proceeds',async()=>{
 const f=flow({errorAtPart:2});await f.start(tasks);await f.done;
 const failed=f.stored.localCaptureTasks.find(t=>t.id===tasks[0].id);
 assert.equal(failed.status,'failed');assert.equal(failed.files.length,1);assert.equal(failed.files[0].part,1);assert.equal(failed.files[0].complete,true);assert.equal(failed.files[0].masterId,'master-1');
 assert.equal(f.stored.localCaptureTasks.find(t=>t.id===tasks[1].id).status,'complete');
});

test('an interrupted browser download is recorded and the next work proceeds without uploading the interrupted file',async()=>{
 const f=flow({interruptedDownload:true});await f.start(tasks);await f.done;
 const failed=f.stored.localCaptureTasks.find(t=>t.id===tasks[0].id);assert.equal(failed.status,'failed');assert.equal(failed.errorStage,'downloading');assert.match(failed.error,/下载中断.*NETWORK_FAILED/);
 assert.equal(f.events.filter(e=>e[0]==='native'&&e[1]==='file').some(e=>e[2].file.taskId===tasks[0].id),false);assert.equal(f.stored.localCaptureTasks.find(t=>t.id===tasks[1].id).status,'complete');
});

for(const [name,options,error,maximumWait] of [
 ['a browser download that never starts',{missingDownload:true},/3 分钟内未启动/,4*60*1000],
 ['a browser download with no received-byte progress',{stalledDownload:true},/连续 5 分钟没有进度/,6*60*1000]
])test(`${name} is recorded and skipped within its bounded wait`,async()=>{
 const f=flow(options);await f.start(tasks);await f.done;
 const failed=f.stored.localCaptureTasks.find(t=>t.id===tasks[0].id);assert.equal(failed.status,'failed');assert.equal(failed.errorStage,'downloading');assert.match(failed.error,error);assert.equal(failed.failures.length,1);
 assert.equal(f.events.filter(e=>e[0]==='native'&&e[1]==='file').some(e=>e[2].file.taskId===tasks[0].id),false);assert.equal(f.stored.localCaptureTasks.find(t=>t.id===tasks[1].id).status,'complete');
 const opened=f.events.filter(e=>e[0]==='open');assert.ok(opened[1][2]-opened[0][2]<maximumWait,'failure should not consume the full 30-minute download allowance');
});

test('an original download receiving bytes keeps running past the three-minute startup limit',async()=>{
 const f=flow({slowDownloadChecks:240});await f.start([tasks[0]]);await f.done;
 assert.equal(f.stored.localCaptureTasks[0].status,'complete');assert.equal(f.stored.localCaptureTasks[0].failures.length,0);assert.equal(f.events.filter(e=>e[0]==='native'&&e[1]==='file').length,2);assert.ok(f.elapsed()>3*60*1000);
});

test('a failed tab cleanup does not change completed work into a failure or stop the batch',async()=>{
 const f=flow({closeError:true});await f.start(tasks);await f.done;
 assert.equal(f.events.filter(e=>e[0]==='open').length,2);assert.equal(f.stored.localCaptureTasks.every(t=>t.status==='complete'&&t.error===null&&!t.failures.length),true);assert.equal(f.stored.localCaptureHistory.every(t=>t.status==='complete'),true);
});

test('a proof arriving late from a skipped artwork is rejected before opening the next work',async()=>{
 const f=flow({errorAtPart:1,checkLateProof:true});await f.start(tasks);await f.done;
 assert.equal(f.lateProofs.length,1);assert.equal(f.lateProofs[0].ok,false);assert.equal(f.stored.localCaptureTasks.find(t=>t.id===tasks[1].id).status,'complete');
});

for(const command of ['task','file'])test(`a native ${command} failure stops the batch and leaves the next artwork pending`,async()=>{
 const f=flow({nativeError:{command,taskId:tasks[0].id}});await f.start(tasks);await f.done;
 assert.equal(f.events.filter(e=>e[0]==='open').length,1);
 assert.equal(f.stored.localCaptureTasks[0].status,'failed');assert.equal(f.stored.localCaptureTasks[1].status,'pending');assert.match(f.stored.localCaptureState.message,/已停止.*本机助手/);
 assert.equal(f.events.some(e=>e[0]==='close'),false,'leave the active tab available for a system failure');
});

test('a requested pause preserves progress and does not open the next artwork',async()=>{
 const f=flow({pauseAtPart:1});await f.start(tasks);await f.done;
 assert.equal(f.events.filter(e=>e[0]==='open').length,1);assert.equal(f.stored.localCaptureTasks[0].status,'paused');assert.equal(f.stored.localCaptureTasks[1].status,'pending');assert.equal(f.events.some(e=>e[0]==='native'&&e[1]==='file'),false);assert.equal(f.events.some(e=>e[0]==='close'),false);
});

test('pausing while the native session is pending cannot be undone by the later Start completion',async()=>{
 const f=flow({pauseDuringSession:true});const started=await f.start(tasks);
 assert.equal(started.ok,false);assert.match(started.error,/暂停/);assert.equal(f.events.some(e=>e[0]==='open'),false);assert.equal(f.events.some(e=>e[0]==='native'&&e[1]==='resume'),false);assert.equal(f.events.filter(e=>e[0]==='native').at(-1)[1],'pause');
});

test('cloud-verified completed parts skip their row and only collect the remaining original',async()=>{
 const f=flow({completed:[1]});await f.start([tasks[0]]);await f.done;
 assert.deepEqual(f.events.filter(e=>e[0]==='click-original').map(e=>e[1]),[2]);assert.deepEqual(f.events.filter(e=>e[0]==='native'&&e[1]==='file').map(e=>e[2].file.part),[2]);assert.equal(f.stored.localCaptureTasks[0].status,'complete');
});

test('a completed download with another artwork filename cannot be uploaded while the next work proceeds',async()=>{
 const f=flow({wrongFilename:true});await f.start(tasks);await f.done;
 const first=f.stored.localCaptureTasks.find(t=>t.id===tasks[0].id);
 assert.equal(f.events.filter(e=>e[0]==='native'&&e[1]==='file').some(e=>e[2].file.taskId===tasks[0].id),false);assert.equal(first.status,'failed');assert.match(first.error,/文件名.*(?:不一致|不匹配)|下载文件.*不匹配/);
 assert.equal(f.stored.localCaptureTasks.find(t=>t.id===tasks[1].id).status,'complete');
});

test('failure history survives starting another batch and reloading the extension worker',async()=>{
 const f=flow({errorAtPart:1});await f.start([tasks[0]]);await f.done;
 const firstFailure=structuredClone(f.stored.localCaptureHistory.find(t=>t.id===tasks[0].id));
 assert.equal(firstFailure.owner,'test-owner');assert.equal(firstFailure.failures.length,1);assert.equal(firstFailure.failures[0].stage,'downloading');assert.equal(firstFailure.failures[0].part,1);
 const next=f.waitForFinish();await f.start([tasks[1]]);await next;
 assert.equal(f.stored.localCaptureHistory.length,2);assert.deepEqual(f.stored.localCaptureHistory.find(t=>t.id===tasks[0].id),firstFailure);
 const restarted=flow({initialStored:f.stored});const status=await restarted.command('status',{ownerId:'test-owner'});
 assert.equal(status.ok,true);assert.equal(status.result.history.length,2);assert.equal(status.result.history.find(t=>t.id===tasks[0].id).status,'failed');assert.equal(status.result.history.find(t=>t.id===tasks[1].id).status,'complete');
});

test('previously failed artwork is scheduled after fresh artwork and each failed attempt is retained',async()=>{
 const f=flow({errorAtPart:1});await f.start([tasks[0]]);await f.done;
 const eventOffset=f.events.length,next=f.waitForFinish();await f.start(tasks);await next;
 assert.deepEqual(f.events.slice(eventOffset).filter(e=>e[0]==='open').map(e=>e[1]),[tasks[1].source,tasks[0].source]);
 const failed=f.stored.localCaptureHistory.find(t=>t.id===tasks[0].id);assert.equal(failed.failures.length,2);assert.equal(failed.status,'failed');
});

test('a successful retry retains prior failures and skips cloud-verified original parts',async()=>{
 const f=flow({errorAtPart:2});await f.start([tasks[0]]);await f.done;
 const before=f.stored.localCaptureHistory.find(t=>t.id===tasks[0].id);assert.equal(before.files[0].complete,true);assert.equal(before.failures.length,1);
 f.configure({errorAtPart:null,completed:[1]});const eventOffset=f.events.length,next=f.waitForFinish();await f.start([tasks[0]]);await next;
 const after=f.stored.localCaptureHistory.find(t=>t.id===tasks[0].id);assert.equal(after.status,'complete');assert.equal(after.error,null);assert.equal(after.files.length,2);assert.equal(after.failures.length,1);assert.deepEqual(after.failures,before.failures);
 assert.deepEqual(f.events.slice(eventOffset).filter(e=>e[0]==='click-original').map(e=>e[1]),[2]);
});

test('history and restored progress are scoped to the native-authenticated cloud owner',async()=>{
 const f=flow({errorAtPart:1});await f.start([tasks[0]]);await f.done;
 f.configure({owner:'other-owner'});const next=f.waitForFinish();await f.start([tasks[1]]);await next;
 assert.equal(f.stored.localCaptureOwner,'other-owner');assert.equal(f.stored.localCaptureHistory.length,2);
 const oldStatus=await f.command('status',{ownerId:'test-owner'});assert.equal(oldStatus.ok,true);assert.equal(oldStatus.result.history.length,1);assert.equal(oldStatus.result.history[0].owner,'test-owner');assert.equal(oldStatus.result.history[0].id,tasks[0].id);
 const otherStatus=await f.command('status',{ownerId:'other-owner'});assert.equal(otherStatus.ok,true);assert.equal(otherStatus.result.history.length,1);assert.equal(otherStatus.result.history[0].owner,'other-owner');assert.equal(otherStatus.result.history[0].id,tasks[1].id);
});

test('the queue-page bridge forwards owner identity for status and rejects messages from another origin',async()=>{
 const messages=[],replies=[];let receive;
 const window={addEventListener(type,listener){assert.equal(type,'message');receive=listener;},postMessage(message,origin){replies.push({message,origin});}};
 const chrome={runtime:{async sendMessage(message){messages.push(message);return {ok:true,result:{owner:message.ownerId,tasks:[],history:[]}};},onMessage:{addListener(){}}}};
 const context=vm.createContext({window,chrome,location:{origin:new URL(QUEUE).origin,pathname:new URL(QUEUE).pathname},Set});vm.runInContext(readFileSync(new URL('../extension/local_bridge.js',import.meta.url),'utf8'),context);
 const data={type:'ART_LOCAL_COMMAND',command:'status',ownerId:'test-owner',requestId:'status-request'};
 await receive({source:window,origin:'https://attacker.invalid',data});assert.equal(messages.length,0);
 await receive({source:{},origin:new URL(QUEUE).origin,data});assert.equal(messages.length,0);
 await receive({source:window,origin:new URL(QUEUE).origin,data});assert.equal(messages.length,1);assert.equal(messages[0].type,'localCaptureCommand');assert.equal(messages[0].ownerId,'test-owner');assert.equal(replies[0].message.result.owner,'test-owner');assert.equal(replies[0].origin,new URL(QUEUE).origin);
});

test('filename identity allows Windows paths and browser collision suffixes while preserving work and part',()=>{
 const match=flow().adapter.matchesFilename,expected='清_查士标_百鹊图卷_1.jpg';
 assert.equal(match('C:\\Downloads\\'+expected,expected),true);
 assert.equal(match('C:\\Downloads\\清_查士标_百鹊图卷_1 (2).jpg',expected),true);
 assert.equal(match('/downloads/清_查士标_百鹊图卷_1 (27).jpg',expected),true);
 assert.equal(match('清_查士标_百鹊图卷_2.jpg',expected),false);
 assert.equal(match('清_查士标_其他作品_1.jpg',expected),false);
 assert.equal(match('清_查士标_百鹊图卷_1.jpg.exe',expected),false);
 assert.equal(match('清_查士标_百鹊图卷_1.jpeg',expected),false);
 assert.equal(match('作者_é_1.jpg','作者_e\u0301_1.jpg'),true);
 assert.equal(match('画名_作品_1.jpg','画名:作品_1.jpg'),true);
});

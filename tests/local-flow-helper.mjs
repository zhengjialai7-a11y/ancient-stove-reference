import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';

const QUEUE='https://zhengjialai7-a11y.github.io/ancient-stove-reference/queue.html';
const source='https://g2.ltfc.net/view/SUHA/608a61b2aa7c385c8d9448d5';
const tasks=[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',source,source_id:'608a61b2aa7c385c8d9448d5',title:'百鹊图卷'},{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',source:'https://g2.ltfc.net/view/SUHA/608a623142b4355c93c903e6',source_id:'608a623142b4355c93c903e6',title:'罗汉图'}];

function flow({errorAtPart=null,errorAtList=false,completed=[],wrongFilename=false,interruptedDownload=false,missingDownload=false,stalledDownload=false,slowDownloadChecks=0,closeError=false,checkLateProof=false,nativeError=null,pauseAtPart=null,pauseDuringSession=false,acceptance=false,fileCount=2,instantDownloads=false,fastEventDownloads=false,cancelError=false,pauseAtCheckpoint=false,missingVerified=false,owner='test-owner',initialStored={}}={}){
 const events=[],stored=structuredClone(initialStored),tabs=new Map(),downloads=[],lateProofs=[];let nonce,tabId=0,adapter,messageListener,currentDownload;
 const timed=missingDownload||stalledDownload||slowDownloadChecks>0;let clock=Date.now();const startClock=clock;
 class AdvancingDate extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
 const verified=new Map();for(const t of initialStored.localCaptureTasks||[])verified.set(t.id,new Set((t.files||[]).filter(f=>f.complete).map(f=>f.part)));let manualCheckpointPaused=false,duringOriginal=false;const validationFinished=[];const waitForValidation=()=>new Promise(resolve=>validationFinished.push(resolve));
 function nativeResult(m){if(m.command==='session')return {owner};if(m.command==='hello')return {version:'0.7.1',network:{ok:true,checks:[]}};if(m.command==='task'){const parts=acceptance?[...(verified.get(m.task.taskId)||[])]:typeof completed==='function'?completed(m.task.taskId):completed;return {parts:acceptance&&missingVerified&&stored.localCaptureValidation?.phase==='repeat'?parts.slice(0,-1):parts};}if(m.command==='file'){if(acceptance){if(!verified.has(m.file.taskId))verified.set(m.file.taskId,new Set());verified.get(m.file.taskId).add(m.file.part);}return {master_id:acceptance?m.file.taskId+'-'+m.file.part:'master-'+m.file.part,project_id:m.file.taskId};}return {};}
 const finished=[];const waitForFinish=()=>new Promise(resolve=>{finished.push(resolve);});const done=waitForFinish();
 const originalList={count:fileCount,files:Array.from({length:fileCount},(_,index)=>index+1).map(part=>({part,filename:`清_查士标_百鹊图卷_${part}.jpg`,original:true,ready:true}))};
 const chrome={
  runtime:{connectNative(){return {onMessage:{addListener(fn){messageListener=fn;}},onDisconnect:{addListener(){}},postMessage(m){events.push(['native',m.command,m]);queueMicrotask(async()=>{if(pauseDuringSession&&m.command==='session')assert.equal((await command('pause')).ok,true);const failed=nativeError&&m.command===nativeError.command&&(!nativeError.taskId||(m.task?.taskId||m.file?.taskId)===nativeError.taskId)&&(!nativeError.part||m.file?.part===nativeError.part);messageListener(failed?{id:m.id,ok:false,error:nativeError.message||'测试：本机助手连接或云端上传失败'}:{id:m.id,ok:true,result:nativeResult(m)});});}};}},
  storage:{local:{async get(keys){if(typeof keys==='string')return {[keys]:stored[keys]};return Object.fromEntries(keys.map(k=>[k,stored[k]]));},async set(values){Object.assign(stored,structuredClone(values));if(values.localCaptureValidation&&['finished','paused','blocked'].includes(values.localCaptureValidation.status))for(const resolve of validationFinished.splice(0))resolve(stored.localCaptureValidation);if(pauseAtCheckpoint&&!manualCheckpointPaused&&values.localCaptureValidation?.pauseProbe){manualCheckpointPaused=true;queueMicrotask(()=>command('pause'));}if(values.localCaptureState?.phase==='finished'||(values.localCaptureState?.phase==='paused'&&/原文件与进度保留/.test(values.localCaptureState.message)))for(const resolve of finished.splice(0))resolve(stored.localCaptureState);}}},
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
    assert.equal(tab.modal,true);assert.equal(count,fileCount);
    if(firstWork&&part===errorAtPart)return [{result:{...result,error:'测试：原图文件尚未就绪'}}];
    const downloadId=downloads.length+1;
    currentDownload={id:downloadId,url:'blob:https://g2.ltfc.net/original-'+downloadId,finalUrl:'blob:https://g2.ltfc.net/original-'+downloadId,state:'in_progress',exists:false,source:tab.url,filename:'C:\\Downloads\\'+(firstWork&&wrongFilename?'无关作品_'+part+'.jpg':originalList.files[part-1].filename),checks:0,bytesReceived:0};downloads.push(currentDownload);
    events.push(['click-original',part,tab.url]);if(fastEventDownloads){duringOriginal=true;await adapter.onDownloadEvent({id:downloadId});}
    const wrong=await adapter.handle({type:'localCaptureProof',nonce:'incorrect-nonce',source:tab.url,href:'blob:https://g2.ltfc.net/unrelated'},{tab:{id:tab.id}});assert.equal(wrong.ok,false);
    const otherFile=await adapter.handle({type:'localCaptureProof',nonce,source:tab.url,href:'blob:https://g2.ltfc.net/unrelated',filename:'清_查士标_其他作品_1.jpg'},{tab:{id:tab.id}});assert.equal(otherFile.ok,false);
    const proof=await adapter.handle({type:'localCaptureProof',nonce,source:tab.url,href:currentDownload.url,filename:originalList.files[part-1].filename},{tab:{id:tab.id}});assert.equal(proof.ok,true);
    if(firstWork&&part===pauseAtPart)assert.equal((await command('pause')).ok,true);
    duringOriginal=false;return [{result:{...result,clicked:true,filename:originalList.files[part-1].filename}}];
   }
   return [{result}];
  }},
  downloads:{async cancel(id){const d=downloads.find(d=>d.id===id);events.push(['cancel',id]);if(cancelError)throw Error('测试：取消操作失败');d.state='interrupted';d.error='USER_CANCELED';},async search(query={}){if(fastEventDownloads&&duringOriginal)return [currentDownload];currentDownload.checks++;const firstWork=currentDownload.source===tasks[0].source;const unrelated={id:999,url:'blob:https://g2.ltfc.net/unrelated',state:'complete',exists:true,filename:'C:\\Downloads\\wrong.jpg'};if(currentDownload.state==='interrupted')return [unrelated,...downloads];if(firstWork&&missingDownload)return [unrelated];if(firstWork&&interruptedDownload){currentDownload.state='interrupted';currentDownload.error='NETWORK_FAILED';events.push(['interrupted-download',currentDownload.id]);}else if(firstWork&&stalledDownload){if(currentDownload.checks===1)events.push(['in-progress',currentDownload.id]);}else if(firstWork&&currentDownload.checks<=slowDownloadChecks){currentDownload.bytesReceived+=1000;if(currentDownload.checks===1)events.push(['in-progress',currentDownload.id]);}else if(currentDownload.checks===1&&!instantDownloads&&!fastEventDownloads){events.push(['in-progress',currentDownload.id]);}else{currentDownload.state='complete';currentDownload.exists=true;events.push(['complete-download',currentDownload.id]);}return [unrelated,...downloads];}}
 };
 const ctx=vm.createContext({chrome,crypto:{randomUUID},Map,Date:timed?AdvancingDate:Date,structuredClone,setTimeout:(fn,ms)=>{if(ms<=1000)queueMicrotask(()=>{if(timed)clock+=ms;fn();});return randomUUID();},clearTimeout(){},queueMicrotask,window:{},location:{},document:{}});
 if(acceptance)vm.runInContext(readFileSync(new URL('../extension/acceptance.js',import.meta.url),'utf8')+';globalThis.acceptanceAPI=CaptureAcceptance;',ctx);
 vm.runInContext(readFileSync(new URL('../extension/automation.js',import.meta.url),'utf8')+';globalThis.adapter=CaptureAutomation;',ctx);adapter=ctx.adapter;
 const command=(name,values={})=>adapter.handle({type:'localCaptureCommand',command:name,accessToken:'test-session-in-memory',ownerId:owner,...values},{tab:{url:QUEUE},frameId:0});
 const start=items=>command('start',{tasks:items});
 const configure=values=>{if('errorAtPart' in values)errorAtPart=values.errorAtPart;if('completed' in values)completed=values.completed;if('owner' in values)owner=values.owner;if('pauseAtCheckpoint' in values)pauseAtCheckpoint=values.pauseAtCheckpoint;};
 return {events,stored,done,start,adapter,command,waitForFinish,tabs,configure,lateProofs,elapsed:()=>clock-startClock,waitForValidation,acceptanceAPI:ctx.acceptanceAPI,chrome};
}

export {flow,tasks,QUEUE,source};

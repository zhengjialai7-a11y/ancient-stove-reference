import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';

const QUEUE='https://zhengjialai7-a11y.github.io/ancient-stove-reference/queue.html';
const source='https://g2.ltfc.net/view/SUHA/608a61b2aa7c385c8d9448d5';
const tasks=[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',source,source_id:'608a61b2aa7c385c8d9448d5',title:'百鹊图卷'},{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',source:'https://g2.ltfc.net/view/SUHA/608a623142b4355c93c903e6',source_id:'608a623142b4355c93c903e6',title:'罗汉图'}];

function flow({errorAtPart=null,completed=[],wrongFilename=false}={}){
 const events=[],stored={},tabs=new Map(),downloads=[];let nonce,tabId=0,adapter,messageListener,currentDownload,finish;
 const done=new Promise(resolve=>{finish=resolve;});
 const originalList={count:2,files:[1,2].map(part=>({part,filename:`清_查士标_百鹊图卷_${part}.jpg`,original:true,ready:true}))};
 const chrome={
  runtime:{connectNative(){return {onMessage:{addListener(fn){messageListener=fn;}},onDisconnect:{addListener(){}},postMessage(m){events.push(['native',m.command,m]);queueMicrotask(()=>messageListener({id:m.id,ok:true,result:m.command==='task'?{parts:completed}:m.command==='file'?{master_id:'master-'+m.file.part}:{}}));}};}},
  storage:{local:{async get(keys){if(typeof keys==='string')return {[keys]:stored[keys]};return Object.fromEntries(keys.map(k=>[k,stored[k]]));},async set(values){Object.assign(stored,structuredClone(values));if(values.localCaptureState?.phase==='finished')finish(stored.localCaptureState);}}},
  tabs:{async create({url}){const id=++tabId;tabs.set(id,{id,url,modal:false});events.push(['open',url]);return {id,url};},async query(){return [];},async get(id){return tabs.get(id);},async remove(id){events.push(['close',id]);tabs.delete(id);},async sendMessage(){}},
  scripting:{async executeScript({target,world,args}){
   const tab=tabs.get(target.tabId);
   if(world==='MAIN'){nonce=args[0];events.push(['arm',nonce]);return [{result:undefined}];}
   const [action,part,count]=args;events.push(['page',action,part,count]);
   const result={url:tab.url,title:'百鹊图卷',count:null,downloadCount:1,labels:['下载']};
   if(action==='next')throw Error('The project-wide list must not turn viewer pages');
   if(action==='download'){tab.modal=true;return [{result:{...result,clicked:true}}];}
   if(tab.modal)result.originalList=originalList;
   if(action==='original'){
    assert.equal(tab.modal,true);assert.equal(count,2);
    if(part===errorAtPart)return [{result:{...result,error:'测试：原图文件尚未就绪'}}];
    currentDownload={id:part,url:'blob:https://g2.ltfc.net/original-'+part,finalUrl:'blob:https://g2.ltfc.net/original-'+part,state:'in_progress',exists:false,filename:'C:\\Downloads\\'+(wrongFilename?'无关作品_'+part+'.jpg':originalList.files[part-1].filename),checks:0};downloads.push(currentDownload);
    events.push(['click-original',part]);
    const wrong=await adapter.handle({type:'localCaptureProof',nonce:'incorrect-nonce',source:tab.url,href:'blob:https://g2.ltfc.net/unrelated'},{tab:{id:tab.id}});assert.equal(wrong.ok,false);
    const otherFile=await adapter.handle({type:'localCaptureProof',nonce,source:tab.url,href:'blob:https://g2.ltfc.net/unrelated',filename:'清_查士标_其他作品_1.jpg'},{tab:{id:tab.id}});assert.equal(otherFile.ok,false);
    const proof=await adapter.handle({type:'localCaptureProof',nonce,source:tab.url,href:currentDownload.url,filename:originalList.files[part-1].filename},{tab:{id:tab.id}});assert.equal(proof.ok,true);
    return [{result:{...result,clicked:true,filename:originalList.files[part-1].filename}}];
   }
   return [{result}];
  }},
  downloads:{async search(){currentDownload.checks++;if(currentDownload.checks===1){events.push(['in-progress',currentDownload.id]);}else{currentDownload.state='complete';currentDownload.exists=true;events.push(['complete-download',currentDownload.id]);}return [{id:999,url:'blob:https://g2.ltfc.net/unrelated',state:'complete',exists:true,filename:'C:\\Downloads\\wrong.jpg'},...downloads];}}
 };
 const ctx=vm.createContext({chrome,crypto:{randomUUID},Map,Date,setTimeout:(fn,ms)=>{if(ms<=1000)queueMicrotask(fn);return randomUUID();},clearTimeout(){},queueMicrotask,window:{},location:{},document:{}});
 vm.runInContext(readFileSync(new URL('../extension/automation.js',import.meta.url),'utf8')+';globalThis.adapter=CaptureAutomation;',ctx);adapter=ctx.adapter;
 const start=items=>adapter.handle({type:'localCaptureCommand',command:'start',accessToken:'test-session-in-memory',tasks:items},{tab:{url:QUEUE},frameId:0});
 return {events,stored,done,start,adapter};
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

test('an original-list failure retains its reason and stops before opening the next work',async()=>{
 const f=flow({errorAtPart:1});await f.start(tasks);await f.done;
 assert.equal(f.events.filter(e=>e[0]==='open').length,1);assert.equal(f.events.some(e=>e[0]==='native'&&e[1]==='file'),false);
 assert.equal(f.stored.localCaptureTasks[0].status,'failed');assert.equal(f.stored.localCaptureTasks[1].status,'pending');assert.match(f.stored.localCaptureState.message,/试跑已停止：测试：原图文件尚未就绪/);assert.equal(f.events.some(e=>e[0]==='close'),false);
});

test('cloud-verified completed parts skip their row and only collect the remaining original',async()=>{
 const f=flow({completed:[1]});await f.start([tasks[0]]);await f.done;
 assert.deepEqual(f.events.filter(e=>e[0]==='click-original').map(e=>e[1]),[2]);assert.deepEqual(f.events.filter(e=>e[0]==='native'&&e[1]==='file').map(e=>e[2].file.part),[2]);assert.equal(f.stored.localCaptureTasks[0].status,'complete');
});

test('a completed download with another artwork filename cannot be sent to native upload',async()=>{
 const f=flow({wrongFilename:true});await f.start([tasks[0]]);await f.done;
 assert.equal(f.events.some(e=>e[0]==='native'&&e[1]==='file'),false);assert.equal(f.stored.localCaptureTasks[0].status,'failed');assert.match(f.stored.localCaptureState.message,/文件名.*(?:不一致|不匹配)|下载文件.*不匹配/);
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

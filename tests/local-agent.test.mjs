import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {CaptureClient,Decoder,frame,dimensions,CHUNK,containedFile} from '../local-agent/core.mjs';
const owner='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',projectId='33333333-3333-4333-8333-333333333333';
const source='https://g2.ltfc.net/view/SUHA/608a61b2aa7c385c8d9448d5';
function picture(size=150){const b=Buffer.alloc(size);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(7000,16);b.writeUInt32BE(2000,20);return b;}
async function setup(t,size=150){const dir=await mkdtemp(path.join(tmpdir(),'capture-agent-'));t.after(()=>rm(dir,{recursive:true,force:true}));const downloads=path.join(dir,'downloads');await mkdir(downloads);const filename=path.join(downloads,'清_查士标_百鹊图卷_1.png');await writeFile(filename,picture(size));
 const state={task:{id:taskId,created_by:owner,source_id:source.split('/').at(-1),source_type:'SUHA',paused:false,candidate_count:0,source_url:source,resolved_project_id:null},chunks:[],patchCalls:0,rpcCalls:[],files:[],masters:[],failAfterFirstChunk:false,corruptReadback:false};
 const answer=(data,status=200,headers={})=>new Response(status===204?null:JSON.stringify(data),{status,headers});
 const fake=async(url,opts={})=>{const u=new URL(url),method=opts.method||'GET';
  if(u.pathname==='/auth/v1/user')return answer({id:owner});
  if(u.pathname==='/rest/v1/reference_capture_status')return answer([state.task]);
  if(u.pathname==='/rest/v1/artwork_masters')return answer(state.masters);
  if(u.pathname==='/rest/v1/reference_capture_files'){
   if(method==='POST'){const value=JSON.parse(opts.body);const prior=state.files.find(r=>r.part_index===value.part_index);prior?Object.assign(prior,value):state.files.push(value);return answer(null,204);}
   return answer(state.files.filter(r=>(!u.searchParams.has('part_index')||'eq.'+r.part_index===u.searchParams.get('part_index'))&&(!u.searchParams.has('sha256')||'eq.'+r.sha256===u.searchParams.get('sha256'))));
  }
  if(u.pathname.startsWith('/storage/v1/object/')){if(!state.chunks.length)return answer({message:'not found'},404);let bytes=Buffer.concat(state.chunks);if(state.corruptReadback){bytes=Buffer.from(bytes);bytes[30]^=1;}return new Response(bytes);}
  if(u.pathname==='/storage/v1/upload/resumable'&&method==='POST')return new Response(null,{status:201,headers:{location:'https://storage.test/storage/v1/upload/resumable/job','upload-offset':'0'}});
  if(u.pathname==='/storage/v1/upload/resumable/job'){
   if(method==='HEAD')return new Response(null,{status:200,headers:{'upload-offset':String(Buffer.concat(state.chunks).length)}});
   if(method==='PATCH'){assert.equal(Number(opts.headers['Upload-Offset']),Buffer.concat(state.chunks).length);state.chunks.push(Buffer.from(opts.body));state.patchCalls++;if(state.failAfterFirstChunk&&state.patchCalls===1)throw Error('connection dropped after server accepted bytes');return new Response(null,{status:204,headers:{'upload-offset':String(Buffer.concat(state.chunks).length)}});}
  }
  if(u.pathname==='/rest/v1/rpc/register_capture_original'){const p=JSON.parse(opts.body);state.rpcCalls.push(p);state.task.resolved_project_id=projectId;state.masters=[{id:'master',project_id:projectId,storage_path:'masters/'+owner+'/'+p.p_sha256+'.png'}];return answer({master_id:'master',project_id:projectId});}
  throw Error('unexpected request '+method+' '+u.pathname);
 };
 const options={directory:downloads,stateDirectory:path.join(dir,'state'),fetchImpl:fake,api:'https://api.test',storage:'https://storage.test'};
 const client=new CaptureClient(options);await client.load();await client.setSession('only-in-memory-session');const input={taskId,source,part:1,count:1,filename};return {client,state,input,options,dir};
}
test('native framing handles fragmented UTF-8 messages and rejects oversized input',()=>{const packet=frame({command:'hello',name:'古画母图'}),decoder=new Decoder();assert.equal(decoder.push(packet.subarray(0,5)).length,0);assert.equal(decoder.push(packet.subarray(5))[0].name,'古画母图');const invalid=Buffer.alloc(4);invalid.writeUInt32LE(2*1024*1024);assert.throws(()=>decoder.push(invalid),/长度/);});
test('native helper registers exact original bytes and metadata only after cloud readback',async t=>{const s=await setup(t);await s.client.processFile(s.input);assert.equal(s.state.rpcCalls.length,1);assert.deepEqual(Buffer.concat(s.state.chunks),await readFile(s.input.filename));const p=s.state.rpcCalls[0];assert.equal(p.p_width,7000);assert.equal(p.p_height,2000);assert.equal(p.p_bytes,150);assert.equal(p.p_title,'百鹊图卷');assert.equal(p.p_author,'查士标');assert.equal(p.p_era,'清');const journal=await readFile(path.join(s.options.stateDirectory,'progress.json'),'utf8');assert.equal(journal.includes('only-in-memory-session'),false);assert.equal(s.client.status().records[0].phase,'complete');});
test('server accepted a chunk before disconnect: restart resumes from server offset',async t=>{const s=await setup(t,CHUNK+450);s.state.failAfterFirstChunk=true;await assert.rejects(s.client.processFile(s.input),/connection dropped/);assert.equal(s.state.rpcCalls.length,0);assert.equal(Buffer.concat(s.state.chunks).length,CHUNK);const restarted=new CaptureClient(s.options);await restarted.load();await restarted.setSession('new-session');await restarted.processFile(s.input);assert.equal(s.state.patchCalls,2);assert.equal(s.state.rpcCalls.length,1);assert.equal(Buffer.concat(s.state.chunks).length,CHUNK+450);});
test('wrong cloud SHA never creates a master or a success receipt',async t=>{const s=await setup(t);s.state.corruptReadback=true;await assert.rejects(s.client.processFile(s.input),/SHA-256/);assert.equal(s.state.rpcCalls.length,0);assert.equal(s.client.status().records[0].phase,'failed');});
test('same content from another artwork is stopped before upload',async t=>{const s=await setup(t);s.state.masters=[{id:'other',project_id:'different',storage_path:'other'}];await assert.rejects(s.client.processFile(s.input),/其他项目/);assert.equal(s.state.patchCalls,0);assert.equal(s.state.rpcCalls.length,0);});
test('paused task stops before transfer; directory boundary also blocks symbolic links',async t=>{const s=await setup(t);s.state.task.paused=true;await assert.rejects(s.client.processFile(s.input),/暂停/);assert.equal(s.state.patchCalls,0);const outside=path.join(s.dir,'outside.png');await writeFile(outside,picture());await assert.rejects(containedFile(s.options.directory,outside),/授权目录/);const link=path.join(s.options.directory,'link.png');await symlink(outside,link);await assert.rejects(containedFile(s.options.directory,link),/授权目录/);});
test('repeated file reuses cloud object, and a different part cannot claim identical bytes',async t=>{const s=await setup(t);await s.client.processFile(s.input);const calls=s.state.patchCalls;await s.client.processFile(s.input);assert.equal(s.state.patchCalls,calls);await assert.rejects(s.client.processFile({...s.input,part:2,count:2}),/另一分段/);});
test('transient cloud reads retry with visible bounded attempts then finish the original association',async t=>{
 const s=await setup(t),fetch=s.client.fetch,events=[];let attempts=0;s.client.event=e=>events.push(e);s.client.delay=async()=>{};
 s.client.fetch=async(url,options)=>{if(new URL(url).pathname==='/rest/v1/reference_capture_status'&&++attempts<=3){if(attempts===1)return new Response('',{status:520});throw Object.assign(Error('socket reset'),{code:'ECONNRESET'});}return fetch(url,options);};
 await s.client.processFile(s.input);assert.equal(events.filter(e=>e.phase==='retrying').length,3);assert.equal(s.state.rpcCalls.length,1);assert.equal(s.state.patchCalls,1);assert.equal(s.client.status().records[0].phase,'complete');
});
test('a PATCH accepted before a socket reset recovers its server offset automatically without sending those bytes twice',async t=>{
 const s=await setup(t,CHUNK+450),fetch=s.client.fetch;s.client.delay=async()=>{};s.state.failAfterFirstChunk=true;
 s.client.fetch=async(url,options)=>{try{return await fetch(url,options);}catch(e){if(e.message.includes('connection dropped'))e.code='ECONNRESET';throw e;}};
 await s.client.processFile(s.input);assert.equal(s.state.patchCalls,2);assert.deepEqual(Buffer.concat(s.state.chunks),await readFile(s.input.filename));assert.equal(s.state.rpcCalls.length,1);
});
test('persistent resets exhaust three retries and manual pause interrupts the backoff instead of continuing',async t=>{
 const s=await setup(t);let calls=0;s.client.delay=async()=>{};s.client.fetch=async()=>{calls++;throw Object.assign(Error('reset'),{code:'ECONNRESET'});};
 await assert.rejects(s.client.processFile(s.input),e=>e.retryAttempts===3&&e.code==='ART_NETWORK');assert.equal(calls,4);assert.equal(s.client.running,false);
 calls=0;s.client.delay=(ms,signal)=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});s.client.event=e=>{if(e.phase==='retrying')queueMicrotask(()=>{s.client.paused=true;});};
 await assert.rejects(s.client.processFile(s.input),e=>e.code==='ART_PAUSED');assert.equal(calls,1);assert.equal(s.client.running,false);
});
test('authentication failures are not retried',async t=>{const s=await setup(t);let calls=0;s.client.fetch=async()=>{calls++;return new Response('',{status:401});};await assert.rejects(s.client.processFile(s.input),e=>e.code==='ART_AUTH');assert.equal(calls,1);});
test('upload offset recovery has one retry budget instead of nesting another three HEAD retries',async t=>{
 const s=await setup(t),fetch=s.client.fetch;let heads=0,patches=0;s.client.delay=async()=>{};
 s.client.fetch=async(url,options)=>{if(options.method==='PATCH'){patches++;throw Object.assign(Error('reset'),{code:'ECONNRESET'});}if(options.method==='HEAD'){heads++;throw Object.assign(Error('reset'),{code:'ECONNRESET'});}return fetch(url,options);};
 await assert.rejects(s.client.processFile(s.input),/ECONNRESET/);assert.equal(patches,1);assert.equal(heads,3);assert.equal(s.state.rpcCalls.length,0);
});
test('cloud connection probes retry temporary failures and keep an upload HEAD that returns 404 reachable',async t=>{
 const s=await setup(t);let healthCalls=0;s.client.delay=async()=>{};s.client.fetch=async(url)=>new URL(url).pathname.endsWith('/health')?(++healthCalls===1?new Response('',{status:503}):new Response('{}')):new Response(null,{status:404});
 assert.equal((await s.client.networkCheck()).ok,true);assert.equal(healthCalls,2);
});
test('native pause aborts an in-flight cloud read immediately and allows an explicit later resume',async t=>{
 const s=await setup(t),fetch=s.client.fetch;s.client.fetch=async(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true}));
 const pending=s.client.processFile(s.input);await new Promise(setImmediate);s.client.paused=true;await assert.rejects(pending,e=>e.code==='ART_PAUSED');assert.equal(s.client.activeRequests.size,0);s.client.paused=false;s.client.fetch=fetch;await s.client.processFile(s.input);assert.equal(s.state.rpcCalls.length,1);
});
test('download evidence is captured only for an armed normal site download link',()=>{const listeners=new Map(),sent=[];class Anchor{constructor(){this.href='blob:https://g2.ltfc.net/original';this.download='original.jpg';}click(){}dispatchEvent(){}}
 const window={top:null,addEventListener:(name,fn)=>listeners.set(name,fn),postMessage:m=>sent.push(m)};window.top=window;const location={origin:'https://g2.ltfc.net',href:source};const ctx=vm.createContext({window,location,HTMLAnchorElement:Anchor,Date});vm.runInContext(readFileSync(new URL('../extension/download_bridge.js',import.meta.url),'utf8'),ctx);const a=new Anchor();a.click();assert.equal(sent.length,0);listeners.get('message')({source:window,origin:location.origin,data:{type:'ART_ORIGINAL_ARM',nonce:'bound-task'}});a.click();assert.equal(sent[0].nonce,'bound-task');assert.equal(sent[0].href,a.href);location.href=source.replace('608a61b2aa7c385c8d9448d5','608a623142b4355c93c903e6');a.click();assert.equal(sent.length,1);});
test('page adapter rejects screenshot buttons and ambiguous download actions',()=>{const control=(label)=>({id:'',getBoundingClientRect:()=>({width:30,height:30}),getAttribute:n=>n==='aria-label'?label:null,click(){this.clicked=true;}});const original=control('下载原图'),screenshot=control('下载截图'),next=control('下一页');const pager={...control(''),innerText:'1 / 19'};let controls=[original,screenshot,next];const ctx=vm.createContext({document:{title:'地狱绘卷 - 中华珍宝馆',body:{innerText:'共19张'},querySelectorAll:s=>s==='button,a,[role="button"]'?controls:[pager]},getComputedStyle:()=>({visibility:'visible',display:'block'}),location:{href:source},chrome:{},crypto:{},setTimeout(){},Map,Date});vm.runInContext(readFileSync(new URL('../extension/automation.js',import.meta.url),'utf8')+';globalThis.adapter=CaptureAutomation;',ctx);const result=ctx.adapter.inspectPage('download');assert.equal(result.count,19);assert.equal(result.position.part,1);assert.equal(original.clicked,true);assert.equal(screenshot.clicked,undefined);controls=[original,control('下载')];assert.match(ctx.adapter.inspectPage('download').error,/唯一识别/);});

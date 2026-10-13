import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
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
  if(u.pathname==='/rest/v1/artwork_masters')return answer(state.masters.filter(m=>!u.searchParams.has('sha256')||!m.sha256||u.searchParams.get('sha256')==='eq.'+m.sha256));
  if(u.pathname==='/rest/v1/reference_capture_files'){
   if(method==='POST'){const value={id:'capture-'+JSON.parse(opts.body).part_index,...JSON.parse(opts.body)};const prior=state.files.find(r=>r.part_index===value.part_index);prior?Object.assign(prior,value):state.files.push(value);return answer(null,204);}
   if(method==='PATCH'){state.beforeFilePatch?.();const found=state.files.filter(r=>[...u.searchParams].every(([key,value])=>value==='is.null'?r[key]==null:value==='eq.'+r[key]));for(const row of found)Object.assign(row,JSON.parse(opts.body));state.filePatchCalls=(state.filePatchCalls||0)+1;return answer(found);}
   return answer(state.files.filter(r=>(!u.searchParams.has('part_index')||'eq.'+r.part_index===u.searchParams.get('part_index'))&&(!u.searchParams.has('sha256')||'eq.'+r.sha256===u.searchParams.get('sha256'))));
  }
  if(u.pathname.startsWith('/storage/v1/object/')){if(!state.chunks.length)return answer({message:'not found'},404);let bytes=Buffer.concat(state.chunks);if(state.corruptReadback){bytes=Buffer.from(bytes);bytes[30]^=1;}return new Response(bytes);}
  if(u.pathname==='/storage/v1/upload/resumable'&&method==='POST')return new Response(null,{status:201,headers:{location:'https://storage.test/storage/v1/upload/resumable/job','upload-offset':'0'}});
  if(u.pathname==='/storage/v1/upload/resumable/job'){
   if(method==='HEAD')return new Response(null,{status:200,headers:{'upload-offset':String(Buffer.concat(state.chunks).length)}});
   if(method==='PATCH'){assert.equal(Number(opts.headers['Upload-Offset']),Buffer.concat(state.chunks).length);state.chunks.push(Buffer.from(opts.body));state.patchCalls++;if(state.failAfterFirstChunk&&state.patchCalls===1)throw Error('connection dropped after server accepted bytes');return new Response(null,{status:204,headers:{'upload-offset':String(Buffer.concat(state.chunks).length)}});}
  }
  if(u.pathname==='/rest/v1/rpc/register_capture_original'){const p=JSON.parse(opts.body);state.rpcCalls.push(p);state.task.resolved_project_id=projectId;state.masters=[{id:'master',created_by:owner,project_id:projectId,sha256:p.p_sha256,verified_sha256:p.p_sha256,verified_at:new Date().toISOString(),original_bytes:p.p_bytes,storage_path:'masters/'+owner+'/'+p.p_sha256+'.png'}];Object.assign(state.files.find(f=>f.part_index===p.p_part_index),{phase:'complete',master_id:'master',sha256:p.p_sha256});return answer({master_id:'master',project_id:projectId});}
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
test('failed duplicate repair archives evidence and clears only the unverified part, never the original file',async t=>{
 const s=await setup(t);await s.client.processFile({...s.input,count:2});const failed={...s.input,part:2,count:2};await assert.rejects(s.client.processFile(failed),/另一分段/);const first=structuredClone(s.state.files.find(f=>f.part_index===1)),before=await readFile(s.input.filename),info=await s.client.reviewPart(failed);assert.equal(info.duplicateParts[0].part_index,1);
 assert.equal((await s.client.resetFailedPart(failed)).reset,true);assert.deepEqual(s.state.files.find(f=>f.part_index===1),first);assert.equal(s.state.files.find(f=>f.part_index===2).sha256,null);assert.equal(s.client.records[owner+':'+taskId+':2'],undefined);assert.deepEqual(await readFile(s.input.filename),before);const saved=JSON.parse(await readFile(path.join(s.options.stateDirectory,'progress.json'),'utf8'));assert.equal(saved.repairs[0].cloud.sha256,first.sha256);assert.equal(saved.repairs[0].status,'reset');assert.equal(JSON.stringify(saved).includes('only-in-memory-session'),false);
 const fresh=path.join(s.options.directory,'清_查士标_百鹊图卷_2.png'),bytes=picture();bytes[40]=25;await writeFile(fresh,bytes);s.state.chunks=[];s.state.masters=[];await s.client.processFile({...failed,filename:fresh});assert.equal(s.state.rpcCalls.length,2);assert.equal(s.state.files.find(f=>f.part_index===2).phase,'complete');assert.deepEqual(s.state.files.find(f=>f.part_index===1),first);
});
test('repair rejects successful parts and never resets a part that gained a cloud master concurrently',async t=>{
 const s=await setup(t);await s.client.processFile(s.input);await assert.rejects(s.client.resetFailedPart(s.input),/已有完成记录/);assert.equal(s.state.filePatchCalls||0,0);
 const failed={...s.input,part:2,count:2};await assert.rejects(s.client.processFile(failed),/另一分段/);s.state.beforeFilePatch=()=>Object.assign(s.state.files.find(f=>f.part_index===2),{phase:'complete',master_id:'other-master'});await assert.rejects(s.client.resetFailedPart(failed),/状态已改变/);assert.equal(s.client.records[owner+':'+taskId+':2'].hash,s.state.files[0].sha256);assert.equal(s.state.files.find(f=>f.part_index===2).master_id,'other-master');
});
test('repair rejects changed provenance or another account before modifying any cloud row',async t=>{
 const s=await setup(t);s.state.corruptReadback=true;await assert.rejects(s.client.processFile(s.input),/SHA-256/);const original=structuredClone(s.state.files);await assert.rejects(s.client.resetFailedPart({...s.input,source:source.replace('608a61b2aa7c385c8d9448d5','608a623142b4355c93c903e6')}),/来源不匹配/);s.client.owner='different-owner';await assert.rejects(s.client.resetFailedPart(s.input),/账号或作品来源不匹配/);assert.deepEqual(s.state.files,original);assert.equal(s.state.filePatchCalls||0,0);
});
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
function seedComplete(s,count=100,parts=Array.from({length:94},(_,i)=>i+1)){
 const bytes=picture(),hash=createHash('sha256').update(bytes).digest('hex');s.state.task.resolved_project_id=projectId;s.state.chunks=[bytes];
 s.state.files=parts.map(part=>({part_index:part,expected_count:count,phase:'complete',sha256:hash,master_id:'master-'+part}));s.state.masters=parts.map(part=>({id:'master-'+part,project_id:projectId,sha256:hash,verified_sha256:hash,verified_at:'2026-10-12T13:50:00Z',original_bytes:bytes.length,storage_path:'masters/'+owner+'/part-'+part+'.png'}));return hash;
}
test('94 of 100 resume fetches completed receipts in one batch without reading any cloud original',async t=>{
 const s=await setup(t);seedComplete(s);const fetch=s.client.fetch,requests=[],events=[];s.client.fetch=async(url,opts)=>{requests.push(new URL(url));return fetch(url,opts);};s.client.event=e=>events.push(e);
 const result=await s.client.completedParts({...s.input,count:100});assert.deepEqual(result.parts,Array.from({length:94},(_,i)=>i+1));assert.equal(result.receipts.length,94);assert.equal(result.receipts[93].master_id,'master-94');assert.equal(result.verification,'receipts');assert.equal(requests.filter(u=>u.pathname==='/rest/v1/artwork_masters').length,1);assert.equal(requests.some(u=>u.pathname.startsWith('/storage/')),false);assert.equal(events.at(-1).part,95);assert.equal(s.client.running,false);
});
test('receipt reuse requires matching task, project, SHA, verified hash, size and completed phase',async t=>{
 const s=await setup(t);seedComplete(s,8,[1,2,3,4,5,6,7,8]);s.state.masters[1].project_id='other';s.state.masters[2].sha256='a'.repeat(64);s.state.masters[3].verified_sha256='b'.repeat(64);s.state.masters[4].verified_at=null;s.state.masters[5].original_bytes=0;s.state.files[6].phase='failed';s.state.masters.pop();assert.deepEqual((await s.client.completedParts({...s.input,count:8})).parts,[1]);
 await assert.rejects(s.client.completedParts({...s.input,count:9}),/总张数/);s.state.task.created_by='other';await assert.rejects(s.client.completedParts({...s.input,count:8}),/账号或作品来源/);s.state.task.created_by=owner;await assert.rejects(s.client.completedParts({...s.input,source:source.replace('608a61b2aa7c385c8d9448d5','608a623142b4355c93c903e6'),count:8}),/账号或作品来源/);
});
test('explicit acceptance repeat reads full original bytes and detects changed cloud objects',async t=>{
 const s=await setup(t);seedComplete(s,2,[1,2]);const fetch=s.client.fetch;let readbacks=0;s.client.fetch=async(url,opts)=>{if(new URL(url).pathname.startsWith('/storage/v1/object/'))readbacks++;return fetch(url,opts);};
 assert.equal((await s.client.completedParts({...s.input,count:2,recheck:true})).verification,'readback');assert.equal(readbacks,2);s.state.corruptReadback=true;await assert.rejects(s.client.completedParts({...s.input,count:2,recheck:true}),/SHA-256/);assert.equal(s.client.running,false);
});
test('active same-account credentials rotate in memory without resetting work or resuming a pause',async t=>{
 const s=await setup(t);s.client.running=true;s.client.context={command:'file',part:95};await s.client.refreshSession('new-ephemeral-token',owner);assert.equal(s.client.session,'new-ephemeral-token');assert.equal(s.client.running,true);assert.deepEqual(s.client.context,{command:'file',part:95});await s.client.save();assert.equal((await readFile(path.join(s.options.stateDirectory,'progress.json'),'utf8')).includes('new-ephemeral-token'),false);
 s.client.fetch=async()=>new Response(JSON.stringify({id:projectId}));await assert.rejects(s.client.refreshSession('other-user-token',owner),/其他账号/);assert.equal(s.client.session,'new-ephemeral-token');await assert.rejects(s.client.refreshSession('other-user-token',projectId),/账号不匹配/);s.client.paused=true;await assert.rejects(s.client.refreshSession('later-token',owner),e=>e.code==='ART_PAUSED');assert.equal(s.client.paused,true);assert.equal(s.client.session,'new-ephemeral-token');
});
test('an expired in-flight metadata request retries only after a verified same-account token rotation',async t=>{
 const s=await setup(t),fetch=s.client.fetch,headers=[];s.client.delay=async()=>{};s.client.fetch=async(url,opts)=>{if(new URL(url).pathname==='/rest/v1/reference_capture_status'){headers.push(opts.headers.authorization);if(headers.length===1){await s.client.refreshSession('fresh-token',owner);return new Response('',{status:401});}}return fetch(url,opts);};
 await s.client.checkTask(taskId,source);assert.deepEqual(headers,['Bearer only-in-memory-session','Bearer fresh-token']);
});
test('opted-in cleanup removes only the original after registration and keeps exact cloud bytes and receipts',async t=>{
 const s=await setup(t),original=await readFile(s.input.filename),result=await s.client.processFile({...s.input,autoCleanup:true});assert.equal(result.cleanup.status,'deleted');await assert.rejects(readFile(s.input.filename),e=>e.code==='ENOENT');assert.deepEqual(Buffer.concat(s.state.chunks),original);assert.equal(s.client.status().records[0].phase,'complete');assert.equal(s.state.files[0].phase,'complete');assert.equal(s.state.rpcCalls.length,1);
 const restarted=new CaptureClient(s.options);await restarted.load();await restarted.setSession('resumed-token');const resumed=await restarted.completedParts(s.input);assert.deepEqual(resumed.parts,[1]);assert.equal(resumed.receipts[0].cleanup.status,'deleted');assert.equal((await restarted.cleanupCompleted()).alreadyDeleted,1);
});
test('failed original verification retains the local file even with automatic cleanup enabled',async t=>{
 const s=await setup(t);s.state.corruptReadback=true;await assert.rejects(s.client.processFile({...s.input,autoCleanup:true}),/SHA-256/);assert.equal((await readFile(s.input.filename)).length,150);assert.equal(s.client.records[owner+':'+taskId+':1'].cleanup,undefined);
});
test('cloud receipt disagreement leaves upload complete and keeps the local original',async t=>{
 const s=await setup(t),fetch=s.client.fetch;s.client.fetch=async(url,opts)=>{const response=await fetch(url,opts);if(new URL(url).pathname==='/rest/v1/rpc/register_capture_original')s.state.masters[0].verified_sha256='f'.repeat(64);return response;};
 const result=await s.client.processFile({...s.input,autoCleanup:true});assert.equal(result.cleanup.status,'kept');assert.match(result.cleanup.reason,/云端完成记录/);assert.equal((await readFile(s.input.filename)).length,150);assert.equal(s.client.status().records[0].phase,'complete');assert.equal(s.state.files[0].phase,'complete');
});
test('a replacement at the download path after upload is retained even when it has identical bytes',async t=>{
 const s=await setup(t),fetch=s.client.fetch;s.client.fetch=async(url,opts)=>{const response=await fetch(url,opts);if(new URL(url).pathname==='/rest/v1/rpc/register_capture_original'){const {rename}=await import('node:fs/promises');await rename(s.input.filename,s.input.filename+'.backup');await writeFile(s.input.filename,picture());}return response;};
 const result=await s.client.processFile({...s.input,autoCleanup:true});assert.equal(result.cleanup.status,'kept');assert.match(result.cleanup.reason,/本地文件已变化/);assert.equal((await readFile(s.input.filename)).length,150);
});
test('a locked Windows file is recorded as retained and can be cleaned later without re-uploading',async t=>{
 const s=await setup(t);s.client.removeFile=async()=>{throw Object.assign(Error('locked'),{code:'EPERM'});};const result=await s.client.processFile({...s.input,autoCleanup:true});assert.equal(result.cleanup.status,'kept');assert.match(result.cleanup.reason,/占用或没有删除权限/);assert.equal(s.client.status().records[0].phase,'complete');s.client.removeFile=null;const cleanup=await s.client.cleanupCompleted();assert.equal(cleanup.deleted,1);assert.equal(cleanup.bytesFreed,150);assert.equal(s.state.rpcCalls.length,1);
});
test('manual cleanup rechecks cloud bytes and retains a changed local original',async t=>{
 const s=await setup(t);await s.client.processFile(s.input);const altered=picture();altered[80]=42;await writeFile(s.input.filename,altered);const result=await s.client.cleanupCompleted();assert.equal(result.deleted,0);assert.equal(result.kept,1);assert.match(result.details[0].reason,/本地文件与已上传原图不一致/);assert.deepEqual(await readFile(s.input.filename),altered);
});
test('manual cleanup keeps the local copy when the previously verified cloud object is corrupt or missing',async t=>{
 const s=await setup(t);await s.client.processFile(s.input);s.state.corruptReadback=true;assert.equal((await s.client.cleanupCompleted()).kept,1);assert.equal((await readFile(s.input.filename)).length,150);s.state.corruptReadback=false;s.state.chunks=[];assert.equal((await s.client.cleanupCompleted()).deleted,0);assert.equal((await readFile(s.input.filename)).length,150);
});
test('cleanup refuses outside paths, symbolic links, and files not in current-account completed records',async t=>{
 const s=await setup(t);await s.client.processFile(s.input);const record=s.client.records[owner+':'+taskId+':1'];const outside=path.join(s.dir,'outside.png');await writeFile(outside,picture());const original=record.filename;record.filename=outside;assert.equal((await s.client.cleanupCompleted()).kept,1);assert.equal((await readFile(outside)).length,150);
 const link=path.join(s.options.directory,'linked.png');await symlink(original,link);record.filename=link;assert.equal((await s.client.cleanupCompleted()).kept,1);assert.equal((await readFile(original)).length,150);
 record.filename=original;record.phase='failed';s.client.records[projectId+':'+taskId+':1']={...record,phase:'complete',filename:outside};assert.equal((await s.client.cleanupCompleted()).total,0);assert.equal((await readFile(outside)).length,150);assert.equal((await readFile(original)).length,150);
});
test('pause during cleanup prevents deletion and later explicit cleanup can resume',async t=>{
 const s=await setup(t);await s.client.processFile(s.input);const fetch=s.client.fetch;s.client.fetch=async(url,opts)=>{const response=await fetch(url,opts);if(new URL(url).pathname.startsWith('/storage/v1/object/'))s.client.paused=true;return response;};const result=await s.client.cleanupCompleted();assert.equal(result.deleted,0);assert.equal(result.kept,1);assert.equal((await readFile(s.input.filename)).length,150);s.client.fetch=fetch;await s.client.setSession('resumed-token');assert.equal((await s.client.cleanupCompleted()).deleted,1);
});
test('persistent cloud outage stops bulk cleanup after one bounded retry budget and keeps remaining files',async t=>{
 const s=await setup(t);await s.client.processFile({...s.input,count:2});s.client.records[owner+':'+taskId+':2']={...s.client.records[owner+':'+taskId+':1'],part:2};let calls=0;s.client.delay=async()=>{};s.client.fetch=async()=>{calls++;return new Response('',{status:503});};const result=await s.client.cleanupCompleted();assert.equal(calls,4);assert.equal(result.deleted,0);assert.equal(result.kept,1);assert.equal(result.remaining,1);assert.equal((await readFile(s.input.filename)).length,150);
});
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

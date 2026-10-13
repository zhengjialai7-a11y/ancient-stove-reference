import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {CaptureClient} from '../local-agent/core.mjs';
import {R2_PART_SIZE,r2Origin,r2ObjectKey} from '../local-agent/r2.mjs';
import {createCloudTransport} from '../local-agent/network.mjs';

const owner='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',projectId='33333333-3333-4333-8333-333333333333';
const source='https://g2.ltfc.net/view/SUHA/608a61b2aa7c385c8d9448d5',origin='https://originals.example.workers.dev';
function png(bytes){const b=Buffer.alloc(bytes,33);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(11000,16);b.writeUInt32BE(2300,20);return b;}
async function setup(t,size=R2_PART_SIZE+93){
 const directory=await mkdtemp(path.join(tmpdir(),'capture-r2-'));t.after(()=>rm(directory,{recursive:true,force:true}));const download=path.join(directory,'downloads');await mkdir(download);
 const filename=path.join(download,'北宋_张择端_清明上河图_1.png'),bytes=png(size),hash=createHash('sha256').update(bytes).digest('hex'),key='masters/'+owner+'/'+hash+'.png';await writeFile(filename,bytes);
 const state={config:{provider:'r2',enabled:true,endpoint:origin},task:{id:taskId,created_by:owner,source_type:'SUHA',source_id:source.split('/').at(-1),source_url:source,paused:false,candidate_count:0,resolved_project_id:null},parts:new Map(),puts:[],files:[],masters:[],receipts:[],registrations:[],requests:[],final:null};
 const json=(data,status=200)=>new Response(status===204?null:JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 function receipt(){return {owner,storage_origin:origin,path:key,sha256:hash,bytes:size,mime:'image/png',etag:'final-etag',issued_at:new Date().toISOString(),signature:'fake-server-signature'};}
 const fake=async(url,options={})=>{
  const u=new URL(url),method=options.method||'GET',body=options.body;state.requests.push({origin:u.origin,path:u.pathname,method,authorization:options.headers?.authorization});
  if(u.origin===origin){
   assert.equal(options.headers?.authorization,'Bearer session-in-memory');assert.equal(options.headers?.apikey,undefined);
   if(u.pathname==='/v1/uploads'&&method==='POST'){state.createCalls=(state.createCalls||0)+1;return json({uploadId:'job-1',key,partSize:R2_PART_SIZE,parts:[...state.parts].map(([partNumber])=>({partNumber,etag:'part-'+partNumber}))});}
   if(u.pathname.startsWith('/v1/uploads/job-1/parts/')&&method==='PUT'){
    assert.equal(u.searchParams.get('key'),key);const partNumber=Number(u.pathname.split('/').at(-1));if(state.expireOnPart===partNumber){state.expireOnPart=null;state.parts.clear();return json({code:'UPLOAD_EXPIRED',error:'上传已过期'},409);}state.puts.push(partNumber);state.parts.set(partNumber,Buffer.from(body));
    if(state.failPart===partNumber){state.failPart=null;throw Error('interrupted after accepted R2 part');}return json({partNumber,etag:'part-'+partNumber});
   }
   if(u.pathname==='/v1/uploads/job-1/complete'&&method==='POST'){
    const p=JSON.parse(body);assert.equal(p.key,key);assert.equal(p.sha256,hash);assert.deepEqual(p.parts,[...state.parts].sort(([a],[b])=>a-b).map(([partNumber])=>({partNumber,etag:'part-'+partNumber})));state.final=Buffer.concat([...state.parts].sort(([a],[b])=>a-b).map(([,data])=>data));
    if(state.loseComplete){state.loseComplete=false;throw Error('lost completion response');}return json({key,bytes:size,etag:'final-etag',receipt:receipt()});
   }
   if(u.pathname==='/v1/objects/'+key){if(!state.final)return json({message:'not found'},404);const value=state.corrupt?Buffer.from(state.final):state.final;if(state.corrupt)value[80]^=1;return new Response(value);}
   if(u.pathname==='/v1/receipts'&&method==='POST'){state.receiptCalls=(state.receiptCalls||0)+1;return json({...receipt(),...(state.badReceipt?{bytes:size+1}:{})});}
  }
  if(u.pathname==='/auth/v1/user')return json({id:owner});
  if(u.pathname==='/rest/v1/rpc/get_original_storage_config'){if(state.configFailure)return json({message:'cannot read config'},state.configFailure);return json(state.config);}
  if(u.pathname==='/rest/v1/reference_capture_status')return json([state.task]);
  if(u.pathname==='/rest/v1/artwork_masters')return json(state.masters.filter(m=>!u.searchParams.has('sha256')||u.searchParams.get('sha256')==='eq.'+m.sha256));
  if(u.pathname==='/rest/v1/reference_capture_files'){
   if(method==='POST'){const p=JSON.parse(body),old=state.files.find(f=>f.part_index===p.part_index);old?Object.assign(old,p):state.files.push(p);return json(null,204);}
   return json(state.files.filter(f=>(!u.searchParams.has('part_index')||u.searchParams.get('part_index')==='eq.'+f.part_index)&&(!u.searchParams.has('sha256')||u.searchParams.get('sha256')==='eq.'+f.sha256)));
  }
  if(u.pathname==='/rest/v1/rpc/record_r2_original_receipt'){state.receipts.push(JSON.parse(body).p_receipt);return json({recorded:true});}
  if(u.pathname==='/rest/v1/rpc/register_capture_original'){
   const p=JSON.parse(body);if(p.p_storage_provider==='r2')assert.equal(state.receipts.length>0,true);state.registrations.push(p);state.task.resolved_project_id=projectId;
   state.masters=[{id:'mother',created_by:owner,project_id:projectId,sha256:hash,verified_sha256:hash,verified_at:new Date().toISOString(),original_bytes:size,storage_path:key,storage_provider:p.p_storage_provider||'supabase',storage_origin:p.p_storage_origin||null}];Object.assign(state.files.find(f=>f.part_index===p.p_part_index),{phase:'complete',master_id:'mother'});return json({master_id:'mother',project_id:projectId});
  }
  if(u.pathname.startsWith('/storage/v1/object/'))return state.legacy?new Response(state.legacy):json({message:'not found'},404);
  throw Error('unexpected request '+method+' '+u.origin+u.pathname);
 };
 const allowed=[],options={directory:download,stateDirectory:path.join(directory,'state'),api:'https://api.test',storage:'https://storage.test',fetchImpl:fake,retryDelays:[],discoverStorageConfig:true,allowStorageOrigin:async value=>allowed.push(value)},client=new CaptureClient(options);await client.load();await client.setSession('session-in-memory');
 return {client,state,options,input:{taskId,source,part:1,count:1,filename},hash,key,bytes,allowed};
}

test('80 MiB original resumes multipart upload after restart without retransmitting acknowledged first part',async t=>{
 const s=await setup(t,80*1024*1024+27);s.state.failPart=2;
 await assert.rejects(s.client.processFile({...s.input,autoCleanup:true}),/interrupted/);assert.deepEqual(s.state.puts,[1,2]);assert.equal(s.state.registrations.length,0);assert.equal((await readFile(s.input.filename)).length,s.bytes.length);
 const saved=JSON.parse(await readFile(path.join(s.options.stateDirectory,'progress.json'),'utf8'));assert.equal(saved.version,3);assert.equal(saved.r2[owner+':'+s.hash].parts.length,1);assert.equal(JSON.stringify(saved).includes('session-in-memory'),false);
 const restarted=new CaptureClient(s.options);await restarted.load();await restarted.setSession('session-in-memory');await restarted.processFile(s.input);
 assert.equal(s.state.puts.filter(n=>n===1).length,1);assert.equal(s.state.puts.filter(n=>n===2).length,2);assert.deepEqual(s.state.final,s.bytes);assert.equal(s.state.registrations[0].p_storage_provider,'r2');assert.equal(s.state.registrations[0].p_storage_origin,origin);assert.equal(s.state.registrations[0].p_width,11000);assert.equal(s.state.registrations[0].p_height,2300);assert.equal(Object.keys(restarted.r2).length,0);
});
test('wrong R2 readback hash never registers a receipt or mother and retains local original',async t=>{
 const s=await setup(t,300);s.state.corrupt=true;await assert.rejects(s.client.processFile({...s.input,autoCleanup:true}),/SHA-256/);assert.equal(s.state.receipts.length,0);assert.equal(s.state.registrations.length,0);assert.deepEqual(await readFile(s.input.filename),s.bytes);
});
test('an expired R2 multipart session is replaced once without losing the local original',async t=>{
 const s=await setup(t);s.state.failPart=2;await assert.rejects(s.client.processFile(s.input),/interrupted/);s.state.expireOnPart=2;
 const restarted=new CaptureClient(s.options);await restarted.load();await restarted.setSession('session-in-memory');await restarted.processFile(s.input);
 assert.equal(s.state.createCalls,2);assert.equal(s.state.puts.filter(n=>n===1).length,2);assert.deepEqual(s.state.final,s.bytes);assert.deepEqual(await readFile(s.input.filename),s.bytes);assert.equal(s.state.registrations.length,1);
});
test('a lost R2 completion response is recovered by full final-object readback',async t=>{
 const s=await setup(t,300);s.state.loseComplete=true;const result=await s.client.processFile({...s.input,autoCleanup:true});assert.equal(result.cleanup.status,'deleted');assert.equal(s.state.receipts.length,1);assert.equal(s.state.registrations.length,1);assert.deepEqual(s.state.final,s.bytes);await assert.rejects(readFile(s.input.filename),e=>e.code==='ENOENT');
 const result2=await s.client.completedParts({...s.input,recheck:true});assert.deepEqual(result2.parts,[1]);assert.equal(result2.receipts[0].cleanup.status,'deleted');
});
test('bad signed-receipt fields retain the original and never reach cloud registration',async t=>{
 const s=await setup(t,300);s.state.badReceipt=true;await assert.rejects(s.client.processFile({...s.input,autoCleanup:true}),/回执与原图不一致/);assert.equal(s.state.receipts.length,0);assert.equal(s.state.registrations.length,0);assert.deepEqual(await readFile(s.input.filename),s.bytes);
});
test('existing Supabase mother keeps its storage provider even after R2 becomes the default',async t=>{
 const s=await setup(t,300);s.state.legacy=s.bytes;s.state.task.resolved_project_id=projectId;s.state.masters=[{id:'mother',created_by:owner,project_id:projectId,sha256:s.hash,verified_sha256:s.hash,verified_at:new Date().toISOString(),original_bytes:s.bytes.length,storage_path:s.key}];
 await s.client.processFile(s.input);assert.equal(s.state.puts.length,0);assert.equal(s.state.receipts.length,0);assert.equal(s.state.registrations[0].p_storage_provider,undefined);assert.equal(s.state.requests.some(r=>r.path.startsWith('/storage/v1/object/')),true);
});
test('manual cleanup follows stored R2 provider and refuses changed cloud bytes',async t=>{
 const s=await setup(t,300);await s.client.processFile(s.input);s.state.corrupt=true;const cleanup=await s.client.cleanupCompleted();assert.equal(cleanup.kept,1);assert.match(cleanup.details[0].reason,/SHA-256/);assert.deepEqual(await readFile(s.input.filename),s.bytes);
});
test('disabled R2 retains oversized original with a concrete storage-limit record',async t=>{
 const s=await setup(t,51*1024*1024);s.state.config={provider:'supabase',enabled:false,endpoint:null};await assert.rejects(s.client.processFile({...s.input,autoCleanup:true}),e=>e.code==='ART_STORAGE_LIMIT'&&/R2/.test(e.message));assert.equal(s.state.puts.length,0);assert.equal(s.state.files[0].phase,'failed');assert.equal(s.state.registrations.length,0);assert.equal((await readFile(s.input.filename)).length,s.bytes.length);
});
test('auth or network error while loading R2 config never falls back to another storage provider',async t=>{
 const s=await setup(t,300);s.state.configFailure=401;await assert.rejects(s.client.processFile(s.input),e=>e.code==='ART_AUTH');assert.equal(s.state.puts.length,0);assert.equal(s.state.requests.some(r=>r.path.startsWith('/storage/')),false);assert.equal(s.state.registrations.length,0);
});
test('untrusted stored origins and credential-bearing or local endpoints never receive credentials',async t=>{
 const s=await setup(t,300);s.state.task.resolved_project_id=projectId;s.state.masters=[{id:'mother',project_id:projectId,sha256:s.hash,storage_path:s.key,storage_provider:'r2',storage_origin:'https://attacker.example.workers.dev'}];await assert.rejects(s.client.processFile(s.input),/尚未连接/);assert.equal(s.state.requests.some(r=>r.origin==='https://attacker.example.workers.dev'),false);
 for(const value of ['http://originals.example.workers.dev','https://name:secret@originals.example.workers.dev','https://originals.example.workers.dev/redirect','https://originals.example.workers.dev:8443','https://localhost','https://127.0.0.1','https://files.local'])assert.throws(()=>r2Origin(value),/无效|不可信/);
 assert.throws(()=>r2ObjectKey('masters/'+projectId+'/'+s.hash+'.png',owner),/账号不匹配/);
});
test('trusted storage origin is added with its Windows proxy route without replacing existing connections',async()=>{
 const origins=['https://api.test','https://storage.test'],routes=[],requests=[],agents=[];
 class Agent{constructor(options){this.options=options;this.destroyed=false;agents.push(this);}destroy(){this.destroyed=true;}}
 const transport=createCloudTransport({origins,env:{},platform:'win32',Agent,resolveRoutes:async values=>{routes.push([...values]);return values.map(value=>({origin:value,proxy:value===origin?'http://localhost:7890':null}));},requestImpl:(url,options,callback)=>{
  const req=new EventEmitter();req.end=()=>{requests.push({url:url.href,options});const res=Readable.from([Buffer.from('exact original bytes')]);res.statusCode=200;res.headers={'content-type':'application/octet-stream'};callback(res);};return req;
 }});
 try{
  await assert.rejects(transport.fetch(origin+'/v1/objects/mother',{headers:{authorization:'Bearer local-only'}}),/非项目/);assert.equal(requests.length,0);
  await transport.fetch(origins[0]+'/health');await transport.allowOrigin(origin);assert.deepEqual(routes,[origins,[origin]]);assert.equal(agents.slice(0,2).some(agent=>agent.destroyed),false);assert.equal(transport.mode(origin),'system');
  const response=await transport.fetch(origin+'/v1/objects/mother',{headers:{authorization:'Bearer approved-session'}});assert.equal(await response.text(),'exact original bytes');assert.equal(requests.at(-1).options.agent.options.proxyEnv.HTTPS_PROXY,'http://localhost:7890');
  await assert.rejects(transport.allowOrigin('https://name:secret@originals.example.workers.dev'),/无效/);assert.equal(requests.length,2);
 }finally{transport.close();}
});

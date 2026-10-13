import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {test} from 'node:test';

const source=readFileSync(new URL('../original-storage.js',import.meta.url),'utf8');
const PART=8*1024*1024,endpoint='https://originals.fixture.test',owner='fixture-owner';
const sha256=async blob=>createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function fixture({enabled=true,rpcError=null,failPart=0,loseComplete=false,corrupt=false}={}){
 const requests=[],receipts=[],progress=[],parts=new Map(),legacyReads=[];
 let complete=false,uploaded=null,failed=false,createCalls=0,configCalls=0;
 const config={provider:enabled?'r2':'supabase',enabled,endpoint,readOrigins:[endpoint]};
 const db={
  auth:{getSession:async()=>({data:{session:{access_token:'session-fixture'}}})},
  rpc:async(name,args)=>{
   if(name==='get_original_storage_config'){configCalls++;return rpcError?{error:rpcError}:{data:config};}
   assert.equal(name,'record_r2_original_receipt');receipts.push(args.p_receipt);return {data:true};
  },
  storage:{from:()=>({getPublicUrl:key=>({data:{publicUrl:'https://old.fixture.test/storage/'+key}}),download:async key=>{legacyReads.push(key);return {data:uploaded||new Blob(['legacy'])};}})}
 };
 const fetchImpl=async(url,options)=>{
  assert.ok(url.startsWith(endpoint+'/'));assert.equal(options.headers.Authorization,'Bearer session-fixture');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  const u=new URL(url),method=options.method;requests.push({path:u.pathname,method,body:options.body});
  if(u.pathname==='/v1/uploads'){
   createCalls++;const meta=JSON.parse(options.body),key='masters/'+owner+'/'+meta.sha256+'.jpg';
   return json({uploadId:'resume-id',key,partSize:PART,parts:[...parts.values()].map(p=>p.receipt),completed:complete});
  }
  if(method==='PUT'){
   const n=Number(u.pathname.match(/\/parts\/(\d+)$/)?.[1]);assert.ok(n>0);assert.ok(options.body instanceof Blob);assert.equal(options.headers['Content-Type'],'application/octet-stream');assert.ok(options.body.size<=PART);
   if(n===failPart&&!failed){failed=true;throw Error('network disconnected');}
   const receipt={partNumber:n,etag:'etag-'+n};parts.set(n,{blob:options.body,receipt});return json(receipt);
  }
  if(u.pathname.endsWith('/complete')){
   const meta=JSON.parse(options.body);assert.deepEqual(meta.parts,[...parts.values()].map(p=>p.receipt).sort((a,b)=>a.partNumber-b.partNumber));
   uploaded=new Blob([...parts.entries()].sort((a,b)=>a[0]-b[0]).map(([,p])=>p.blob));assert.equal(uploaded.size,meta.bytes);assert.equal(await sha256(uploaded),meta.sha256);complete=true;
   if(loseComplete)throw Error('completion response lost');return json({receipt:{key:meta.key,sha256:meta.sha256}});
  }
  if(u.pathname.startsWith('/v1/objects/')){
   if(!uploaded)return new Response('missing',{status:404});
   if(corrupt){const bytes=new Uint8Array(await uploaded.arrayBuffer());bytes[0]^=1;return new Response(new Blob([bytes]));}
   return new Response(uploaded);
  }
  assert.equal(u.pathname,'/v1/receipts');const meta=JSON.parse(options.body);return json({receipt:{payload:{...meta,owner},signature:'server-signature'}});
 };
 const ctx=vm.createContext({URL,crypto:webcrypto,fetch:fetchImpl,AbortController,setTimeout,clearTimeout,WeakMap});vm.runInContext(source,ctx);
 const client=new ctx.OriginalStorage({db,bucket:'art-reference-images',fetchImpl,hash:sha256,onProgress:(sent,total)=>progress.push([sent,total])});
 return {client,config,requests,receipts,progress,parts,legacyReads,get createCalls(){return createCalls},get configCalls(){return configCalls},set uploaded(value){uploaded=value}};
}
async function targetFor(s,file){const hash=await sha256(file),path='masters/'+owner+'/'+hash+'.jpg';return {hash,target:await s.client.target(file.size,path)};}

test('80 MB raw original uses ten 8 MiB parts and records a receipt only after whole-file readback',async()=>{
 const s=fixture(),file=new File([new Uint8Array(80*1024*1024)],'large-original.jpg',{type:'image/jpeg'}),{hash,target}=await targetFor(s,file);
 const result=await s.client.upload(file,target,hash);assert.equal(result.storage_provider,'r2');assert.equal(s.parts.size,10);
 assert.equal(s.requests.filter(r=>r.path.startsWith('/v1/objects/')).length,1);assert.equal(s.receipts.length,1);assert.equal(s.receipts[0].payload.sha256,hash);
 assert.equal(s.receipts[0].payload.bytes,file.size);assert.deepEqual(s.progress.at(-1),[file.size,file.size]);
 const reassembled=new Blob([...s.parts.values()].map(p=>p.blob));assert.equal(await sha256(reassembled),hash);
 assert.equal(s.legacyReads.length,0);
});

test('retry resumes server-held parts without downloading or uploading the first part again',async()=>{
 const s=fixture({failPart:2}),file=new File([new Uint8Array(PART*2+7)],'resume.jpg',{type:'image/jpeg'}),{hash,target}=await targetFor(s,file);
 await assert.rejects(s.client.upload(file,target,hash),/network disconnected/);assert.equal(s.parts.size,1);assert.equal(s.receipts.length,0);
 await s.client.upload(file,target,hash);assert.equal(s.createCalls,2);assert.equal(s.parts.size,3);
 assert.equal(s.requests.filter(r=>r.method==='PUT'&&r.path.endsWith('/parts/1')).length,1);assert.equal(s.receipts.length,1);
});

test('lost completion response is recovered only through matching whole object bytes',async()=>{
 const s=fixture({loseComplete:true}),file=new File(['original bytes'],'lost.jpg',{type:'image/jpeg'}),{hash,target}=await targetFor(s,file);
 await s.client.upload(file,target,hash);assert.equal(s.receipts.length,1);assert.equal(s.requests.filter(r=>r.path.endsWith('/complete')).length,1);
 await s.client.upload(file,target,hash);assert.equal(s.requests.filter(r=>r.path.endsWith('/complete')).length,1);assert.equal(s.requests.filter(r=>r.method==='PUT').length,1);
});

test('mismatching SHA after upload leaves the server parts intact and never records a receipt',async()=>{
 const s=fixture({corrupt:true}),file=new File(['raw original'],'broken.jpg',{type:'image/jpeg'}),{hash,target}=await targetFor(s,file);
 await assert.rejects(s.client.upload(file,target,hash),/SHA-256/);assert.equal(s.parts.size,1);assert.equal(s.receipts.length,0);
 assert.equal(s.requests.filter(r=>r.path==='/v1/receipts').length,0);
});

test('R2 not connected blocks over 50 MB before any transfer while small Supabase originals remain supported',async()=>{
 const s=fixture({enabled:false});await assert.rejects(s.client.target(50*1024*1024+1,'masters/owner/hash.jpg'),/R2 未连接，母图已保留/);
 const target=await s.client.target(1024,'masters/owner/hash.jpg');assert.equal(target.storage_provider,'supabase');assert.equal(s.requests.length,0);
});

test('only a missing config RPC permits the legacy fallback; auth and network errors do not',async()=>{
 const old=fixture({rpcError:{code:'PGRST202',message:'missing RPC'}});assert.equal((await old.client.target(3,'masters/owner/hash.jpg')).storage_provider,'supabase');
 for(const error of [{code:'42501',message:'denied'},{code:'PGRST301',message:'expired'},{message:'network error'}]){
  const s=fixture({rpcError:error});await assert.rejects(s.client.target(3,'masters/owner/hash.jpg'),/读取母图存储配置失败/);assert.equal(s.requests.length,0);
 }
});

test('native canvas URL uses an approved public R2 route and never sends JWT to an editable origin',async()=>{
 const s=fixture(),master={storage_provider:'r2',storage_origin:endpoint,storage_path:'masters/owner/hash.jpg'};
 assert.equal(await s.client.publicUrl(master),endpoint+'/public/masters/owner/hash.jpg');assert.equal(s.requests.length,0);
 for(const value of ['https://evil.fixture.test','https://originals.fixture.test@evil.fixture.test','https://originals.fixture.test/other','https://originals.fixture.test:8443','https://127.0.0.1','https://[::1]','https://originals.local','https://originals.localhost','https://localhost','https://originals.fixture.test?x=1','https://originals.fixture.test#x']){
  await assert.rejects(s.client.download({...master,storage_origin:value}),/可信|来源|地址/);assert.equal(s.requests.length,0);
 }
 await assert.rejects(s.client.publicUrl({...master,storage_path:'masters/../secret'}),/路径无效/);
});

test('old Supabase mothers keep their public URLs and original bytes with R2 enabled',async()=>{
 const s=fixture(),file=new Blob(['native unchanged bytes']);s.uploaded=file;
 const old={storage_path:'masters/owner/old.jpg',original_width:3100,original_height:6484};
 assert.equal(await s.client.publicUrl(old),'https://old.fixture.test/storage/'+old.storage_path);
 assert.equal(await s.client.verify(file,old,await sha256(file)),await sha256(file));assert.deepEqual(s.legacyReads,[old.storage_path]);assert.equal(s.configCalls,0);assert.equal(s.requests.length,0);
 const html=readFileSync(new URL('../importer.html',import.meta.url),'utf8');assert.match(html,/im\.crossOrigin\s*=\s*"anonymous"/);assert.match(html,/imageSmoothingEnabled=false/);
});

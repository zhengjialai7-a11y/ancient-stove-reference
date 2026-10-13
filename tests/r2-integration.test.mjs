import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {mkdtemp,open,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {CaptureClient,digestFile,API} from '../local-agent/core.mjs';
import {createGateway,PART_SIZE} from '../r2-worker/worker.mjs';

// This runs the real native uploader and real gateway. Only external R2 and
// Supabase services are replaced. It does not prove production R2 CPU limits.
const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MASTER='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORIGIN='https://originals.example.workers.dev';
const TOKEN='integration-session-only-in-memory';
const SECRET='0123456789abcdef'.repeat(4);
const SOURCE='https://g2.ltfc.net/view/SUHA/608a61b2aa7c385c8d9448d5';
const MIB=1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=(value,status=200)=>Response.json(value,{status});
const digestBytes=value=>typeof value==='string'?value:Buffer.from(value instanceof ArrayBuffer?value:value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength)).toString('hex');
const arrayBuffer=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
let fixedLengthInvocations=0;
const priorFixedLength=globalThis.FixedLengthStream;
before(()=>{
 // Node lacks Workers' FixedLengthStream. Model its length contract so the
 // actual gateway's production promotion/pump branch also runs in this test.
 globalThis.FixedLengthStream=class extends TransformStream{
  constructor(expected){
   let count=0;
   super({transform(chunk,controller){count+=chunk.byteLength;if(count>expected)throw Error('FixedLengthStream received excess bytes');controller.enqueue(chunk);},flush(){assert.equal(count,expected,'FixedLengthStream must receive every original byte');}});
   fixedLengthInvocations++;
  }
 };
});
after(()=>{if(priorFixedLength===undefined)delete globalThis.FixedLengthStream;else globalThis.FixedLengthStream=priorFixedLength;});

const crcTable=Uint32Array.from({length:256},(_,n)=>{
 for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;
 return n>>>0;
});
function crcUpdate(crc,bytes){for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return crc>>>0;}
function pngChunk(type,data){
 const typeBytes=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);
 length.writeUInt32BE(data.length);checksum.writeUInt32BE((crcUpdate(crcUpdate(0xffffffff,typeBytes),data)^0xffffffff)>>>0);
 return Buffer.concat([length,typeBytes,data,checksum]);
}
async function originalFixture(directory,bytes=80*MIB){
 // A valid grayscale PNG plus an ancillary padding chunk gives a large raw
 // original without invoking image decoders, encoders, resizing or conversions.
 const width=4096,height=1024,header=Buffer.alloc(13);
 header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;
 const prefix=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header)]);
 const suffix=Buffer.concat([pngChunk('IDAT',deflateSync(Buffer.alloc((width+1)*height))),pngChunk('IEND',Buffer.alloc(0))]);
 const paddingBytes=bytes-prefix.length-suffix.length-12;
 assert.ok(paddingBytes>0);
 const file=path.join(directory,'宋_测试_原始母图_1.png'),handle=await open(file,'w');
 const paddingHeader=Buffer.alloc(8);paddingHeader.writeUInt32BE(paddingBytes);paddingHeader.write('paDd',4,'ascii');
 const digest=createHash('sha256');let crc=crcUpdate(0xffffffff,paddingHeader.subarray(4));
 const write=async chunk=>{await handle.write(chunk);digest.update(chunk);};
 try{
  await write(prefix);await write(paddingHeader);
  const padding=Buffer.alloc(MIB,0x53);
  for(let offset=0;offset<paddingBytes;offset+=padding.length){const part=padding.subarray(0,Math.min(padding.length,paddingBytes-offset));crc=crcUpdate(crc,part);await write(part);}
  const checksum=Buffer.alloc(4);checksum.writeUInt32BE((crc^0xffffffff)>>>0);await write(checksum);await write(suffix);
 }finally{await handle.close();}
 assert.equal((await stat(file)).size,bytes);
 return {file,bytes,width,height,sha256:digest.digest('hex')};
}

async function bodyBytes(value){
 if(typeof value==='string')return Buffer.from(value);
 if(value instanceof ArrayBuffer)return Buffer.from(value);
 if(ArrayBuffer.isView(value))return Buffer.from(value.buffer,value.byteOffset,value.byteLength);
 const chunks=[];
 for await(const chunk of value)chunks.push(Buffer.from(chunk));
 return Buffer.concat(chunks);
}
function bodyStream(bytes){
 let offset=0;
 return new ReadableStream({pull(controller){
  if(offset===bytes.length){controller.close();return;}
  const next=Math.min(offset+256*1024,bytes.length);controller.enqueue(bytes.subarray(offset,next));offset=next;
 }});
}
class FakeR2{
 constructor({corruptPart=null}={}){this.objects=new Map();this.uploads=new Map();this.events=[];this.corruptPart=corruptPart;this.listPages=0;}
 object(key,{body=false,range}={}){
  const stored=this.objects.get(key);if(!stored)return null;
  const value={key,size:stored.bytes.length,etag:stored.etag,httpEtag:'"'+stored.etag+'"',uploaded:new Date(),httpMetadata:{...stored.httpMetadata},customMetadata:{...stored.customMetadata},checksums:stored.checksum?{sha256:arrayBuffer(Buffer.from(stored.checksum,'hex'))}:{}};
  if(body){
   const bytes=range?stored.bytes.subarray(range.offset,range.offset+range.length):stored.bytes;
   value.body=bodyStream(bytes);value.json=async()=>JSON.parse(stored.bytes.toString());value.text=async()=>stored.bytes.toString();
  }
  return value;
 }
 async head(key){this.events.push(['head',key]);return this.object(key);}
 async get(key,options={}){this.events.push(['get',key]);return this.object(key,{body:true,range:options.range});}
 async put(key,value,options={}){
  const bytes=await bodyBytes(value),old=this.objects.get(key),conditions=options.onlyIf;
  if(conditions?.get('If-None-Match')==='*'&&old)return null;
  if(conditions?.get('If-Match')&&old?.etag!==conditions.get('If-Match'))return null;
  const actual=hash(bytes),expected=options.sha256?digestBytes(options.sha256):null;
  this.events.push(['put',key,bytes.length,expected]);
  if(expected&&actual!==expected)throw Object.assign(Error('BadDigest (10037): provided SHA-256 does not match'),{code:10037});
  this.objects.set(key,{bytes,etag:createHash('md5').update(bytes).digest('hex'),checksum:expected?actual:null,httpMetadata:options.httpMetadata||{},customMetadata:options.customMetadata||{}});
  return this.object(key);
 }
 async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])this.objects.delete(key);}
 async list({prefix='',cursor}={}){
  // Exercise paginated acknowledgement discovery and lexicographic part10/part2.
  const keys=[...this.objects.keys()].filter(key=>key.startsWith(prefix)).sort(),offset=Number(cursor||0),page=keys.slice(offset,offset+3),next=offset+page.length;
  this.listPages++;
  return {objects:page.map(key=>this.object(key)),truncated:next<keys.length,...(next<keys.length?{cursor:String(next)}:{})};
 }
 async createMultipartUpload(key,options){
  const uploadId=randomUUID();this.uploads.set(uploadId,{key,options,parts:new Map()});this.events.push(['create',key,uploadId]);
  return this.resumeMultipartUpload(key,uploadId);
 }
 resumeMultipartUpload(key,uploadId){
  const bucket=this;
  const current=()=>{const upload=bucket.uploads.get(uploadId);if(!upload||upload.key!==key)throw Object.assign(Error('NoSuchUpload (10024)'),{code:10024});return upload;};
  return {key,uploadId,
   async uploadPart(partNumber,body){
    const upload=current();let bytes=Buffer.from(await bodyBytes(body));
    if(bucket.corruptPart===partNumber){bytes[bytes.length-1]^=1;bucket.corruptPart=null;}
    const etag=createHash('md5').update(bytes).digest('hex');upload.parts.set(partNumber,{bytes,etag});bucket.events.push(['part',partNumber,bytes.length]);
    return {partNumber,etag};
   },
   async complete(parts){
    const upload=current(),chunks=parts.map(part=>{const stored=upload.parts.get(part.partNumber);assert.equal(stored?.etag,part.etag);return stored.bytes;});
    const bytes=Buffer.concat(chunks);bucket.objects.set(key,{bytes,etag:hash(bytes).slice(0,32)+'-'+parts.length,httpMetadata:upload.options.httpMetadata,customMetadata:upload.options.customMetadata});bucket.uploads.delete(uploadId);bucket.events.push(['complete',key,bytes.length]);
    return bucket.object(key);
   },
   async abort(){bucket.uploads.delete(uploadId);}
  };
 }
}

function fixtureBackend({corruptReadback=false,corruptPart=null}={}){
 const bucket=new FakeR2({corruptPart}),events=[],receipts=new Map(),files=new Map(),masters=new Map();
 const task={id:TASK,created_by:OWNER,source_type:'SUHA',source_id:'608a61b2aa7c385c8d9448d5',source_url:SOURCE,paused:false,candidate_count:0,project_id:null,resolved_project_id:null,resolved_master_id:null};
 const queryRows=(rows,search)=>rows.filter(row=>[...search].every(([key,match])=>{
  if(['select','on_conflict'].includes(key))return true;
  if(match.startsWith('eq.'))return String(row[key])===match.slice(3);
  if(match.startsWith('in.('))return match.slice(4,-1).split(',').includes(String(row[key]));
  throw Error('Unsupported fake query '+key+'='+match);
 }));
 const supabase=async(url,options={})=>{
  const requestUrl=new URL(url),headers=new Headers(options.headers),method=options.method||'GET';
  assert.equal(requestUrl.origin,API);assert.equal(headers.get('authorization'),'Bearer '+TOKEN);
  if(requestUrl.pathname==='/auth/v1/user')return json({id:OWNER});
  const body=options.body?JSON.parse(options.body):null;
  if(requestUrl.pathname==='/rest/v1/rpc/get_original_storage_config')return json({provider:'r2',enabled:true,endpoint:ORIGIN,readOrigins:[ORIGIN]});
  if(requestUrl.pathname==='/rest/v1/reference_capture_status')return json(queryRows([task],requestUrl.searchParams));
  if(requestUrl.pathname==='/rest/v1/artwork_masters')return json(queryRows([...masters.values()],requestUrl.searchParams));
  if(requestUrl.pathname==='/rest/v1/reference_capture_files'){
   if(method==='POST'){assert.equal(body.created_by,OWNER);assert.equal(body.task_id,TASK);const prior=files.get(body.part_index)||{};files.set(body.part_index,{...prior,...body});events.push(['ledger',body.phase]);return new Response(null,{status:204});}
   return json(queryRows([...files.values()],requestUrl.searchParams));
  }
  if(requestUrl.pathname==='/rest/v1/rpc/record_r2_original_receipt'){
   const r=body.p_receipt;
   // This duplicates the SQL canonical contract independently of the gateway.
   const canonical=['r2-v1',r.owner,r.storage_origin,r.path,r.sha256,String(r.bytes),r.mime,r.etag,String(r.issued_at)].join('\n');
   assert.equal(r.signature,createHmac('sha256',Buffer.from(SECRET,'utf8')).update(canonical,'utf8').digest('hex'));
   assert.equal(r.owner,OWNER);assert.equal(r.storage_origin,ORIGIN);assert.equal(r.path,`masters/${OWNER}/${r.sha256}.png`);assert.equal(r.mime,'image/png');assert.ok(Math.abs(Date.now()/1000-r.issued_at)<900);
   assert.equal(bucket.objects.get(r.path)?.checksum,r.sha256);assert.equal(bucket.objects.get(r.path)?.bytes.length,r.bytes);
   receipts.set(r.path,{...r});events.push(['receipt',r.path]);return json({verified:true});
  }
  if(requestUrl.pathname==='/rest/v1/rpc/register_capture_original'){
   assert.equal(body.p_storage_provider,'r2');assert.equal(body.p_storage_origin,ORIGIN);assert.equal(body.p_task_id,TASK);assert.equal(body.p_part_index,1);assert.equal(body.p_expected_count,1);
   const key=`masters/${OWNER}/${body.p_sha256}.png`,receipt=receipts.get(key);assert.ok(receipt,'Registration requires a trusted persisted receipt');assert.equal(receipt.sha256,body.p_sha256);assert.equal(receipt.bytes,body.p_bytes);assert.equal(receipt.mime,body.p_mime);
   masters.set(MASTER,{id:MASTER,created_by:OWNER,project_id:PROJECT,sha256:body.p_sha256,verified_sha256:body.p_sha256,verified_at:new Date().toISOString(),original_bytes:body.p_bytes,original_width:body.p_width,original_height:body.p_height,mime_type:body.p_mime,storage_provider:'r2',storage_origin:ORIGIN,storage_path:key});
   Object.assign(task,{project_id:PROJECT,resolved_project_id:PROJECT});Object.assign(files.get(1),{phase:'complete',master_id:MASTER});events.push(['register',key]);return json({master_id:MASTER,project_id:PROJECT,part_index:1});
  }
  throw Error('Unexpected Supabase route '+requestUrl.pathname);
 };
 const gateway=createGateway({fetchImpl:supabase}),env={BUCKET:bucket,R2_HMAC_SECRET:SECRET,ALLOWED_ORIGIN:'https://zhengjialai7-a11y.github.io'};
 let pausedPart=null,client=null;
 const fetchImpl=async(url,options={})=>{
  const requestUrl=new URL(url);
  if(requestUrl.origin===API)return supabase(url,options);
  assert.equal(requestUrl.origin,ORIGIN);const headers=new Headers(options.headers);assert.equal(headers.get('authorization'),'Bearer '+TOKEN);assert.equal(headers.has('apikey'),false);
  const part=/\/parts\/(\d+)$/.exec(requestUrl.pathname);
  if(part&&Number(part[1])===pausedPart){pausedPart=null;client.paused=true;events.push(['pause',Number(part[1])]);return json({error:'Synthetic network interruption',code:'STORAGE_UNAVAILABLE'},503);}
  if(options.body!==undefined)headers.set('Content-Length',String(Buffer.byteLength(options.body)));
  const response=await gateway.fetch(new Request(url,{...options,headers}),env);
  if(corruptReadback&&response.ok&&requestUrl.pathname.startsWith('/v1/objects/')){
   let first=true;
   const body=response.body.pipeThrough(new TransformStream({transform(chunk,controller){if(first){chunk=Uint8Array.from(chunk);chunk[chunk.length-1]^=1;first=false;}controller.enqueue(chunk);}}));
   events.push(['corrupt-readback']);return new Response(body,{status:response.status,headers:response.headers});
  }
  return response;
 };
 const native=({directory,stateDirectory})=>{
  client=new CaptureClient({directory,stateDirectory,fetchImpl,discoverStorageConfig:true,retryDelays:[],allowStorageOrigin:async origin=>{assert.equal(origin,ORIGIN);events.push(['allow',origin]);}});
  return client;
 };
 return {bucket,events,receipts,files,masters,native,pauseAt(part){pausedPart=part;}};
}

test('real native and Worker resume an 80 MiB raw PNG, verify receipt and remove local original only after registration',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'r2-original-integration-'));
 try{
  const original=await originalFixture(directory),stateDirectory=path.join(directory,'state'),backend=fixtureBackend(),input={taskId:TASK,source:SOURCE,part:1,count:1,filename:original.file,autoCleanup:true};
  const first=backend.native({directory,stateDirectory});await first.load();await first.setSession(TOKEN);backend.pauseAt(6);
  await assert.rejects(first.processFile(input),error=>error.code==='ART_PAUSED');
  assert.equal((await digestFile(original.file)).hash,original.sha256);assert.equal(backend.masters.size,0);assert.equal(backend.receipts.size,0);
  const progress=JSON.parse(await readFile(path.join(stateDirectory,'progress.json'),'utf8'));
  assert.equal(progress.records[`${OWNER}:${TASK}:1`].phase,'paused');assert.deepEqual(progress.r2[`${OWNER}:${original.sha256}`].parts.map(part=>part.partNumber),[1,2,3,4,5]);
  assert.equal(JSON.stringify(progress).includes(TOKEN),false);assert.equal(JSON.stringify(progress).includes(SECRET),false);
  const second=backend.native({directory,stateDirectory});await second.load();await second.setSession(TOKEN);
  const result=await second.processFile(input);assert.equal(result.master_id,MASTER);assert.equal(result.cleanup.status,'deleted');assert.equal(result.cleanup.bytes,original.bytes);
  await assert.rejects(stat(original.file),error=>error.code==='ENOENT');
  const master=backend.masters.get(MASTER),remote=backend.bucket.objects.get(master.storage_path);
  assert.equal(master.original_bytes,80*MIB);assert.equal(master.original_width,original.width);assert.equal(master.original_height,original.height);assert.equal(master.mime_type,'image/png');assert.equal(master.sha256,original.sha256);assert.equal(hash(remote.bytes),original.sha256);assert.equal(remote.checksum,original.sha256);
  assert.deepEqual(backend.bucket.events.filter(event=>event[0]==='part').map(event=>event[1]),[1,2,3,4,5,6,7,8,9,10]);
  assert.equal(backend.bucket.events.filter(event=>event[0]==='create').length,1);assert.ok(backend.bucket.events.some(event=>event[0]==='put'&&event[1]===master.storage_path&&event[2]===80*MIB&&event[3]===original.sha256));
  assert.ok(backend.bucket.listPages>=4);assert.equal([...backend.bucket.objects.keys()].filter(key=>key.startsWith('_staging/')||key.startsWith('_uploads/')).length,0);
  assert.ok(fixedLengthInvocations>0,'Use the production streaming promotion branch');
  assert.ok(backend.events.findIndex(event=>event[0]==='receipt')<backend.events.findIndex(event=>event[0]==='register'));
  assert.deepEqual(second.r2,{});
  assert.deepEqual((await second.completedParts({taskId:TASK,source:SOURCE,count:1,recheck:true})).parts,[1]);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('Worker checksum rejection retains local mother, then a fresh upload recovers without another download',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'r2-corrupt-original-'));
 try{
  const original=await originalFixture(directory,9*MIB),backend=fixtureBackend({corruptPart:2}),client=backend.native({directory,stateDirectory:path.join(directory,'state')});await client.load();await client.setSession(TOKEN);
  await assert.rejects(client.processFile({taskId:TASK,source:SOURCE,part:1,count:1,filename:original.file,autoCleanup:true}),/SHA-256/);
  assert.equal((await digestFile(original.file)).hash,original.sha256);assert.equal(backend.masters.size,0);assert.equal(backend.receipts.size,0);assert.equal(backend.files.get(1).phase,'failed');
  assert.equal([...backend.bucket.objects.keys()].some(key=>key.startsWith('masters/')),false);assert.ok(client.r2[`${OWNER}:${original.sha256}`]);
  const recovered=await client.processFile({taskId:TASK,source:SOURCE,part:1,count:1,filename:original.file,autoCleanup:true});
  assert.equal(recovered.cleanup.status,'deleted');await assert.rejects(stat(original.file),error=>error.code==='ENOENT');
  assert.equal(backend.bucket.objects.get(`masters/${OWNER}/${original.sha256}.png`).checksum,original.sha256);
  assert.equal(backend.bucket.events.filter(event=>event[0]==='create').length,2);assert.deepEqual(backend.bucket.events.filter(event=>event[0]==='part').map(event=>event[1]),[1,2,1,2]);
  assert.equal(backend.events.filter(event=>event[0]==='receipt').length,1);assert.equal(backend.events.filter(event=>event[0]==='register').length,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('an 80 MiB corrupted readback retains local original even after R2 server checksum success',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'r2-corrupt-readback-'));
 try{
  const original=await originalFixture(directory),backend=fixtureBackend({corruptReadback:true}),client=backend.native({directory,stateDirectory:path.join(directory,'state')});await client.load();await client.setSession(TOKEN);
  await assert.rejects(client.processFile({taskId:TASK,source:SOURCE,part:1,count:1,filename:original.file,autoCleanup:true}),/回读 SHA-256/);
  assert.equal((await digestFile(original.file)).hash,original.sha256);assert.equal((await stat(original.file)).size,80*MIB);assert.equal(backend.masters.size,0);assert.equal(backend.receipts.size,0);assert.equal(backend.files.get(1).phase,'failed');
  const remote=backend.bucket.objects.get(`masters/${OWNER}/${original.sha256}.png`);assert.equal(remote.checksum,original.sha256);assert.equal(hash(remote.bytes),original.sha256);assert.ok(backend.events.some(event=>event[0]==='corrupt-readback'));
 }finally{await rm(directory,{recursive:true,force:true});}
});

import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,rename,mkdir,realpath,stat,lstat,unlink,open} from 'node:fs/promises';
import path from 'node:path';
import {networkError} from './network.mjs';
import {setTimeout as sleep} from 'node:timers/promises';
import {r2Origin,r2ObjectKey,r2Url,uploadR2,recordR2Receipt} from './r2.mjs';

export const PROJECT='otaokoencpoanxjjuqzv',API=`https://${PROJECT}.supabase.co`,STORAGE=`https://${PROJECT}.storage.supabase.co`;
export const KEY='sb_publishable_hA9UHbP834axMbvdRRbwyA_4dUTU2-B',BUCKET='art-reference-images',CHUNK=6*1024*1024;
export function sourceKey(url){const m=String(url||'').match(/^https:\/\/g2\.ltfc\.net\/view\/([A-Z0-9_]{3,20})\/([a-f0-9]{24})(?:[/?#]|$)/i);return m?m[1].toUpperCase()+':'+m[2].toLowerCase():null;}
export function frame(value){const body=Buffer.from(JSON.stringify(value));if(body.length>900000)throw Error('消息过大');const head=Buffer.alloc(4);head.writeUInt32LE(body.length);return Buffer.concat([head,body]);}
export class Decoder{buffer=Buffer.alloc(0);push(bytes){this.buffer=Buffer.concat([this.buffer,bytes]);const messages=[];while(this.buffer.length>=4){const n=this.buffer.readUInt32LE();if(n<2||n>1048576)throw Error('消息长度无效');if(this.buffer.length<n+4)break;messages.push(JSON.parse(this.buffer.subarray(4,n+4)));this.buffer=this.buffer.subarray(n+4);}return messages;}}
export async function digestFile(filename){const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(filename)){hash.update(chunk);bytes+=chunk.length;}return {hash:hash.digest('hex'),bytes};}
export function dimensions(b){
 if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',width:b.readUInt32BE(16),height:b.readUInt32BE(20),ext:'png'};
 if(b.length>12&&b[0]===255&&b[1]===216){let i=2;while(i+4<b.length){if(b[i]!==255){i++;continue;}const marker=b[i+1];i+=2;if(marker===216||marker===217||marker===1||(marker>=208&&marker<=215))continue;const len=b.readUInt16BE(i);if(len<2||i+len>b.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&len>=7)return {mime:'image/jpeg',height:b.readUInt16BE(i+3),width:b.readUInt16BE(i+5),ext:'jpg'};i+=len;}}
 if(b.length>=30&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'){
  const kind=b.toString('ascii',12,16);if(kind==='VP8X')return {mime:'image/webp',width:1+b.readUIntLE(24,3),height:1+b.readUIntLE(27,3),ext:'webp'};
  if(kind==='VP8 '&&b[23]===157&&b[24]===1&&b[25]===42)return {mime:'image/webp',width:b.readUInt16LE(26)&16383,height:b.readUInt16LE(28)&16383,ext:'webp'};
  if(kind==='VP8L'&&b[20]===47){const bits=b.readUInt32LE(21);return {mime:'image/webp',width:(bits&16383)+1,height:((bits>>>14)&16383)+1,ext:'webp'};}
 }
 throw Error('文件不是可识别的原始 JPEG/PNG/WebP 图片');
}
export async function containedFile(root,filename){const base=await realpath(root),file=await realpath(filename);const relative=path.relative(base,file);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('下载文件不在授权目录内');const s=await stat(file);if(!s.isFile()||!s.size||/\.(?:crdownload|part|tmp)$/i.test(file))throw Error('原图尚未下载完成');return {file,size:s.size,mtime:s.mtimeMs,dev:s.dev,ino:s.ino};}
export class CaptureClient {
 constructor({directory,stateDirectory,fetchImpl=fetch,api=API,storage=STORAGE,event=()=>{},retryDelays=[2000,5000,10000],delay=(ms,signal)=>sleep(ms,undefined,{signal}),requestTimeout=45000,uploadTimeout=120000,idleTimeout=60000,discoverStorageConfig=false,allowStorageOrigin=async()=>{}}){this.directory=directory;this.stateDirectory=stateDirectory;this.fetch=fetchImpl;this.api=api;this.storage=storage;this.event=event;this.session=null;this.owner=null;this._paused=false;this.activeRequests=new Set();this.pauseController=new AbortController();this.retryDelays=retryDelays;this.delay=delay;this.requestTimeout=requestTimeout;this.uploadTimeout=uploadTimeout;this.idleTimeout=idleTimeout;this.context={};this.records={};this.tus={};this.r2={};this.repairs=[];this.running=false;this.discoverStorageConfig=discoverStorageConfig;this.allowStorageOrigin=allowStorageOrigin;this.storageConfig=null;this.trustedStorageOrigins=new Set();}
 get paused(){return this._paused;}
 set paused(value){this._paused=!!value;if(value){this.pauseController.abort();for(const controller of this.activeRequests)controller.abort();}else if(this.pauseController.signal.aborted)this.pauseController=new AbortController();}
 pauseError(){return Object.assign(Error('任务已暂停，原文件与进度已保留'),{code:'ART_PAUSED'});}
 emit(values){this.event({...this.context,...values});}
 async retryOperation(stage,operation,{retrySafe=true}={}){
  for(let attempt=0;;attempt++){
   if(this.paused)throw this.pauseError();
   try{return await operation();}catch(error){
    if(this.paused)throw this.pauseError();
    if(!retrySafe||!error.retryable||attempt>=this.retryDelays.length){error.retryAttempts=attempt;throw error;}
    const retryInMs=this.retryDelays[attempt];this.emit({phase:'retrying',stage,retryAttempt:attempt+1,maxRetries:this.retryDelays.length,retryInMs,nextRetryAt:Date.now()+retryInMs,error:error.message});
    try{await this.delay(retryInMs,this.pauseController.signal);}catch(e){if(this.paused)throw this.pauseError();throw e;}
   }
  }
 }
 async load(){await mkdir(this.stateDirectory,{recursive:true});try{const data=JSON.parse(await readFile(path.join(this.stateDirectory,'progress.json'),'utf8'));this.records=data.records||{};this.tus=data.tus||{};this.r2=data.r2||{};this.repairs=data.repairs||[];}catch(e){if(e.code!=='ENOENT')throw Error('本机进度文件损坏，请保留文件并联系修复');}}
 async save(){const filename=path.join(this.stateDirectory,'progress.json');await writeFile(filename+'.tmp',JSON.stringify({version:3,records:this.records,tus:this.tus,r2:this.r2,repairs:this.repairs},null,2),{mode:0o600});await rename(filename+'.tmp',filename);}
 async setSession(accessToken){if(this.running)throw Error('正在上传，不能切换账号');if(typeof accessToken!=='string'||accessToken.length>12000)throw Error('登录凭据无效');this.paused=false;this.context={command:'session'};const res=await this.request(this.api+'/auth/v1/user',{headers:{authorization:'Bearer '+accessToken},stage:'云端登录校验',authorize:false});const account=await res.json();if(!/^[0-9a-f-]{36}$/i.test(account.id||''))throw Error('账号无效');this.owner=account.id;this.session=accessToken;this.storageConfig=null;this.trustedStorageOrigins.clear();return {owner:this.owner};}
 async originalStorageConfig(){
  if(this.storageConfig)return this.storageConfig;
  let config={provider:'supabase',enabled:false,endpoint:null};
  if(this.discoverStorageConfig){try{const response=await this.request(this.api+'/rest/v1/rpc/get_original_storage_config',{method:'POST',retrySafe:true,stage:'读取母图存储设置',headers:{'Content-Type':'application/json'},body:'{}'});config=await response.json();}catch(e){if(e.status!==404)throw e;}}
  if(!config||!['supabase','r2'].includes(config.provider))throw Error('母图存储设置无效');
  const origins=[...(config.endpoint?[config.endpoint]:[]),...(Array.isArray(config.readOrigins)?config.readOrigins:[])].map(r2Origin);
  if(config.provider==='r2'&&config.enabled===true&&!config.endpoint)throw Error('R2 母图服务尚未连接，本地原图已保留');
  for(const origin of origins){await this.allowStorageOrigin(origin);this.trustedStorageOrigins.add(origin);}
  this.storageConfig={...config,endpoint:config.endpoint?r2Origin(config.endpoint):null};return this.storageConfig;
 }
 async originalStorage(master=null){
  const config=await this.originalStorageConfig(),provider=master?(master.storage_provider||'supabase'):(config.provider==='r2'&&config.enabled===true?'r2':'supabase');
  if(provider==='supabase')return {provider:'supabase',origin:null};
  if(provider!=='r2')throw Error('母图存储类型无效');
  const origin=r2Origin(master?.storage_origin||config.endpoint);
  if(!this.trustedStorageOrigins.has(origin))throw Error('此母图的 R2 服务尚未连接，本地原图已保留');
  return {provider:'r2',origin};
 }
 async refreshSession(accessToken,owner){
  if(!this.owner||owner!==this.owner||typeof accessToken!=='string'||accessToken.length>12000)throw Error('登录凭据更新账号不匹配');if(this.paused)throw this.pauseError();
  const controller=new AbortController();this.activeRequests.add(controller);const timer=setTimeout(()=>controller.abort(),30000),expectedOwner=this.owner;
  this.emit({command:'refresh_session',phase:'credentials',stage:'更新登录凭据'});
  try{const response=await this.fetchCloud(this.api+'/auth/v1/user',{headers:{apikey:KEY,authorization:'Bearer '+accessToken},redirect:'error',signal:controller.signal},'更新登录凭据');if(!response.ok)throw await this.httpError(response,'更新登录凭据');const account=await response.json();if(this.paused)throw this.pauseError();if(this.owner!==expectedOwner||account.id!==expectedOwner)throw Error('登录凭据属于其他账号，当前任务已保留');this.session=accessToken;return {owner:this.owner};}
  finally{clearTimeout(timer);this.activeRequests.delete(controller);}
 }
 async fetchCloud(url,options,stage){try{return await this.fetch(url,options);}catch(e){if(e.code==='ART_NETWORK')throw e;if(e.code==='ART_REDIRECT')throw e;if(e.code||e.cause||e.name==='TypeError'||e.name==='TimeoutError'||e.name==='AbortError')throw networkError(e,stage||this.requestStage(url,options?.method),url);throw e;}}
 requestStage(url,method='GET'){const p=new URL(url).pathname;if(p.includes('/upload/resumable'))return method==='HEAD'?'恢复母图上传':'上传母图';if(p.includes('/storage/v1/object/'))return '回读核验母图';if(p.includes('/rpc/'))return '登记母图关联';if(p.includes('/reference_capture_files'))return method==='GET'?'读取分段进度':'保存分段进度';return '读取收藏任务';}
 async networkCheck(){this.context={command:'hello'};const checks=await Promise.all([{label:'云端 API',url:this.api+'/auth/v1/health'},{label:'母图上传端点',url:this.storage+'/storage/v1/upload/resumable'}].map(async item=>{const stage=item.label+'连通检查';try{await this.request(item.url,{method:item.label==='云端 API'?'GET':'HEAD',headers:{apikey:KEY},authorize:false,timeout:10000,stage});return {label:item.label,ok:true,host:new URL(item.url).hostname};}catch(e){if(e.status&&e.status<500&&![407,408,429].includes(e.status))return {label:item.label,ok:true,host:new URL(item.url).hostname};return {label:item.label,ok:false,error:e.message};}}));return {ok:checks.every(c=>c.ok),checks};}
 async httpError(response,stage){if(response.status===401)return Object.assign(Error('登录过期，请重新登录队列后继续'),{code:'ART_AUTH',stage,status:401,retryable:false});const text=await response.text();let message,serverCode;try{const value=JSON.parse(text);message=value.message||value.msg||value.error;if(typeof value.code==='string')serverCode=value.code.slice(0,100);}catch{}return Object.assign(Error(String(message||stage+'失败（HTTP '+response.status+'）').slice(0,240)),{code:'ART_HTTP',serverCode,stage,status:response.status,retryable:[408,429,500,502,503,504,520,521,522,523,524].includes(response.status)});}
 async request(url,{method='GET',headers={},body,retrySafe=method==='GET'||method==='HEAD',stage=this.requestStage(url,method),authorize=true,timeout=method==='PATCH'?this.uploadTimeout:this.requestTimeout,progress=null}={}){
  if(authorize&&!this.session)throw Error('请先从云端队列授权登录');
  const destination=new URL(url),supabase=[new URL(this.api).origin,new URL(this.storage).origin].includes(destination.origin);if(destination.username||destination.password||(!supabase&&!this.trustedStorageOrigins.has(destination.origin)))throw Error('本机助手拒绝向非项目云端地址发送请求');
  return this.retryOperation(stage,async()=>{
   const controller=new AbortController();this.activeRequests.add(controller);const timer=setTimeout(()=>controller.abort(),timeout);
   this.emit({phase:method==='PATCH'||progress?'uploading':'requesting',stage,...(progress||method==='PATCH'?progress||{bytes:Number(headers['Upload-Offset'])||0,total:this.context.total}:{})});
   const requestToken=this.session;
   try{const response=await this.fetchCloud(url,{method,headers:{...(supabase?{apikey:KEY}:{}),...(authorize?{authorization:'Bearer '+requestToken}:{}),...headers},body,redirect:'error',signal:controller.signal},stage);if(!response.ok){const error=await this.httpError(response,stage);if(authorize&&error.status===401&&this.session!==requestToken)error.retryable=true;throw error;}const bytes=await response.arrayBuffer();return new Response([204,205,304].includes(response.status)||method==='HEAD'?null:bytes,{status:response.status,headers:response.headers});}
   catch(e){if(this.paused)throw this.pauseError();if(e.code==='ART_HTTP'||e.code==='ART_AUTH'||e.code==='ART_REDIRECT'||e.code==='ART_NETWORK')throw e;if(e.code||e.cause||['TypeError','TimeoutError','AbortError'].includes(e.name))throw networkError(e,stage,url);throw e;}
   finally{clearTimeout(timer);this.activeRequests.delete(controller);}
  },{retrySafe});
 }
 async rows(table,query){const r=await this.request(this.api+'/rest/v1/'+table+'?'+new URLSearchParams(query));return r.json();}
 async checkTask(taskId,source,{review=false}={}){const rows=await this.rows('reference_capture_status',{id:'eq.'+taskId,select:'id,created_by,source_id,source_type,source_url,paused,candidate_count,project_id,resolved_project_id,resolved_master_id'});const t=rows[0];if(!t||t.created_by!==this.owner||sourceKey(source)!==t.source_type+':'+t.source_id)throw Error('任务账号或作品来源不匹配');if(this.paused)throw this.pauseError();if(!review&&t.paused)throw Error('任务已暂停');if(!review&&((t.candidate_count>1&&!t.project_id)||t.resolved_master_id))throw Error('来源关联需要人工确认');return t;}
 async completedParts(input){
  if(this.running)throw Error('本机正在处理另一张原图');if(!Number.isInteger(input.count)||input.count<1||input.count>500)throw Error('母图张数无效');this.running=true;const verification=input.recheck===true?'readback':'receipts';this.context={command:'task',taskId:input.taskId,count:input.count,verification};
  try{const task=await this.checkTask(input.taskId,input.source),rows=await this.rows('reference_capture_files',{task_id:'eq.'+input.taskId,select:'part_index,expected_count,phase,sha256,master_id'});if(rows.some(r=>r.expected_count!==input.count))throw Error('母图总张数与云端已有分段记录不一致');
   this.emit({phase:'receipts',stage:'核对云端已完成分段记录'});const candidates=rows.filter(r=>r.phase==='complete'&&r.master_id&&Number.isInteger(r.part_index)&&r.part_index>=1&&r.part_index<=input.count),ids=[...new Set(candidates.map(r=>r.master_id))],masters=new Map();
   for(let start=0;start<ids.length;start+=100){const found=await this.rows('artwork_masters',{created_by:'eq.'+this.owner,id:'in.('+ids.slice(start,start+100).join(',')+')',select:'id,project_id,sha256,verified_sha256,verified_at,original_bytes,storage_path,storage_provider,storage_origin'});for(const m of found)masters.set(m.id,m);}
   const receipts=[];for(const r of candidates){const m=masters.get(r.master_id);if(!m||m.project_id!==task.resolved_project_id||m.sha256!==r.sha256||m.verified_sha256!==m.sha256||!/^[a-f0-9]{64}$/.test(m.sha256||'')||!m.verified_at||!m.storage_path||!Number.isSafeInteger(Number(m.original_bytes))||Number(m.original_bytes)<1)continue;
    if(input.recheck===true){this.context.part=r.part_index;await this.verify(m.storage_path,m.sha256,Number(m.original_bytes),await this.originalStorage(m));}const local=this.records[this.owner+':'+input.taskId+':'+r.part_index];receipts.push({part:r.part_index,master_id:m.id,project_id:m.project_id,...(local?.hash===m.sha256&&local.cleanup?{cleanup:local.cleanup}:{})});
   }
   receipts.sort((a,b)=>a.part-b.part);const parts=receipts.map(r=>r.part),nextPart=Array.from({length:input.count},(_,i)=>i+1).find(p=>!parts.includes(p))||null;this.emit({phase:'receipts',stage:'已确认 '+parts.length+' 张完成记录'+(nextPart?'，继续第 '+nextPart+' 张':''),part:nextPart,confirmed:parts.length});const deletedParts=Object.entries(this.records).filter(([key,r])=>key===this.owner+':'+input.taskId+':'+r.part&&r.source===input.source&&r.count===input.count&&r.cleanup?.status==='deleted').map(([,r])=>r.part);return {parts,receipts,verification,deletedParts};
  }finally{this.running=false;}
 }
 async cleanupRecord(record,{recheck=true,snapshot=null}={}){
  if(record.cleanup?.status==='deleted')return record.cleanup;
  let cleanup;try{
   if(this.paused)throw this.pauseError();if(record.phase!=='complete'||!record.masterId||!record.projectId||!/^[a-f0-9]{64}$/.test(record.hash||''))throw Error('缺少已完成上传记录，保留本地文件');
   const task=await this.checkTask(record.taskId,record.source),row=(await this.rows('reference_capture_files',{task_id:'eq.'+record.taskId,part_index:'eq.'+record.part,select:'phase,expected_count,sha256,master_id'}))[0];
   const master=(await this.rows('artwork_masters',{created_by:'eq.'+this.owner,id:'eq.'+record.masterId,select:'id,created_by,project_id,sha256,verified_sha256,verified_at,original_bytes,storage_path,storage_provider,storage_origin'}))[0];
   if(!row||row.phase!=='complete'||row.expected_count!==record.count||row.sha256!==record.hash||row.master_id!==record.masterId||!master||master.id!==record.masterId||master.created_by!==this.owner||master.project_id!==record.projectId||task.resolved_project_id!==record.projectId||master.sha256!==record.hash||master.verified_sha256!==record.hash||!master.verified_at||Number(master.original_bytes)!==record.bytes||!master.storage_path)throw Error('云端完成记录或母图关联不一致，保留本地文件');
   const before=await lstat(record.filename),local=await containedFile(this.directory,record.filename);if(before.isSymbolicLink()||!before.isFile()||local.file!==record.filename||local.size!==record.bytes)throw Error('本地路径或文件已变化，保留文件');
   if(snapshot&&(local.dev!==snapshot.dev||local.ino!==snapshot.ino||local.size!==snapshot.size||local.mtime!==snapshot.mtime))throw Error('上传后本地文件已变化，保留文件');
   const stored=await this.originalStorage(master);if(record.storage_provider&&record.storage_provider!==stored.provider||record.storage_origin&&record.storage_origin!==stored.origin)throw Error('母图存储关联发生变化，保留本地文件');
   if(recheck)await this.verify(master.storage_path,record.hash,record.bytes,stored);
   this.emit({phase:'cleaning',stage:'清理前核对本地原图',bytes:0,total:record.bytes});const hash=createHash('sha256');let bytes=0,lastEvent=0;
   for await(const chunk of createReadStream(local.file)){if(this.paused)throw this.pauseError();hash.update(chunk);bytes+=chunk.length;if(Date.now()-lastEvent>=500){this.emit({phase:'cleaning',stage:'清理前核对本地原图',bytes,total:record.bytes});lastEvent=Date.now();}}
   const after=await lstat(record.filename);if(after.isSymbolicLink()||!after.isFile()||after.dev!==local.dev||after.ino!==local.ino||after.size!==local.size||after.mtimeMs!==local.mtime||await realpath(record.filename)!==local.file||bytes!==record.bytes||hash.digest('hex')!==record.hash)throw Error('本地文件与已上传原图不一致，保留文件');
   if(this.paused)throw this.pauseError();await (this.removeFile||unlink)(local.file);cleanup={status:'deleted',bytes:record.bytes,time:new Date().toISOString()};
  }catch(e){cleanup={status:e.code==='ENOENT'?'missing':'kept',bytes:0,time:new Date().toISOString(),retryable:!!e.retryable,reason:e.code==='ENOENT'?'本地文件已不存在':['EACCES','EPERM','EBUSY'].includes(e.code)?'文件被占用或没有删除权限，已保留':e.message,code:e.code};}
  record.cleanup=cleanup;try{await this.save();}catch{cleanup.notice='清理结果未能写入本机记录，云端母图已保留';}this.emit({phase:'cleaning',stage:cleanup.status==='deleted'?'本地原图已删除':cleanup.reason,cleanup});return cleanup;
 }
 async cleanupCompleted(){
  if(this.running)throw Error('本机正在处理原图，请先暂停采集');if(!this.owner||!this.session)throw Error('请先登录当前账号');this.running=true;this.context={command:'cleanup',owner:this.owner};
  const candidates=Object.entries(this.records).filter(([key,r])=>key===this.owner+':'+r.taskId+':'+r.part&&r.phase==='complete'),result={owner:this.owner,total:candidates.length,deleted:0,alreadyDeleted:0,kept:0,missing:0,bytesFreed:0,remaining:0,details:[]};
  try{for(let index=0;index<candidates.length;index++){if(this.paused){result.remaining=candidates.length-index;result.error='清理已暂停，剩余文件保留';break;}const record=candidates[index][1];this.context={command:'cleanup',owner:this.owner,taskId:record.taskId,part:record.part,count:record.count,index:index+1,totalFiles:candidates.length};this.emit({phase:'cleaning',stage:'正在检查已上传原图 '+(index+1)+' / '+candidates.length});
    if(record.cleanup?.status==='deleted'){result.alreadyDeleted++;continue;}const cleanup=await this.cleanupRecord(record);result[cleanup.status==='deleted'?'deleted':cleanup.status==='missing'?'missing':'kept']++;result.bytesFreed+=cleanup.bytes||0;if(cleanup.status==='kept'&&result.details.length<20)result.details.push({taskId:record.taskId,part:record.part,reason:cleanup.reason});
    if(cleanup.retryable||['ART_AUTH','ART_PAUSED','ART_NETWORK'].includes(cleanup.code)){result.error=cleanup.reason;result.remaining=candidates.length-index-1;break;}
   }this.emit({phase:'finished',stage:'本地原图清理结束',result});return result;
  }finally{this.running=false;}
 }
 safeTus(url){const value=new URL(url,this.storage);const origin=new URL(this.storage).origin;if(value.origin!==origin||!value.pathname.startsWith('/storage/v1/upload/resumable/')||value.username||value.password)throw Error('续传地址不可信');return value.href;}
 async verify(objectPath,expectedHash,expectedBytes,stored={provider:'supabase',origin:null}){
  if(!this.session)throw Error('请先从云端队列授权登录');
  if(!['supabase','r2'].includes(stored.provider))throw Error('母图存储类型无效');
  if(stored.provider==='r2'&&(!this.trustedStorageOrigins.has(r2Origin(stored.origin))||!r2ObjectKey(objectPath,this.owner)))throw Error('母图服务地址或路径不可信');
  const stage='回读核验母图',url=stored.provider==='r2'?r2Url(stored.origin,'/v1/objects/'+objectPath):this.api+'/storage/v1/object/'+BUCKET+'/'+objectPath;
  return this.retryOperation(stage,async()=>{
   const controller=new AbortController();this.activeRequests.add(controller);let timer;const arm=ms=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(),ms);};arm(this.requestTimeout);this.emit({phase:'verifying',stage,bytes:0,total:expectedBytes});
   const requestToken=this.session;
   try{const r=await this.fetchCloud(url,{headers:{...(stored.provider==='supabase'?{apikey:KEY}:{}),authorization:'Bearer '+requestToken},redirect:'error',signal:controller.signal},stage);if(!r.ok){const error=await this.httpError(r,stage);if(error.status===401&&this.session!==requestToken)error.retryable=true;throw error;}arm(this.idleTimeout);const hash=createHash('sha256');let bytes=0,lastEvent=0;
    for await(const chunk of r.body){if(this.paused)throw this.pauseError();arm(this.idleTimeout);hash.update(chunk);bytes+=chunk.length;if(Date.now()-lastEvent>=500||bytes===expectedBytes){this.emit({phase:'verifying',stage,bytes,total:expectedBytes});lastEvent=Date.now();}}
    if(bytes!==expectedBytes||hash.digest('hex')!==expectedHash)throw Error('云端回读 SHA-256 或字节数不一致，未登记完成');return true;
   }catch(e){if(this.paused)throw this.pauseError();if(e.code==='ART_HTTP'||e.code==='ART_AUTH'||e.code==='ART_NETWORK'||e.code==='ART_REDIRECT')throw e;if(e.code||e.cause||['TypeError','TimeoutError','AbortError'].includes(e.name))throw networkError(e,stage,url);throw e;}
   finally{clearTimeout(timer);this.activeRequests.delete(controller);}
  });
 }
 async upload(filename,objectPath,meta,expectedHash,expectedBytes){
  this.context.total=expectedBytes;
  const journalKey=this.owner+':'+expectedHash;let url=this.tus[journalKey],offset=0;
  const readOffset=async({retrySafe=true}={})=>{const r=await this.request(url,{method:'HEAD',retrySafe,headers:{'Tus-Resumable':'1.0.0'}});const value=Number(r.headers.get('upload-offset'));if(!Number.isSafeInteger(value)||value<offset||value>expectedBytes)throw Error('续传偏移无效');return value;};
  if(url){url=this.safeTus(url);try{offset=await readOffset();}catch(e){if([404,410].includes(e.status)){url=null;delete this.tus[journalKey];await this.save();}else throw e;}}
  if(!url){const metadata={bucketName:BUCKET,objectName:objectPath,contentType:meta.mime,cacheControl:'31536000'};const r=await this.request(this.storage+'/storage/v1/upload/resumable',{method:'POST',headers:{'Tus-Resumable':'1.0.0','Upload-Length':String(expectedBytes),'Upload-Metadata':Object.entries(metadata).map(([k,v])=>k+' '+Buffer.from(v).toString('base64')).join(','),'x-upsert':'false'}});url=this.safeTus(r.headers.get('location'));offset=Number(r.headers.get('upload-offset')||0);this.tus[journalKey]=url;await this.save();}
  if(!Number.isSafeInteger(offset)||offset<0||offset>expectedBytes)throw Error('续传偏移无效');
  const handle=await open(filename,'r');try{while(offset<expectedBytes){let recover=false;await this.retryOperation('上传母图',async()=>{
   if(recover){offset=await readOffset({retrySafe:false});if(offset===expectedBytes)return;}
   const size=Math.min(CHUNK,expectedBytes-offset),buffer=Buffer.alloc(size);const {bytesRead}=await handle.read(buffer,0,size,offset);if(bytesRead!==size)throw Error('上传时原文件发生变化');this.emit({phase:'uploading',stage:'上传母图',bytes:offset,total:expectedBytes});
   try{const r=await this.request(url,{method:'PATCH',retrySafe:false,headers:{'Tus-Resumable':'1.0.0','Upload-Offset':String(offset),'Content-Type':'application/offset+octet-stream'},body:buffer});const next=Number(r.headers.get('upload-offset'));if(next!==offset+size)throw Error('服务端续传偏移不匹配');offset=next;}
   catch(e){recover=true;throw e;}
  });this.emit({phase:'uploading',stage:'上传母图',bytes:offset,total:expectedBytes});}}
  finally{await handle.close();}delete this.tus[journalKey];await this.save();
 }
 async ledger(taskId,part,count,values,{retrySafe=true}={}){const r=await this.request(this.api+'/rest/v1/reference_capture_files?on_conflict=created_by,task_id,part_index',{method:'POST',retrySafe,headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({created_by:this.owner,task_id:taskId,part_index:part,expected_count:count,updated_at:new Date().toISOString(),...values})});return r;}
 async reviewPart(input){
  if(!Number.isInteger(input.part)||input.part<1||input.part>500)throw Error('失败分段无效');
  await this.checkTask(input.taskId,input.source,{review:true});
  const row=(await this.rows('reference_capture_files',{created_by:'eq.'+this.owner,task_id:'eq.'+input.taskId,part_index:'eq.'+input.part,select:'id,created_by,task_id,part_index,expected_count,phase,sha256,master_id,error,original_filename,updated_at'}))[0];
  const duplicates=row?.sha256?await this.rows('reference_capture_files',{created_by:'eq.'+this.owner,task_id:'eq.'+input.taskId,sha256:'eq.'+row.sha256,select:'part_index,phase,original_filename,master_id'}):[];
  const masters=row?.sha256?await this.rows('artwork_masters',{created_by:'eq.'+this.owner,sha256:'eq.'+row.sha256,select:'id,project_id,original_filename'}):[];
  return {owner:this.owner,taskId:input.taskId,part:input.part,row:row||null,duplicateParts:duplicates.filter(r=>r.part_index!==input.part),masters};
 }
 async resetFailedPart(input){
  if(this.running)throw Error('本机正在处理原图，请先等待批次结束');if(!this.owner||!this.session)throw Error('请先登录当前账号');this.running=true;this.context={command:'repair',taskId:input.taskId,part:input.part};
  try{
   if(!Number.isInteger(input.count)||input.count<1||input.count>500||!Number.isInteger(input.part)||input.part<1||input.part>input.count)throw Error('失败分段或张数无效');
   await this.checkTask(input.taskId,input.source);const key=this.owner+':'+input.taskId+':'+input.part,local=this.records[key];
   if(local&&(local.source!==input.source||local.count!==input.count||local.phase==='complete'||local.masterId))throw Error('此分段已有完成记录或来源不一致，不能重置');
   const info=await this.reviewPart(input),row=info.row;
   if(row&&(row.created_by!==this.owner||row.task_id!==input.taskId||row.expected_count!==input.count||row.phase!=='failed'||row.master_id))throw Error('云端分段已完成或状态改变，不能重置');
   if(!row&&!local)return {owner:this.owner,taskId:input.taskId,part:input.part,reset:true};
   const repair={owner:this.owner,taskId:input.taskId,part:input.part,at:new Date().toISOString(),action:'redownload',local:local?structuredClone(local):null,cloud:row?structuredClone(row):null,status:'prepared'};
   this.repairs.push(repair);await this.save();
   if(row){
    const query=new URLSearchParams({id:'eq.'+row.id,created_by:'eq.'+this.owner,task_id:'eq.'+input.taskId,part_index:'eq.'+input.part,expected_count:'eq.'+input.count,phase:'eq.failed',master_id:'is.null',sha256:row.sha256?'eq.'+row.sha256:'is.null',updated_at:'eq.'+row.updated_at});
    const response=await this.request(this.api+'/rest/v1/reference_capture_files?'+query,{method:'PATCH',retrySafe:false,headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({sha256:null,original_filename:null,error:'已保留原失败记录，等待重新下载：'+String(row.error||'人工核对').slice(0,180),updated_at:new Date().toISOString()})});
    const changed=await response.json();if(changed.length!==1)throw Error('云端分段状态已改变，未重置；请刷新后核对');
   }
   if(this.paused)throw this.pauseError();delete this.records[key];if(local?.hash){delete this.tus[this.owner+':'+local.hash];delete this.r2[this.owner+':'+local.hash];}repair.status='reset';await this.save();return {owner:this.owner,taskId:input.taskId,part:input.part,reset:true};
  }finally{this.running=false;}
 }
 async processFile(input){
  if(this.running)throw Error('本机正在处理另一张原图');this.running=true;this.context={command:'file',taskId:input.taskId,part:input.part,count:input.count};
  let record,k;try{
   if(!Number.isInteger(input.part)||!Number.isInteger(input.count)||input.part<1||input.part>input.count||input.count>500)throw Error('母图张数无效');
   const task=await this.checkTask(input.taskId,input.source);const verified=await containedFile(this.directory,input.filename);
   const file=await open(verified.file,'r');let meta;try{const head=Buffer.alloc(Math.min(verified.size,1024*1024));await file.read(head,0,head.length,0);meta=dimensions(head);}finally{await file.close();}
   this.emit({phase:'hashing',stage:'核对本机原图'});const {hash,bytes}=await digestFile(verified.file);if(bytes!==verified.size||!meta.width||!meta.height)throw Error('原图尺寸或文件大小无效');
   k=this.owner+':'+input.taskId+':'+input.part;const prior=this.records[k];if(prior&&(prior.hash!==hash||prior.count!==input.count))throw Error('相同分段的文件或张数改变，需要人工确认');
   record={taskId:input.taskId,source:input.source,part:input.part,count:input.count,filename:verified.file,hash,bytes,phase:'downloaded',updatedAt:new Date().toISOString()};this.records[k]=record;await this.save();
   const old=(await this.rows('artwork_masters',{created_by:'eq.'+this.owner,sha256:'eq.'+hash,select:'id,project_id,storage_path,storage_provider,storage_origin'}))[0];
   if(old&&old.project_id!==task.resolved_project_id)throw Error('相同原图已属于其他项目，需要人工确认');
   const cloudPart=(await this.rows('reference_capture_files',{task_id:'eq.'+input.taskId,part_index:'eq.'+input.part,select:'expected_count,sha256,master_id'}))[0];
   if(cloudPart&&(cloudPart.expected_count!==input.count||(cloudPart.sha256&&cloudPart.sha256!==hash)))throw Error('云端此分段已记录不同文件或张数');
   const sameParts=await this.rows('reference_capture_files',{task_id:'eq.'+input.taskId,sha256:'eq.'+hash,select:'part_index'});if(sameParts.some(p=>p.part_index!==input.part))throw Error('此原图与另一分段完全相同，请核对是否切换到了下一张');
   const objectPath=old?.storage_path||'masters/'+this.owner+'/'+hash+'.'+meta.ext;
   const journalKey=this.owner+':'+hash;if(this.r2[journalKey]&&this.tus[journalKey])throw Error('此原图存在两种上传续传记录，需要人工核对');
   const stored=await this.originalStorage(old||(this.r2[journalKey]?{storage_provider:'r2',storage_origin:this.r2[journalKey].origin}:this.tus[journalKey]?{storage_provider:'supabase'}:prior?.storage_provider==='r2'||prior?.phase==='complete'?prior:null));
   Object.assign(record,{storage_provider:stored.provider,storage_origin:stored.origin,storage_path:objectPath});await this.save();
   await this.ledger(input.taskId,input.part,input.count,{phase:'downloaded',original_filename:path.basename(verified.file),sha256:hash,error:null});
   let exists=false;try{await this.verify(objectPath,hash,bytes,stored);exists=true;}catch(e){if(old)throw e;}
   if(!exists){await this.checkTask(input.taskId,input.source);record.phase='uploading';await this.save();await this.ledger(input.taskId,input.part,input.count,{phase:'uploading',sha256:hash});
    if(stored.provider==='supabase'&&bytes>50*1024*1024&&this.discoverStorageConfig)throw Object.assign(Error('原图超过当前 Supabase 单文件上限，R2 母图服务尚未启用；本地原图与采集记录已保留'),{code:'ART_STORAGE_LIMIT',retryable:false});
    try{if(stored.provider==='r2')await uploadR2(this,verified.file,objectPath,meta,hash,bytes,stored);else await this.upload(verified.file,objectPath,meta,hash,bytes);}catch(e){if(this.paused)throw e;try{await this.verify(objectPath,hash,bytes,stored);}catch{throw e;}}
   }
   record.phase='verifying';await this.save();await this.ledger(input.taskId,input.part,input.count,{phase:'verifying',sha256:hash});await this.verify(objectPath,hash,bytes,stored);
   if(stored.provider==='r2')await recordR2Receipt(this,objectPath,hash,bytes,meta.mime,stored);
   const after=await stat(verified.file);if(after.size!==verified.size||after.mtimeMs!==verified.mtime)throw Error('原文件在上传期间发生变化');await this.checkTask(input.taskId,input.source);
   const filenameMeta=path.basename(verified.file).match(/^([^_]{1,12})_([^_]{1,30})_(.+?)(?:_\d+(?: \(\d+\))?)?\.(?:jpe?g|png|webp)$/i);
   const r=await this.request(this.api+'/rest/v1/rpc/register_capture_original',{method:'POST',retrySafe:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({p_task_id:input.taskId,p_part_index:input.part,p_expected_count:input.count,p_filename:path.basename(verified.file),p_sha256:hash,p_mime:meta.mime,p_width:meta.width,p_height:meta.height,p_bytes:bytes,p_title:input.title||filenameMeta?.[3]||'',p_author:filenameMeta?.[2]||'',p_era:filenameMeta?.[1]||'',...(stored.provider==='r2'?{p_storage_provider:'r2',p_storage_origin:stored.origin}:{})})});
   const result=await r.json();Object.assign(record,{phase:'complete',masterId:result.master_id,projectId:result.project_id,error:null});if(stored.provider==='r2')delete this.r2[journalKey];await this.save();const cleanup=input.autoCleanup===true?await this.cleanupRecord(record,{recheck:false,snapshot:verified}):null;this.event({phase:'complete',taskId:input.taskId,part:input.part,count:input.count});return {...result,...(cleanup?{cleanup}:{})};
  }catch(e){if(record){record.phase=this.paused?'paused':'failed';record.error=e.message;await this.save();if(!this.paused)try{await this.ledger(input.taskId,input.part,input.count,{phase:'failed',sha256:record.hash,error:e.message},{retrySafe:false});}catch{}}throw e;}
  finally{this.running=false;}
 }
 status(){return {version:'0.7.6',directory:this.directory,running:this.running,paused:this.paused,records:this.owner?Object.entries(this.records).filter(([k])=>k.startsWith(this.owner+':')).map(([,r])=>r).slice(-100):[]};}
}

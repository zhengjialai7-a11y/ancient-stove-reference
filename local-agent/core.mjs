import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,rename,mkdir,realpath,stat,open} from 'node:fs/promises';
import path from 'node:path';

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
export async function containedFile(root,filename){const base=await realpath(root),file=await realpath(filename);const relative=path.relative(base,file);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('下载文件不在授权目录内');const s=await stat(file);if(!s.isFile()||!s.size||/\.(?:crdownload|part|tmp)$/i.test(file))throw Error('原图尚未下载完成');return {file,size:s.size,mtime:s.mtimeMs};}
export class CaptureClient {
 constructor({directory,stateDirectory,fetchImpl=fetch,api=API,storage=STORAGE,event=()=>{}}){this.directory=directory;this.stateDirectory=stateDirectory;this.fetch=fetchImpl;this.api=api;this.storage=storage;this.event=event;this.session=null;this.owner=null;this.paused=false;this.records={};this.tus={};this.running=false;}
 async load(){await mkdir(this.stateDirectory,{recursive:true});try{const data=JSON.parse(await readFile(path.join(this.stateDirectory,'progress.json'),'utf8'));this.records=data.records||{};this.tus=data.tus||{};}catch(e){if(e.code!=='ENOENT')throw Error('本机进度文件损坏，请保留文件并联系修复');}}
 async save(){const filename=path.join(this.stateDirectory,'progress.json');await writeFile(filename+'.tmp',JSON.stringify({version:1,records:this.records,tus:this.tus},null,2),{mode:0o600});await rename(filename+'.tmp',filename);}
 async setSession(accessToken){if(this.running)throw Error('正在上传，不能切换账号');if(typeof accessToken!=='string'||accessToken.length>12000)throw Error('登录凭据无效');const res=await this.fetch(this.api+'/auth/v1/user',{headers:{apikey:KEY,authorization:'Bearer '+accessToken},redirect:'error',signal:AbortSignal.timeout(30000)});if(!res.ok)throw Error('云端登录已失效，请重新登录');const account=await res.json();if(!/^[0-9a-f-]{36}$/i.test(account.id||''))throw Error('账号无效');this.owner=account.id;this.session=accessToken;this.paused=false;return {owner:this.owner};}
 async request(url,{method='GET',headers={},body}={}){if(!this.session)throw Error('请先从云端队列授权登录');const response=await this.fetch(url,{method,headers:{apikey:KEY,authorization:'Bearer '+this.session,...headers},body,redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok){if(response.status===401)throw Error('登录过期，请重新登录队列后继续');const t=await response.text();let message;try{const value=JSON.parse(t);message=value.message||value.msg||value.error;}catch{}throw Error(String(message||'云端请求失败 '+response.status).slice(0,240));}return response;}
 async rows(table,query){const r=await this.request(this.api+'/rest/v1/'+table+'?'+new URLSearchParams(query));return r.json();}
 async checkTask(taskId,source){const rows=await this.rows('reference_capture_status',{id:'eq.'+taskId,select:'id,created_by,source_id,source_type,source_url,paused,candidate_count,project_id,resolved_project_id,resolved_master_id'});const t=rows[0];if(!t||t.created_by!==this.owner||sourceKey(source)!==t.source_type+':'+t.source_id)throw Error('任务账号或作品来源不匹配');if(t.paused||this.paused)throw Error('任务已暂停');if((t.candidate_count>1&&!t.project_id)||t.resolved_master_id)throw Error('来源关联需要人工确认');return t;}
 async completedParts(input){const task=await this.checkTask(input.taskId,input.source);const rows=await this.rows('reference_capture_files',{task_id:'eq.'+input.taskId,select:'part_index,expected_count,phase,sha256,master_id'});if(rows.some(r=>r.expected_count!==input.count))throw Error('母图总张数与云端已有分段记录不一致');const parts=[];for(const r of rows){if(r.phase!=='complete'||!r.master_id)continue;const m=(await this.rows('artwork_masters',{id:'eq.'+r.master_id,select:'project_id,sha256,verified_sha256,verified_at,original_bytes,storage_path'}))[0];if(!m||m.project_id!==task.resolved_project_id||m.sha256!==r.sha256||m.verified_sha256!==m.sha256||!m.verified_at)continue;await this.verify(m.storage_path,m.sha256,Number(m.original_bytes));parts.push(r.part_index);}return {parts};}
 safeTus(url){const value=new URL(url,this.storage);const origin=new URL(this.storage).origin;if(value.origin!==origin||!value.pathname.startsWith('/storage/v1/upload/resumable/')||value.username||value.password)throw Error('续传地址不可信');return value.href;}
 async verify(objectPath,expectedHash,expectedBytes){this.event({phase:'verifying'});const r=await this.request(this.api+'/storage/v1/object/'+BUCKET+'/'+objectPath);const hash=createHash('sha256');let bytes=0;for await(const chunk of r.body){if(this.paused)throw Error('任务已暂停');hash.update(chunk);bytes+=chunk.length;}if(bytes!==expectedBytes||hash.digest('hex')!==expectedHash)throw Error('云端回读 SHA-256 或字节数不一致，未登记完成');return true;}
 async upload(filename,objectPath,meta,expectedHash,expectedBytes){
  const journalKey=this.owner+':'+expectedHash;let url=this.tus[journalKey],offset=0;
  if(url){url=this.safeTus(url);const r=await this.fetch(url,{method:'HEAD',headers:{authorization:'Bearer '+this.session,'Tus-Resumable':'1.0.0'},redirect:'error',signal:AbortSignal.timeout(30000)});if(r.ok)offset=Number(r.headers.get('upload-offset'));else if([404,410].includes(r.status)){url=null;delete this.tus[journalKey];await this.save();}else throw Error('恢复上传失败 '+r.status);}
  if(!url){const metadata={bucketName:BUCKET,objectName:objectPath,contentType:meta.mime,cacheControl:'31536000'};const r=await this.request(this.storage+'/storage/v1/upload/resumable',{method:'POST',headers:{'Tus-Resumable':'1.0.0','Upload-Length':String(expectedBytes),'Upload-Metadata':Object.entries(metadata).map(([k,v])=>k+' '+Buffer.from(v).toString('base64')).join(','),'x-upsert':'false'}});url=this.safeTus(r.headers.get('location'));offset=Number(r.headers.get('upload-offset')||0);this.tus[journalKey]=url;await this.save();}
  if(!Number.isSafeInteger(offset)||offset<0||offset>expectedBytes)throw Error('续传偏移无效');
  const handle=await open(filename,'r');try{while(offset<expectedBytes){if(this.paused)throw Error('任务已暂停');const size=Math.min(CHUNK,expectedBytes-offset),buffer=Buffer.alloc(size);const {bytesRead}=await handle.read(buffer,0,size,offset);if(bytesRead!==size)throw Error('上传时原文件发生变化');const r=await this.request(url,{method:'PATCH',headers:{'Tus-Resumable':'1.0.0','Upload-Offset':String(offset),'Content-Type':'application/offset+octet-stream'},body:buffer});const next=Number(r.headers.get('upload-offset'));if(next!==offset+size)throw Error('服务端续传偏移不匹配');offset=next;this.event({phase:'uploading',bytes:offset,total:expectedBytes});}}
  finally{await handle.close();}delete this.tus[journalKey];await this.save();
 }
 async ledger(taskId,part,count,values){const r=await this.request(this.api+'/rest/v1/reference_capture_files?on_conflict=created_by,task_id,part_index',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({created_by:this.owner,task_id:taskId,part_index:part,expected_count:count,updated_at:new Date().toISOString(),...values})});return r;}
 async processFile(input){
  if(this.running)throw Error('本机正在处理另一张原图');this.running=true;
  let record,k;try{
   if(!Number.isInteger(input.part)||!Number.isInteger(input.count)||input.part<1||input.part>input.count||input.count>500)throw Error('母图张数无效');
   const task=await this.checkTask(input.taskId,input.source);const verified=await containedFile(this.directory,input.filename);
   const file=await open(verified.file,'r');let meta;try{const head=Buffer.alloc(Math.min(verified.size,1024*1024));await file.read(head,0,head.length,0);meta=dimensions(head);}finally{await file.close();}
   const {hash,bytes}=await digestFile(verified.file);if(bytes!==verified.size||!meta.width||!meta.height)throw Error('原图尺寸或文件大小无效');
   k=this.owner+':'+input.taskId+':'+input.part;const prior=this.records[k];if(prior&&(prior.hash!==hash||prior.count!==input.count))throw Error('相同分段的文件或张数改变，需要人工确认');
   record={taskId:input.taskId,source:input.source,part:input.part,count:input.count,filename:verified.file,hash,bytes,phase:'downloaded',updatedAt:new Date().toISOString()};this.records[k]=record;await this.save();
   const old=(await this.rows('artwork_masters',{created_by:'eq.'+this.owner,sha256:'eq.'+hash,select:'id,project_id,storage_path'}))[0];
   if(old&&old.project_id!==task.resolved_project_id)throw Error('相同原图已属于其他项目，需要人工确认');
   const cloudPart=(await this.rows('reference_capture_files',{task_id:'eq.'+input.taskId,part_index:'eq.'+input.part,select:'expected_count,sha256,master_id'}))[0];
   if(cloudPart&&(cloudPart.expected_count!==input.count||(cloudPart.sha256&&cloudPart.sha256!==hash)))throw Error('云端此分段已记录不同文件或张数');
   const sameParts=await this.rows('reference_capture_files',{task_id:'eq.'+input.taskId,sha256:'eq.'+hash,select:'part_index'});if(sameParts.some(p=>p.part_index!==input.part))throw Error('此原图与另一分段完全相同，请核对是否切换到了下一张');
   const objectPath=old?.storage_path||'masters/'+this.owner+'/'+hash+'.'+meta.ext;
   await this.ledger(input.taskId,input.part,input.count,{phase:'downloaded',original_filename:path.basename(verified.file),sha256:hash,error:null});
   let exists=false;try{await this.verify(objectPath,hash,bytes);exists=true;}catch(e){if(old)throw e;}
   if(!exists){await this.checkTask(input.taskId,input.source);record.phase='uploading';await this.save();await this.ledger(input.taskId,input.part,input.count,{phase:'uploading',sha256:hash});
    try{await this.upload(verified.file,objectPath,meta,hash,bytes);}catch(e){if(this.paused)throw e;try{await this.verify(objectPath,hash,bytes);}catch{throw e;}}
   }
   record.phase='verifying';await this.save();await this.ledger(input.taskId,input.part,input.count,{phase:'verifying',sha256:hash});await this.verify(objectPath,hash,bytes);
   const after=await stat(verified.file);if(after.size!==verified.size||after.mtimeMs!==verified.mtime)throw Error('原文件在上传期间发生变化');await this.checkTask(input.taskId,input.source);
   const filenameMeta=path.basename(verified.file).match(/^([^_]{1,12})_([^_]{1,30})_(.+?)(?:_\d+(?: \(\d+\))?)?\.(?:jpe?g|png|webp)$/i);
   const r=await this.request(this.api+'/rest/v1/rpc/register_capture_original',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_task_id:input.taskId,p_part_index:input.part,p_expected_count:input.count,p_filename:path.basename(verified.file),p_sha256:hash,p_mime:meta.mime,p_width:meta.width,p_height:meta.height,p_bytes:bytes,p_title:input.title||filenameMeta?.[3]||'',p_author:filenameMeta?.[2]||'',p_era:filenameMeta?.[1]||''})});
   const result=await r.json();Object.assign(record,{phase:'complete',masterId:result.master_id,projectId:result.project_id,error:null});await this.save();this.event({phase:'complete',taskId:input.taskId,part:input.part,count:input.count});return result;
  }catch(e){if(record){record.phase='failed';record.error=e.message;await this.save();try{await this.ledger(input.taskId,input.part,input.count,{phase:'failed',sha256:record.hash,error:e.message});}catch{}}throw e;}
  finally{this.running=false;}
 }
 status(){return {version:'0.7.0',directory:this.directory,running:this.running,paused:this.paused,records:this.owner?Object.entries(this.records).filter(([k])=>k.startsWith(this.owner+':')).map(([,r])=>r).slice(-100):[]};}
}

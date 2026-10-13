import {open} from 'node:fs/promises';

export const R2_PART_SIZE=8*1024*1024;
export function r2Origin(value){
 let url;try{url=new URL(value);}catch{throw Error('R2 母图服务地址无效');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||!url.hostname.includes('.')||/^(?:localhost|.*\.localhost|.*\.local|\d+(?:\.\d+){3}|\[.*\])$/i.test(url.hostname))throw Error('R2 母图服务地址不可信');
 return url.origin;
}
export function r2ObjectKey(value,owner){
 if(typeof value!=='string'||!new RegExp('^masters/'+owner.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/[a-f0-9]{64}\\.(?:jpg|png|webp)$').test(value))throw Error('R2 母图路径与当前账号不匹配');
 return value;
}
export function r2Url(origin,path){return r2Origin(origin)+path;}
export async function uploadR2(client,filename,key,meta,hash,bytes,storage){
 for(let attempt=0;;attempt++)try{return await multipartUpload(client,filename,key,meta,hash,bytes,storage);}catch(error){
  if(attempt!==0||(![404,410].includes(error.status)&&!(error.status===409&&error.serverCode==='UPLOAD_EXPIRED')))throw error;
  try{await client.verify(key,hash,bytes,storage);return {completed:true,key};}catch(readback){if(readback.status!==404)throw readback;}
  const journalKey=client.owner+':'+hash,journal=client.r2[journalKey];
  if(!journal||journal.origin!==storage.origin||journal.key!==key||journal.sha256!==hash||journal.bytes!==bytes)throw error;
  delete client.r2[journalKey];await client.save();client.emit({phase:'uploading',stage:'R2 续传任务已过期，重新建立上传；本地原图保留',bytes:0,total:bytes});
 }
}
async function multipartUpload(client,filename,key,meta,hash,bytes,storage){
 key=r2ObjectKey(key,client.owner);const origin=r2Origin(storage.origin),journalKey=client.owner+':'+hash;let journal=client.r2[journalKey];
 if(journal&&(journal.origin!==origin||journal.key!==key||journal.sha256!==hash||journal.bytes!==bytes||journal.mime!==meta.mime))throw Error('R2 续传记录与原图不一致，需要人工核对');
 if(!journal){
  const response=await client.request(r2Url(origin,'/v1/uploads'),{method:'POST',retrySafe:true,stage:'准备 R2 母图续传',headers:{'Content-Type':'application/json'},body:JSON.stringify({sha256:hash,bytes,mime:meta.mime})}),created=await response.json();
  if(created.key!==key||created.partSize!==R2_PART_SIZE)throw Error('R2 续传任务信息无效');
  if(created.completed===true)return created;
  if(typeof created.uploadId!=='string'||!created.uploadId||created.uploadId.length>1000)throw Error('R2 续传任务信息无效');
  journal={origin,key,sha256:hash,bytes,mime:meta.mime,uploadId:created.uploadId,partSize:R2_PART_SIZE,parts:created.parts||[]};client.r2[journalKey]=journal;await client.save();
 }
 if(!Array.isArray(journal.parts)||journal.partSize!==R2_PART_SIZE||typeof journal.uploadId!=='string'||!journal.uploadId||journal.uploadId.length>1000)throw Error('R2 续传记录无效，需要人工核对');
 const partCount=Math.ceil(bytes/R2_PART_SIZE),parts=new Map();
 for(const part of journal.parts){if(!Number.isInteger(part.partNumber)||part.partNumber<1||part.partNumber>partCount||typeof part.etag!=='string'||!part.etag||part.etag.length>500||parts.has(part.partNumber))throw Error('R2 分块记录无效，需要人工核对');parts.set(part.partNumber,part);}
 client.context.total=bytes;const handle=await open(filename,'r');
 try{for(let n=1;n<=partCount;n++){
  if(parts.has(n))continue;
  const offset=(n-1)*R2_PART_SIZE,size=Math.min(R2_PART_SIZE,bytes-offset),buffer=Buffer.alloc(size),{bytesRead}=await handle.read(buffer,0,size,offset);
  if(bytesRead!==size)throw Error('上传时原文件发生变化');
  client.emit({phase:'uploading',stage:'上传 R2 母图',bytes:offset,total:bytes});
  const response=await client.request(r2Url(origin,'/v1/uploads/'+encodeURIComponent(journal.uploadId)+'/parts/'+n+'?key='+encodeURIComponent(key)),{method:'PUT',retrySafe:true,timeout:client.uploadTimeout,stage:'上传 R2 母图',progress:{bytes:offset,total:bytes},headers:{'Content-Type':'application/octet-stream'},body:buffer}),accepted=await response.json();
  if(accepted.partNumber!==n||typeof accepted.etag!=='string'||!accepted.etag||accepted.etag.length>500)throw Error('R2 分块回执无效');
  parts.set(n,{partNumber:n,etag:accepted.etag});journal.parts=[...parts.values()].sort((a,b)=>a.partNumber-b.partNumber);await client.save();client.emit({phase:'uploading',stage:'上传 R2 母图',bytes:offset+size,total:bytes});
 }}finally{await handle.close();}
 const response=await client.request(r2Url(origin,'/v1/uploads/'+encodeURIComponent(journal.uploadId)+'/complete'),{method:'POST',retrySafe:true,timeout:Math.max(client.uploadTimeout,180000),stage:'合并并核验 R2 母图',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,sha256:hash,bytes,mime:meta.mime,parts:journal.parts})});
 return response.json();
}
export async function recordR2Receipt(client,key,hash,bytes,mime,storage){
 r2ObjectKey(key,client.owner);const response=await client.request(r2Url(storage.origin,'/v1/receipts'),{method:'POST',retrySafe:true,stage:'确认 R2 母图回执',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,sha256:hash,bytes,mime})}),receipt=await response.json();
 if(receipt.owner!==client.owner||receipt.storage_origin!==storage.origin||receipt.path!==key||receipt.sha256!==hash||Number(receipt.bytes)!==bytes||receipt.mime!==mime||typeof receipt.signature!=='string'||!receipt.signature||!receipt.issued_at||typeof receipt.etag!=='string'||!receipt.etag)throw Error('R2 母图核验回执与原图不一致');
 await client.request(client.api+'/rest/v1/rpc/record_r2_original_receipt',{method:'POST',retrySafe:true,stage:'登记 R2 母图核验回执',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_receipt:receipt})});
}

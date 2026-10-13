// Original image transport. Image bytes, dimensions and crop coordinates stay unchanged.
(function(root){
 'use strict';
 const PART_SIZE=8*1024*1024,LEGACY_LIMIT=50*1024*1024;
 function origin(value){
  if(typeof value!=='string')throw Error('母图存储来源配置无效');
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||!u.hostname.includes('.')||/^(?:localhost|.*\.localhost|.*\.local|\d+(?:\.\d+){3}|\[.*\])$/i.test(u.hostname))throw Error('母图存储来源必须是可信 HTTPS 地址');
  return u.origin;
 }
 function keyPath(value){
  if(typeof value!=='string'||!value||value.length>1024||value.split('/').some(x=>!x||x==='.'||x==='..')||/[^A-Za-z0-9_./-]/.test(value))throw Error('母图对象路径无效');
  return value.split('/').map(encodeURIComponent).join('/');
 }
 async function digest(blob){
  return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join('');
 }
 class OriginalStorage{
  constructor({db,bucket,fetchImpl=root.fetch.bind(root),hash=digest,onProgress=()=>{},timeoutMs=300000}){
   this.db=db;this.bucket=bucket;this.fetch=fetchImpl;this.hash=hash;this.onProgress=onProgress;this.timeoutMs=timeoutMs;this.configuration=null;
  }
  async config(refresh=false){
   if(this.configuration&&!refresh)return this.configuration;
   const {data,error}=await this.db.rpc('get_original_storage_config');
   if(error){
    // Only a genuinely absent RPC allows an older Supabase deployment to work.
    if(error.code==='PGRST202'||error.code==='42883')return this.configuration={provider:'supabase',enabled:false,endpoint:null,readOrigins:[]};
    throw Error('读取母图存储配置失败：'+(error.message||String(error)));
   }
   const value=Array.isArray(data)?data[0]:data;
   if(!value||!['supabase','r2'].includes(value.provider)||typeof value.enabled!=='boolean')throw Error('母图存储配置无效');
   const endpoint=value.endpoint?origin(value.endpoint):null;
   const readOrigins=(value.readOrigins||[]).map(origin);
   if(endpoint&&!readOrigins.includes(endpoint))throw Error('母图上传地址未列入可信读取来源');
   if(value.provider==='r2'&&value.enabled&&!endpoint)throw Error('R2 未连接，母图已保留；连接后可继续上传');
   return this.configuration={provider:value.provider,enabled:value.enabled,endpoint,readOrigins};
  }
  async target(bytes,path){
   keyPath(path);const cfg=await this.config(true);
   if(cfg.provider==='r2'&&cfg.enabled)return {storage_provider:'r2',storage_origin:cfg.endpoint,storage_path:path};
   if(bytes>LEGACY_LIMIT)throw Error('R2 未连接，母图已保留；这张原图超过当前 Supabase 的 50 MB 文件上限，请连接 R2 后继续上传');
   return {storage_provider:'supabase',storage_origin:null,storage_path:path};
  }
  async descriptor(master){
   const descriptor=typeof master==='string'?{storage_path:master}:master;
   keyPath(descriptor?.storage_path);
   const provider=descriptor.storage_provider||'supabase';
   if(provider==='supabase')return {...descriptor,storage_provider:provider,storage_origin:null};
   if(provider!=='r2')throw Error('母图存储类型无效');
   const cfg=await this.config(),storage_origin=origin(descriptor.storage_origin);
   if(!cfg.readOrigins.includes(storage_origin))throw Error('母图来源不在云端可信配置中，禁止读取或发送登录凭据');
   return {...descriptor,storage_provider:provider,storage_origin};
  }
  async publicUrl(master){
   const item=await this.descriptor(master);
   return item.storage_provider==='r2'?item.storage_origin+'/public/'+keyPath(item.storage_path):this.db.storage.from(this.bucket).getPublicUrl(item.storage_path).data.publicUrl;
  }
  async request(endpoint,path,{method='GET',body,raw=false,blob=false}={}){
   const cfg=await this.config(),trusted=origin(endpoint);
   if(!cfg.readOrigins.includes(trusted))throw Error('母图请求地址未授权');
   const {data,error}=await this.db.auth.getSession(),token=data?.session?.access_token;
   if(error||!token)throw Error('登录已过期，请重新登录');
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
   try{
    const headers={Authorization:'Bearer '+token};
    if(body!==undefined)headers['Content-Type']=raw?'application/octet-stream':'application/json';
    const response=await this.fetch(trusted+path,{method,headers,body:body===undefined?undefined:raw?body:JSON.stringify(body),signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
    if(!response.ok){let detail='';try{const value=await response.json();detail=value.error?.message||value.error||value.message||'';}catch(_){}
     throw Object.assign(Error('母图存储请求失败（'+response.status+'）'+(detail?'：'+String(detail):'')),{status:response.status});}
    return blob?await response.blob():await response.json();
   }catch(e){if(e.name==='AbortError')throw Error('母图传输超时，原图及已上传分片已保留，可重新提交继续上传');throw e;}
   finally{clearTimeout(timer);}
  }
  async download(master){
   const item=await this.descriptor(master);
   if(item.storage_provider==='r2')return this.request(item.storage_origin,'/v1/objects/'+keyPath(item.storage_path),{blob:true});
   const {data,error}=await this.db.storage.from(this.bucket).download(item.storage_path);
   if(error||!data)throw Error('云端回读失败：'+(error?.message||'未获得文件'));
   return data;
  }
  async verify(file,master,expectedHash){
   const remote=await this.download(master);
   if(remote.size!==file.size)throw Error('原图上传前后字节数不一致，禁止登记');
   if(await this.hash(remote)!==expectedHash)throw Error('云端文件 SHA-256 与本地原图不一致，禁止登记');
   return expectedHash;
  }
  async receipt(master,{sha256,bytes,mime}){
   const item=await this.descriptor(master);
   if(item.storage_provider!=='r2')return null;
   const result=await this.request(item.storage_origin,'/v1/receipts',{method:'POST',body:{key:item.storage_path,sha256,bytes,mime}});
   const receipt=result.receipt||result;
   const {error}=await this.db.rpc('record_r2_original_receipt',{p_receipt:receipt});
   if(error)throw Error('母图校验凭据未保存：'+(error.message||String(error)));
   return receipt;
  }
  async upload(file,master,sha256,mime=file.type){
   const item=await this.descriptor(master),cfg=await this.config();
   if(item.storage_provider!=='r2'||!cfg.enabled||cfg.provider!=='r2'||item.storage_origin!==cfg.endpoint)throw Error('R2 未连接，母图已保留；连接后可继续上传');
   if(!/^[a-f0-9]{64}$/.test(sha256)||!Number.isSafeInteger(file.size)||file.size<1)throw Error('母图校验信息无效');
   const meta={sha256,bytes:file.size,mime},state=await this.request(item.storage_origin,'/v1/uploads',{method:'POST',body:meta});
   if(state.key!==item.storage_path)throw Error('上传返回的对象路径与本地原图不一致');
   if(!state.completed){
    if(typeof state.uploadId!=='string'||!state.uploadId||state.uploadId.length>1024||/[\x00-\x1f]/.test(state.uploadId)||state.partSize!==PART_SIZE||!Array.isArray(state.parts))throw Error('母图续传状态无效');
    const count=Math.ceil(file.size/PART_SIZE),parts=new Map();
    for(const part of state.parts){if(!Number.isInteger(part.partNumber)||part.partNumber<1||part.partNumber>count||typeof part.etag!=='string'||!part.etag||parts.has(part.partNumber))throw Error('母图续传分片凭据无效');parts.set(part.partNumber,part);}
    let sent=[...parts.keys()].reduce((n,p)=>n+Math.min(PART_SIZE,file.size-(p-1)*PART_SIZE),0);this.onProgress(sent,file.size);
    for(let partNumber=1;partNumber<=count;partNumber++){
     if(parts.has(partNumber))continue;
     const chunk=file.slice((partNumber-1)*PART_SIZE,Math.min(partNumber*PART_SIZE,file.size));
     const part=await this.request(item.storage_origin,'/v1/uploads/'+encodeURIComponent(state.uploadId)+'/parts/'+partNumber+'?key='+encodeURIComponent(item.storage_path),{method:'PUT',raw:true,body:chunk});
     if(part.partNumber!==partNumber||typeof part.etag!=='string'||!part.etag)throw Error('母图分片上传凭据无效');
     parts.set(partNumber,part);sent+=chunk.size;this.onProgress(sent,file.size);
    }
    try{await this.request(item.storage_origin,'/v1/uploads/'+encodeURIComponent(state.uploadId)+'/complete',{method:'POST',body:{key:item.storage_path,...meta,parts:[...parts.values()].sort((a,b)=>a.partNumber-b.partNumber)}});}
    catch(e){
     // A response can be lost after completion. Only matching full object bytes recover it.
     try{await this.verify(file,item,sha256);}catch(_){throw e;}
    }
   }
   await this.verify(file,item,sha256);
   await this.receipt(item,meta);this.onProgress(file.size,file.size);
   return item;
  }
 }
 root.OriginalStorage=OriginalStorage;
})(globalThis);

'use strict';
// Persistent retry intent contains no credentials. Every attempt obtains a fresh
// same-account session from the already-open queue page before native auth.
const CaptureNetworkRetry=(()=>{
 const KEY='localCaptureNetworkRetry',ALARM='art-capture-network-retry',INTERVAL=5*60*1000;
 const transientStatus=new Set([408,429,500,502,503,504,520,521,522,523,524]);
 function isNetworkError(e){
  if(!e||e.retryable===false||e.code==='ART_AUTH'||e.code==='ART_PAUSED'||e.code==='ART_NATIVE_MISSING'||[401,403].includes(e.status))return false;
  if(e.code==='ART_HTTP')return e.retryable===true&&transientStatus.has(e.status);
  if(['ART_NETWORK','ART_NATIVE_LINK','ART_NATIVE_TIMEOUT','NETWORK_FAILED','NETWORK_TIMEOUT','NETWORK_DISCONNECTED','NETWORK_SERVER_DOWN','SERVER_FAILED','SERVER_UNREACHABLE'].includes(e.code))return e.retryable!==false;
  if(e.code)return false;
  return !/SHA-256|字节数不一致|来源.*不匹配|账号.*不匹配/.test(e.message||'')&&/ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET|fetch failed/i.test(e.message||'');
 }
 const fingerprint=tasks=>JSON.stringify((tasks||[]).map(t=>[t.id,t.source]).sort((a,b)=>a[0].localeCompare(b[0])));
 const safeError=e=>String(e?.message||e||'网络连接中断').replace(/https?:\/\/\S+/gi,'[请求地址]').replace(/Bearer\s+\S+/gi,'[登录凭据]').slice(0,300);
 function publicState(job){if(!job)return null;return {id:job.id,owner:job.owner,mode:job.mode,phase:job.phase,nextAttemptAt:job.nextAttemptAt,attempt:job.attempt,error:job.error,taskId:job.taskId||null};}
 function create({storage,alarms,publish=async()=>{},requestSession=async()=>{},run,validate=async()=>true,canRun=()=>true,now=()=>Date.now(),uuid=()=>crypto.randomUUID()}){
  let chain=Promise.resolve(),busy=false,generation=0;
  const serial=fn=>{const p=chain.then(fn);chain=p.catch(()=>{});return p;};
  const read=async()=>{const data=await storage.get(KEY);return data[KEY]||null;};
  const arm=async job=>{if(job)await alarms.create(ALARM,{when:Math.max(now()+1000,job.nextAttemptAt)});else await alarms.clear(ALARM);};
  async function write(job,previous){await storage.set({[KEY]:job});await arm(job);await publish(publicState(job),job,previous);}
  async function schedule(context,error){
   if(!isNetworkError(error)||!context.owner)return null;const epoch=generation;
   return serial(async()=>{if(epoch!==generation)return null;const old=await read();if(epoch!==generation)return null;
    const command=context.intent.command,intent={command,...(context.intent.tasks?{tasks:context.intent.tasks.map(t=>({id:t.id,source:t.source,source_id:t.source_id,title:String(t.title||'').slice(0,180),count:t.count||null}))}:{}),...(context.intent.retryIds?{retryIds:[...context.intent.retryIds]}:{})};
    const job={id:uuid(),owner:context.owner,mode:context.mode||'collect',batch:context.batch||fingerprint(intent.tasks),intent,autoCleanup:context.autoCleanup===true,taskId:context.taskId||null,phase:'waiting',nextAttemptAt:now()+INTERVAL,attempt:old?.owner===context.owner&&old.batch===context.batch?old.attempt:0,error:safeError(error)};
    await write(job,old);return publicState(job);
   });
  }
  function cancel(id){generation++;return serial(async()=>{const old=await read();if(id&&old?.id!==id)return false;await write(null,old);return true;});}
  async function finish(id,error){return serial(async()=>{const old=await read();if(old?.id!==id)return;await write(null,{...old,...(error?{terminalError:safeError(error)}:{})});});}
  async function restore(){return serial(async()=>{const job=await read();if(!job){await arm(null);return null;}if(!await validate(job)){await write(null,job);return null;}if(job.phase==='starting'){job.phase='waiting';job.requestNonce=null;}await arm(job);await publish(publicState(job),job);return publicState(job);});}
  async function due(force=false,owner){return serial(async()=>{const job=await read();if(!job||owner&&job.owner!==owner)return false;if(!force&&job.nextAttemptAt>now()){await arm(job);return false;}if(!await validate(job)){await write(null,job);return false;}
   if(busy||!canRun()){job.nextAttemptAt=now()+INTERVAL;await write(job,job);return false;}
   job.phase='requesting';job.requestNonce=uuid();job.attempt++;job.nextAttemptAt=now()+INTERVAL;await write(job,job);await requestSession({...publicState(job),requestNonce:job.requestNonce});return true;
  });}
  async function accept(message){
   if(busy)return {ok:false,error:'自动恢复正在进行'};busy=true;const epoch=generation;let job;
   try{
    job=await serial(async()=>{const current=await read();if(epoch!==generation||!current||current.id!==message.retryId||current.owner!==message.ownerId||current.requestNonce!==message.retryNonce||current.phase!=='requesting')return null;if(!await validate(current))return null;current.phase='starting';await write(current,current);return current;});
    if(!job)return {ok:false,error:'自动恢复请求已取消或已过期'};
    if(epoch!==generation)return {ok:false,error:'自动恢复已取消'};
    if(message.unavailable){if(message.network===true){await schedule({...job},Object.assign(Error('网络中断，暂时无法更新登录凭据'),{code:'ART_NETWORK',retryable:true}));return {ok:true,result:{waiting:true}};}await finish(job.id,'登录已失效，请重新登录后继续');return {ok:false,error:'登录已失效，请重新登录后继续'};}
    if(typeof message.accessToken!=='string'||!message.accessToken){await finish(job.id,'登录已失效，请重新登录后继续');return {ok:false,error:'自动恢复缺少登录凭据'};}
    if(epoch!==generation)return {ok:false,error:'自动恢复已取消'};
    const result=await run(job,message.accessToken,()=>epoch===generation);
    if(epoch!==generation)return {ok:false,error:'自动恢复已取消'};
    if(result.ok){await finish(job.id);return result;}
    const error=Object.assign(Error(result.error||'恢复失败'),result.errorInfo||{});if(isNetworkError(error)){await schedule({...job},error);return {ok:true,result:{waiting:true}};}await finish(job.id,error);return result;
   }finally{busy=false;}
  }
  return {schedule,cancel,restore,due,accept,status:async owner=>{const job=await read();return job?.owner===owner?publicState(job):null;},job:read,isBusy:()=>busy};
 }
 return {create,isNetworkError,fingerprint,publicState,KEY,ALARM,INTERVAL};
})();

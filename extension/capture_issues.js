'use strict';
// Shared review policy. Skipping never grants permission to upload or count a failure as complete.
const CaptureIssues=(()=>{
 const labels={duplicate:'重复 ID / 重复原图',source:'来源或关联待核对',count:'母图张数待核对',hash:'原图核验失败',storage:'母图存储上限 / R2 待连接',download:'下载失败',network:'网络连接中断',auth:'登录或权限失效',system:'本机助手异常',other:'需要人工处理'};
 function kind(error,stage){
  const code=error?.code||'',message=error?.message||error?.error||'';
  if(code==='ART_AUTH'||[401,403].includes(error?.status)||/登录已失效|登录过期|登录凭据|云端登录校验/.test(message))return 'auth';
  if(['ART_NATIVE_MISSING','ENOSPC','ENOMEM'].includes(code)||/本机进度文件损坏|另一个浏览器正在运行/.test(message))return 'system';
  if(code==='ART_STORAGE_LIMIT'||error?.status===413||/R2.*(?:尚未启用|尚未连接|待连接)/.test(message))return 'storage';
  if(['ART_NETWORK','ART_NATIVE_LINK','ART_NATIVE_TIMEOUT','NETWORK_FAILED','NETWORK_TIMEOUT','NETWORK_DISCONNECTED','NETWORK_SERVER_DOWN','SERVER_FAILED','SERVER_UNREACHABLE'].includes(code)||code==='ART_HTTP'&&[408,429,500,502,503,504,520,521,522,523,524].includes(error?.status)||/ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|fetch failed/.test(message))return 'network';
  if(/重复|另一分段完全相同|相同原图已属于其他项目/.test(message))return 'duplicate';
  if(/来源|关联|其他项目|账号.*不匹配/.test(message))return 'source';
  if(/张数|分段.*改变|不同文件/.test(message))return 'count';
  if(/SHA-256|字节数不一致|原文件.*变化|图片|原图尺寸/.test(message))return 'hash';
  if(['opening','preparing','downloading'].includes(stage))return 'download';
  return 'other';
 }
 function global(error,stage){return error?.code==='ART_PAUSED'||['auth','system'].includes(kind(error,stage))||kind(error,stage)==='network'&&!['opening','preparing','downloading'].includes(stage);}
 function pending(task){return task?.status==='failed'&&task.review?.status!=='resolved';}
 function review(task){const failure=task?.failures?.at(-1),type=task?.review?.kind||kind({...task?.errorDetail,message:task?.error},task?.errorStage);return {kind:type,label:labels[type],part:task?.review?.part||failure?.part||null,time:task?.failedAt||failure?.time||null};}
 return {kind,global,pending,review,labels};
})();

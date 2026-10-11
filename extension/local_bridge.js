'use strict';
// The local uploader receives a cloud access token only after an explicit Start.
// Tokens never go to the art website or chrome.storage.
(()=>{
 const ORIGIN='https://zhengjialai7-a11y.github.io';
 if(location.origin!==ORIGIN||location.pathname!=='/ancient-stove-reference/queue.html')return;
 window.addEventListener('message',async event=>{
  const m=event.data;if(event.source!==window||event.origin!==ORIGIN||m?.type!=='ART_LOCAL_COMMAND'||typeof m.requestId!=='string'||m.requestId.length>80)return;
  const commands=new Set(['hello','directory','status','start','pause','resume','retry']);if(!commands.has(m.command))return;
  try{const result=await chrome.runtime.sendMessage({type:'localCaptureCommand',command:m.command,tasks:m.tasks,accessToken:m.accessToken});window.postMessage({type:'ART_LOCAL_RESULT',requestId:m.requestId,...result},ORIGIN);}
  catch(e){window.postMessage({type:'ART_LOCAL_RESULT',requestId:m.requestId,ok:false,error:e.message},ORIGIN);}
 });
 chrome.runtime.onMessage.addListener(m=>{if(m?.type==='localCaptureProgress')window.postMessage({type:'ART_LOCAL_PROGRESS',state:m.state},ORIGIN);});
})();

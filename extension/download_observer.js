'use strict';
if(window.top===window)window.addEventListener('message',e=>{
 if(e.source!==window||e.origin!==location.origin||e.data?.type!=='ART_ORIGINAL_LINK')return;
 const {nonce,source,href,filename}=e.data;if(typeof nonce!=='string'||nonce.length>80||typeof source!=='string'||typeof href!=='string'||href.length>12000)return;
 chrome.runtime.sendMessage({type:'localCaptureProof',nonce,source,href,filename}).catch(()=>{});
});

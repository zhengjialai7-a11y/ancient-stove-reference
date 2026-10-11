'use strict';
// Only the project's hosted queue may request its saved collection records.
// No authentication tokens, browsing history or image bytes cross this bridge.
const QUEUE_ORIGIN='https://zhengjialai7-a11y.github.io';
window.addEventListener('message',async event=>{
 if(location.origin!==QUEUE_ORIGIN||location.pathname!=='/ancient-stove-reference/queue.html'||event.origin!==QUEUE_ORIGIN||event.source!==window||event.data?.type!=='ART_CAPTURE_REQUEST')return;
 const requestId=event.data.requestId;if(typeof requestId!=='string'||requestId.length>80)return;
 const {favoriteQueueV04,favoriteResponseSnapshot}=await chrome.storage.local.get(['favoriteQueueV04','favoriteResponseSnapshot']);
 const allowed=['source_id','sourceId','resourceId','source_type','sourceType','favorite_line_id','lineId','title','author','era','status','phase','paused','notes','order','queue_order','downloadFilename','download_filename'];
 const rows=favoriteQueueV04?.items?.length?favoriteQueueV04.items:favoriteResponseSnapshot?.rows||[];
 const items=rows.slice(0,2500).map(row=>Object.fromEntries(allowed.filter(k=>['string','number','boolean'].includes(typeof row[k])).map(k=>[k,row[k]])));
 window.postMessage({type:'ART_CAPTURE_EXPORT',requestId,queue:{version:5,items}},QUEUE_ORIGIN);
});

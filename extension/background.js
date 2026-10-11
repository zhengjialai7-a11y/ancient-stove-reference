'use strict';
// v0.7 local automation uses only explicitly started, source-bound download tasks.
importScripts('automation.js');
const IMPORTER='https://zhengjialai7-a11y.github.io/ancient-stove-reference/importer.html';
const SITE=/^https:\/\/(?:[a-z0-9-]+\.)*ltfc\.net(?:\/|$)/i;
const WINDOW_MS=3*60*1000;
function sourceSite(value){return typeof value==='string'&&SITE.test(value);}
function safeOrigin(url){try{return new URL(url).origin;}catch{return '未知';}}
async function store(name, item){await chrome.storage.local.set({[name]:item});}
async function downloadCreated(item){
 const {attempt}=await chrome.storage.local.get('attempt');
 const linkedAttempt=attempt&&Date.now()-attempt.time<WINDOW_MS;
 const siteReference=[item.referrer,item.url,item.finalUrl].some(sourceSite);
 if(!linkedAttempt&&!siteReference)return;
 await store('download',{
  id:item.id, started:Date.now(), state:item.state||'in_progress',
  filename:item.filename||'', origin:safeOrigin(item.finalUrl||item.url),
  source:linkedAttempt?attempt.page:(item.referrer||''),
  totalBytes:item.totalBytes||0, bytesReceived:item.bytesReceived||0,
  relation:siteReference?'来源相关':'下载按钮后3分钟内的候选任务', error:''
 });
 await chrome.action.setBadgeBackgroundColor({color:'#72512f'});
 await chrome.action.setBadgeText({text:'↓'});
}
chrome.downloads.onCreated.addListener(item=>{downloadCreated(item).catch(()=>{});});
chrome.downloads.onChanged.addListener(async delta=>{
 try{
  const {download}=await chrome.storage.local.get('download');
  if(!download||download.id!==delta.id)return;
  if(delta.filename)download.filename=delta.filename.current;
  if(delta.state)download.state=delta.state.current;
  if(delta.error)download.error=delta.error.current;
  const matching=await chrome.downloads.search({id:delta.id});
  if(matching.length){download.bytesReceived=matching[0].bytesReceived||0;download.totalBytes=matching[0].totalBytes||0;}
  await store('download',download);
  if(delta.state?.current==='complete'){
   await chrome.action.setBadgeBackgroundColor({color:'#237747'});
   await chrome.action.setBadgeText({text:'✓'});
  }else if(delta.state?.current==='interrupted'){
   await chrome.action.setBadgeBackgroundColor({color:'#9e382e'});
   await chrome.action.setBadgeText({text:'!'});
  }
 }catch(e){}
});
// Capture both favorites albumView transitions and ordinary SUHA view pages.
// Do not conflate albumId/sourceId with the unrelated SUHA work ID.
const ALBUM=/^https:\/\/(?:[a-z0-9-]+\.)*ltfc\.net\/albumView\/([0-9a-f]{24})/i;
const VIEW=/^https:\/\/(?:[a-z0-9-]+\.)*ltfc\.net\/view\/([A-Za-z0-9_-]+)\/([0-9a-f]{24})/i;
async function rememberFavoriteNavigation(tabId,url){
 let parsed;try{parsed=new URL(url);}catch{return;}
 const album=parsed.href.match(ALBUM),view=parsed.href.match(VIEW);
 if(!album&&!view)return;
 const {favoriteClick}=await chrome.storage.local.get('favoriteClick');
 const matchedClick=Boolean(favoriteClick&&Date.now()-favoriteClick.time<30000);
 const detail=album?{kind:'albumView',albumId:album[1],sourceId:parsed.searchParams.get('sourceId')||'',activeIndex:parsed.searchParams.get('activeIndex')||'',page:parsed.searchParams.get('page')||'',type:parsed.searchParams.get('type')||''}:{kind:'view',viewType:view[1],viewId:view[2]};
 if(!matchedClick&&!album)return;
 await store('favoriteClickResult',{...(matchedClick?favoriteClick:{title:'未关联点击标题',position:null}),url:parsed.href,...detail,capturedAt:Date.now()});
 // A confirmed mapping is created ONLY when a real click on a favorite card
 // was followed by a real albumView URL. Album ID and source ID remain distinct.
 if(album&&matchedClick&&Number.isInteger(Number(favoriteClick.position))&&Number(favoriteClick.position)>=1){
  const {favoriteMappedWorks=[]}=await chrome.storage.local.get('favoriteMappedWorks');
  const row={albumId:detail.albumId,position:Number(favoriteClick.position),title:favoriteClick.title||'',sourceId:detail.sourceId,activeIndex:detail.activeIndex,page:detail.page,sourceUrl:parsed.href,confirmedAt:new Date().toISOString(),method:'user-click-navigation'};
  if(/^[a-f0-9]{24}$/i.test(row.sourceId)){
   const key=x=>x.albumId+'|'+x.position;
   const mapping=new Map(favoriteMappedWorks.map(x=>[key(x),x]));
   mapping.set(key(row),row);
   await store('favoriteMappedWorks',[...mapping.values()]);
  }
 }

}
chrome.tabs.onUpdated.addListener((tabId,changeInfo,tab)=>{
 if(changeInfo.url)rememberFavoriteNavigation(tabId,changeInfo.url).catch(()=>{});
});
// Chromium may preserve a tab's URL while the SPA navigates internally.
chrome.webNavigation?.onHistoryStateUpdated?.addListener(details=>{
 if(details.frameId===0)rememberFavoriteNavigation(details.tabId,details.url).catch(()=>{});
});
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
 (async()=>{
  if(['localCaptureCommand','localCaptureProof'].includes(msg?.type)){sendResponse(await CaptureAutomation.handle(msg,sender));return;}
  if(msg?.type==='favoritesBatch'){
   if(!/\/resource_favorites/.test(sender.tab?.url||sender.url||'')){sendResponse({ok:false});return;}
   const albumId=typeof msg.albumId==='string'&&/^[a-f0-9]{24}$/i.test(msg.albumId)?msg.albumId:'';
   const rows=(Array.isArray(msg.rows)?msg.rows:[]).filter(x=>/^[a-f0-9]{24}$/i.test(x.resourceId||'')).slice(0,2500)
    .map(x=>({position:Number(x.position)||0,sourceId:x.resourceId,sourceType:String(x.sourceType||'').slice(0,32),lineId:String(x.lineId||'').slice(0,24),joinTime:String(x.joinTime||'').slice(0,40),title:String(x.title||'').slice(0,150),author:String(x.author||'').slice(0,90)}));
   if(!rows.length){sendResponse({ok:false});return;}
   const {favoriteResponseSnapshot}=await chrome.storage.local.get('favoriteResponseSnapshot');
   const indexed=new Map((favoriteResponseSnapshot?.albumId===albumId?favoriteResponseSnapshot.rows:[]||[]).map(x=>[x.lineId||x.position,x]));
   for(const x of rows)indexed.set(x.lineId||x.position,x);
   const total=Number.isInteger(msg.total)&&msg.total>=0?msg.total:null;
   const snapshot={albumId,total,loadedCount:msg.count||rows.length,rows:[...indexed.values()].sort((a,b)=>a.position-b.position),collectedAt:new Date().toISOString(),method:'observed-normal-page-response'};
   await store('favoriteResponseSnapshot',snapshot);sendResponse({ok:true,count:snapshot.rows.length});return;
  }
  if(msg?.type==='favoriteClick'){
   if(!sourceSite(sender.tab?.url||sender.url)){sendResponse({ok:false});return;}
   await store('favoriteClick',{position:msg.position,title:String(msg.title||'').slice(0,100),page:msg.page,time:Date.now()});
   sendResponse({ok:true});return;
  }
  if(msg?.type==='favoriteNavigation'){
   const href=String(msg.url||'');
   if(!sourceSite(href)){sendResponse({ok:false});return;}
   await rememberFavoriteNavigation(sender.tab?.id||0,href);
   sendResponse({ok:true});return;
  }
  if(msg?.type==='siteReady'){
   sendResponse({ok:true});return;
  }
  if(msg?.type==='downloadIntent'){
   const page=sourceSite(sender.tab?.url)?sender.tab.url:(sourceSite(sender.url)?sender.url:'');
   if(!page){sendResponse({ok:false});return;}
   const attempt={time:Date.now(),page,label:String(msg.label||'下载').slice(0,100),tabId:sender.tab?.id??null,frameId:sender.frameId??0};
   await chrome.storage.local.set({attempt,siteState:{time:Date.now(),value:'已点击网站下载按钮'},download:null});
   await chrome.action.setBadgeBackgroundColor({color:'#72512f'});
   await chrome.action.setBadgeText({text:'…'});
   sendResponse({ok:true});return;
  }
  if(msg?.type==='siteState'){
   const {attempt,siteState}=await chrome.storage.local.get(['attempt','siteState']);
   if(!attempt||Date.now()-attempt.time>WINDOW_MS||!sourceSite(sender.url||sender.tab?.url)){
    sendResponse({ok:false});return;
   }
   if(msg.value&&msg.value!==siteState?.value)await store('siteState',{time:Date.now(),value:String(msg.value).slice(0,50)});
   sendResponse({ok:true});return;
  }
  if(msg?.type==='openImporter'){
   const {attempt,download}=await chrome.storage.local.get(['attempt','download']);
   const u=new URL(IMPORTER);
   const source=attempt?.page||download?.source;
   if(sourceSite(source))u.searchParams.set('source_url',source);
   await chrome.tabs.create({url:u.toString()});sendResponse({ok:true});return;
  }
  if(msg?.type==='openDownloads'){
   await chrome.tabs.create({url:'chrome://downloads/'});sendResponse({ok:true});return;
  }
  if(msg?.type==='clear'){
   await chrome.storage.local.remove(['attempt','siteState','download']);
   await chrome.action.setBadgeText({text:''});sendResponse({ok:true});return;
  }
  sendResponse({ok:false});
 })().catch(err=>sendResponse({ok:false,error:String(err)}));
 return true;
});

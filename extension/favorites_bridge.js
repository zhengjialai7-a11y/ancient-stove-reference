// Runs inside the website's main world at document_start. Observe only responses
// that the user's normal favorites page loads. No additional network requests.
(()=>{
 if(window.__artFavoritesBridge038)return;
 window.__artFavoritesBridge038=true;
 if(window.top!==window)return;
 const FAV=/\/resource_favorites(?:\?|$)/i;
 const MARK='art-ref-favorites-v038';
 function safeId(x){return typeof x==='string'&&/^[a-f0-9]{24}$/i.test(x)?x.toLowerCase():null;}
 function findAlbumArrays(root){
  const found=[];const visited=new WeakSet();let budget=12000;
  function walk(x,depth){
   if(!x||typeof x!=='object'||depth>12||budget--<=0||visited.has(x))return;
   visited.add(x);
   if(Array.isArray(x.albumLines)){
    const rows=x.albumLines.slice(0,2500).map((line,idx)=>{
     if(!line||typeof line!=='object')return null;
     const res=line.resource;
     if(!res||typeof res!=='object')return null;
     const id=safeId(res.id||res.Id);
     if(!id)return null;
     return {position:idx+1,resourceId:id,sourceType:String(res.src||'').slice(0,32),lineId:safeId(line.Id||line.id)||'',joinTime:typeof line.joinTime==='string'?line.joinTime.slice(0,40):'',title:String(res.title||res.name||res.resourceName||'').slice(0,150),author:String(res.author||res.authorName||'').slice(0,90)};
    }).filter(Boolean);
    const t=Number(x.albumLinesTotal);
    found.push({rows,total:Number.isInteger(t)&&t>=0?t:null,count:x.albumLines.length,albumId:safeId(x.albumInfo?.Id||x.albumInfo?.id)||null});
   }
   if(Array.isArray(x)){for(const value of x.slice(0,2500))walk(value,depth+1);return;}
   for(const [key,value] of Object.entries(x)){
    if(/token|cookie|authorization|password|secret|session|cagAccess/i.test(key))continue;
    if(value&&typeof value==='object')walk(value,depth+1);
   }
  }
  walk(root,0);return found;
 }
 function report(body,kind){
  if(!FAV.test(location.pathname))return;
  let sets=[];
  try{sets=findAlbumArrays(body);}catch(e){}
  if(!sets.length)return;
  for(const s of sets){
   if(s.rows.length<1)continue;
   window.postMessage({tag:MARK,kind,albumId:s.albumId,total:s.total,count:s.count,rows:s.rows,time:Date.now()},location.origin);
  }
 }
 function parseBody(text,kind){
  if(!text||text.length>9000000)return;
  try{report(JSON.parse(text),kind);return;}catch(e){}
  // Some frameworks wrap JSON in a single quoted/escaped transport envelope.
  // Do not parse arbitrary script or eval strings; only ordinary JSON objects.
 }
 const originalFetch=window.fetch;
 window.fetch=function(...args){
  const p=originalFetch.apply(this,args);
  try{
   const req=args[0];const target=typeof req==='string'?req:req?.url||'';
   if(FAV.test(location.pathname)&&/getAlbumLinesInfo|resource_favorites|albumLines/i.test(String(target))){
    p.then(res=>{const type=res.headers.get('content-type')||'';if(/json|text/i.test(type))res.clone().text().then(t=>parseBody(t,'fetch')).catch(()=>{});}).catch(()=>{});
   }
  }catch(e){}
  return p;
 };
 const origOpen=XMLHttpRequest.prototype.open,origSend=XMLHttpRequest.prototype.send;
 XMLHttpRequest.prototype.open=function(method,url,...rest){this.__artFavoritesUrl=String(url||'');return origOpen.call(this,method,url,...rest);};
 XMLHttpRequest.prototype.send=function(...args){
  if(FAV.test(location.pathname)&&/getAlbumLinesInfo|resource_favorites|albumLines/i.test(this.__artFavoritesUrl||'')){
   this.addEventListener('load',()=>{try{
    if(this.responseType==='json')report(this.response,'xhr');
    else if(!this.responseType||this.responseType==='text')parseBody(this.responseText,'xhr');
   }catch(e){}},{once:true});
  }
  return origSend.apply(this,args);
 };
})();

if(!globalThis.__artRefCollectorInstalled){
 globalThis.__artRefCollectorInstalled=true;
'use strict';
// Observe only user interactions and visible button status on the website. No cookies, URLs for image payloads, or HTTP interception.
let lastIntent=0,watchUntil=0,watchTimer=null,lastStatus='',lastReport=0;
function send(type,data={}){
 try{chrome.runtime.sendMessage({type,...data},()=>{void chrome.runtime.lastError;});}catch(e){}
}
function humanLabel(el){
 const raw=[el.innerText,el.textContent,el.getAttribute('aria-label'),el.getAttribute('title')].filter(Boolean).join(' ');
 return raw.replace(/\s+/g,' ').trim().slice(0,120);
}
function isDownloadControl(el){
 if(!el||!el.closest)return false;
 const label=humanLabel(el);
 return /下载|保存原图|download|save image|jpeg|jpg/i.test(label)||el.hasAttribute('download')||/download/i.test(el.getAttribute('href')||'');
}
function detectState(){
 if(Date.now()>watchUntil){clearInterval(watchTimer);watchTimer=null;return;}
 const nodes=document.querySelectorAll('button,a,[role="button"]');
 let state='';
 for(let i=0;i<Math.min(nodes.length,700);i++){
  const t=humanLabel(nodes[i]);
  if(/准备下载|正在准备|生成下载|下载准备/.test(t)){state='准备下载';break;}
  if(/^重试$|下载失败|请求超时|下载超时/.test(t)){state='重试／下载失败';break;}
  if(/正在下载|下载中/.test(t)){state='网页显示下载中';break;}
 }
 if(state&&(state!==lastStatus||Date.now()-lastReport>5000)){lastStatus=state;lastReport=Date.now();send('siteState',{value:state});}
}
document.addEventListener('click',event=>{
 const target=event.target?.nodeType===1?event.target:event.target?.parentElement;
 if(!target?.closest)return;
 let el=target.closest('button,a,[role="button"],[download],[data-action*="download"],[class*="download"],[class*="Download"],[title*="下载"]');
 // Some painting sites use a styled div/span instead of a native button.
 if(!el){const label=humanLabel(target);if(label.length<=40&&/下载|download/i.test(label))el=target;
  else if(target.parentElement){const parentLabel=humanLabel(target.parentElement);if(parentLabel.length<=40&&/下载|download/i.test(parentLabel))el=target.parentElement;}}
 if(!isDownloadControl(el))return;
 const now=Date.now();if(now-lastIntent<700)return;
 lastIntent=now;lastStatus='';lastReport=0;watchUntil=now+120000;
 send('downloadIntent',{label:humanLabel(el)});
 if(watchTimer)clearInterval(watchTimer);
 watchTimer=setInterval(detectState,900);
 setTimeout(detectState,600);
},true);
// Accept only carefully filtered metadata emitted from the normal favorites page.
window.addEventListener('message',event=>{
 if(event.source!==window||event.origin!==location.origin||event.data?.tag!=='art-ref-favorites-v038')return;
 const m=event.data;
 if(!/\/resource_favorites/.test(location.pathname)||!Array.isArray(m.rows))return;
 const rows=m.rows.filter(x=>/^[a-f0-9]{24}$/i.test(x.resourceId||'')).slice(0,2500);
 if(rows.length)send('favoritesBatch',{albumId:m.albumId,total:m.total,count:m.count,rows,kind:m.kind});
});
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
 if(msg?.type==='ping'){reply({ok:true,page:location.href});return;}
 if(msg?.type==='scanFavorites'){
  if(window.top!==window){reply({ok:false,error:'仅支持主框架'});return;}
  const works=new Map();
  const patterns=[/\/view\/([a-z0-9_-]+)\/([0-9a-f]{24})(?:[/?#]|$)/i,/\/resource\/([0-9a-f]{24})(?:[/?#]|$)/i];
  function add(raw,label){
   if(typeof raw!=='string'||raw.length>600)return;
   const hit=patterns.map(p=>raw.match(p)).find(Boolean);
   if(!hit)return;
   const id=hit[hit.length-1].toLowerCase();
   // Only accept an actual view URL; raw DOM identifiers are diagnostic only.
   const url=hit.length===3?'https://g2.ltfc.net/view/'+hit[1]+'/'+id:'';
   if(!url)return;
   if(!works.has(id)||(!works.get(id).title&&label))works.set(id,{id,title:String(label||'').replace(/\s+/g,' ').slice(0,140),url});
  }
  const anchors=[...document.querySelectorAll('a[href]')];
  for(const a of anchors){
   const raw=a.getAttribute('href')||'';
   add(raw,humanLabel(a)||a.querySelector('img')?.alt||'');
  }
  // SPA cards can navigate through onclick/data attributes without an <a>.
  const cards=[...document.querySelectorAll('[data-id],[data-resource-id],[data-href],[data-url],[onclick],[role="link"],img')].slice(0,3000);
  const attrCounts={};const samples=[];
  for(const el of cards){
   const possible=[el,...(el.closest? [el.parentElement,el.parentElement?.parentElement]:[])].filter(Boolean);
   for(const node of possible){
    for(const key of ['href','data-href','data-url','onclick']){
     const value=node.getAttribute?.(key);if(value)add(value,humanLabel(node).slice(0,120));
    }
    for(const attr of node.attributes||[]){if(/^data-/.test(attr.name)&&samples.length<12)attrCounts[attr.name]=(attrCounts[attr.name]||0)+1;}
   }
  }
  // Vue/React favorites tiles may not contain hyperlinks at all. Extract visible
  // numbered titles as UNRESOLVED candidates, not fictitious artwork IDs.
  const candidateTitles=[];
  const titlesSeen=new Set();
  for(const node of document.querySelectorAll('div,span,p,h2,h3,h4,a')){
   if(node.children.length>3)continue;
   const label=(node.innerText||'').trim().replace(/\s+/g,' ');
   const m=label.match(/^(\d{1,4})[.、．]\s*(.{2,65})$/);
   if(!m||m[2].length>65||titlesSeen.has(m[1]+':'+m[2]))continue;
   if(node.getBoundingClientRect().width===0)continue;
   titlesSeen.add(m[1]+':'+m[2]);
   candidateTitles.push({position:Number(m[1]),title:m[2]});
   if(candidateTitles.length>=100)break;
  }
  const text=(document.body?.innerText||'').slice(0,2000);
  const hints=[...document.querySelectorAll('a,button,[role=button]')].map(x=>humanLabel(x)).filter(x=>/^(下一页|下页|更多|加载更多|末页|第\d+页)$/.test(x)).slice(0,12);
  const imageCount=document.querySelectorAll('img').length;
  const hrefSamples=anchors.map(x=>x.getAttribute('href')||'').filter(Boolean).filter(x=>!/^javascript:/.test(x)).slice(0,10).map(x=>{try{const u=new URL(x,location.href);return u.origin===location.origin?u.pathname.slice(0,75):'[other origin]';}catch{return '[invalid]';}});
  reply({ok:true,page:location.href,count:works.size,works:[...works.values()],paginationHints:hints,pageHasFavorites:/我的收藏|收藏夹|收藏和画单|我的画单|收藏作品/.test(text),candidateTitles,diagnostics:{images:imageCount,anchors:anchors.length,cards:cards.length,hrefSamples,attributeNames:Object.keys(attrCounts).slice(0,16),readyState:document.readyState}});
  return;
 }
});
// Observe real user card navigation to learn source work IDs. No automatic clicks.
document.addEventListener('click',event=>{
 if(!/resource_favorites|search_favorites|sort_favorites/i.test(location.href))return;
 let node=event.target?.nodeType===1?event.target:event.target?.parentElement;
 const candidates=[];
 for(let i=0;i<8&&node;i++,node=node.parentElement){
  const t=(node.innerText||'').replace(/\s+/g,' ').trim();
  const m=t.match(/(?:^|\s)(\d{1,4})[.、．]\s*(.{2,70})/);
  if(m)candidates.push({position:Number(m[1]),title:m[2].slice(0,90)});
 }
 if(!candidates.length)return;
 const c=candidates.sort((a,b)=>a.title.length-b.title.length)[0];
 send('favoriteClick',{position:c.position,title:c.title,page:location.href});
},true);
// Notify the background on SPA history changes as well as full navigation.
// This is only URL observation; we never click, fetch images or bypass access checks.
let lastObservedUrl=location.href;
function reportNavigation(){
 const now=location.href;
 if(now===lastObservedUrl)return;
 lastObservedUrl=now;
 if(/\/(?:albumView|view)\//i.test(now))send('favoriteNavigation',{url:now});
}
for(const kind of ['pushState','replaceState']){
 const original=history[kind];
 history[kind]=function(...args){const result=original.apply(this,args);queueMicrotask(reportNavigation);return result;};
}
window.addEventListener('popstate',reportNavigation);
setInterval(reportNavigation,900);
send('siteReady');

}

'use strict';
const $=id=>document.getElementById(id);
const ts=t=>t?new Date(t).toLocaleTimeString('zh-CN',{hour12:false}):'';
const bytes=n=>Number(n)>0?(n/1048576).toFixed(2)+' MB':'未知';
let copyText='';
async function connectContent(tabId){
 try{const r=await chrome.tabs.sendMessage(tabId,{type:'ping'});if(r?.ok)return true;}catch(e){}
 // Recover tabs opened before the extension was installed/reloaded.
 try{
  await chrome.scripting.executeScript({target:{tabId,allFrames:false},files:['content.js']});
  const r=await chrome.tabs.sendMessage(tabId,{type:'ping'});
  return Boolean(r?.ok);
 }catch(e){throw Error('网页连接失败：'+e.message+'。请确认扩展有 ltfc.net 网站访问权限，并刷新网站页面。');}
}

async function refresh(){
 let isConnected=false;
 const tabs=await chrome.tabs.query({active:true,currentWindow:true});
 const tab=tabs[0];
 const correct=Boolean(tab?.url&&/^https:\/\/(?:[a-z0-9-]+\.)*ltfc\.net\//i.test(tab.url));
 if(correct){try{isConnected=await connectContent(tab.id);}catch(e){$('connection').textContent='⚠ '+e.message;}}
 if(isConnected)$('connection').textContent='✓ 当前中华珍宝馆标签页已连接';else if(!correct)$('connection').textContent='请先切换到中华珍宝馆作品标签页，再点刷新诊断';
 const {attempt,siteState,download}=await chrome.storage.local.get(['attempt','siteState','download']);
 if(!attempt){$('attempt').textContent='还没有记录到网站下载按钮点击';}
 else $('attempt').textContent=ts(attempt.time)+' · '+(attempt.label||'下载')+'\n'+(siteState?.value||'已点击网站下载按钮')+'\n'+(attempt.page||'');
 if(!download){$('download').textContent='浏览器尚未产生可匹配的下载任务（不代表收到0字节）';}
 else{
  let d=download;
  try{const matches=await chrome.downloads.search({id:download.id});if(matches.length)d={...download,...matches[0]};}catch(e){}
  const labels={in_progress:'下载进行中',complete:'下载已完成',interrupted:'下载已中断'};
  $('download').textContent=(labels[d.state]||d.state)+' · '+ts(d.started||attempt?.time)+'\n'+(d.filename||'文件名未确定')+'\n已接收 '+bytes(d.bytesReceived)+' / 总大小 '+bytes(d.totalBytes)+'\n'+(d.relation||'')+(d.error?'\n错误：'+d.error:'');
 }
 let diagnosis='';
 if(download?.state==='complete')diagnosis='浏览器已下载完成；可以打开上传工作台选择该原始 JPEG，完成云端 SHA-256 校验。';
 else if(download?.state==='interrupted')diagnosis='浏览器曾创建下载任务，但任务中断。请打开下载记录查看浏览器报告的错误。';
 else if(download)diagnosis='已出现浏览器下载任务，请查看下载记录中的进度。';
 else if(attempt){diagnosis='网站下载按钮已点击，但没有检测到浏览器下载事件。'+(siteState?.value?.includes('重试')?'网页已显示失败/重试；问题在交付浏览器下载之前。':siteState?.value?.includes('准备')?'网页仍显示“准备下载”；尚不能判定底层 HTTP 原因。':'若页面一直没有响应，请查看网站提示；无法仅凭此记录确定服务器原因。');}
 else diagnosis='先刷新作品页，再点击网站正常下载按钮，然后回来点“刷新诊断”。';
 $('diagnosis').textContent=diagnosis;
 copyText=['采集助手 v0.9.7', '网页监听：'+$('connection').textContent,'网页按钮：'+$('attempt').textContent,'浏览器下载：'+$('download').textContent,'结论：'+diagnosis].join('\n\n');
}
function send(cmd){return chrome.runtime.sendMessage({type:cmd});}
$('refresh').onclick=refresh;
$('openQueue').onclick=()=>chrome.tabs.create({url:'https://zhengjialai7-a11y.github.io/ancient-stove-reference/queue.html'});
$('openReview').onclick=()=>chrome.tabs.create({url:'https://zhengjialai7-a11y.github.io/ancient-stove-reference/queue.html#review'});
$('downloads').onclick=()=>send('openDownloads');
$('openImporter').onclick=()=>send('openImporter');
$('clear').onclick=async()=>{await send('clear');await refresh();};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(copyText);$('copy').textContent='已复制';}catch(e){$('copy').textContent='复制失败';}};
refresh().catch(e=>{$('diagnosis').textContent='读取失败：'+e.message;});

let gathered=[];
async function scanFavorites(){
 const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
 if(!tab?.url||!/^https:\/\/(?:[a-z0-9-]+\.)*ltfc\.net\//i.test(tab.url))throw Error('先打开中华珍宝馆的收藏夹页面');
 await connectContent(tab.id);
 const out=await chrome.tabs.sendMessage(tab.id,{type:'scanFavorites'});
 if(!out?.ok)throw Error(out?.error||'页面未连接，请刷新后重试');
 let bulk=null,bulkError='';
 try{
  const js=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['bulk_probe.js']});
  bulk=js?.[0]?.result||null;
 }catch(e){bulkError=String(e.message||e);}
 if(bulk?.extracted?.length){
  const {favoriteBulkWorks=[]}=await chrome.storage.local.get('favoriteBulkWorks');
  const known=new Map(favoriteBulkWorks.map(x=>[x.page+'|'+x.position+'|'+x.title,x]));
  for(const x of bulk.extracted){const row={...x,page:out.page,detectedAt:new Date().toISOString()};const key=row.page+'|'+row.position+'|'+row.title;
   if(known.has(key)&&known.get(key).sourceId!==row.sourceId){known.delete(key);continue;}
   known.set(key,row);
  }
  await chrome.storage.local.set({favoriteBulkWorks:[...known.values()]});
 }
 const {favoriteResponseSnapshot}=await chrome.storage.local.get('favoriteResponseSnapshot');
 const snap=favoriteResponseSnapshot;
 $('responseStatus').textContent=snap
  ?'收藏夹接口已捕获：'+snap.rows.length+' 条真实 resource.id；接口总数 '+(snap.total??'未提供')+'；本次返回记录 '+snap.loadedCount+'；完整度 '+(snap.total===snap.rows.length?'一致':'尚需验证分页或加载')+'。\n来源：'+snap.albumId+'；时间 '+snap.collectedAt
  :'尚未捕获收藏夹列表响应。请在打开本插件之前刷新「我的收藏」网页，再点扫描。';
 const {favoriteClickResult}=await chrome.storage.local.get('favoriteClickResult');
 const clickHint=favoriteClickResult&&Date.now()-favoriteClickResult.capturedAt<3600000
 ?'\n最近收藏卡片点击：'+favoriteClickResult.position+'. '+favoriteClickResult.title+' → '+favoriteClickResult.url+'\n跳转类型：'+(favoriteClickResult.kind||'未知')+'；albumId：'+(favoriteClickResult.albumId||'—')+'；sourceId：'+(favoriteClickResult.sourceId||'—')+'；activeIndex：'+(favoriteClickResult.activeIndex||'—')
 :'\n下一步：在收藏夹正常点击一幅作品进入详情页，再返回收藏夹，重新扫描查看跳转链接。';
 const {favoriteBulkWorks=[]}=await chrome.storage.local.get('favoriteBulkWorks');
 const {favoriteMappedWorks=[]}=await chrome.storage.local.get('favoriteMappedWorks');
 const {favoriteWorks=[]}=await chrome.storage.local.get('favoriteWorks');
 const map=new Map(favoriteWorks.map(x=>[x.id,x]));
 for(const x of out.works)map.set(x.id,{...map.get(x.id),...x});
 gathered=[...map.values()];
 await chrome.storage.local.set({favoriteWorks:gathered});
 $('favorites').textContent='当前页直接识别 '+out.count+' 幅；已验证 albumView 对应 '+favoriteMappedWorks.length+' 幅；普通 view 累计 '+gathered.length+' 幅。\n页面：'+out.page+'\n收藏夹特征：'+(out.pageHasFavorites?'可见':'未确认，注意不要误扫普通作品页')+'\n翻页提示：'+(out.paginationHints.join('、')||'未检测到')+'\n页面诊断：图片 '+(out.diagnostics?.images??'?')+'、链接 '+(out.diagnostics?.anchors??'?')+'、卡片候选 '+(out.diagnostics?.cards??'?')+'\n链接样例：'+(out.diagnostics?.hrefSamples||[]).join(' | ')+'\n数据字段：'+(out.diagnostics?.attributeNames||[]).join('、')+'\n页面可见标题候选（未取得作品ID，不计入已采集）：'+(out.candidateTitles?.length||0)+'\n'+(out.candidateTitles||[]).slice(0,15).map(x=>x.position+'. '+x.title).join(' | ')+clickHint+'\n批量卡片检查：'+(bulk?.extracted?.length??0)+'条唯一候选；歧义 '+(bulk?.ambiguous?.length??0)+' 条'+(bulkError?'；运行失败：'+bulkError:'')+'；累计批量候选 '+favoriteBulkWorks.length+' 条（未经逐幅下载验证）'+'\n批量候选样例：'+(bulk?.extracted||[]).slice(0,7).map(x=>x.position+'. '+x.title+' / '+x.sourceId).join(' | ')+'\n最近验证作品：\n'+favoriteMappedWorks.slice(-8).map(x=>x.position+'. '+x.title+' / sourceId='+x.sourceId).join('\n')+'\n本次作品：\n'+out.works.slice(0,7).map(x=>(x.title||'未识别标题')+' / '+x.id).join('\n')+(out.works.length>7?'\n…':'');
}
$('scanFavorites').onclick=()=>scanFavorites().catch(e=>{$('favorites').textContent='扫描失败：'+e.message;});
$('exportFavorites').onclick=async()=>{
 const {favoriteWorks=[],favoriteMappedWorks=[],favoriteBulkWorks=[],favoriteResponseSnapshot=null}=await chrome.storage.local.get(['favoriteWorks','favoriteMappedWorks','favoriteBulkWorks','favoriteResponseSnapshot']);
 if(!favoriteWorks.length&&!favoriteMappedWorks.length&&!favoriteBulkWorks.length&&!favoriteResponseSnapshot?.rows?.length){$('favorites').textContent='还没有已收集的作品，请先扫描收藏夹。';return;}
 const blob=new Blob([JSON.stringify({version:2,capturedAt:new Date().toISOString(),confirmedMappings:favoriteMappedWorks.length,confirmedByClick:favoriteMappedWorks,bulkCandidates:favoriteBulkWorks,observedFavorites:favoriteResponseSnapshot,normalViewWorks:favoriteWorks,notes:'sourceId is not a SUHA view ID. Unconfirmed title candidates are not downloadable records.'},null,2)],{type:'application/json'});
 const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='中华珍宝馆_收藏作品清单.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
};

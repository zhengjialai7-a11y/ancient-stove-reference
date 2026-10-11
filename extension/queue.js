"use strict";
const $=id=>document.getElementById(id);
const KEY='favoriteQueueV04',ALLOWED=new Set(['pending','needs_review','downloaded','uploaded','failed','existing']);
let queue=[],page=0,batchIds=new Set();const PAGE_SIZE=35;
const say=t=>$('msg').textContent=t;
const goodId=s=>/^[a-f0-9]{24}$/i.test(s||'');
const workKey=r=>r.sourceType+':'+r.sourceId;
function normalize(record,idx){
 const sourceId=String(record.source_id||record.sourceId||'').trim().toLowerCase(),sourceType=String(record.source_type||record.sourceType||'').trim().toUpperCase();
 if(!goodId(sourceId)||!/^[A-Z0-9_]{3,20}$/.test(sourceType))return null;
 const title=String(record.title||'').trim().slice(0,150),author=String(record.author||'').trim().slice(0,100);
 const existing=record.status==='already_in_supabase'||record.status==='existing'||record.status==='in_supabase'||record.status==='already_imported_by_source';
 const status=ALLOWED.has(record.status)?record.status:existing?'existing':sourceType==='SUHA'?'pending':'needs_review';
 return {sourceId,sourceType,lineId:String(record.favorite_line_id||record.lineId||'').trim(),position:Number(record.original_position??record.position)||null,joinedAt:record.joined_at||record.joinTime||null,title,author,status:sourceType!=='SUHA'&&status==='pending'?'needs_review':status,notes:String(record.notes||'').slice(0,400),verifiedHash:String(record.verifiedHash||'').trim(),downloadFilename:String(record.downloadFilename||'').slice(0,160),order:idx};
}
function parseJSON(obj){
 const data=Array.isArray(obj)?obj:obj.items||obj.observedFavorites?.rows||obj.rows;
 if(!Array.isArray(data))throw Error('JSON中找不到items或observedFavorites.rows数组');
 const parsed=data.map(normalize).filter(Boolean);if(!parsed.length)throw Error('没有找到含真实sourceId/sourceType的有效作品');
 const unique=new Map(),dupes=[];
 for(const row of parsed){const key=workKey(row);if(unique.has(key)){dupes.push(row);continue;}unique.set(key,row);}
 return {items:[...unique.values()],invalid:data.length-parsed.length,duplicate:dupes.length,total:obj.reportedTotal||obj.observedFavorites?.total||null};
}
async function save(){await chrome.storage.local.set({[KEY]:{version:4,updatedAt:new Date().toISOString(),items:queue}});}
async function importData(obj){
 const parsed=parseJSON(obj),prior=new Map(queue.map(x=>[workKey(x),x]));
 queue=parsed.items.map(row=>{const previous=prior.get(workKey(row));return previous?{...row,status:previous.status,notes:previous.notes,title:previous.title||row.title,author:previous.author||row.author,verifiedHash:previous.verifiedHash,downloadFilename:previous.downloadFilename}:row;});
 batchIds=new Set();page=0;await save();render();
 say('已导入 '+queue.length+' 个不同来源作品；无效记录 '+parsed.invalid+'，重复 '+parsed.duplicate+'。'+(parsed.total&&parsed.total!==parsed.items.length?'接口报告总数 '+parsed.total+'，请核对：列表并未全部取得。':'')+' 已有进度按来源 ID 自动保留。');
}
function stateLabel(s){return ({pending:'待处理',needs_review:'来源待确认',downloaded:'已下载待上传',uploaded:'已核验入库',failed:'失败待重试',existing:'已在库'})[s]||s;}
function allFiltered(){const filter=$('filter').value,s=$('search').value.trim().toLowerCase();return queue.filter(r=>(filter==='all'||r.status===filter)&&(!s||[r.sourceId,r.title,r.author].some(v=>String(v).toLowerCase().includes(s))));}
function el(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
function btn(label,fn){const b=el('button',label);b.type='button';b.onclick=fn;return b;}
function openSource(row){if(row.sourceType!=='SUHA'){say('该来源类型为 '+row.sourceType+'，尚未验证普通作品页 URL，不能随意拼接。请从收藏夹正常打开。');return;}
 chrome.tabs.create({url:'https://g2.ltfc.net/view/SUHA/'+row.sourceId});}
function openImporter(row){const url='https://zhengjialai7-a11y.github.io/ancient-stove-reference/importer.html?source_url='+encodeURIComponent('https://g2.ltfc.net/view/'+row.sourceType+'/'+row.sourceId);chrome.tabs.create({url});}
async function update(row,mode){if(mode==='uploaded'){
  const value=prompt('请粘贴工作台已验证的母图 SHA-256（64位）。没有校验结果请取消：',row.verifiedHash||'');
  if(value===null)return;if(!/^[a-f0-9]{64}$/i.test(value.trim())){say('必须先完成工作台的 SHA-256 校验才能标记为已入库。');return;}
  row.verifiedHash=value.trim().toLowerCase();
 } else if(mode==='downloaded'){
  const filename=prompt('请输入浏览器已成功下载的 JPEG 文件名（非空）。上传还需在工作台完成：',row.downloadFilename||'');if(filename===null)return;if(!/\.jpe?g$/i.test(filename.trim())){say('仅确认浏览器已完成的 JPEG 下载；请填写 .jpg/.jpeg 文件名。');return;}
  row.downloadFilename=filename.trim();
 } else if(mode==='failed'){
  const note=prompt('记录本次失败原因（便于继续处理）：',row.notes||'');if(note===null)return;row.notes=note.slice(0,400);
 }
 row.status=mode;await save();render();
}
function render(){
 const count=s=>queue.filter(x=>x.status===s).length;
 const stat=$('stats');stat.replaceChildren();
 [['收藏来源',queue.length],['待处理',count('pending')],['特殊类型待确认',count('needs_review')],['已下载待上传',count('downloaded')],['已核验入库',count('uploaded')],['已有母图',count('existing')],['失败待重试',count('failed')]].forEach(([label,num])=>{const c=el('div');c.className='stat';c.append(el('span',label),el('strong',String(num)));stat.append(c);});
 const rows=allFiltered(),pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));page=Math.min(Math.max(0,page),pages-1);$('pageStats').textContent='共 '+rows.length+' 条 · 第 '+(page+1)+' / '+pages+' 页';
 const body=$('tbody');body.replaceChildren();for(const r of rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE)){
  const tr=el('tr');if(batchIds.has(workKey(r)))tr.style.background='#f4ecd9';
  tr.append(el('td',String(r.order+1)),el('td',r.sourceType),el('td',r.sourceId));
  const info=el('td',r.title||'作品名称待补充');if(r.author)info.append(el('div',r.author));tr.append(info);
  const status=el('td',stateLabel(r.status));status.className='status';tr.append(status);
  const actions=el('td');actions.style.minWidth='350px';
  const buttons=el('div');buttons.className='row';buttons.append(btn('打开作品',()=>openSource(r)),btn('上传工作台',()=>openImporter(r)));
  const statusSelect=el('select');statusSelect.className='compact';for(const st of ['pending','needs_review','downloaded','uploaded','failed','existing']){const o=el('option',stateLabel(st));o.value=st;statusSelect.add(o);}statusSelect.value=r.status;statusSelect.onchange=async()=>{const v=statusSelect.value;await update(r,v);};buttons.append(statusSelect);
  buttons.append(btn('编辑信息',async()=>{const title=prompt('作品名称（没有可留空）',r.title||'');if(title===null)return;const author=prompt('作者（没有可留空）',r.author||'');if(author===null)return;r.title=title.trim().slice(0,150);r.author=author.trim().slice(0,100);await save();render();}));
  actions.append(buttons);if(r.notes)actions.append(el('div','备注：'+r.notes));tr.append(actions);body.append(tr);
 }
 $('prev').disabled=page===0;$('next').disabled=page>=pages-1;
 $('batchStatus').textContent=batchIds.size?'当前批次 '+batchIds.size+' 条：'+[...batchIds].slice(0,8).join('、')+(batchIds.size>8?'…':''):'尚未选择批次';
}
$('jsonFile').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>8*1024*1024)throw Error('文件超过8MB');await importData(JSON.parse(await file.text()));}catch(err){say('导入失败：'+err.message);}});
$('loadObserved').onclick=async()=>{try{const {favoriteResponseSnapshot}=await chrome.storage.local.get('favoriteResponseSnapshot');if(!favoriteResponseSnapshot?.rows)throw Error('尚无 v0.3.8 捕获的完整收藏数据；请先打开收藏夹并刷新页面');await importData({observedFavorites:favoriteResponseSnapshot});}catch(e){say(e.message);}};
$('filter').onchange=()=>{page=0;render();};$('search').oninput=()=>{page=0;render();};$('prev').onclick=()=>{page--;render();};$('next').onclick=()=>{page++;render();};
$('nextBatch').onclick=()=>{const n=Number($('batch').value);const candidates=queue.filter(r=>r.status==='pending'||r.status==='failed').slice(0,n);batchIds=new Set(candidates.map(workKey));page=0;$('filter').value='all';render();say(candidates.length?'已选出 '+candidates.length+' 条待处理作品。请逐条打开作品，在网站内合法下载并上传核验。':'没有可处理的待处理项。');};
function exportJson(items,name){const blob=new Blob([JSON.stringify({version:4,albumId:'66c1fe7d63ccfe1a4fd92ff2',updatedAt:new Date().toISOString(),items},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
$('export').onclick=()=>exportJson(queue,'中华珍宝馆_收藏采集队列_含进度.json');$('exportBatch').onclick=()=>exportJson(queue.filter(x=>batchIds.has(workKey(x))),'中华珍宝馆_本批次.json');
$('reset').onclick=async()=>{if(!confirm('仅清除本浏览器保存的队列和进度，不会删除导出文件或 Supabase 母图。确认吗？'))return;queue=[];batchIds.clear();await chrome.storage.local.remove(KEY);render();say('本地队列已清除。可通过之前导出的 JSON 恢复。');};
(async()=>{const data=await chrome.storage.local.get(KEY);queue=Array.isArray(data[KEY]?.items)?data[KEY].items:[];render();if(queue.length)say('已从浏览器本地恢复 '+queue.length+' 条任务及保存的状态。');else say('请导入718条 JSON，或点击“读取插件已捕获的收藏”。');})().catch(e=>say('初始化失败：'+e.message));

$('openCloud').onclick=()=>chrome.tabs.create({url:'https://zhengjialai7-a11y.github.io/ancient-stove-reference/queue.html'});

'use strict';
const $=id=>document.getElementById(id),C=CaptureCommon;
const db=supabase.createClient('https://otaokoencpoanxjjuqzv.supabase.co','sb_publishable_hA9UHbP834axMbvdRRbwyA_4dUTU2-B');
let user=null,queue=[],workspace=[],projectData=[],masterData=[],cropData=[],imports=[],newIds=new Set(),newLabel='最近清单新增',newSelection=false,page=0,batchIds=new Set(),channel=null,refreshTimer=null,loading=false,rerun=false,authEpoch=0,importing=false;
const PAGE_SIZE=35,say=t=>$('msg').textContent=t;
async function refreshOriginalStorage(epoch=authEpoch){
 const node=$('originalStorageState');if(!node||!user)return;
 try{const {data,error}=await db.rpc('get_original_storage_config');if(epoch!==authEpoch)return;if(error)throw error;node.textContent=data?.enabled&&data?.provider==='r2'?'新母图存储：R2 · 已接入':'新母图存储：Supabase · R2 待连接（大文件暂不上传）';}
 catch(e){if(epoch===authEpoch)node.textContent='母图存储配置未确认：'+String(e.message||e).slice(0,120);}
}
function el(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
function btn(label,fn){const b=el('button',label);b.onclick=()=>Promise.resolve().then(fn).catch(e=>say(e.message));return b;}
async function loadAll(){
 if(!user)return;if(loading){rerun=true;return;}loading=true;const epoch=authEpoch;
 try{const all=[];for(let start=0;;start+=500){const {data,error}=await db.from('reference_capture_status').select('*').order('queue_order').order('id').range(start,start+499);if(error)throw error;all.push(...data);if(data.length<500)break;}
 const snapshot=await Promise.all([readTable('artwork_projects','id,title,author,era,source_url'),readTable('artwork_masters','id,project_id,original_filename,original_width,original_height,original_bytes,sha256,verified_sha256,verified_at'),readTable('artwork_crops','id,master_id,status'),readImports()]);
 if(epoch!==authEpoch)return;queue=all;[projectData,masterData,cropData,imports]=snapshot;workspace=C.workspaceRows(queue,projectData,masterData,cropData);
 if(!newSelection)newIds=new Set(imports[0]?.new_task_ids||[]);
 render();renderImports();refreshOriginalStorage(epoch);$('cloudState').textContent='已自动加载云端 '+queue.length+' 条收藏；下次登录无需重新提交 JSON。';$('syncState').textContent='已同步 '+new Date().toLocaleTimeString('zh-CN');window.dispatchEvent?.(new Event('art-capture-queue-updated'));return true;
 }catch(e){if(epoch===authEpoch)$('syncState').textContent='同步失败，当前数据可能过期：'+e.message;}
 finally{loading=false;if(rerun){rerun=false;scheduleRefresh();}}
}
async function readTable(table,columns){const rows=[];for(let start=0;;start+=500){const {data,error}=await db.from(table).select(columns).order('id').range(start,start+499);if(error)throw error;rows.push(...data);if(data.length<500)return rows;}}
async function readImports(){const {data,error}=await db.from('reference_capture_imports').select('id,file_name,item_count,added_count,existing_count,invalid_count,duplicate_count,new_task_ids,created_at').order('created_at',{ascending:false}).order('id').limit(20);if(error)throw error;return data;}
function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(loadAll,250);}
function subscribe(){
 if(channel)db.removeChannel(channel);if(!user)return;
 channel=db.channel('capture-workbench-'+user.id);
 for(const table of ['reference_capture_tasks','reference_capture_imports','artwork_masters','artwork_crops','artwork_projects'])channel.on('postgres_changes',{event:'*',schema:'public',table},scheduleRefresh);
 channel.subscribe(status=>{if(status==='SUBSCRIBED')scheduleRefresh();else if(['CHANNEL_ERROR','TIMED_OUT'].includes(status))$('syncState').textContent='实时连接暂不可用，改用定期同步';});
}
async function patch(row,values){
 if(!user)throw Error('请先登录');
 const {data,error}=await db.from('reference_capture_tasks').update({...values,updated_at:new Date().toISOString()}).eq('id',row.id).select('id');
 if(error||!data?.length)throw Error(error?.message||'没有保存权限');await loadAll();
}
async function importData(obj,fileName='收藏清单.json'){
 if(!user)throw Error('请先登录');if(importing)throw Error('正在导入，请等待');importing=true;const epoch=authEpoch;
 $('jsonFile').disabled=true;$('loadObserved').disabled=true;say('正在保存收藏 JSON 并检查新增作品…');
 try{C.parseJSON(obj);
 const {data,error}=await db.rpc('import_reference_capture_json',{p_payload:obj,p_file_name:fileName});if(error)throw error;
 if(epoch!==authEpoch)return;
 newIds=new Set(data.new_task_ids||[]);newLabel='本次新增';newSelection=true;page=0;$('search').value='';$('filter').value=data.added_count?'new':'all';
 const synced=await loadAll();
 say((data.reused_archive?'这份 JSON 已归档，复用已有云端文件。':'收藏 JSON 已保存到云端。')+' 新增 '+data.added_count+' 条，已存在 '+data.existing_count+' 条，文件内重复 '+data.duplicate_count+' 条，无效 '+data.invalid_count+' 条。已有作品资料、母图关联和处理进度保持不变。'+(synced?'':' 列表正在同步，可点击刷新状态。'));
 }finally{importing=false;$('jsonFile').disabled=false;$('loadObserved').disabled=false;}
}
function allFiltered(){const f=$('filter').value,s=$('search').value.trim().toLowerCase();return [...workspace,...queue].filter(r=>(f==='all'||(f==='new'?newIds.has(r.id):f==='paused'?r.paused:f==='needs_review'?r.link_issue||r.live_status===f:r.live_status===f))&&(!s||[r.source_id,r.display_title,r.display_author,...(r.mismatched_files||[])].some(v=>String(v||'').toLowerCase().includes(s))));}
function renderImports(){
 const list=$('importHistory');list.replaceChildren();$('archiveCount').textContent=imports.length?'最近 '+imports.length+' 份云端清单':'尚无归档清单；导入后会自动保存';
 for(const record of imports){const row=el('div');row.className='archive';const info=el('div',record.file_name);
 info.append(el('div',new Date(record.created_at).toLocaleString('zh-CN')+' · 有效 '+record.item_count+' · 首次新增 '+record.added_count+' · 已存在 '+record.existing_count+' · 文件内重复 '+record.duplicate_count+' · 无效 '+record.invalid_count));
 const actions=el('div');actions.className='row';
 actions.append(btn('下载归档 JSON',async()=>{if(!user)throw Error('请先登录');const epoch=authEpoch;const {data,error}=await db.from('reference_capture_imports').select('payload,file_name').eq('id',record.id).single();if(error)throw error;if(epoch===authEpoch)downloadJSON(data.payload,data.file_name);}),btn('查看此清单新增',()=>{newIds=new Set(record.new_task_ids);newSelection=true;newLabel='此清单首次新增';$('filter').value='new';$('search').value='';page=0;render();say(record.file_name+'：首次新增 '+record.added_count+' 条。');}));
 row.append(info,actions);list.append(row);}
}
function render(){
 const option=$('filter').querySelector('option[value="new"]');option.textContent=newLabel+'（'+newIds.size+'）';$('showNew').textContent='查看'+newLabel+'（'+newIds.size+'）';$('showNew').disabled=!newIds.size;
 const stats=$('stats');stats.replaceChildren();for(const [label,n] of [['收藏来源',queue.length],['已有母图项目',new Set(masterData.map(m=>m.project_id||m.id)).size],['全部母图',masterData.length],['草稿待审核',cropData.filter(c=>c.status==='draft').length],['关联待确认',queue.filter(r=>r.live_status==='needs_review').length+workspace.length],['已暂停',queue.filter(r=>r.paused).length]]){const d=el('div');d.className='stat';d.append(el('span',label),el('strong',String(n)));stats.append(d);}
 $('workspaceNotice').textContent=workspace.length?'另有 '+workspace.length+' 个已上传项目尚未准确关联收藏来源，已在下方显示母图和裁切进度。核对原作链接后会自动合并到对应收藏任务。':'已有母图项目均已关联收藏任务。';
 const rows=allFiltered(),pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));page=Math.max(0,Math.min(page,pages-1));$('pageStats').textContent='共 '+rows.length+' 条 · 第 '+(page+1)+' / '+pages+' 页';const body=$('tbody');body.replaceChildren();
 for(const r of rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE)){
  const tr=el('tr');if(batchIds.has(r.id))tr.style.background='#f4ecd9';tr.append(el('td',r.workspace_only?'已上传':String(r.queue_order+1)),el('td',r.source_type),el('td',r.source_id));const info=el('td',r.display_title||'作品名称待补充');if(newIds.has(r.id)){const tag=el('span',newLabel);tag.className='new-tag';info.append(tag);}if(r.display_author)info.append(el('div',r.display_author));tr.append(info);
  const status=el('td',(r.paused?'已暂停 · ':'')+(C.labels[r.live_status]||r.live_status));status.className='status';status.append(el('div','母图 '+r.master_count+' · 已核验 '+r.verified_count+' · 草稿 '+r.draft_count+' · 已发布 '+r.published_count));
  const details=el('details'),summary=el('summary','母图详情');details.append(summary);for(const m of r.masters||[])details.append(el('div',(m.filename||m.id)+' · '+m.width+'×'+m.height+' · '+m.bytes+' 字节 · '+(m.verified?'SHA-256 已核验':'待回读核验')+' · SHA-256 '+m.sha256));if(r.master_count)status.append(details);tr.append(status);
  if(r.workspace_only){
   status.append(el('div','来源待关联：'+r.link_issue));const actions=el('td'),buttons=el('div');buttons.className='row';
   const link=el('a','打开母图工作台');link.href=C.importerURL(r);link.target='_blank';link.rel='noopener';
   const edit=el('a','核对来源与作品资料');edit.href=C.importerURL(r)+'&edit_project=1';edit.target='_blank';edit.rel='noopener';buttons.append(link,edit);actions.append(buttons);
   if(r.mismatched_files.length)actions.append(el('div','文件归属待核对：'+r.mismatched_files.join('、')));
   actions.append(el('div','下一步：'+(r.link_issue==='来源不在当前收藏清单'?'导入包含此作品的收藏清单，或继续在工作台处理':'核对并保存此项目的原作来源链接')));tr.append(actions);body.append(tr);continue;
  }
  const actions=el('td'),buttons=el('div');buttons.className='row';actions.style.minWidth='330px';
  if(['needs_review','failed'].includes(r.phase)||r.live_status==='needs_review'||r.resolved_master_id||r.link_issue)buttons.append(btn('集中处理此问题',()=>window.dispatchEvent(new CustomEvent('art-capture-review-open',{detail:{taskId:r.id}}))));
  if(r.source_type==='SUHA')buttons.append(btn(batchIds.has(r.id)?'移出本批':'加入本批',()=>{batchIds.has(r.id)?batchIds.delete(r.id):batchIds.add(r.id);render();}));
  buttons.append(btn('打开作品',()=>{if(!r.source_url)throw Error('特殊来源类型请从收藏夹正常打开，不猜测下载 URL');window.open(r.source_url,'_blank','noopener');}),btn(r.master_count?'打开母图工作台':'上传母图',()=>{window.open(C.importerURL(r),'_blank','noopener');}),btn(r.paused?'继续':'暂停',()=>patch(r,{paused:!r.paused})));
  const select=el('select');for(const s of ['pending','needs_review','downloaded','failed'])select.add(new Option(C.labels[s],s));select.value=r.phase;select.onchange=async()=>{try{let filename=r.download_filename,reason=r.failure_reason;if(select.value==='downloaded'){filename=prompt('填写已实际下载的原图文件名（此状态不代表云端核验）',filename||'');if(!filename?.trim()){render();return;}}if(select.value==='failed'){reason=prompt('记录失败原因',reason||'');if(reason===null){render();return;}}await patch(r,{phase:select.value,download_filename:filename,failure_reason:reason,last_checked_at:new Date().toISOString(),retry_count:r.retry_count+(select.value==='failed'?1:0)});}catch(e){say(e.message);render();}};
  if(!r.master_count)buttons.append(select);
  buttons.append(btn('编辑信息',async()=>{const title=prompt('作品名称',r.display_title||'');if(title===null)return;const author=prompt('作者',r.display_author||'');if(author===null)return;await patch(r,{title:title.trim().slice(0,180),author:author.trim().slice(0,120)});}));
  if(r.candidate_count>1&&!r.project_id){const choice=el('select');choice.add(new Option('确认关联项目…',''));for(const p of r.candidate_projects)choice.add(new Option(p.title,p.id));choice.onchange=()=>{if(choice.value&&confirm('确认这条来源记录对应「'+choice.selectedOptions[0].textContent+'」？'))patch(r,{project_id:choice.value}).catch(e=>say(e.message));};buttons.append(choice);}
  actions.append(buttons,el('div','下一步：'+C.nextAction(r)));if(r.failure_reason)actions.append(el('div','上次失败：'+r.failure_reason));if(r.notes)actions.append(el('div','备注：'+r.notes));tr.append(actions);body.append(tr);
 }
 $('prev').disabled=page===0;$('next').disabled=page>=pages-1;$('batchStatus').textContent=batchIds.size?'当前批次 '+batchIds.size+' 条':'尚未选择批次';
}
function downloadJSON(value,name){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function exportJSON(items,name){downloadJSON({version:6,items,workspace_projects:workspace},name);}
$('jsonFile').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>8*1024*1024)throw Error('文件超过 8MB');await importData(JSON.parse(await file.text()),file.name);}catch(e){say(e.message);}finally{e.target.value='';}};
$('loadObserved').onclick=()=>{
 const requestId=crypto.randomUUID();let timer;
 const receive=async e=>{if(e.source!==window||e.origin!==location.origin||e.data?.type!=='ART_CAPTURE_EXPORT'||e.data.requestId!==requestId)return;clearTimeout(timer);window.removeEventListener('message',receive);try{await importData(e.data.queue,'采集助手_收藏清单.json');}catch(e){say(e.message);}};
 window.addEventListener('message',receive);timer=setTimeout(()=>{window.removeEventListener('message',receive);say('未连接新版采集助手。可更新到 v0.5，或在旧队列导出带进度 JSON 后从这里导入。');},3000);
 window.postMessage({type:'ART_CAPTURE_REQUEST',requestId},location.origin);
};
$('refresh').onclick=loadAll;$('filter').onchange=()=>{page=0;render();};$('search').oninput=()=>{page=0;render();};$('prev').onclick=()=>{page--;render();};$('next').onclick=()=>{page++;render();};
$('showNew').onclick=()=>{$('filter').value='new';$('search').value='';page=0;render();};
$('clearBatch').onclick=()=>{batchIds.clear();render();say('已清空批次，可逐幅加入需要验收的作品。');};
$('nextBatch').onclick=()=>{const visible=new Set(allFiltered().map(r=>r.id));batchIds=new Set(queue.filter(r=>visible.has(r.id)&&!r.paused&&!r.master_count&&['pending','failed'].includes(r.live_status)).slice(0,Number($('batch').value)).map(r=>r.id));page=0;render();say('已从当前筛选选择 '+batchIds.size+' 条待处理作品；已有母图的作品不会再次进入下载批次。');};
$('export').onclick=()=>exportJSON(queue,'中华珍宝馆_收藏采集队列_云端进度.json');$('exportBatch').onclick=()=>exportJSON(queue.filter(r=>batchIds.has(r.id)),'中华珍宝馆_本批次.json');
async function refreshAuth(){const {data:{session}}=await db.auth.getSession();const nextUser=session?.user||null;if(user?.id!==nextUser?.id){authEpoch++;queue=[];workspace=[];projectData=[];masterData=[];cropData=[];imports=[];batchIds.clear();newIds.clear();newSelection=false;newLabel='最近清单新增';page=0;$('filter').value='all';say('新收藏清单可继续导入；云端会按来源类型和作品 ID 只追加新增作品。');$('cloudState').textContent='正在加载云端收藏…';render();renderImports();}user=nextUser;$('authState').textContent=user?'已登录：'+user.email:'未登录';$('loginPanel').hidden=!!user;$('workPanel').hidden=!user;$('logout').hidden=!user;subscribe();if(user)await loadAll();else{$('cloudState').textContent='登录后自动加载云端收藏';$('syncState').textContent='';}}
$('login').onclick=async()=>{const {error}=await db.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});if(error)$('loginMsg').textContent='登录失败：'+error.message;else{$('password').value='';await refreshAuth();}};
$('logout').onclick=()=>db.auth.signOut();db.auth.onAuthStateChange(()=>setTimeout(refreshAuth,0));
window.addEventListener('focus',scheduleRefresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleRefresh();});setInterval(()=>{if(!document.hidden&&user)scheduleRefresh();},15000);
refreshAuth().catch(e=>say('初始化失败：'+e.message));

'use strict';
const $=id=>document.getElementById(id),C=CaptureCommon;
const db=supabase.createClient('https://otaokoencpoanxjjuqzv.supabase.co','sb_publishable_hA9UHbP834axMbvdRRbwyA_4dUTU2-B');
let user=null,queue=[],page=0,batchIds=new Set(),channel=null,refreshTimer=null,loading=false,rerun=false,authEpoch=0,importing=false;
const PAGE_SIZE=35,say=t=>$('msg').textContent=t,key=r=>r.source_type+':'+r.source_id;
function el(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
function btn(label,fn){const b=el('button',label);b.onclick=()=>Promise.resolve().then(fn).catch(e=>say(e.message));return b;}
async function loadAll(){
 if(!user)return;if(loading){rerun=true;return;}loading=true;const epoch=authEpoch;
 try{const all=[];for(let start=0;;start+=500){const {data,error}=await db.from('reference_capture_status').select('*').order('queue_order').order('id').range(start,start+499);if(error)throw error;all.push(...data);if(data.length<500)break;}
 if(epoch!==authEpoch)return;queue=all;render();$('syncState').textContent='已同步 '+new Date().toLocaleTimeString('zh-CN');
 }catch(e){if(epoch===authEpoch)$('syncState').textContent='同步失败，当前数据可能过期：'+e.message;}
 finally{loading=false;if(rerun){rerun=false;scheduleRefresh();}}
}
function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(loadAll,250);}
function subscribe(){
 if(channel)db.removeChannel(channel);if(!user)return;
 channel=db.channel('capture-workbench-'+user.id);
 for(const table of ['reference_capture_tasks','artwork_masters','artwork_crops','artwork_projects'])channel.on('postgres_changes',{event:'*',schema:'public',table},scheduleRefresh);
 channel.subscribe(status=>{if(status==='SUBSCRIBED')scheduleRefresh();else if(['CHANNEL_ERROR','TIMED_OUT'].includes(status))$('syncState').textContent='实时连接暂不可用，改用定期同步';});
}
async function patch(row,values){
 if(!user)throw Error('请先登录');
 const {data,error}=await db.from('reference_capture_tasks').update({...values,updated_at:new Date().toISOString()}).eq('id',row.id).select('id');
 if(error||!data?.length)throw Error(error?.message||'没有保存权限');await loadAll();
}
async function importData(obj){
 if(!user)throw Error('请先登录');if(importing)throw Error('正在导入，请等待');importing=true;
 try{const parsed=C.parseJSON(obj);const old=new Map(queue.map(r=>[key(r),r]));
 for(let i=0;i<parsed.items.length;i+=100){const {error}=await db.from('reference_capture_tasks').upsert(parsed.items.slice(i,i+100).map(r=>({...r,created_by:user.id})),{onConflict:'created_by,source_type,source_id',ignoreDuplicates:true});if(error)throw error;}
 // A pristine seeded row may adopt locally saved progress; never replace a changed cloud row.
 for(const row of parsed.items){const prior=old.get(key(row));if(prior&&prior.created_at===prior.updated_at&&prior.phase==='pending'&&!prior.paused&&!prior.master_count&&(row.phase!=='pending'||row.title||row.notes)){
 const {error}=await db.from('reference_capture_tasks').update({phase:row.phase,paused:row.paused,title:row.title||prior.title,author:row.author||prior.author,notes:row.notes||prior.notes,download_filename:row.download_filename,legacy_status:row.legacy_status,updated_at:new Date().toISOString()}).eq('id',prior.id).eq('updated_at',prior.updated_at);if(error)throw error;
 }}
 page=0;await loadAll();say('已同步 '+parsed.items.length+' 条来源记录；重复来源保留云端进度。无效 '+parsed.invalid+'，文件内重复 '+parsed.duplicate+'。');
 }finally{importing=false;}
}
function allFiltered(){const f=$('filter').value,s=$('search').value.trim().toLowerCase();return queue.filter(r=>(f==='all'||(f==='paused'?r.paused:r.live_status===f))&&(!s||[r.source_id,r.display_title,r.display_author].some(v=>String(v||'').toLowerCase().includes(s))));}
function render(){
 const stats=$('stats');stats.replaceChildren();for(const [label,n] of [['收藏来源',queue.length],['已有母图',queue.filter(r=>r.master_count>0).length],['全部母图',queue.reduce((a,r)=>a+r.master_count,0)],['草稿待审核',queue.reduce((a,r)=>a+r.draft_count,0)],['关联待确认',queue.filter(r=>r.live_status==='needs_review').length],['已暂停',queue.filter(r=>r.paused).length]]){const d=el('div');d.className='stat';d.append(el('span',label),el('strong',String(n)));stats.append(d);}
 const rows=allFiltered(),pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));page=Math.max(0,Math.min(page,pages-1));$('pageStats').textContent='共 '+rows.length+' 条 · 第 '+(page+1)+' / '+pages+' 页';const body=$('tbody');body.replaceChildren();
 for(const r of rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE)){
  const tr=el('tr');if(batchIds.has(r.id))tr.style.background='#f4ecd9';tr.append(el('td',String(r.queue_order+1)),el('td',r.source_type),el('td',r.source_id));const info=el('td',r.display_title||'作品名称待补充');if(r.display_author)info.append(el('div',r.display_author));tr.append(info);
  const status=el('td',(r.paused?'已暂停 · ':'')+(C.labels[r.live_status]||r.live_status));status.className='status';status.append(el('div','母图 '+r.master_count+' · 已核验 '+r.verified_count+' · 草稿 '+r.draft_count+' · 已发布 '+r.published_count));
  const details=el('details'),summary=el('summary','母图详情');details.append(summary);for(const m of r.masters||[])details.append(el('div',(m.filename||m.id)+' · '+m.width+'×'+m.height+' · '+m.bytes+' 字节 · '+(m.verified?'SHA-256 已核验':'待回读核验')+' · SHA-256 '+m.sha256));if(r.master_count)status.append(details);tr.append(status);
  const actions=el('td'),buttons=el('div');buttons.className='row';actions.style.minWidth='330px';
  buttons.append(btn('打开作品',()=>{if(!r.source_url)throw Error('特殊来源类型请从收藏夹正常打开，不猜测下载 URL');window.open(r.source_url,'_blank','noopener');}),btn(r.master_count?'打开母图工作台':'上传母图',()=>{window.open(C.importerURL(r),'_blank','noopener');}),btn(r.paused?'继续':'暂停',()=>patch(r,{paused:!r.paused})));
  const select=el('select');for(const s of ['pending','needs_review','downloaded','failed'])select.add(new Option(C.labels[s],s));select.value=r.phase;select.onchange=async()=>{try{let filename=r.download_filename,reason=r.failure_reason;if(select.value==='downloaded'){filename=prompt('填写已实际下载的原图文件名（此状态不代表云端核验）',filename||'');if(!filename?.trim()){render();return;}}if(select.value==='failed'){reason=prompt('记录失败原因',reason||'');if(reason===null){render();return;}}await patch(r,{phase:select.value,download_filename:filename,failure_reason:reason,last_checked_at:new Date().toISOString(),retry_count:r.retry_count+(select.value==='failed'?1:0)});}catch(e){say(e.message);render();}};
  if(!r.master_count)buttons.append(select);
  buttons.append(btn('编辑信息',async()=>{const title=prompt('作品名称',r.display_title||'');if(title===null)return;const author=prompt('作者',r.display_author||'');if(author===null)return;await patch(r,{title:title.trim().slice(0,180),author:author.trim().slice(0,120)});}));
  if(r.candidate_count>1&&!r.project_id){const choice=el('select');choice.add(new Option('确认关联项目…',''));for(const p of r.candidate_projects)choice.add(new Option(p.title,p.id));choice.onchange=()=>{if(choice.value&&confirm('确认这条来源记录对应「'+choice.selectedOptions[0].textContent+'」？'))patch(r,{project_id:choice.value}).catch(e=>say(e.message));};buttons.append(choice);}
  actions.append(buttons,el('div','下一步：'+C.nextAction(r)));if(r.failure_reason)actions.append(el('div','上次失败：'+r.failure_reason));if(r.notes)actions.append(el('div','备注：'+r.notes));tr.append(actions);body.append(tr);
 }
 $('prev').disabled=page===0;$('next').disabled=page>=pages-1;$('batchStatus').textContent=batchIds.size?'当前批次 '+batchIds.size+' 条':'尚未选择批次';
}
function exportJSON(items,name){const blob=new Blob([JSON.stringify({version:5,items},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
$('jsonFile').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>8*1024*1024)throw Error('文件超过 8MB');await importData(JSON.parse(await file.text()));}catch(e){say(e.message);}};
$('loadObserved').onclick=()=>{
 const requestId=crypto.randomUUID();let timer;
 const receive=async e=>{if(e.source!==window||e.origin!==location.origin||e.data?.type!=='ART_CAPTURE_EXPORT'||e.data.requestId!==requestId)return;clearTimeout(timer);window.removeEventListener('message',receive);try{await importData(e.data.queue);}catch(e){say(e.message);}};
 window.addEventListener('message',receive);timer=setTimeout(()=>{window.removeEventListener('message',receive);say('未连接新版采集助手。可更新到 v0.5，或在旧队列导出带进度 JSON 后从这里导入。');},3000);
 window.postMessage({type:'ART_CAPTURE_REQUEST',requestId},location.origin);
};
$('refresh').onclick=loadAll;$('filter').onchange=()=>{page=0;render();};$('search').oninput=()=>{page=0;render();};$('prev').onclick=()=>{page--;render();};$('next').onclick=()=>{page++;render();};
$('nextBatch').onclick=()=>{batchIds=new Set(queue.filter(r=>!r.paused&&!r.master_count&&['pending','failed'].includes(r.live_status)).slice(0,Number($('batch').value)).map(r=>r.id));page=0;$('filter').value='all';render();say('已选择 '+batchIds.size+' 条待处理作品；已有母图的作品不会再次进入下载批次。');};
$('export').onclick=()=>exportJSON(queue,'中华珍宝馆_收藏采集队列_云端进度.json');$('exportBatch').onclick=()=>exportJSON(queue.filter(r=>batchIds.has(r.id)),'中华珍宝馆_本批次.json');
async function refreshAuth(){const {data:{session}}=await db.auth.getSession();authEpoch++;user=session?.user||null;$('authState').textContent=user?'已登录：'+user.email:'未登录';$('loginPanel').hidden=!!user;$('workPanel').hidden=!user;$('logout').hidden=!user;subscribe();if(user)await loadAll();else{queue=[];render();$('syncState').textContent='';}}
$('login').onclick=async()=>{const {error}=await db.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});if(error)$('loginMsg').textContent='登录失败：'+error.message;else{$('password').value='';await refreshAuth();}};
$('logout').onclick=()=>db.auth.signOut();db.auth.onAuthStateChange(()=>setTimeout(refreshAuth,0));
window.addEventListener('focus',scheduleRefresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleRefresh();});setInterval(()=>{if(!document.hidden&&user)scheduleRefresh();},15000);
refreshAuth().catch(e=>say('初始化失败：'+e.message));

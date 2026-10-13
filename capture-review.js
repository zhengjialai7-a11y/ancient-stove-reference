'use strict';
const CaptureReview=(()=>{
 function create(api){
  let choices={},selected=null,working=false,page=0,lastKey='',message='';const checked=new Set(),details=new Map(),drafts=new Map();
  const $=api.$,el=api.el,dialog=$('localReviewDialog');
  const title=t=>t.title||t.display_title||t.source_id||t.id;
  function cloudInfo(cloud){
   const reason=cloud.failure_reason||cloud.link_issue||'',stage=/下载|download/i.test(reason)?'downloading':undefined,kind=CaptureIssues.kind({message:reason},stage),sourceIssue=cloud.resolved_master_id||cloud.candidate_count>1&&!cloud.project_id||cloud.link_issue||cloud.phase==='needs_review';
   const type=kind==='other'&&sourceIssue?'source':kind;return {kind:type,label:CaptureIssues.labels[type],part:null,time:cloud.updated_at||null};
  }
  function archivedNotes(task,action){const cloud=task.cloud,reason=cloud.failure_reason||cloud.link_issue||task.error||task.info.label;return [cloud.notes||'','[集中处理 '+new Date().toISOString()+'] '+action+'；原状态：'+(cloud.phase||'未知')+'；原因：'+reason].filter(Boolean).join('\n');}
  function rows(){
   const map=new Map();for(const task of [...api.history(),...api.tasks()]){if(task.owner&&task.owner!==api.owner())continue;if(task.status==='failed'||task.failures?.length)map.set(task.id,task);}
   for(const cloud of api.queue()){if((cloud.candidate_count>1&&!cloud.project_id)||cloud.resolved_master_id||['needs_review','failed'].includes(cloud.phase)||cloud.link_issue){const previous=map.get(cloud.id);map.set(cloud.id,{...cloud,...previous,cloudIssue:true,source:previous?.source||cloud.source_url,title:previous?.title||cloud.display_title||cloud.title});}}
   return [...map.values()].map(task=>{const cloud=api.queue().find(t=>t.id===task.id),info=task.cloudIssue&&!task.error?cloudInfo(cloud):CaptureIssues.review(task),choice=choices[task.id],localVersion=task.failedAt||task.failures?.at(-1)?.time||null,cloudVersion=task.cloudIssue?cloud?.updated_at||null:null,failureAt=cloudVersion&&(!localVersion||cloudVersion>localVersion)?cloudVersion:localVersion,active=choice?.failureAt===failureAt?choice:null;return {...task,cloud,info,failureAt,choice:active||{},reviewStatus:task.status==='complete'&&!task.cloudIssue?'resolved':active?.status||'pending'};}).sort((a,b)=>String(b.failureAt||'').localeCompare(String(a.failureAt||'')));
  }
  const busy=()=>working||api.busy();
  function button(label,fn){const b=el('button',label);b.disabled=busy();b.onclick=async()=>{if(busy())return;const owner=api.owner();working=true;message='正在处理，请稍候…';render();try{await fn();if(api.owner()!==owner)return;}catch(e){if(api.owner()===owner)message=e.message;}finally{working=false;if(api.owner()===owner)render();}};return b;}
  function link(label,href){const a=el('a',label);a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;}
  function source(task){try{const url=new URL(task.source||task.source_url);if(url.protocol==='https:'&&url.hostname==='g2.ltfc.net'&&/^\/view\/[A-Z0-9_]{3,20}\/[a-f0-9]{24}\/?$/i.test(url.pathname))return url.href;}catch{}return null;}
  function open(id){if(id){const all=rows(),task=all.find(t=>t.id===id);selected=id;if(task){$('localReviewFilter').value=task.reviewStatus;$('localReviewSearch').value='';const visible=all.filter(t=>t.reviewStatus===task.reviewStatus);page=Math.floor(visible.findIndex(t=>t.id===id)/20);}}dialog.hidden=false;if(dialog.showModal&&!dialog.open)dialog.showModal();else dialog.open=true;lastKey='';render();}
  function close(){if(dialog.close)dialog.close();dialog.open=false;dialog.hidden=true;}
  function setData(data){choices=data||{};render();}
  async function retry(task,redownload=false){
   if(task.cloud?.paused)throw Error('作品已暂停，请先点击“解除作品暂停”');if(!api.history().some(t=>t.id===task.id))throw Error('请先确认关联项目，再使用“准备此作品”');
   details.delete(task.id);await api.execute(redownload?'review_redownload':'review_retry',{taskIds:[task.id],...(redownload?{part:task.info.part}:{})});message='已从保存进度开始处理；完成后自动更新问题状态。';
  }
  function renderDetail(task){
   const panel=$('localReviewDetail');panel.replaceChildren();if(!task){panel.append(el('p','从左侧选择一条问题，查看详情并处理。'));return;}
   panel.append(el('h3',title(task)),el('p','来源 ID：'+(task.source_id||task.cloud?.source_id||'待核对')+' · 任务 ID：'+task.id),el('p',task.info.label+' · '+({pending:'待处理',deferred:'暂缓',resolved:'已解决'}[task.reviewStatus])+' · '+(task.info.part?'失败分段：第 '+task.info.part+' 张':'整幅作品或原图清单')+' · 已完成 '+(task.files||[]).filter(f=>f.complete).length+' / '+(task.count||'?')+' 张'));
   panel.append(el('p',task.error||task.cloud?.failure_reason||task.cloud?.link_issue||(task.cloud?.phase==='failed'?'云端未记录具体失败原因，请核对原作和下载权限':'来源关联需要人工确认')));
   const guidance={duplicate:'先打开作品核对失败分段。若下载到了重复原图，使用“重新下载失败分段”；相同内容不会被强行登记为新的母图。',source:'核对来源链接与关联项目。候选项目有冲突时须先确认关联，不能直接准备或重试；作品资料可在母图工作台核对。',count:'核对网站原图清单的实际张数。尚无分段记录时可重新准备并留空张数；已有分段时须先核对原作，避免改动已完成进度。',hash:'核对失败分段文件。可重新下载未完成分段，再执行原字节上传与回读核验。',download:'确认珍宝馆已登录且作品可正常下载，再重试此作品。未成功下载的分段会重新下载。',network:'网络恢复后可重试；若顶部有自动恢复倒计时，可先暂停该计划再集中处理。',auth:'先重新登录收藏队列，再继续当前批次或重试此作品。',system:'先检查本机助手、下载目录和磁盘空间，再重试。'};
   panel.append(el('p',guidance[task.info.kind]||'处理作品页或文件的问题后，重试此作品；暂时无法处理的可保留为暂缓。'));
   const legacy=!!task.cloud?.resolved_master_id,ambiguous=task.cloud?.candidate_count>1&&!task.cloud.project_id,hasHistory=api.history().some(t=>t.id===task.id),canCollect=!task.cloud||task.cloud.source_type==='SUHA',links=el('div');links.className='row';const url=source(task);if(url)links.append(link('打开原作',url));const importer=api.importerURL(task.cloud||{...task,source_url:task.source});links.append(link(legacy?'打开已有母图':canCollect?'打开母图工作台':'手动上传母图',legacy?importer+(importer.includes('?')?'&':'?')+'master_id='+encodeURIComponent(task.cloud.resolved_master_id):importer));panel.append(links);
   if(legacy)panel.append(el('p','此来源已有旧独立母图，现有文件及裁切记录保留，不重复下载。请先打开已有母图核对；不会将未核验文件或未完成分段标为完成。'));
   if(!canCollect)panel.append(el('p','该来源类型暂不支持自动原图采集，问题记录保留。请从收藏夹正常打开原作，手动下载后使用“手动上传母图”；不猜测下载链接，也不会把该问题标为完成。'));
   if(ambiguous){const choice=el('select');choice.dataset.reviewAction='project';const empty=el('option','选择确认关联的项目…');empty.value='';choice.append(empty);for(const p of task.cloud.candidate_projects||[]){const option=el('option',p.title+' · '+p.id);option.value=p.id;choice.append(option);}choice.disabled=busy();const save=button('确认关联项目',async()=>{if(!(task.cloud.candidate_projects||[]).some(p=>p.id===choice.value))throw Error('请先选择与原作对应的项目');await api.patch(task.cloud,{project_id:choice.value,phase:'pending',failure_reason:null,notes:archivedNotes(task,'确认关联项目 '+choice.value)});if(canCollect){await api.prepare(task.id);message='项目关联已保存，作品已准备；关闭窗口后点击开始采集。';}else message='项目关联已保存；该来源请手动上传母图。';});panel.append(choice,save);}
   const actions=el('div');actions.className='row';
   if(task.cloud?.paused)actions.append(button('解除作品暂停',async()=>{await api.patch(task.cloud,{paused:false});message='作品暂停已解除，可以重试。';}));
   if(task.reviewStatus!=='resolved'){
    if(canCollect&&!legacy&&!ambiguous&&hasHistory){
     actions.append(button('重试此作品',()=>retry(task)));
     const file=task.files?.find(f=>f.part===task.info.part);if(task.info.part){if(file&&!file.complete)actions.append(button('重新下载失败分段',()=>retry(task,true)));actions.append(button('核对分段文件',async()=>{details.set(task.id,await api.execute('review_info',{taskId:task.id,part:task.info.part}));message='已读取云端分段信息。';}));}
    }else if(!legacy&&!ambiguous&&!hasHistory&&task.cloud?.source_type==='SUHA')actions.append(button('已核对，准备重试',async()=>{if(task.cloud.paused)throw Error('作品已暂停，请先点击“解除作品暂停”');await api.patch(task.cloud,{phase:'pending',failure_reason:null,notes:archivedNotes(task,'已核对，准备重试')});await api.prepare(task.id);message='原失败原因已存入云端备注，作品已准备；关闭窗口后点击开始采集。';}));
    const note=el('textarea');note.rows=2;note.placeholder='处理备注，例如需核对第 45 张原图';note.value=drafts.get(task.id)??task.choice.note??'';note.disabled=busy();note.oninput=()=>drafts.set(task.id,note.value);panel.append(note);
    actions.append(button(task.reviewStatus==='deferred'?'恢复待处理':'暂缓处理并留备注',async()=>{await api.command('review_update',{taskId:task.id,reviewStatus:task.reviewStatus==='deferred'?'pending':'deferred',note:note.value,failureAt:task.failureAt});await api.refresh();message='处理状态已保存，原失败记录保留。';}));
   }
   panel.append(actions);
   const data=details.get(task.id);if(data){const box=el('div');box.className='notice';box.append(el('p',data.row?'云端第 '+data.part+' 张：'+data.row.phase+' · '+(data.row.original_filename||'未登记文件名'):'云端尚无此分段记录'));if(data.duplicateParts?.length)box.append(el('p','与第 '+data.duplicateParts.map(r=>r.part_index).join('、')+' 张内容相同'));if(data.masters?.length)for(const m of data.masters)box.append(el('p','已有母图：'+m.id+' · 项目 '+m.project_id));panel.append(box);}
   const history=el('details');history.append(el('summary','失败与处理历史（'+(task.failures?.length||0)+' 次失败）'));for(const failure of task.failures||[])history.append(el('p',[failure.time,failure.part?'第 '+failure.part+' 张':'',failure.error].filter(Boolean).join(' · ')));for(const repair of task.repairs||[])history.append(el('p',repair.time+' · 重新下载第 '+repair.part+' 张'));panel.append(history);
  }
  function render(){
   if(!api.owner()){clear();return;}const all=rows(),pending=all.filter(t=>t.reviewStatus==='pending'),filter=$('localReviewFilter').value||'pending',search=$('localReviewSearch').value.toLowerCase().trim(),list=all.filter(t=>(filter==='all'||t.reviewStatus===filter)&&(!search||[title(t),t.source_id,t.id,t.error,t.info.label].some(v=>String(v||'').toLowerCase().includes(search))));
   $('localReviewCount').textContent='待处理问题 '+pending.length+' 幅 · 暂缓 '+all.filter(t=>t.reviewStatus==='deferred').length+' 幅';$('localReviewOpen').textContent='集中处理问题（'+pending.length+'）';$('localReviewRetrySelected').disabled=busy()||!checked.size;$('localReviewStatus').textContent=message||(api.busy()?'本批正在运行或等待自动恢复；处理操作在批次结束或暂停后开放。':'失败原图、已完成分段和历史记录保留；选择问题后处理。');
   if(dialog.hidden)return;page=Math.max(0,Math.min(page,Math.max(0,Math.ceil(list.length/20)-1)));const key=JSON.stringify([all,filter,search,page,selected,working,api.busy(),[...checked],[...details],message]);if(key===lastKey)return;lastKey=key;
   const container=$('localReviewList');container.replaceChildren();for(const task of list.slice(page*20,(page+1)*20)){const row=el('div');row.className='capture-record';const check=el('input');check.type='checkbox';check.checked=checked.has(task.id);check.disabled=busy()||task.reviewStatus==='resolved'||!api.history().some(t=>t.id===task.id)||task.cloud?.paused||task.cloud?.resolved_master_id||task.cloud?.candidate_count>1&&!task.cloud.project_id||task.cloud&&task.cloud.source_type!=='SUHA';check.onchange=()=>{check.checked?checked.add(task.id):checked.delete(task.id);render();};const choose=el('button',title(task));choose.dataset.reviewTaskId=task.id;choose.onclick=()=>{selected=task.id;lastKey='';render();};row.append(check,choose,el('span',task.info.label+' · '+(task.info.part?'第 '+task.info.part+' 张 · ':'')+({pending:'待处理',deferred:'暂缓',resolved:'已解决'}[task.reviewStatus])));container.append(row);}
   $('localReviewPage').textContent='第 '+(page+1)+' / '+Math.max(1,Math.ceil(list.length/20))+' 页 · '+list.length+' 幅';$('localReviewPrev').disabled=page===0;$('localReviewNext').disabled=(page+1)*20>=list.length;
   if(!selected||!list.some(t=>t.id===selected))selected=list[0]?.id||null;renderDetail(list.find(t=>t.id===selected));
  }
  function clear(){choices={};selected=null;working=false;checked.clear();details.clear();drafts.clear();lastKey='';message='';close();$('localReviewList').replaceChildren();$('localReviewDetail').replaceChildren();$('localReviewCount').textContent='登录后查看待处理问题';$('localReviewOpen').textContent='集中处理问题';}
  $('localReviewOpen').onclick=()=>open();$('localReviewClose').onclick=close;$('localReviewFilter').value='pending';$('localReviewFilter').onchange=()=>{page=0;render();};$('localReviewSearch').oninput=()=>{page=0;render();};$('localReviewPrev').onclick=()=>{page--;render();};$('localReviewNext').onclick=()=>{page++;render();};
  $('localReviewRetrySelected').onclick=async()=>{if(busy())return;const selectedRows=rows().filter(t=>checked.has(t.id)&&t.reviewStatus!=='resolved'&&!t.cloud?.paused&&!t.cloud?.resolved_master_id&&!(t.cloud?.candidate_count>1&&!t.cloud.project_id)&&(!t.cloud||t.cloud.source_type==='SUHA')&&api.history().some(h=>h.id===t.id));if(!selectedRows.length)return;working=true;render();try{await api.execute('review_retry',{taskIds:selectedRows.map(t=>t.id)});checked.clear();message='已开始处理所选问题，已有完成分段会复用。';}catch(e){message=e.message;}finally{working=false;render();}};
  return {render,setData,open,clear};
 }
 return {create};
})();

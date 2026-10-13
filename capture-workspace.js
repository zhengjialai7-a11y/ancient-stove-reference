// Loaded after the workbench's main script. All writes still use its signed-in user.
let incomingCaptureTask=null,captureChannel=null,captureTimer=null;
async function getCaptureTask(){
 const taskId=new URLSearchParams(location.search).get('capture_task');if(!taskId)return null;
 if(!/^[a-f0-9-]{36}$/i.test(taskId))throw Error('采集任务 ID 无效');
 const {data,error}=await db.from('reference_capture_status').select('*').eq('id',taskId).single();if(error)throw error;return data;
}
async function initCaptureTask(){
 incomingCaptureTask=await getCaptureTask();
 let id=new URLSearchParams(location.search).get('project_id');
 if(incomingCaptureTask){
  id=incomingCaptureTask.resolved_project_id;
  if(!id){clearActiveMaster(true);$("projectSelect").value='';projectSelectionId='';for(const [name,value] of [['workTitle',incomingCaptureTask.display_title],['author',incomingCaptureTask.display_author],['era',incomingCaptureTask.display_era],['sourceUrl',incomingCaptureTask.source_url]])$(name).value=value||'';$("projectDetails").open=true;updateSourceShortcut();}
 }
 if(id){const p=projects.find(p=>p.id===id);if(!p)throw Error('关联项目不存在或没有读取权限');await loadProjects(id);fillProjectMetadata(p);projectSelectionId=id;$("projectDetails").open=false;if(projectMasters.length)await selectMaster(projectMasters[0]);}
 // Legacy extension URLs also reuse a unique source project without matching by title.
 if(!incomingCaptureTask&&!id){const source=CaptureCommon.sourceKey(new URLSearchParams(location.search).get('source_url'));const matches=projects.filter(p=>source&&CaptureCommon.sourceKey(p.source_url)===source);if(matches.length===1){await loadProjects(matches[0].id);fillProjectMetadata(matches[0]);projectSelectionId=matches[0].id;}}
 const masterId=new URLSearchParams(location.search).get('master_id')||incomingCaptureTask?.resolved_master_id;
 if(masterId){
  if(!/^[a-f0-9-]{36}$/i.test(masterId))throw Error('母图 ID 无效');
  if(incomingCaptureTask?.resolved_master_id&&masterId!==incomingCaptureTask.resolved_master_id)throw Error('母图与当前来源记录不一致');
  const {data:m,error}=await db.from('artwork_masters').select('*').eq('id',masterId).single();if(error)throw error;
  if(!m||m.created_by!==user?.id)throw Error('母图不存在或没有读取权限');
  if(incomingCaptureTask&&CaptureCommon.sourceKey(m.source_url)!==incomingCaptureTask.source_type+':'+incomingCaptureTask.source_id)throw Error('母图来源与当前记录不匹配');
  if(id&&m.project_id!==id)throw Error('母图与当前项目不一致');
  await selectMaster(m);
 }
 if(id&&new URLSearchParams(location.search).get('edit_project')==='1'){setWorkspaceMode('import');$("projectDetails").open=true;}
 await refreshCaptureSummary();
}
async function assertCaptureContext(){
 if(!incomingCaptureTask)return;
 const row=await getCaptureTask();incomingCaptureTask=row;
 if(row.paused)throw Error('收藏采集任务已暂停，请先在队列点击继续');
 if(row.candidate_count>1&&!row.project_id)throw Error('同一来源对应多个古画项目，请先在收藏队列确认关联');
 const p=projects.find(p=>p.id===$("projectSelect").value);
 const source=CaptureCommon.sourceKey(p?.source_url||$("sourceUrl").value.trim());
 if(source!==row.source_type+':'+row.source_id)throw Error('当前项目的来源作品 ID 与采集任务不一致，请从队列重新打开正确作品');
 if(row.resolved_project_id&&p?.id!==row.resolved_project_id)throw Error('当前项目与采集任务关联项目不一致');
}
async function assertCaptureMaster(m){
 if(!incomingCaptureTask)return;
 const p=projects.find(p=>p.id===m.project_id);
 if(CaptureCommon.sourceKey(p?.source_url||m.source_url)!==incomingCaptureTask.source_type+':'+incomingCaptureTask.source_id)throw Error('相同文件已登记到其他来源作品，不能自动复用到本任务');
}
async function bindCaptureProject(id){
 if(!incomingCaptureTask)return;
 const {data,error}=await db.from('reference_capture_tasks').update({project_id:id,updated_at:new Date().toISOString()}).eq('id',incomingCaptureTask.id).eq('paused',false).select('id');
 if(error||!data?.length)throw Error(error?.message||'任务已暂停或关联未能保存');
 scheduleCaptureRefresh();
}
async function markMasterVerified(m,hash){
 const {data,error}=await db.from('artwork_masters').update({verified_sha256:hash,verified_at:new Date().toISOString()}).eq('id',m.id).eq('sha256',hash).eq('storage_path',m.storage_path).select('id');
 if(error||!data?.length)throw Error(error?.message||'母图校验凭据未保存');scheduleCaptureRefresh();
}
async function refreshCaptureSummary(){
 if(!user)return;const project=$("projectSelect").value,task=incomingCaptureTask?.id;
 try{let query=db.from('reference_capture_status').select('*');if(task)query=query.eq('id',task);else if(project)query=query.eq('resolved_project_id',project);else{$('captureSummary').textContent='选择项目后自动显示关联队列状态。';return;}
 const {data,error}=await query;if(error)throw error;if(project!==$("projectSelect").value&&!task)return;
 if(!data?.length){const parts=projectMasters.filter(m=>m.project_id===project),verified=parts.filter(m=>m.verified_at&&m.verified_sha256===m.sha256).length;$('captureSummary').textContent='本项目已上传 '+parts.length+' 张母图 / 已核验 '+verified+' 张；来源尚未准确关联收藏任务。收藏队列已显示本项目进度，请核对原作来源链接及收藏清单。';return;}
 if(task)incomingCaptureTask=data[0];$('captureSummary').textContent=data.map(r=>(r.display_title||r.source_id)+' · '+(r.paused?'已暂停 · ':'')+CaptureCommon.labels[r.live_status]+' · 母图 '+r.master_count+' / 已核验 '+r.verified_count+' · 草稿 '+r.draft_count+' · 已发布 '+r.published_count+'。下一步：'+CaptureCommon.nextAction(r)).join('\n');
 }catch(e){$('captureSummary').textContent='队列状态同步失败：'+e.message;}
}
function scheduleCaptureRefresh(){clearTimeout(captureTimer);captureTimer=setTimeout(refreshCaptureSummary,250);}
function startCaptureSync(){
 if(captureChannel)db.removeChannel(captureChannel);captureChannel=db.channel('master-capture-link-'+user.id);
 for(const table of ['reference_capture_tasks','artwork_masters','artwork_crops','artwork_projects'])captureChannel.on('postgres_changes',{event:'*',schema:'public',table},scheduleCaptureRefresh);
 captureChannel.subscribe(status=>{if(status==='SUBSCRIBED')scheduleCaptureRefresh();});
}
$('verifyStoredMaster').onclick=async()=>{
 if(!master||busy||multiRunning||navigationRunning)return;const m=master;setBusy(true);
 try{message('正在回读已登记母图，核对字节数和 SHA-256…');const {data,error}=await db.storage.from(BUCKET).download(m.storage_path);if(error)throw error;if(data.size!==Number(m.original_bytes))throw Error('云端字节数与登记值不一致');const hash=await sha256(data);if(hash!==m.sha256)throw Error('云端 SHA-256 与登记原图不一致，不能标记核验通过');await markMasterVerified(m,hash);await refreshCaptureSummary();message('回读核验通过：云端文件字节数及 SHA-256 与登记原图一致，收藏队列状态已更新。','ok');}
 catch(e){message('回读核验失败：'+e.message,'err');}finally{setBusy(false);}
};
window.addEventListener('focus',scheduleCaptureRefresh);setInterval(()=>{if(user&&!document.hidden)scheduleCaptureRefresh();},15000);

(async()=>{try{await refreshAuth();}catch(e){message("初始化失败："+e.message,"err");}})();

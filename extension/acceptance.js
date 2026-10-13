'use strict';
// Real browser/native acceptance checks. No tokens, signed download URLs or local paths in reports.
const CaptureAcceptance=(()=>{
 const VERSION='0.9.7',LABELS={pipeline:'下载、上传和关联',multi:'多张母图',skip:'失败跳过与留档',pause:'暂停与恢复',repeat:'重复采集复用',restart:'浏览器重启保留'};
 const safeError=value=>String(value||'').replace(/\b[A-Z]:\\[^\r\n']+/gi,'[本机路径]').replace(/https?:\/\/[^\s]+/gi,'[下载或请求地址]').replace(/(?:Bearer\s+|access_token[=:]\s*)\S+/gi,'[登录凭据]');
 const now=()=>new Date().toISOString();
 const summary=task=>({id:task.id,source_id:task.source_id,source:task.source,title:task.title,count:task.count,status:task.status,error:task.error?safeError(task.error):null,failures:(task.failures||[]).map(f=>({time:f.time,stage:f.stage,part:f.part,error:safeError(f.error)})),files:(task.files||[]).map(f=>({part:f.part,complete:!!f.complete,masterId:f.masterId||null,projectId:f.projectId||null}))});
 // Chrome storage may reorder object keys. Compare record values and match files by part.
 const byPart=files=>[...(files||[])].sort((a,b)=>a.part-b.part);
 function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
 const sameData=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
 function differences(task,baseline){if(!task)return ['record'];const current=summary(task),previous={...baseline,files:byPart(baseline.files)};current.files=byPart(current.files);return [...new Set([...Object.keys(current),...Object.keys(previous)])].sort().filter(key=>!sameData(current[key],previous[key]));}
 function restoreFinalSnapshot(value){const baseline=value.restartBaseline,ids=value.taskIds;if(value.status==='finished'&&Array.isArray(ids)&&Array.isArray(baseline)&&baseline.length===ids.length&&ids.every(id=>baseline.some(t=>t.id===id)))value.tasks=structuredClone(baseline);}
 function create(api){
  let report=null,busy=false,control=0,autoPause=false;
  const sameOwner=()=>report&&api.state().owner===report.owner;
  async function save(message){if(!sameOwner())throw Error('验收账号已变化');report.updatedAt=now();if(report.status==='finished')restoreFinalSnapshot(report);else report.tasks=api.state().tasks.map(summary);const data=await chrome.storage.local.get('localCaptureValidationReports'),all=data.localCaptureValidationReports||[];const index=all.findIndex(r=>r.id===report.id);if(index<0)all.push(structuredClone(report));else all[index]=structuredClone(report);await chrome.storage.local.set({localCaptureValidation:report,localCaptureValidationReports:all});await api.progress({validation:report,...(message?{message}:{})});}
  function setCheck(name,status,detail,evidence={}){report.checks[name]={label:LABELS[name],status,detail,evidence};}
  async function prepare({resume=false}={}){
   const {owner,tasks}=api.state();if(!owner)throw Error('请先登录');
   const data=await chrome.storage.local.get(['localCaptureValidation','localCaptureBrowserBoot']);
   if(resume){report=data.localCaptureValidation;if(!report||report.owner!==owner)throw Error('没有当前账号可继续的验收');if(!['paused','blocked','running'].includes(report.status))throw Error('本次验收已结束，可查看报告或重新开始');if(report.taskIds.length!==tasks.length||!report.taskIds.every(id=>tasks.some(t=>t.id===id))||!(report.tasks||[]).every(old=>tasks.some(t=>t.id===old.id&&t.source===old.source)))throw Error('原验收批次已改变，请重新开始验收');}
   else{let boot=data.localCaptureBrowserBoot;if(!boot){boot={id:crypto.randomUUID(),at:now(),event:'baseline'};await chrome.storage.local.set({localCaptureBrowserBoot:boot});}report={id:crypto.randomUUID(),owner,version:VERSION,startedAt:now(),updatedAt:now(),status:'running',phase:'collect',taskIds:tasks.map(t=>t.id),baselineBootId:boot.id,checks:{},downloads:[],uploads:[],reuses:[],verified:[],events:[],probe:{taskId:tasks[0]?.id,attempted:false,cancelledId:null,observed:false},pauseProbe:null};for(const name of Object.keys(LABELS))setCheck(name,'pending',name==='restart'?'自动验收结束后，关闭并重新打开浏览器，再检查记录保留':'等待实际运行');}
   if(resume&&report.pauseProbe&&!report.pauseProbe.resumedAt){const probe=report.pauseProbe,task=tasks.find(t=>t.id===probe.taskId),file=task?.files?.find(f=>f.part===probe.part);if(!file?.complete||file.masterId!==probe.masterId||task.count!==probe.count)throw Error('暂停检查点已变化，请保留记录并核对');report.pauseProbe.resumedAt=now();}control=api.state().pauseEpoch;report.status='running';report.error=null;autoPause=false;await save('一键验收已启动；保持电脑和浏览器开启');
  }
  const observer={
   automaticPause:()=>autoPause&&api.state().pauseEpoch===control,
   async list(task,list){report.events.push({type:'list',taskId:task.id,count:list.count,files:list.files.map(f=>({part:f.part,filename:f.filename,original:f.original})),time:now()});await save();},
   async verified(task,parts){report.verified.push({taskId:task.id,count:task.count,parts:[...parts],phase:report.phase,time:now()});await save();},
   async matchedDownload(download,task,part){if(report.phase==='repeat'||report.probe.attempted||report.probe.taskId!==task.id||download.state!=='in_progress')return;report.probe.attempted=true;report.probe.part=part;report.probe.requestedId=download.id;try{await chrome.downloads.cancel(download.id);report.probe.cancelledId=download.id;}catch(e){report.probe.cancelError=safeError(e.message);}await save('验收：正在检查取消测试下载后能否继续下一幅');},
   async interruptedDownload(download,task,part){if((report.probe.cancelledId===download.id||report.probe.requestedId===download.id)&&report.probe.taskId===task.id&&report.probe.part===part){report.probe.observed=true;report.probe.error=download.error||'interrupted';await save();}},
   async downloaded(task,file){report.downloads.push({taskId:task.id,part:file.part,count:file.count,downloadId:file.downloadId,phase:report.phase,time:now()});await save();},
   async uploaded(task,file,result){report.uploads.push({taskId:task.id,part:file.part,masterId:result.master_id,projectId:result.project_id,phase:report.phase,time:now()});await save();},
   async reused(task,part){report.reuses.push({taskId:task.id,part,phase:report.phase,time:now()});await save();},
   async afterPart(task,part){if(report.phase==='repeat'||report.pauseProbe||task.count<2||part>=task.count)return false;const file=task.files?.find(f=>f.part===part);if(!file?.complete||!file.masterId)return false;report.pauseProbe={taskId:task.id,part,masterId:file.masterId,count:task.count,pausedAt:now(),resumedAt:null};autoPause=true;await save('验收：已核验第 '+part+' 张，正在自动暂停并保存进度');return true;},
   async failed(task,canSkip){report.events.push({type:canSkip?'skipped':'stopped',phase:report.phase,taskId:task.id,error:safeError(task.error),stage:task.errorStage,time:now()});await save();},
   async complete(task){report.events.push({type:'complete',phase:report.phase,taskId:task.id,time:now()});await save();}
  };
  async function collect(list){
   let remaining=list;
   while(remaining.length){
    if(api.state().pauseEpoch!==control)return {paused:true};
    const result=await api.execute(remaining,{observer,validation:true,fullReadback:report.phase==='repeat'});
    if(result.paused&&autoPause&&api.state().pauseEpoch===control){
     autoPause=false;const data=await chrome.storage.local.get(['localCaptureTasks','localCaptureOwner']);const probe=report.pauseProbe,saved=(data.localCaptureTasks||[]).find(t=>t.id===probe.taskId),part=saved?.files?.find(f=>f.part===probe.part);
     if(data.localCaptureOwner!==report.owner||!part?.complete||part.masterId!==probe.masterId||saved.count!==probe.count){setCheck('pause','failed','暂停后持久化的分段记录发生变化');return {stopReason:'暂停保存核对失败'};}
     await api.delay(1000);if(api.state().pauseEpoch!==control)return {paused:true};report.pauseProbe.resumedAt=now();await save('验收：暂停进度已保存，正在自动继续并回读核验已有分段');remaining=api.state().tasks.filter(t=>list.some(r=>r.id===t.id)&&t.status!=='complete');continue;
    }
    return result;
   }
   return {paused:false,stopReason:null};
  }
  function evaluateCollection(){
   const tasks=api.state().tasks,complete=tasks.filter(t=>t.status==='complete'&&t.files?.filter(f=>f.complete).length===t.count);
   setCheck('pipeline',complete.length===tasks.length?'passed':'failed','完成 '+complete.length+' / '+tasks.length+' 幅；本次上传 '+report.uploads.filter(u=>u.phase!=='repeat').length+' 张，回读复用 '+report.reuses.filter(r=>r.phase!=='repeat').length+' 次（复跑另计）',{taskIds:complete.map(t=>t.id)});
   const multi=complete.filter(t=>t.count>1),downloaded=report.downloads.filter(d=>multi.some(t=>t.id===d.taskId));setCheck('multi',multi.length&&new Set(downloaded.map(d=>d.taskId+':'+d.part)).size>=2?'passed':'pending',multi.length?'原图列表与母图张数一致；本次实际下载 '+downloaded.length+' 张多图原件':'本批次没有已完成的多图作品，请选一幅含多张 JPG 的作品',{works:multi.map(t=>({id:t.id,count:t.count}))});
   const skipped=report.events.filter(e=>e.type==='skipped'),followed=skipped.find(e=>report.events.slice(report.events.indexOf(e)+1).some(n=>n.type==='complete'&&n.phase===e.phase&&n.taskId!==e.taskId));const retained=followed&&tasks.find(t=>t.id===followed.taskId)?.failures?.some(f=>safeError(f.error)===followed.error);setCheck('skip',followed&&retained?'passed':'pending',followed&&retained?'失败原因已留档，随后另一幅作品继续并完成':report.probe.attempted&&!report.probe.observed?'测试下载已完成或未能取消，尚未观察到失败跳过':'本次尚未观察到失败后另一幅完成；需要至少两幅可处理作品',{cancelledDownloadId:report.probe.cancelledId,observedInterruption:report.probe.observed,failedTaskId:followed?.taskId||null});
   const probe=report.pauseProbe,task=probe&&tasks.find(t=>t.id===probe.taskId),file=task?.files?.find(f=>f.part===probe.part),reused=probe&&report.reuses.some(r=>r.taskId===probe.taskId&&r.part===probe.part&&r.time>=probe.resumedAt);if(report.checks.pause.status!=='failed')setCheck('pause',probe?.resumedAt&&reused&&task?.status==='complete'&&file?.masterId===probe.masterId?'passed':'pending',probe?.resumedAt&&reused&&task?.status==='complete'?'自动暂停后从已保存进度继续，已核验分段被复用':'未完成暂停恢复检查；需要多图作品成功上传至少一张',{checkpoint:probe});
  }
  async function run(){
   if(busy)throw Error('验收正在运行');busy=true;
   try{
    const hello=await api.native('hello');report.nativeVersion=hello.version||null;if(hello.network&&!hello.network.ok)throw Object.assign(Error(hello.network.checks.filter(c=>!c.ok).map(c=>c.error).join('；')),{code:'ART_NETWORK',retryable:true});
    if(report.phase==='collect'){
     let result=await collect(api.state().tasks);if(result.paused){report.status='paused';report.error=result.stopReason?safeError(result.stopReason):null;await save('验收已暂停，进度和报告已保存；可点击继续验收');return;}if(result.stopReason)throw result.stopError||Error(result.stopReason);
     report.phase='recover';await save('验收：正在恢复测试取消或失败的作品');
    }
    if(report.phase==='recover'){
     const result=await collect(api.state().tasks.filter(t=>t.status!=='complete'&&(!t.review||t.review.kind==='network'||report.probe.observed&&report.probe.taskId===t.id)));if(result.paused){report.status='paused';report.error=result.stopReason?safeError(result.stopReason):null;await save('验收已暂停，进度和报告已保存；可点击继续验收');return;}if(result.stopReason)throw result.stopError||Error(result.stopReason);
     evaluateCollection();report.phase='repeat';report.repeatBaseline=api.state().tasks.filter(t=>t.status==='complete').map(summary);await save('验收：复跑已完成作品，检查重复下载和上传');
    }
    if(report.phase==='repeat'){
     const complete=api.state().tasks.filter(t=>report.repeatBaseline.some(s=>s.id===t.id));
     if(complete.length){const result=await collect(complete);if(result.paused){report.status='paused';report.error=result.stopReason?safeError(result.stopReason):null;await save('验收已暂停，可点击继续验收');return;}if(result.stopReason)throw result.stopError||Error(result.stopReason);const downloads=report.downloads.filter(d=>d.phase==='repeat'),uploads=report.uploads.filter(u=>u.phase==='repeat'),stable=report.repeatBaseline.every(old=>{const task=api.state().tasks.find(t=>t.id===old.id);return task?.status==='complete'&&task.count===old.count&&sameData(byPart(summary(task).files),byPart(old.files));});const allVerified=complete.every(t=>report.verified.some(v=>v.phase==='repeat'&&v.taskId===t.id&&v.parts.length===t.count&&new Set(v.parts).size===t.count));setCheck('repeat',stable&&!downloads.length&&!uploads.length&&allVerified?'passed':'failed','复跑新增下载 '+downloads.length+' 次，新增上传 '+uploads.length+' 次；核对分段回读结果及母图 ID',{downloads:downloads.length,uploads:uploads.length,stable,allVerified});}
     report.phase='done';report.status='finished';report.finishedAt=now();report.restartBaseline=api.state().tasks.map(summary);const bootData=await chrome.storage.local.get('localCaptureBrowserBoot');report.restartBaselineBootId=bootData.localCaptureBrowserBoot?.id||report.baselineBootId;await save('自动验收结束；通过 '+Object.values(report.checks).filter(c=>c.status==='passed').length+' 项，待验证 '+Object.values(report.checks).filter(c=>c.status==='pending').length+' 项。浏览器重启保留可单独检查。');
    }
   }catch(e){report.status=api.state().pauseEpoch!==control?'paused':'blocked';report.error=safeError(e.message);await save('验收'+(report.status==='paused'?'已暂停':'已停止')+'：'+report.error+'；记录已保留');if(report.status==='blocked')await api.scheduleNetwork?.(e);}
   finally{busy=false;}
  }
  async function status(owner){if(busy&&report?.owner===owner)return structuredClone(report);const data=await chrome.storage.local.get('localCaptureValidation');const saved=data.localCaptureValidation;if(!saved||saved.owner!==owner)return null;report=saved;restoreFinalSnapshot(report);if(report.status==='running')report={...report,status:'paused',error:'浏览器或插件执行已中断，点击继续验收'};return structuredClone(report);}
  async function checkRestart(owner){
   const data=await chrome.storage.local.get(['localCaptureValidation','localCaptureBrowserBoot','localCaptureHistory']),saved=data.localCaptureValidation;
   if(!saved||saved.owner!==owner)throw Error('没有当前账号的验收报告');if(saved.status!=='finished')throw Error('请先完成自动验收再检查重启保留');report=saved;
   const boot=data.localCaptureBrowserBoot,changed=!!boot&&boot.event==='startup'&&boot.id!==(report.restartBaselineBootId||report.baselineBootId),baseline=report.restartBaseline||[],mismatches=baseline.map(old=>({taskId:old.id,fields:differences((data.localCaptureHistory||[]).find(t=>t.owner===owner&&t.id===old.id),old)})).filter(d=>d.fields.length);
   if(!baseline.length||baseline.length!==report.taskIds.length||!report.taskIds.every(id=>baseline.some(t=>t.id===id)))mismatches.push({taskId:null,fields:['baseline']});
   const kept=!mismatches.length;
   setCheck('restart',!changed?'pending':kept?'passed':'failed',!changed?'尚未检测到浏览器重新启动；完全退出浏览器后重新打开，再检查':kept?'浏览器启动事件已记录；作品状态、分段 ID 和失败记录均保留':'重启后保存的作品或分段记录不一致',{bootAt:boot?.at||null,changed,kept,differences:mismatches,checkedWithVersion:VERSION});await save();return structuredClone(report);
  }
  return {prepare,run,status,checkRestart,isBusy:()=>busy,report:()=>report};
 }
 async function browserStarted(){await chrome.storage.local.set({localCaptureBrowserBoot:{id:crypto.randomUUID(),at:now(),event:'startup'}});}
 return {create,browserStarted};
})();

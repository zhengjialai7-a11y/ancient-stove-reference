'use strict';
// Serial, supervised three-work pilot. Binding uses an exact observed download link.
const CaptureAutomation=(()=>{
 const HOST='com.art_reference.capture',QUEUE='https://zhengjialai7-a11y.github.io/ancient-stove-reference/queue.html';
 let nativePort=null,running=false,starting=false,paused=false,pauseEpoch=0,active=null,proofs=[],tasks=[],history=[],owner=null,current=null,state={version:'0.7.3',phase:'idle',message:'尚未开始本机试跑',files:[]};const waiters=new Map();
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const key=url=>{const m=String(url||'').match(/^https:\/\/g2\.ltfc\.net\/view\/([A-Z0-9_]{3,20})\/([a-f0-9]{24})(?:[/?#]|$)/i);return m?m[1].toUpperCase()+':'+m[2].toLowerCase():null;};
 const matchesFilename=(name,expected)=>{const clean=s=>String(s||'').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/,'').toLowerCase();const base=String(name||'').split(/[\\/]/).at(-1);const actual=clean(base),wanted=clean(expected);return !!wanted&&(actual===wanted||actual.replace(/ \(\d+\)(?=\.[^.]+$)/,'')===wanted);};
 async function progress(values){state={...state,...values,owner,tasks,history:history.filter(t=>t.owner===owner)};await chrome.storage.local.set({localCaptureState:state});const tabs=await chrome.tabs.query({url:QUEUE+'*'});for(const t of tabs)chrome.tabs.sendMessage(t.id,{type:'localCaptureProgress',state}).catch(()=>{});}
 function connect(){if(nativePort)return;nativePort=chrome.runtime.connectNative(HOST);nativePort.onMessage.addListener(m=>{if(m.event){if(m.error)progress({phase:'failed',message:m.error});else if(m.state)progress({upload:m.state});return;}const waiter=waiters.get(m.id);if(!waiter)return;waiters.delete(m.id);clearTimeout(waiter.timer);m.ok?waiter.resolve(m.result):waiter.reject(Error(m.error||'本机助手失败'));});nativePort.onDisconnect.addListener(()=>{const message=chrome.runtime.lastError?.message||'本机助手连接断开，请检查安装或浏览器状态';nativePort=null;pauseEpoch++;paused=true;for(const waiter of waiters.values()){clearTimeout(waiter.timer);waiter.reject(Error(message));}waiters.clear();progress({phase:'failed',message});});}
 function native(command,values={}){connect();const id=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(id);reject(Error('本机助手响应超时'));},['file','task'].includes(command)?60*60*1000:120000);waiters.set(id,{resolve,reject,timer});try{nativePort.postMessage({id,command,...values});}catch(e){clearTimeout(timer);waiters.delete(id);reject(e);}});}
 async function persist(){for(const task of tasks){task.owner=owner;const index=history.findIndex(t=>t.owner===owner&&t.id===task.id&&t.source===task.source);const copy=structuredClone(task);if(index<0)history.push(copy);else history[index]=copy;}await chrome.storage.local.set({localCaptureTasks:tasks,localCaptureOwner:owner,localCaptureHistory:history});}
 function ensureRunning(){if(paused)throw Error('试跑已暂停');}
 async function closeTab(tab){if(tab)try{await chrome.tabs.remove(tab.id);}catch{}}

 function inspectPage(action,part=1,expectedCount=null){
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'&&!e.disabled&&e.getAttribute('aria-disabled')!=='true';};
  const label=e=>String(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||'').trim().replace(/\s+/g,' ');
  const controls=[...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
  const download=controls.filter(e=>!/(?:slice|glyph)/i.test(e.id)&&/^(?:下载|下载资源|下载原图|原图下载|保存原图|下载图片|Download|Download image)$/i.test(label(e)));
  const next=controls.filter(e=>/^(?:下一页|下一张|下一幅|下一图|Next|Next page)$/i.test(label(e)));
  const ratios=[];for(const e of document.querySelectorAll('[class*="page"],[class*="Page"],[class*="swiper"],[class*="Swiper"],[class*="index"],[class*="Index"]')){if(!visible(e))continue;const text=(e.innerText||'').trim();if(text.length>40)continue;const m=text.match(/^(?:第\s*)?(\d+)\s*[/／]\s*(\d+)\s*(?:张|幅|页)?$/);if(m&&Number(m[2])<=500)ratios.push({part:Number(m[1]),count:Number(m[2])});}
  const unique=new Map(ratios.map(r=>[r.part+'/'+r.count,r]));const position=unique.size===1?[...unique.values()][0]:null;
  const text=document.body?.innerText||'';const total=text.match(/(?:共|总计)\s*(\d{1,3})\s*(?:张图片|张图|张|幅|页)/);
  // Read only the public, artwork-bound source metadata already rendered in the page.
  const source=location.href.match(/\/view\/([A-Z0-9_]+)\/([a-f0-9]{24})/i),metadata=[];let budget=4000;
  function visit(value,depth=0){if(!value||typeof value!=='object'||depth>18||--budget<0)return;if(!Array.isArray(value)&&source&&value.src===source[1].toUpperCase()&&value.id===source[2]&&value.suha?.Id===source[2]){const h=value.suha.hdp;let n=null;if(h?.src==='PIC'&&/^[a-f0-9]{24}$/i.test(h.id||'')&&h.hdpic?.Id===h.id)n=1;else if(h?.src==='COLL'&&h.hdpcoll?.layoutMode==='PAGE'){const ids=h.hdpcoll.hdpIds;if(Array.isArray(ids)&&ids.length>0&&ids.length<=500&&ids.every(id=>typeof id==='string'&&/^[a-f0-9]{24}$/i.test(id))&&new Set(ids).size===ids.length)n=ids.length;}if(n)metadata.push({count:n,title:String(value.suha.name||'').slice(0,180)});return;}for(const child of Object.values(value))visit(child,depth+1);}
  function parseRecords(text){for(const line of text.split('\n')){try{visit(JSON.parse(line.slice(line.indexOf(':')+1)));}catch{}}}
  let flight='';for(const script of [...(document.scripts||document.querySelectorAll('script'))]){const raw=String(script.textContent||'');const start=raw.indexOf('self.__next_f.push(');if(start<0||raw.length>2e6)continue;try{const args=JSON.parse(raw.slice(start+19,raw.lastIndexOf(')')));if(args[0]===1&&typeof args[1]==='string'){parseRecords(args[1]);flight+=args[1];}}catch{}}
  if(flight.length<4e6)parseRecords(flight);
  const metadataCounts=new Set(metadata.map(m=>m.count)),metadataCount=metadataCounts.size===1?metadata[0].count:null;
  let count=position?.count||Number(total?.[1])||metadataCount||null;
  let error=metadataCounts.size>1?'网页同一作品的母图数量信息冲突，请核对作品版本':metadataCount&&position&&metadataCount!==position.count?'网页母图数量与页码显示不一致，请核对作品版本':null;
  if(error)count=null;
  const result={url:location.href,title:metadata[0]?.title||document.title.split(/\s+-\s+/)[0].trim().slice(0,180),position,count,metadataCount,countSource:count?(position||total?'pager':'page-metadata'):null,downloadCount:download.length,nextCount:next.length,labels:controls.map(label).filter(Boolean).slice(0,25),...(error?{error}:{})};
  // The current site opens a project-wide original-file list before downloading.
  // Only the original section is read; slice, glyph and reduced-size rows are excluded.
  const frames=[...document.querySelectorAll('[data-download-list-scroll-frame="true"]')].filter(e=>e.getAttribute('data-download-list-scroll-frame')==='true'&&visible(e));
  let originalList=null,targets=[];
  if(frames.length>1)originalList={count:null,files:[],error:'出现多个下载列表，请关闭多余窗口后重试'};
  else if(frames.length===1){
   const headers=[...frames[0].querySelectorAll('div')].filter(e=>{const t=(e.innerText||'').replace(/\s+/g,'');return t.length<160&&t.includes('原始高清图像')&&t.includes('作品原始高清文件')&&/\d+个文件/.test(t)&&!t.includes('.jpg');});
   if(headers.length!==1)originalList={count:null,files:[],error:'尚未找到唯一的原始高清文件列表'};
   else{
    const n=Number(headers[0].innerText.match(/(\d+)\s*个文件/)?.[1]);let row=headers[0].nextElementSibling;const files=[];
    while(row&&files.length<=500){const names=[...row.querySelectorAll('p')].map(e=>(e.innerText||'').trim());const filename=names.find(t=>/\.(?:jpe?g|png|webp)$/i.test(t));if(!filename)break;const index=Number(filename.match(/_(\d+)\.(?:jpe?g|png|webp)$/i)?.[1]);const description=names.find(t=>t.includes('比例：'))||'';const original=/[（(]原大[）)]/.test(description)&&!/[（(]原大\s*1\s*[\/／]/.test(description);const buttons=[...row.querySelectorAll('button')].filter(e=>/^(?:点击下载|重新下载|重试|准备下载|取消下载)$/.test(label(e)));const button=buttons.length===1?buttons[0]:null;const ready=!!button&&visible(button)&&/^(?:点击下载|重新下载|重试)$/.test(label(button));files.push({part:index,filename,original,ready,status:button?label(button):'无法识别下载按钮'});targets.push({part:index,button});row=row.nextElementSibling;}
    const valid=Number.isInteger(n)&&n>=1&&n<=500&&files.length===n&&new Set(files.map(f=>f.part)).size===n&&files.every(f=>f.part>=1&&f.part<=n);
    originalList={count:n,files,...(!valid?{error:'原始文件数量或编号不完整，请等待列表加载并核对'}:files.some(f=>!f.original)?{error:'网站仅提供缩小比例文件，未作为原图下载'}:{})};
   }
  }
  if(originalList){const dialog=frames[0]?.closest?.('[role="dialog"]');result.downloadWaitSeconds=Number((dialog?.innerText||'').match(/等待\s*(\d+)\s*秒后可下载新作品/)?.[1])||0;result.originalList=originalList;if(!originalList.error){result.count=originalList.count;result.countSource='original-list';}}
  if(action==='original'){
   if(!originalList||originalList.error)return {...result,error:originalList?.error||'原始高清文件列表尚未打开'};
   if(expectedCount&&expectedCount!==originalList.count)return {...result,error:'原始高清文件总数与试跑记录不一致'};
   const file=originalList.files.find(f=>f.part===part),target=targets.find(t=>t.part===part);if(!file?.ready||!target?.button)return {...result,error:'第 '+part+' 张原图正在准备或下载，暂不能再次点击'};
   target.button.scrollIntoView?.({block:'nearest'});target.button.click();return {...result,clicked:true,filename:file.filename};
  }
  if(result.error)return result;
  if(action==='download'){if(download.length!==1)return {...result,error:'无法唯一识别原图下载按钮，请在作品页点击正常下载按钮'};download[0].click();return {...result,clicked:true};}
  if(action==='next'){if(next.length!==1)return {...result,error:'无法唯一识别下一张母图按钮'};next[0].click();return {...result,clicked:true};}
  if(action==='format'){const options=controls.filter(e=>/^(?:JPEG|JPG|PNG|下载JPEG|下载JPG|下载原图|保存原图)$/i.test(label(e)));if(options.length===1){options[0].click();return {...result,clicked:true};}return result;}
  return result;
 }
 async function snapshot(tabId,action='inspect',part=1,count=null){const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:inspectPage,args:[action,part,count]});return result;}
 async function ready(tabId){let last,stable=0,lastInjectionError='';for(let i=0;i<60;i++){if(paused)throw Error('试跑已暂停');try{last=await snapshot(tabId);if(last.error)throw Error(last.error);if(last?.downloadCount===1||last?.originalList){if(++stable>=2)return last;}else stable=0;}catch(e){lastInjectionError=e.message;}await delay(1000);}throw Error('未找到就绪的原图下载工具栏。请确认珍宝馆已登录，作品可以正常下载。'+(lastInjectionError?' '+lastInjectionError:'')+(last?.labels?.length?' 页面按钮：'+last.labels.slice(0,8).join('、'):''));}
 async function prepareDownloadList(tabId,first){if(!first.originalList){const clicked=await snapshot(tabId,'download');if(clicked.error)throw Error(clicked.error);}await progress({phase:'preparing',message:'已点击网站下载，等待原始高清文件列表'});let last;for(let i=0;i<60;i++){if(paused)throw Error('试跑已暂停');last=await snapshot(tabId);if(last.originalList&&!last.originalList.error&&!last.downloadWaitSeconds)return last;if(last.downloadWaitSeconds)await progress({phase:'preparing',message:'网站要求等待 '+last.downloadWaitSeconds+' 秒后下载新作品'});if(last.originalList?.files?.some(f=>!f.original))throw Error(last.originalList.error);await delay(1000);}throw Error(last?.originalList?.error||'原始高清文件列表未打开。请核对网站登录、下载权限和提示信息');}
 async function identifyDownload(tabId,task,part,count){
  ensureRunning();const before=await snapshot(tabId);ensureRunning();const expectedFilename=before.originalList?.files.find(f=>f.part===part)?.filename;if(!expectedFilename)throw Error('无法确认当前分段的原始文件名');
  const nonce=crypto.randomUUID();proofs=[];active={tabId,taskId:task.id,source:task.source,part,count,nonce,expectedFilename,started:Date.now()};
  await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:n=>window.postMessage({type:'ART_ORIGINAL_ARM',nonce:n},location.origin),args:[nonce]});ensureRunning();
  const result=await snapshot(tabId,'original',part,count);if(result.error)throw Error(result.error);await progress({phase:'downloading',message:result.error||'等待网站生成原图下载：第 '+part+' / '+count+' 张',taskId:task.id,part,count,labels:result.labels});
  const deadline=Date.now()+30*60*1000;let started=false,lastBytes=-1,lastChange=Date.now();
  while(Date.now()<deadline){if(paused)throw Error('试跑已暂停');const tab=await chrome.tabs.get(tabId);if(key(tab.url)!==key(task.source))throw Error('下载过程中作品页发生切换，已停止关联');
   if(proofs.length){const list=await chrome.downloads.search({startedAfter:new Date(active.started-1000).toISOString()});const found=list.filter(d=>proofs.some(p=>p.href===d.url||p.href===d.finalUrl));if(found.length>1)throw Error('网站一次生成多个下载，需要逐张确认');
    if(found.length===1){const d=found[0];started=true;const bytes=Number(d.bytesReceived)||0;if(bytes!==lastBytes){lastBytes=bytes;lastChange=Date.now();}if(d.state==='interrupted')throw Error('下载中断：'+(d.error||'未知原因'));if(d.state==='complete'){if(!d.exists||!d.filename)throw Error('下载完成但本机原文件不可读取');if(!matchesFilename(d.filename,expectedFilename))throw Error('下载文件名与第 '+part+' 张原始文件不一致，未上传关联');return d;}if(Date.now()-lastChange>5*60*1000)throw Error('原图下载连续 5 分钟没有进度，已保留失败记录，可稍后重试');}
   }
   if(!started&&Date.now()-active.started>3*60*1000)throw Error('3 分钟内未启动可确认来源的原图下载，已保留失败记录，可稍后重试');
   if(!proofs.length&&Date.now()-active.started>5000){const page=await snapshot(tabId);const file=page.originalList?.files.find(f=>f.part===part);if(file?.status==='重试')throw Error('网站原图下载失败，请查看作品页提示后重试');}
   await delay(1000);
  }throw Error('没有收到可确认来源的完整原图。请在作品页完成正常下载，再重试此作品。');
 }
 async function execute(list){running=true;paused=false;let stopReason=null;try{await native('resume');ensureRunning();
  for(const task of list){if(paused)break;current=task;task.status='running';task.error=null;task.errorStage=null;task.startedAt=new Date().toISOString();await persist();await progress({phase:'opening',message:'正在打开 '+(task.title||task.source_id),taskId:task.id});
   let tab,stage='opening',part=null;try{ensureRunning();tab=await chrome.tabs.create({url:task.source,active:true});ensureRunning();let first=await ready(tab.id);ensureRunning();if(key(first.url)!==key(task.source))throw Error('作品来源地址不匹配');stage='preparing';first=await prepareDownloadList(tab.id,first);ensureRunning();if(key(first.url)!==key(task.source))throw Error('下载列表作品来源发生切换');task.title=task.title||first.title;
    const count=first.originalList?.count;if(!Number.isInteger(count)||count<1||count>500)throw Error('无法确认母图总张数，请在试跑清单填写实际张数后重新开始');
    if(task.count&&task.count!==count)throw Error('填写或已有记录的母图张数与原始文件列表不一致');task.count=count;
    stage='checking';const completed=await native('task',{task:{taskId:task.id,source:task.source,count}});ensureRunning();
    for(part=1;part<=count;part++){
     ensureRunning();stage='checking';await native('resume');ensureRunning();stage='downloading';let snap=await snapshot(tab.id);ensureRunning();if(snap.originalList?.error||snap.originalList?.count!==count)throw Error(snap.originalList?.error||'原始文件列表在运行期间发生变化');
     const saved=task.files?.find(f=>f.part===part);let file=saved;
     if(completed.parts.includes(part)){if(!file){file={part,count,complete:true};task.files??=[];task.files.push(file);}else file.complete=true;await persist();await progress({phase:'skipped',message:'已回读核验分段 '+part+' / '+count+'，跳过重复下载和上传'});}
     else{
      if(!file?.filename){const d=await identifyDownload(tab.id,task,part,count);ensureRunning();file={part,count,filename:d.filename,downloadId:d.id,title:task.title||snap.title,complete:false};task.files??=[];if(saved)task.files[task.files.indexOf(saved)]=file;else task.files.push(file);await persist();}
      active=null;proofs=[];stage='uploading';ensureRunning();await progress({phase:'uploading',message:'上传并核验第 '+part+' / '+count+' 张',taskId:task.id,part,count});ensureRunning();
      const result=await native('file',{file:{taskId:task.id,source:task.source,part,count,filename:file.filename,title:file.title}});file.complete=true;file.masterId=result.master_id;await persist();ensureRunning();
     }
    }
    task.status='complete';task.error=null;task.errorStage=null;task.completedAt=new Date().toISOString();await persist();await progress({phase:'work_complete',message:'此作品 '+count+' 张母图已核验关联',taskId:task.id});await closeTab(tab);
   }catch(e){active=null;proofs=[];task.status=paused?'paused':'failed';task.error=e.message;task.errorStage=stage;if(!paused){task.failedAt=new Date().toISOString();task.failures??=[];task.failures.push({time:task.failedAt,stage,part,error:e.message});}await persist();
    const canSkip=!paused&&['opening','preparing','downloading'].includes(stage);await progress({phase:canSkip?'work_skipped':task.status,message:(task.title||task.source_id)+'：'+e.message+(canSkip?'；已记录并跳过，继续下一幅':''),taskId:task.id});
    if(canSkip){await closeTab(tab);continue;}stopReason=e.message;break;
   }
  }
 }catch(e){stopReason=e.message;await progress({phase:paused?'paused':'failed',message:e.message});}
 finally{active=null;proofs=[];if(paused)await native('pause').catch(()=>{});running=false;current=null;await progress({phase:paused?'paused':'finished',message:paused?'试跑已暂停，原文件与进度保留':stopReason?'试跑已停止：'+stopReason:'试跑结束：完成 '+tasks.filter(t=>t.status==='complete').length+' 幅，失败 '+tasks.filter(t=>t.status==='failed').length+' 幅（记录已保留）',tasks});}}
 async function handle(m,sender){
  if(m.type==='localCaptureProof'){if(!active||sender.tab?.id!==active.tabId||m.nonce!==active.nonce||key(m.source)!==key(active.source))return {ok:false};if(typeof m.href!=='string'||m.href.length>12000||!/^https:\/\/|^blob:https:\/\//.test(m.href))return {ok:false};if(m.filename&&!matchesFilename(m.filename,active.expectedFilename))return {ok:false};if(!proofs.some(p=>p.href===m.href))proofs.push({href:m.href});return {ok:true};}
  if(sender.tab?.url?.split('?')[0]!==QUEUE||sender.frameId!==0)return {ok:false,error:'只允许收藏队列启动本机采集'};
  try{switch(m.command){
   case 'hello':return {ok:true,result:await native('hello')};
   case 'directory':return {ok:true,result:await native('directory')};
   case 'status':{const data=await chrome.storage.local.get(['localCaptureTasks','localCaptureState','localCaptureOwner','localCaptureHistory']);if(!running&&!starting){tasks=data.localCaptureTasks||[];owner=data.localCaptureOwner||null;history=data.localCaptureHistory||[];if(data.localCaptureState)state={...data.localCaptureState,phase:'paused',message:'已恢复上次试跑记录；失败下载已保留，可重试'};}const requestedOwner=m.ownerId||owner,matching=owner===requestedOwner;return {ok:true,result:{owner:requestedOwner,state:matching?{...state,owner,tasks,history:history.filter(t=>t.owner===owner)}:null,tasks:matching?tasks:[],history:history.filter(t=>t.owner===requestedOwner),running:matching&&(running||starting)}};}
   case 'pause':pauseEpoch++;paused=true;await native('pause');await progress({phase:'paused',message:'已请求暂停，正在保留进度'});return {ok:true};
   case 'start':case 'resume':case 'retry':{
    if(running||starting)throw Error('已有试跑任务正在运行');if(typeof m.accessToken!=='string')throw Error('请先登录云端队列');const requestedEpoch=pauseEpoch;starting=true;try{const session=await native('session',{accessToken:m.accessToken});if(requestedEpoch!==pauseEpoch)throw Error('试跑已暂停');if(!session?.owner)throw Error('本机助手未确认当前账号，请重新检测助手');const data=await chrome.storage.local.get(['localCaptureTasks','localCaptureOwner','localCaptureHistory']);const priorOwner=data.localCaptureOwner;owner=session.owner;history=data.localCaptureHistory||[];const previous=!priorOwner||priorOwner===owner?data.localCaptureTasks||[]:[];for(const t of previous){if(!history.some(h=>h.owner===owner&&h.id===t.id&&h.source===t.source))history.push({...t,owner});}
    if(m.command==='start'){
     if(!Array.isArray(m.tasks)||!m.tasks.length||m.tasks.length>3)throw Error('试跑版每批 1–3 幅作品');
     tasks=m.tasks.map(t=>{if(!/^[0-9a-f-]{36}$/i.test(t.id||'')||key(t.source)!=='SUHA:'+t.source_id)throw Error('试跑任务来源无效');const prior=history.find(p=>p.owner===owner&&p.id===t.id&&p.source===t.source);if(prior&&t.count&&prior.count&&t.count!==prior.count&&prior.files?.length)throw Error('已有进度的母图张数不可改变');return {id:t.id,source:t.source,source_id:t.source_id,title:String(t.title||'').slice(0,180),count:t.count||prior?.count||null,files:prior?.files||[],failures:prior?.failures||[],failedAt:prior?.failedAt||null,error:prior?.error||null,errorStage:prior?.errorStage||null,status:prior?.status==='failed'?'failed':'pending'};});
    }else{if(priorOwner&&priorOwner!==owner)throw Error('上次试跑属于其他账号，请准备当前账号的新批次');tasks=previous;}
    if(!tasks.length)throw Error('没有可恢复的试跑任务');if(m.counts!==undefined){if(!Array.isArray(m.counts)||m.counts.length>3)throw Error('恢复张数无效');for(const value of m.counts){const task=tasks.find(t=>t.id===value.id);if(!task||!Number.isInteger(value.count)||value.count<1||value.count>500)throw Error('恢复张数无效');if(task.count&&task.count!==value.count&&task.files?.length)throw Error('已有分段进度的母图张数不可改变');task.count=value.count;}}tasks.sort((a,b)=>Number(a.status==='failed')-Number(b.status==='failed'));await persist();if(requestedEpoch!==pauseEpoch)throw Error('试跑已暂停');paused=false;execute(m.command==='start'?tasks:tasks.filter(t=>t.status!=='complete'));return {ok:true,result:{started:true}};}finally{starting=false;if(requestedEpoch!==pauseEpoch)await native('pause').catch(()=>{});}
   }
   default:throw Error('未知采集命令');
  }}catch(e){return {ok:false,error:e.message};}
 }
 return {handle,inspectPage,key,matchesFilename};
})();

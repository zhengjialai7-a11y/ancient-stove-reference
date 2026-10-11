'use strict';
// Serial, supervised three-work pilot. Binding uses an exact observed download link.
const CaptureAutomation=(()=>{
 const HOST='com.art_reference.capture',QUEUE='https://zhengjialai7-a11y.github.io/ancient-stove-reference/queue.html';
 let nativePort=null,running=false,paused=false,active=null,proofs=[],tasks=[],current=null,state={version:'0.7.0',phase:'idle',message:'尚未开始本机试跑',files:[]};const waiters=new Map();
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const key=url=>{const m=String(url||'').match(/^https:\/\/g2\.ltfc\.net\/view\/([A-Z0-9_]{3,20})\/([a-f0-9]{24})(?:[/?#]|$)/i);return m?m[1].toUpperCase()+':'+m[2].toLowerCase():null;};
 async function progress(values){state={...state,...values};await chrome.storage.local.set({localCaptureState:state});const tabs=await chrome.tabs.query({url:QUEUE+'*'});for(const t of tabs)chrome.tabs.sendMessage(t.id,{type:'localCaptureProgress',state}).catch(()=>{});}
 function connect(){if(nativePort)return;nativePort=chrome.runtime.connectNative(HOST);nativePort.onMessage.addListener(m=>{if(m.event){if(m.error)progress({phase:'failed',message:m.error});else if(m.state)progress({upload:m.state});return;}const waiter=waiters.get(m.id);if(!waiter)return;waiters.delete(m.id);clearTimeout(waiter.timer);m.ok?waiter.resolve(m.result):waiter.reject(Error(m.error||'本机助手失败'));});nativePort.onDisconnect.addListener(()=>{const message=chrome.runtime.lastError?.message||'本机助手连接断开，请检查安装或浏览器状态';nativePort=null;paused=true;for(const waiter of waiters.values()){clearTimeout(waiter.timer);waiter.reject(Error(message));}waiters.clear();progress({phase:'failed',message});});}
 function native(command,values={}){connect();const id=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(id);reject(Error('本机助手响应超时'));},['file','task'].includes(command)?60*60*1000:120000);waiters.set(id,{resolve,reject,timer});try{nativePort.postMessage({id,command,...values});}catch(e){clearTimeout(timer);waiters.delete(id);reject(e);}});}
 async function persist(){await chrome.storage.local.set({localCaptureTasks:tasks});}
 function inspectPage(action){
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'&&!e.disabled&&e.getAttribute('aria-disabled')!=='true';};
  const label=e=>String(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||'').trim().replace(/\s+/g,' ');
  const controls=[...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
  const download=controls.filter(e=>!/(?:slice|glyph)/i.test(e.id)&&/^(?:下载|下载资源|下载原图|原图下载|保存原图|下载图片|Download|Download image)$/i.test(label(e)));
  const next=controls.filter(e=>/^(?:下一页|下一张|下一幅|下一图|Next|Next page)$/i.test(label(e)));
  const ratios=[];for(const e of document.querySelectorAll('[class*="page"],[class*="Page"],[class*="swiper"],[class*="Swiper"],[class*="index"],[class*="Index"]')){if(!visible(e))continue;const text=(e.innerText||'').trim();if(text.length>40)continue;const m=text.match(/^(?:第\s*)?(\d+)\s*[/／]\s*(\d+)\s*(?:张|幅|页)?$/);if(m&&Number(m[2])<=500)ratios.push({part:Number(m[1]),count:Number(m[2])});}
  const unique=new Map(ratios.map(r=>[r.part+'/'+r.count,r]));const position=unique.size===1?[...unique.values()][0]:null;
  const text=document.body?.innerText||'';const total=text.match(/(?:共|总计)\s*(\d{1,3})\s*(?:张图片|张图|张|幅|页)/);const count=position?.count||Number(total?.[1])||null;
  const result={url:location.href,title:document.title.split(/\s+-\s+/)[0].trim().slice(0,180),position,count,downloadCount:download.length,nextCount:next.length,labels:controls.map(label).filter(Boolean).slice(0,25)};
  if(action==='download'){if(download.length!==1)return {...result,error:'无法唯一识别原图下载按钮，请在作品页点击正常下载按钮'};download[0].click();return {...result,clicked:true};}
  if(action==='next'){if(next.length!==1)return {...result,error:'无法唯一识别下一张母图按钮'};next[0].click();return {...result,clicked:true};}
  if(action==='format'){const options=controls.filter(e=>/^(?:JPEG|JPG|PNG|下载JPEG|下载JPG|下载原图|保存原图)$/i.test(label(e)));if(options.length===1){options[0].click();return {...result,clicked:true};}return result;}
  return result;
 }
 async function snapshot(tabId,action='inspect'){const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:inspectPage,args:[action]});return result;}
 async function ready(tabId){let last;for(let i=0;i<60;i++){if(paused)throw Error('试跑已暂停');try{last=await snapshot(tabId);if(last?.downloadCount||last?.count)return last;}catch{}await delay(1000);}throw Error('作品页面尚未就绪。请确认珍宝馆已登录，并在作品页正常打开原图。');}
 async function identifyDownload(tabId,task,part,count){
  const nonce=crypto.randomUUID();proofs=[];active={tabId,taskId:task.id,source:task.source,part,count,nonce,started:Date.now()};
  await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:n=>window.postMessage({type:'ART_ORIGINAL_ARM',nonce:n},location.origin),args:[nonce]});
  const result=await snapshot(tabId,'download');await progress({phase:'downloading',message:result.error||'等待网站生成原图下载：第 '+part+' / '+count+' 张',taskId:task.id,part,count,labels:result.labels});
  const deadline=Date.now()+30*60*1000;let formatTried=false;
  while(Date.now()<deadline){if(paused)throw Error('试跑已暂停');const tab=await chrome.tabs.get(tabId);if(key(tab.url)!==key(task.source))throw Error('下载过程中作品页发生切换，已停止关联');
   if(proofs.length){const list=await chrome.downloads.search({startedAfter:new Date(active.started-1000).toISOString()});const found=list.filter(d=>proofs.some(p=>p.href===d.url||p.href===d.finalUrl));if(found.length>1)throw Error('网站一次生成多个下载，需要逐张确认');
    if(found.length===1){const d=found[0];if(d.state==='interrupted')throw Error('下载中断：'+(d.error||'未知原因'));if(d.state==='complete'){if(!d.exists||!d.filename)throw Error('下载完成但本机原文件不可读取');return d;}}
   }
   if(!formatTried&&Date.now()-active.started>2500){formatTried=true;await snapshot(tabId,'format').catch(()=>{});}
   await delay(1000);
  }throw Error('没有收到可确认来源的完整原图。请在作品页完成正常下载，再重试此作品。');
 }
 async function execute(list){running=true;paused=false;try{await native('resume');
  for(const task of list){if(paused)break;current=task;task.status='running';await persist();await progress({phase:'opening',message:'正在打开 '+(task.title||task.source_id),taskId:task.id});
   let tab;try{tab=await chrome.tabs.create({url:task.source,active:true});let first=await ready(tab.id);if(key(first.url)!==key(task.source))throw Error('作品来源地址不匹配');
    const count=first.count||task.count;if(!Number.isInteger(count)||count<1||count>500)throw Error('无法确认母图总张数，请在试跑清单填写实际张数后重新开始');
    if(task.count&&first.count&&task.count!==first.count)throw Error('填写的母图张数与网页显示不一致');if(first.position&&first.position.part!==1)throw Error('作品页没有从第一张开始，请先核对页序');task.count=count;
    const completed=await native('task',{task:{taskId:task.id,source:task.source,count}});
    for(let part=1;part<=count;part++){
     if(paused)throw Error('试跑已暂停');await native('resume');let snap=await snapshot(tab.id);if(snap.position&&snap.position.part!==part)throw Error('母图页序与待处理分段不一致');
     const saved=task.files?.find(f=>f.part===part);let file=saved;
     if(completed.parts.includes(part)){await progress({phase:'skipped',message:'已回读核验分段 '+part+' / '+count+'，跳过重复下载和上传'});}
     else{
      if(!file){const d=await identifyDownload(tab.id,task,part,count);file={part,count,filename:d.filename,downloadId:d.id,title:task.title||snap.title,complete:false};task.files??=[];task.files.push(file);await persist();}
      active=null;await progress({phase:'uploading',message:'上传并核验第 '+part+' / '+count+' 张',taskId:task.id,part,count});
      const result=await native('file',{file:{taskId:task.id,source:task.source,part,count,filename:file.filename,title:file.title}});file.complete=true;file.masterId=result.master_id;await persist();
     }
     if(part<count){const next=await snapshot(tab.id,'next');if(next.error)throw Error(next.error);let moved=false;for(let n=0;n<20;n++){await delay(500);const s=await snapshot(tab.id);if(s.position?.part===part+1){moved=true;break;}if(!s.position&&n>=3){moved=true;break;}}if(!moved)throw Error('下一张母图未切换成功');}
    }
    task.status='complete';task.error=null;await persist();await progress({phase:'work_complete',message:'此作品 '+count+' 张母图已核验关联',taskId:task.id});await chrome.tabs.remove(tab.id);
   }catch(e){task.status=paused?'paused':'failed';task.error=e.message;await persist();await progress({phase:task.status,message:e.message,taskId:task.id});if(paused)break;}
  }
 }catch(e){await progress({phase:'failed',message:e.message});}
 finally{active=null;running=false;current=null;await progress({phase:paused?'paused':'finished',message:paused?'试跑已暂停，原文件与进度保留':'试跑结束：完成 '+tasks.filter(t=>t.status==='complete').length+' 幅，未完成 '+tasks.filter(t=>t.status!=='complete').length+' 幅'});}}
 async function handle(m,sender){
  if(m.type==='localCaptureProof'){if(!active||sender.tab?.id!==active.tabId||m.nonce!==active.nonce||key(m.source)!==key(active.source))return {ok:false};if(typeof m.href!=='string'||m.href.length>12000||!/^https:\/\/|^blob:https:\/\//.test(m.href))return {ok:false};if(!proofs.some(p=>p.href===m.href))proofs.push({href:m.href});return {ok:true};}
  if(sender.tab?.url?.split('?')[0]!==QUEUE||sender.frameId!==0)return {ok:false,error:'只允许收藏队列启动本机采集'};
  try{switch(m.command){
   case 'hello':return {ok:true,result:await native('hello')};
   case 'directory':return {ok:true,result:await native('directory')};
   case 'status':if(!tasks.length){const data=await chrome.storage.local.get(['localCaptureTasks','localCaptureState']);tasks=data.localCaptureTasks||[];if(data.localCaptureState&&!running)state={...data.localCaptureState,phase:'paused',message:'已恢复上次试跑进度；登录后点击继续'};}return {ok:true,result:{state,tasks,running}};
   case 'pause':paused=true;await native('pause');await progress({phase:'paused',message:'已请求暂停，正在保留进度'});return {ok:true};
   case 'start':case 'resume':case 'retry':{
    if(running)throw Error('已有试跑任务正在运行');if(typeof m.accessToken!=='string')throw Error('请先登录云端队列');await native('session',{accessToken:m.accessToken});
    if(m.command==='start'){
     if(!Array.isArray(m.tasks)||!m.tasks.length||m.tasks.length>3)throw Error('试跑版每批 1–3 幅作品');
     const {localCaptureTasks:previous=[]}=await chrome.storage.local.get('localCaptureTasks');
     tasks=m.tasks.map(t=>{if(!/^[0-9a-f-]{36}$/i.test(t.id||'')||key(t.source)!=='SUHA:'+t.source_id)throw Error('试跑任务来源无效');const prior=previous.find(p=>p.id===t.id&&p.source===t.source);if(prior&&t.count&&prior.count&&t.count!==prior.count)throw Error('已有进度的母图张数不可改变');return {id:t.id,source:t.source,source_id:t.source_id,title:String(t.title||'').slice(0,180),count:t.count||prior?.count||null,files:prior?.files||[],status:'pending'};});
    }else if(!tasks.length){tasks=(await chrome.storage.local.get('localCaptureTasks')).localCaptureTasks||[];}
    if(!tasks.length)throw Error('没有可恢复的试跑任务');await persist();paused=false;execute(m.command==='start'?tasks:tasks.filter(t=>t.status!=='complete'));return {ok:true,result:{started:true}};
   }
   default:throw Error('未知采集命令');
  }}catch(e){return {ok:false,error:e.message};}
 }
 return {handle,inspectPage,key};
})();

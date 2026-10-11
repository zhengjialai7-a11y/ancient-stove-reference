(function(root){
 'use strict';
 const labels={pending:'待处理',needs_review:'关联待确认',downloaded:'已下载待上传',failed:'失败待处理',uploaded_unverified:'已上传 · 待回读核验',uploaded:'母图已核验入库',drafts_ready:'草稿待审核',published:'已有发布参考'};
 function sourceKey(url){const m=String(url||'').match(/^https:\/\/g2\.ltfc\.net\/view\/([A-Z0-9_]+)\/([a-f0-9]{24})(?:[/?#]|$)/i);return m?m[1].toUpperCase()+':'+m[2].toLowerCase():null;}
 function normalize(record,idx){
  if(!record||typeof record!=='object'||Array.isArray(record))return null;
  const source_id=String(record.source_id||record.sourceId||record.resourceId||record.resource?.id||'').trim().toLowerCase();
  const source_type=String(record.source_type||record.sourceType||record.resource?.type||record.resource?.src||'').trim().toUpperCase();
  if(!/^[a-f0-9]{24}$/.test(source_id)||!/^[A-Z0-9_]{3,20}$/.test(source_type))return null;
  const status=record.phase||record.status;
  return {source_id,source_type,source_url:source_type==='SUHA'?'https://g2.ltfc.net/view/SUHA/'+source_id:null,
   title:String(record.title||'').trim().slice(0,180),author:String(record.author||'').trim().slice(0,120),era:String(record.era||'').slice(0,100),
   favorite_line_id:String(record.favorite_line_id||record.lineId||record.id||'').slice(0,80)||null,queue_order:Number(record.queue_order??record.order??idx)||0,
   phase:['pending','needs_review','downloaded','failed'].includes(status)?status:source_type==='SUHA'?'pending':'needs_review',
   paused:record.paused===true,notes:String(record.notes||'').slice(0,2000),download_filename:record.download_filename||record.downloadFilename||null,
   legacy_status:record.legacy_status||record.status||null};
 }
 function parseJSON(obj){
  const data=Array.isArray(obj)?obj:obj?.items||obj?.observedFavorites?.rows||obj?.rows;
  if(!Array.isArray(data))throw Error('JSON 中找不到收藏记录数组');
  const unique=new Map();let invalid=0,duplicate=0;
  data.forEach((r,i)=>{const n=normalize(r,i);if(!n){invalid++;return;}const key=n.source_type+':'+n.source_id;if(unique.has(key)){duplicate++;return;}unique.set(key,n);});
  if(!unique.size)throw Error('未找到有效来源作品 ID');return {items:[...unique.values()],invalid,duplicate};
 }
 function importerURL(row){const q=new URLSearchParams();if(!row.workspace_only)q.set('capture_task',row.id);if(row.resolved_project_id)q.set('project_id',row.resolved_project_id);if(row.source_url&&!row.workspace_only)q.set('source_url',row.source_url);return './importer.html?'+q;}
 function workspaceRows(tasks,projects,masters,crops){
  const linked=new Set(tasks.map(t=>t.resolved_project_id).filter(Boolean)),parts=new Map(),cuts=new Map();
  for(const m of masters){if(!parts.has(m.project_id))parts.set(m.project_id,[]);parts.get(m.project_id).push(m);}
  for(const c of crops){if(!cuts.has(c.master_id))cuts.set(c.master_id,[]);cuts.get(c.master_id).push(c);}
  return projects.filter(p=>!linked.has(p.id)&&parts.has(p.id)).map(p=>{
   const ms=parts.get(p.id),cs=ms.flatMap(m=>cuts.get(m.id)||[]),source=sourceKey(p.source_url),same=tasks.filter(t=>t.source_type+':'+t.source_id===source);
   const verified_count=ms.filter(m=>m.verified_at&&m.verified_sha256===m.sha256).length,draft_count=cs.filter(c=>c.status==='draft').length,published_count=cs.filter(c=>c.status==='published').length;
   const live_status=verified_count<ms.length?'uploaded_unverified':draft_count?'drafts_ready':published_count?'published':'uploaded';
   const mismatches=ms.filter(m=>{const meta=filenameMetadata(m.original_filename);return meta&&artworkTitle(meta.title)!==artworkTitle(p.title);}).map(m=>m.original_filename);
   return {id:'project:'+p.id,workspace_only:true,resolved_project_id:p.id,source_type:'母图项目',source_id:source?.split(':')[1]||'未填写来源',source_url:p.source_url,
    display_title:p.title,display_author:p.author,master_count:ms.length,verified_count,draft_count,published_count,live_status,
    link_issue:!source?'尚未填写有效来源链接':same.length?'来源与其他项目冲突，待核对原作链接':'来源不在当前收藏清单',mismatched_files:mismatches,
    masters:ms.map(m=>({id:m.id,filename:m.original_filename,width:m.original_width,height:m.original_height,bytes:m.original_bytes,sha256:m.sha256,verified_at:m.verified_at,verified:!!m.verified_at&&m.verified_sha256===m.sha256}))};
  });
 }
 function filenameMetadata(name){const m=String(name||'').match(/^([^_]{1,12})_([^_]{1,30})_(.+?)(?:_(?:\d+)(?: \(\d+\))?)?\.(?:jpe?g|png|webp)$/i);return m?{era:m[1],author:m[2],title:m[3]}:null;}
 function artworkTitle(title){return String(title||'').replace(/[\s《》「」]/g,'');}
 function nextAction(row){if(row.paused)return '任务已暂停；继续后处理';if(row.candidate_count>1&&!row.project_id)return '确认来源对应的古画项目';if(row.master_count>row.verified_count)return '在母图工作台重新回读核验';if(row.draft_count)return '打开工作台审核裁切草稿';if(row.master_count)return '继续添加分段母图或框选草稿';return row.next_action|| (row.phase==='downloaded'?'上传原图并回读校验':'打开来源取得原始高清文件');}
 root.CaptureCommon={sourceKey,normalize,parseJSON,labels,importerURL,nextAction,workspaceRows,filenameMetadata,artworkTitle};
})(globalThis);

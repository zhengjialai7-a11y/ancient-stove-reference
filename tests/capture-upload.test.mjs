import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {test} from 'node:test';
const html=readFileSync(new URL('../importer.html',import.meta.url),'utf8');
const upload=html.slice(html.indexOf('async function uploadMultiItem('),html.indexOf('$("batchGo").onclick='));
const verify=html.slice(html.indexOf('async function verifyRemoteOriginal('),html.indexOf('async function loadProjects('));
const sha256=async file=>Buffer.from(await webcrypto.subtle.digest('SHA-256',await file.arrayBuffer())).toString('hex');
function setup({corrupt=false,paused=false,existing=false}={}){
 const file=new File([new Uint8Array([1,2,3,4])],'part.jpg',{type:'image/jpeg'}),events=[],writes=[];
 const ctx=vm.createContext({Date,Error,user:{id:'owner'},BUCKET:'images',sha256,drawMultiQueue:()=>{},$:()=>({style:{},value:0}),
  assertCaptureContext:async()=>{events.push('guard');if(paused)throw Error('paused');},assertCaptureMaster:async()=>{},
  markMasterVerified:async()=>events.push('reuse-receipt'),uploadBytes:async()=>events.push('upload'),uploadedOriginals:new WeakMap(),
  originalStorage:{target:async(_,path)=>({storage_provider:'supabase',storage_origin:null,storage_path:path}),verify:async(local,_,hash)=>{events.push('readback');const remote=corrupt?new Blob([new Uint8Array([5,6,7,8])]):file;if(remote.size!==local.size)throw Error('字节数不符');if(await sha256(remote)!==hash)throw Error('SHA-256 不符');}},
  db:{storage:{from:()=>({list:async()=>({data:[{name:await sha256(file)+'.jpg',metadata:{size:file.size}}]}),download:async()=>{events.push('readback');return {data:corrupt?new Blob([new Uint8Array([5,6,7,8])]):file}}})},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:existing?{id:'old',project_id:'project',storage_path:'existing'}:null})})}),insert:payload=>{events.push('insert');writes.push(payload);return {select:()=>({single:async()=>({data:{id:'new',...payload}})})}}})}});
 vm.runInContext(readFileSync(new URL('../capture-common.js',import.meta.url),'utf8'),ctx);
 vm.runInContext(html.slice(html.indexOf('function assertFileArtwork('),html.indexOf('async function loadFile('))+'\n'+verify+'\n'+upload,ctx);ctx.item={file,width:100,height:80};ctx.project={id:'project',title:'fixture',source_url:'https://g2.ltfc.net/view/SUHA/608a619faa7c385c8d943087'};
 return {ctx,writes,events,run:()=>vm.runInContext('uploadMultiItem(item,project,1)',ctx)};
}
test('batch upload registers native metadata and verification receipt only after matching cloud bytes',async()=>{
 const s=setup();await s.run();assert.deepEqual(s.events,['guard','upload','readback','insert']);assert.equal(s.writes[0].verified_sha256,s.writes[0].sha256);assert.ok(s.writes[0].verified_at);assert.equal(s.writes[0].original_bytes,4);assert.equal(s.writes[0].project_id,'project');
});
test('failed cloud SHA verification never registers a master or completion receipt',async()=>{
 const s=setup({corrupt:true});await assert.rejects(s.run(),/SHA-256/);assert.equal(s.writes.length,0);assert.deepEqual(s.events,['guard','upload','readback']);
});
test('paused collection stops before transfer and reusing a master avoids another upload',async()=>{
 const stopped=setup({paused:true});await assert.rejects(stopped.run(),/paused/);assert.deepEqual(stopped.events,['guard']);
 const reuse=setup({existing:true});await reuse.run();assert.deepEqual(reuse.events,['guard','readback','reuse-receipt']);assert.equal(reuse.writes.length,0);
});
test('switching projects after choosing files rejects a different artwork before any transfer',async()=>{
 const s=setup();s.ctx.item.file=new File([new Uint8Array([1,2,3,4])],'明_佚名明人_珍禽货郎图_1.jpg',{type:'image/jpeg'});s.ctx.project.title='罗汉图';
 await assert.rejects(s.run(),/请先切换或新建/);assert.deepEqual(s.events,['guard']);assert.equal(s.writes.length,0);
});

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const context=vm.createContext({URLSearchParams});
vm.runInContext(readFileSync(new URL('../capture-common.js',import.meta.url),'utf8'),context);
const C=context.CaptureCommon,id='608a619faa7c385c8d943087';
test('version identity uses type and complete source ID, rejects unrelated URLs',()=>{
 assert.equal(C.sourceKey('https://g2.ltfc.net/view/SUHA/'+id+'?page=2'),'SUHA:'+id);
 assert.equal(C.sourceKey('https://g2.ltfc.net/view/SUHA/'+id+'0'),null);
 assert.equal(C.sourceKey('https://else.test/view/SUHA/'+id),null);
 assert.notEqual(C.sourceKey('https://g2.ltfc.net/view/SUHA/'+id),C.sourceKey('https://g2.ltfc.net/view/SHIY/'+id));
});
test('legacy claimed upload is preserved as history and cannot fabricate verification',()=>{
 const r=C.normalize({sourceId:id,sourceType:'SUHA',status:'uploaded',verifiedHash:'a'.repeat(64)},0);
 assert.equal(r.phase,'pending');assert.equal(r.legacy_status,'uploaded');assert.equal(r.verified_sha256,undefined);
});
test('deduplicates by source type and ID, keeps different versions and captured response format',()=>{
 const result=C.parseJSON({items:[{source_id:id,source_type:'SUHA'},{sourceId:id,sourceType:'SUHA'},{resourceId:id,sourceType:'SHIY'},{title:'十八学士图'}]});
 assert.equal(result.items.length,2);assert.equal(result.duplicate,1);assert.equal(result.invalid,1);
 assert.equal(result.items[1].phase,'needs_review');assert.equal(result.items[1].source_url,null);
});
test('task links carry stable task and project IDs and accurate source URL',()=>{
 const url=C.importerURL({id:'task-1',resolved_project_id:'project-1',source_url:'https://g2.ltfc.net/view/SUHA/'+id});
 const q=new URLSearchParams(url.split('?')[1]);assert.equal(q.get('capture_task'),'task-1');assert.equal(q.get('project_id'),'project-1');assert.equal(q.get('source_url'),'https://g2.ltfc.net/view/SUHA/'+id);
});
test('next action distinguishes pause, ambiguity, partial verification and existing drafts',()=>{
 assert.match(C.nextAction({paused:true}),/暂停/);
 assert.match(C.nextAction({candidate_count:2}),/确认来源/);
 assert.match(C.nextAction({master_count:2,verified_count:1}),/回读核验/);
 assert.match(C.nextAction({master_count:2,verified_count:2,draft_count:3}),/审核/);
});
test('all scripts compile, and import/batch/reuse paths persist only verified receipts',()=>{
 const html=readFileSync(new URL('../importer.html',import.meta.url),'utf8');
 const app=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];new vm.Script(app);
 for(const name of ['queue.js','capture-workspace.js','extension/sync_bridge.js'])new vm.Script(readFileSync(new URL('../'+name,import.meta.url),'utf8'));
 assert.equal((app.match(/verified_sha256:hash/g)||[]).length,2);
 assert.match(app,/await assertCaptureMaster\(old\);await verifyRemoteOriginal\(selectedFile/);
 assert.match(app,/await verifyRemoteOriginal\(file,old.storage_path,hash\);await markMasterVerified/);
 assert.match(app,/await assertCaptureContext\(\);const file=it.file/);
});
test('legacy bridge only releases allowlisted collection fields to the project queue',async()=>{
 let listener,sent;const fixture={sourceId:id,sourceType:'SUHA',status:'downloaded',access_token:'never-export'};
 const window={addEventListener:(_,fn)=>listener=fn,postMessage:data=>sent=data};
 const ctx=vm.createContext({window,location:{origin:'https://zhengjialai7-a11y.github.io',pathname:'/ancient-stove-reference/queue.html'},chrome:{storage:{local:{get:async()=>({favoriteQueueV04:{items:[fixture]}})}}}});
 vm.runInContext(readFileSync(new URL('../extension/sync_bridge.js',import.meta.url),'utf8'),ctx);
 await listener({source:window,origin:'https://malicious.test',data:{type:'ART_CAPTURE_REQUEST',requestId:'fixture'}});assert.equal(sent,undefined);
 await listener({source:window,origin:ctx.location.origin,data:{type:'ART_CAPTURE_REQUEST',requestId:'fixture'}});assert.equal(sent.queue.items[0].sourceId,id);assert.equal(sent.queue.items[0].access_token,undefined);
});

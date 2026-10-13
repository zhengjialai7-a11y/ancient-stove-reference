import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {flow,tasks} from './local-flow-helper.mjs';

function works(count){return [tasks[0],...Array.from({length:count-1},(_,i)=>{const source_id=(i+100).toString(16).padStart(24,'0');return {id:randomUUID(),source_id,source:'https://g2.ltfc.net/view/SUHA/'+source_id,title:'批量古画 '+(i+2)};})];}
test('fifty-work collection completes serially and retains upload-after-cleanup evidence',async()=>{
 const list=works(50),f=flow({fileCount:1,instantDownloads:true});const result=await f.command('start',{tasks:list,autoCleanup:true});assert.equal(result.ok,true);await f.done;assert.equal(f.stored.localCaptureTasks.length,50);assert.equal(f.stored.localCaptureTasks.every(t=>t.status==='complete'&&t.files[0].localDeleted),true);assert.equal(f.stored.localCaptureHistory.length,50);assert.equal(f.events.filter(e=>e[0]==='native'&&e[1]==='file').length,50);let open=0,peak=0;for(const event of f.events){if(event[0]==='open')peak=Math.max(peak,++open);if(event[0]==='close')open--;}assert.equal(peak,1);assert.equal(open,0);
});
test('one download failure in a fifty-work batch is retained while the other forty-nine finish',async()=>{
 const list=works(50),f=flow({fileCount:1,instantDownloads:true,errorAtPart:1});await f.start(list);await f.done;assert.equal(f.stored.localCaptureTasks[0].status,'failed');assert.equal(f.stored.localCaptureTasks.filter(t=>t.status==='complete').length,49);assert.equal(f.stored.localCaptureHistory[0].failures.length,1);assert.equal(f.events.filter(e=>e[0]==='native'&&e[1]==='file').length,49);
});
test('a large blocked batch and count overrides survive a worker restart and resume only unfinished work',async()=>{
 const list=works(25),first=flow({fileCount:1,instantDownloads:true,nativeError:{command:'file',taskId:list[8].id,part:1}});await first.start(list);await first.done;assert.equal(first.stored.localCaptureTasks.filter(t=>t.status==='complete').length,8);assert.equal(first.stored.localCaptureTasks.filter(t=>t.status==='pending').length,16);const restored=flow({fileCount:1,instantDownloads:true,initialStored:first.stored});const wrong=await restored.command('resume',{counts:[{id:list[0].id,count:2}]});assert.equal(wrong.ok,false);assert.match(wrong.error,/分段进度的母图张数不可改变/);assert.equal(restored.events.some(e=>e[0]==='open'),false);const done=restored.waitForFinish();assert.equal((await restored.command('resume',{counts:list.map(t=>({id:t.id,count:1}))})).ok,true);await done;assert.equal(restored.stored.localCaptureTasks.length,25);assert.equal(restored.stored.localCaptureTasks.every(t=>t.status==='complete'),true);assert.equal(restored.events.filter(e=>e[0]==='native'&&e[1]==='file').length,17);assert.equal(restored.events.filter(e=>e[0]==='click-original').length,16,'the downloaded file whose upload failed is reused');assert.equal(restored.events.filter(e=>e[0]==='open').some(e=>list.slice(0,8).some(t=>t.source===e[1])),false);
});
test('validation keeps its small cap while ordinary collection guards oversized and duplicate batches',async()=>{
 const f=flow({acceptance:true});let result=await f.command('validate',{tasks:works(4)});assert.equal(result.ok,false);assert.match(result.error,/自动验收每批 1–3/);result=await f.start(Array(5001).fill(tasks[0]));assert.equal(result.ok,false);assert.match(result.error,/5000/);result=await f.start([tasks[0],tasks[0]]);assert.equal(result.ok,false);assert.match(result.error,/重复/);assert.equal(f.events.some(e=>e[0]==='open'),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {flow,tasks} from './local-flow-helper.mjs';

test('a new collection of 94/100 restores cloud associations and downloads only parts 95 to 100',async()=>{
 const f=flow({fileCount:100,completed:Array.from({length:94},(_,i)=>i+1)});assert.equal((await f.start([tasks[0]])).ok,true);await f.done;
 assert.deepEqual(f.events.filter(e=>e[0]==='click-original').map(e=>e[1]),[95,96,97,98,99,100]);assert.deepEqual(f.events.filter(e=>e[0]==='native'&&e[1]==='file').map(e=>e[2].file.part),[95,96,97,98,99,100]);
 const saved=f.stored.localCaptureTasks[0];assert.equal(saved.status,'complete');assert.equal(saved.files.filter(f=>f.complete).length,100);assert.equal(saved.files.find(f=>f.part===94).masterId,'master-94');assert.equal(f.events.find(e=>e[0]==='native'&&e[1]==='task')[2].task.recheck,false);
});
test('continuation processes only holes in completion receipts and retains their existing local downloads',async()=>{
 const prior={...tasks[0],count:6,status:'failed',files:[{part:2,count:6,filename:'C:\\Downloads\\清_查士标_百鹊图卷_2.jpg',complete:false},{part:5,count:6,complete:true}]};
 const f=flow({fileCount:6,completed:[1,3,4,6],initialStored:{localCaptureOwner:'test-owner',localCaptureTasks:[prior],localCaptureHistory:[]}});assert.equal((await f.command('resume')).ok,true);await f.done;
 assert.deepEqual(f.events.filter(e=>e[0]==='click-original').map(e=>e[1]),[5]);assert.deepEqual(f.events.filter(e=>e[0]==='native'&&e[1]==='file').map(e=>e[2].file.part),[2,5]);assert.equal(f.stored.localCaptureTasks[0].files.filter(f=>f.complete).length,6);
});
test('a wholly completed collection makes no per-image page calls or new uploads',async()=>{
 const f=flow({fileCount:100,completed:Array.from({length:100},(_,i)=>i+1)});await f.start([tasks[0]]);await f.done;assert.equal(f.stored.localCaptureTasks[0].files.length,100);assert.equal(f.events.some(e=>e[0]==='click-original'||e[0]==='native'&&e[1]==='file'),false);assert.equal(f.events.filter(e=>e[0]==='page'&&e[1]==='snapshot').length,0);
});

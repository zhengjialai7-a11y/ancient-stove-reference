import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CaptureClient} from '../local-agent/core.mjs';

const bytes=Buffer.from('original binary mother image bytes'),hash=createHash('sha256').update(bytes).digest('hex');
function client(fetchImpl,options={}){const c=new CaptureClient({directory:'unused',stateDirectory:'unused',api:'https://api.test',storage:'https://storage.test',fetchImpl,delay:async()=>{},requestTimeout:15,idleTimeout:50,...options});c.session='ephemeral-test-token';return c;}
test('readback keeps receiving original bytes beyond the header deadline and uses an idle deadline',async()=>{
 const events=[],c=client(async(url,{signal})=>new Response(new ReadableStream({start(controller){let offset=0;const timer=setInterval(()=>{controller.enqueue(bytes.subarray(offset,offset+5));offset+=5;if(offset>=bytes.length){clearInterval(timer);controller.close();}},20);signal.addEventListener('abort',()=>{clearInterval(timer);controller.error(new DOMException('aborted','AbortError'));},{once:true});}})),{event:e=>events.push(e)});
 assert.equal(await c.verify('masters/test.png',hash,bytes.length),true);assert.equal(events.at(-1).bytes,bytes.length);assert.equal(c.activeRequests.size,0);
});
test('a stalled readback aborts, retries from byte zero and verifies the final complete hash',async()=>{
 let calls=0;const events=[],c=client(async(url,{signal})=>{if(++calls>1)return new Response(bytes);return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,2));signal.addEventListener('abort',()=>controller.error(new DOMException('idle deadline','AbortError')),{once:true});}}));},{idleTimeout:20,event:e=>events.push(e)});
 assert.equal(await c.verify('masters/test.png',hash,bytes.length),true);assert.equal(calls,2);assert.equal(events.filter(e=>e.phase==='retrying').length,1);assert.equal(events.filter(e=>e.phase==='verifying'&&e.bytes===0).length,2);
});
test('a broken metadata response body is retried before JSON reaches task validation',async()=>{
 let calls=0;const c=client(async()=>{if(++calls>1)return new Response(JSON.stringify([{id:'saved-part'}]));return new Response(new ReadableStream({start(controller){controller.error(Object.assign(Error('body reset'),{code:'ECONNRESET'}));}}));});
 assert.deepEqual(await c.rows('reference_capture_files',{}),[{id:'saved-part'}]);assert.equal(calls,2);
});
test('a readback hash mismatch remains a failure and is never turned into a retry success',async()=>{let calls=0;const c=client(async()=>{calls++;return new Response(Buffer.alloc(bytes.length));});await assert.rejects(c.verify('masters/test.png',hash,bytes.length),/SHA-256/);assert.equal(calls,1);});

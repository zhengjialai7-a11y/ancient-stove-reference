import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {flow,tasks,QUEUE} from './local-flow-helper.mjs';

class Element{
 constructor(tag='',text=''){this.tag=tag;this.textContent=text;this.children=[];this.dataset={};this.style={};this.value='';this.hidden=false;this.disabled=false;}
 append(...nodes){for(const n of nodes){n.parentElement=this;this.children.push(n);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 remove(){this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
 querySelectorAll(selector){const all=this.children.flatMap(n=>[n,...n.querySelectorAll(selector)]);return all.filter(n=>selector==='[data-local-task-id]'?n.dataset.localTaskId:n.tag==='input'&&n.dataset.taskId);}
}
function queueUI(){
 const owner='ui-owner',f=flow({acceptance:true,owner}),elements=new Map(),handlers=new Map(),exports=[],commands=[];let runtimeMessage,authChange;const overrides={};
 for(const [,id] of readFileSync(new URL('../queue.html',import.meta.url),'utf8').matchAll(/\bid="([^"]+)"/g))elements.set(id,new Element());
 const $=id=>{assert.ok(elements.has(id),'Missing UI element '+id);return elements.get(id);};
 const window={addEventListener(name,handler){if(!handlers.has(name))handlers.set(name,[]);handlers.get(name).push(handler);},postMessage(data,origin){queueMicrotask(()=>{for(const handler of handlers.get('message')||[])handler({source:window,origin,data});});}};
 const rows=tasks.map(t=>({...t,source_type:'SUHA',source_url:t.source,display_title:t.title,master_count:0}));
 const ctx=vm.createContext({$,el:(tag,text)=>new Element(tag,text),user:{id:owner},queue:rows,batchIds:new Set(),allFiltered:()=>rows,render(){},downloadJSON:(report,name)=>exports.push({report:structuredClone(report),name}),location:{origin:new URL(QUEUE).origin,pathname:new URL(QUEUE).pathname},window,db:{auth:{getSession:async()=>({data:{session:{user:{id:owner},access_token:'ephemeral-ui-session'}}}),onAuthStateChange(fn){authChange=fn;}}},crypto:{randomUUID},setTimeout:(fn,ms)=>ms>1000?randomUUID():setTimeout(fn,ms),clearTimeout(){},scheduleRefresh(){},URL,chrome:{runtime:{sendMessage:async message=>{commands.push(message);if(overrides.status&&message.command==='status')return overrides.status;return f.adapter.handle(message,{tab:{url:QUEUE},frameId:0});},onMessage:{addListener(fn){runtimeMessage=fn;}}}}});
 f.chrome.tabs.query=async()=>[{id:9999,url:QUEUE}];f.chrome.tabs.sendMessage=async(_id,message)=>runtimeMessage?.(message);
 vm.runInContext(readFileSync(new URL('../extension/local_bridge.js',import.meta.url),'utf8'),ctx);
 vm.runInContext(readFileSync(new URL('../capture-local.js',import.meta.url),'utf8'),ctx);
 return {f,$,ctx,exports,commands,window,overrides,authChange:(event,session)=>authChange(event,session)};
}
test('page button sends the authenticated validation request through the real bridge and renders/export actual results',async()=>{
 const ui=queueUI();await ui.$('localPrepare').onclick();const done=ui.f.waitForValidation();await ui.$('localValidate').onclick();await done;await new Promise(setImmediate);
 const command=ui.commands.find(m=>m.command==='validate');assert.equal(command.ownerId,'ui-owner');assert.equal(command.accessToken,'ephemeral-ui-session');assert.equal(command.tasks.length,2);
 assert.equal(ui.$('localValidationReport').children.length,6);assert.match(ui.$('localValidationMessage').textContent,/自动验收结束/);assert.equal(ui.$('localValidationResume').hidden,true);assert.equal(ui.$('localValidationExport').disabled,false);
 const rows=ui.$('localValidationReport').children.map(e=>e.textContent);assert.ok(rows.some(t=>t.includes('多张母图 · 通过')));assert.ok(rows.some(t=>t.includes('浏览器重启保留 · 待验证')));
 await ui.$('localValidationExport').onclick();assert.equal(ui.exports.length,1);assert.equal(ui.exports[0].report.checks.repeat.status,'passed');assert.equal(JSON.stringify(ui.exports).includes('ephemeral-ui-session'),false);assert.match(ui.exports[0].name,/验收报告.*json$/);
});
test('queue ignores a different account validation progress and keeps its own report intact',async()=>{
 const ui=queueUI();ui.$('localValidationMessage').textContent='本账号报告';ui.window.postMessage({type:'ART_LOCAL_PROGRESS',state:{owner:'other-owner',validation:{owner:'other-owner',status:'finished',checks:{fake:{label:'秘密作品',status:'passed',detail:'secret'}}}}},new URL(QUEUE).origin);await new Promise(setImmediate);assert.equal(ui.$('localValidationMessage').textContent,'本账号报告');assert.equal(ui.$('localValidationReport').children.length,0);
});

test('an old plugin returns an immediate upgrade message instead of timing out on new validation commands',async()=>{
 const ui=queueUI();ui.overrides.status={ok:true,result:{owner:'ui-owner',tasks:[],history:[]}};await ui.$('localValidate').onclick();assert.match(ui.$('localMessage').textContent,/完整更新至 v0.8.1/);assert.equal(ui.commands.some(m=>m.command==='validate'),false);
});
test('an account change clears the visible acceptance report and disables its export',async()=>{
 const ui=queueUI();await ui.$('localPrepare').onclick();const done=ui.f.waitForValidation();await ui.$('localValidate').onclick();await done;await new Promise(setImmediate);assert.equal(ui.$('localValidationReport').children.length,6);ui.authChange('SIGNED_IN',{user:{id:'other-owner'}});assert.equal(ui.$('localValidationReport').children.length,0);assert.equal(ui.$('localValidationExport').disabled,true);
});

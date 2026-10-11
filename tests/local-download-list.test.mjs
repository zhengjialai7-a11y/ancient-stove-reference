import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Model the public viewer's actual two-step dialog, including a separate slice
// section, filename paragraphs, original-size descriptions, and row buttons.
class Element {
 constructor(tag,attrs={},text=''){this.tagName=tag.toUpperCase();this.attrs=attrs;this.ownText=text;this.children=[];this.parentElement=null;this.disabled=!!attrs.disabled;this.id=attrs.id||'';this.clicked=0;}
 append(...children){for(const e of children){e.parentElement=this;this.children.push(e);}return this;}
 get innerText(){return [this.ownText,...this.children.map(e=>e.innerText)].filter(Boolean).join('\n');}
 get textContent(){return [this.ownText,...this.children.map(e=>e.textContent)].join('');}
 get nextElementSibling(){if(!this.parentElement)return null;const siblings=this.parentElement.children;return siblings[siblings.indexOf(this)+1]||null;}
 get previousElementSibling(){if(!this.parentElement)return null;const siblings=this.parentElement.children;return siblings[siblings.indexOf(this)-1]||null;}
 getAttribute(name){return this.attrs[name]??null;}
 getBoundingClientRect(){return {width:30,height:30};}
 click(){this.clicked++;}
 matches(selector){return selector.split(',').some(part=>{part=part.trim();const steps=part.split(/\s+/);if(steps.length>1){if(!this.matches(steps.pop()))return false;let p=this.parentElement;while(p){if(p.matches(steps.join(' ')))return true;p=p.parentElement;}return false;}const tag=part.match(/^[a-z]+/i);if(tag&&tag[0].toUpperCase()!==this.tagName)return false;const attrs=[...part.matchAll(/\[([\w-]+)(?:([*^$]?=)["']?([^\]"']*)["']?)?\]/g)];for(const [,name,op,value] of attrs){const actual=this.getAttribute(name);if(actual===null)return false;if(op==='='&&actual!==value)return false;if(op==='*='&&!String(actual).includes(value))return false;}return !!tag||attrs.length>0;});}
 querySelectorAll(selector){const result=[];for(const child of this.children){if(child.matches(selector))result.push(child);result.push(...child.querySelectorAll(selector));}return result;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 closest(selector){let p=this;while(p){if(p.matches(selector))return p;p=p.parentElement;}return null;}
 contains(element){return element===this||this.children.some(e=>e.contains(element));}
}
const el=(tag,attrs={},text='')=>new Element(tag,attrs,text);

function row(part,{filename=`清_查士标_百鹊图卷_${part}.jpg`,description='比例：(原大)    文件大小：18.50MB',button='点击下载',disabled=false}={}){
 const action=el('button',{'aria-label':button,disabled},button);
 const node=el('div',{class:'border-b border-gray-100'}).append(el('div',{class:'grid'}).append(el('div',{},'预览'),el('div').append(el('p',{},filename),el('p',{},description)),action));
 return {node,action};
}
function dialog(count,rows,{slice=false}={}){
 const frame=el('div',{'data-download-list-scroll-frame':'true'}),list=el('div');frame.append(list);
 const sliceAction=el('button',{'aria-label':'点击下载'},'点击下载');
 if(slice){list.append(el('div').append(el('span',{},'画谱切片'),el('span',{},'1 个文件')),el('div').append(el('p',{},'清_查士标_百鹊图卷 (画谱切片).jpg'),sliceAction));}
 list.append(el('div').append(el('span',{},'原始高清图像'),el('span',{},'作品原始高清文件'),el('span',{},`${count} 个文件`)),...rows.map(r=>r.node),el('div',{},'已经到底了'));
 const node=el('div',{role:'dialog'}).append(el('div',{},'资源文件下载'),el('div',{},`共 ${count+(slice?1:0)} 个文件`),frame);
 return {node,sliceAction};
}
function adapter(...dialogs){
 const body=el('body').append(el('button',{'aria-label':'下载'},'下载'),...dialogs.map(d=>d.node));
 const ctx=vm.createContext({document:{title:'百鹊图卷 - 中华珍宝馆',body,querySelectorAll:s=>body.querySelectorAll(s),querySelector:s=>body.querySelector(s)},location:{href:'https://g2.ltfc.net/view/SUHA/608a61b2aa7c385c8d9448d5'},getComputedStyle:()=>({visibility:'visible',display:'block'}),chrome:{},crypto:{},setTimeout(){},Map,Date});
 vm.runInContext(readFileSync(new URL('../extension/automation.js',import.meta.url),'utf8')+';globalThis.adapter=CaptureAutomation;',ctx);
 return (...args)=>ctx.adapter.inspectPage(...args);
}
function blocked(result){assert.ok(result.error||result.originalList?.error,'unsafe or incomplete original lists must report an error');assert.notEqual(result.clicked,true);}

test('single original file is identified from the actual download-list dialog',()=>{
 const r=row(1),inspect=adapter(dialog(1,[r]));
 const result=inspect();assert.equal(result.originalList.count,1);assert.equal(result.originalList.files.length,1);assert.equal(result.originalList.files[0].part,1);assert.equal(result.originalList.files[0].filename,'清_查士标_百鹊图卷_1.jpg');assert.equal(result.originalList.files[0].original,true);assert.equal(result.originalList.files[0].ready,true);assert.equal(r.action.clicked,0);
 assert.equal(inspect('original',1,1).clicked,true);assert.equal(r.action.clicked,1);
});
test('multi-mother file list downloads only the requested numbered original and excludes slice rows',()=>{
 const rows=[row(1),row(2),row(3)],d=dialog(3,rows,{slice:true}),inspect=adapter(d);
 const result=inspect();assert.equal(result.originalList.count,3);assert.deepEqual(Array.from(result.originalList.files,f=>f.part),[1,2,3]);
 assert.equal(inspect('original',2,3).clicked,true);assert.equal(rows[0].action.clicked,0);assert.equal(rows[1].action.clicked,1);assert.equal(rows[2].action.clicked,0);assert.equal(d.sliceAction.clicked,0);
});
test('list count changes and missing numbered rows block clicks',()=>{
 const first=row(1),third=row(3);blocked(adapter(dialog(3,[first,third]))('original',1,3));assert.equal(first.action.clicked,0);
 const rows=[row(1),row(2)];blocked(adapter(dialog(2,rows))('original',1,3));assert.equal(rows[0].action.clicked,0);
});
test('duplicate original indices block all automatic download clicks',()=>{
 const rows=[row(1),row(1)];blocked(adapter(dialog(2,rows))('original',1,2));assert.equal(rows[0].action.clicked+rows[1].action.clicked,0);
});
test('scaled files are never accepted as the original-size mother',()=>{
 const r=row(1,{description:'比例：(原大 1/2)    文件大小：4.60MB'}),inspect=adapter(dialog(1,[r]));
 const result=inspect();assert.equal(result.originalList.files[0].original,false);blocked(inspect('original',1,1));assert.equal(r.action.clicked,0);
});
test('competing file dialogs cannot bind a task to an arbitrary original list',()=>{
 const a=row(1),b=row(1);blocked(adapter(dialog(1,[a]),dialog(1,[b]))('original',1,1));assert.equal(a.action.clicked+b.action.clicked,0);
});
test('a missing list cannot fall back to an unrelated generic download button',()=>{
 const inspect=adapter();blocked(inspect('original',1,1));
});
test('preparing, downloading, or disabled original buttons cannot be clicked',()=>{
 for(const options of [{button:'准备下载',disabled:true},{button:'取消下载'},{button:'点击下载',disabled:true}]){const r=row(1,options);blocked(adapter(dialog(1,[r]))('original',1,1));assert.equal(r.action.clicked,0);}
});
test('a failed normal original download can retry its same explicit row',()=>{
 const r=row(1,{button:'重试'});assert.equal(adapter(dialog(1,[r]))('original',1,1).clicked,true);assert.equal(r.action.clicked,1);
});

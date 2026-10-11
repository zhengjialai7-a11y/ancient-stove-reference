import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const artworkId='608a61b2aa7c385c8d9448d5';
const foreignId='608a623142b4355c93c903e6';
const picId='aaaaaaaaaaaaaaaaaaaaaaaa';
const source='https://g2.ltfc.net/view/SUHA/'+artworkId;
const automation=readFileSync(new URL('../extension/automation.js',import.meta.url),'utf8');

function element(text='',attributes={}){
 return {
  id:attributes.id||'',tagName:'BUTTON',innerText:text,textContent:text,className:'',disabled:false,
  getAttribute(name){return attributes[name]??null;},
  hasAttribute(name){return Object.hasOwn(attributes,name);},
  getBoundingClientRect(){return {width:30,height:30};},
  querySelectorAll(){return [];},
  querySelector(){return null;},
  click(){this.clicked=true;}
 };
}
function flight(value,record='9'){
 return 'self.__next_f.push([1,'+JSON.stringify(record+':'+JSON.stringify(value)+'\n')+'])';
}
function inspect({works=[],scriptTexts=null,pager=null,text='',controls=[],action='inspect'}={}){
 const scripts=(scriptTexts||works.map((work,index)=>flight({artwork:work},String(index+8)))).map(textContent=>({textContent,innerHTML:textContent,innerText:textContent,getAttribute(){return null;}}));
 const pagers=pager?[element(pager)]:[];
 const document={
  title:'百鹊图卷 - 中华珍宝馆',readyState:'complete',scripts,body:{innerText:text,textContent:text},
  getElementById(id){return controls.find(control=>control.id===id)||null;},
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
  querySelectorAll(selector){
   if(/^script(?:\b|\[)/.test(selector))return scripts;
   if(/\[class\*="(?:page|Page|swiper|Swiper|index|Index)"\]/.test(selector))return pagers;
   return controls;
  }
 };
 const context=vm.createContext({document,getComputedStyle:()=>({visibility:'visible',display:'block'}),location:{href:source},chrome:{},crypto:{},setTimeout(){},Map,Date,URL});
 vm.runInContext(automation+';globalThis.adapter=CaptureAutomation;',context);
 return {result:context.adapter.inspectPage(action),context};
}
function single(overrides={}){
 return {src:'SUHA',id:artworkId,suha:{Id:artworkId,name:'百鹊图卷',hdp:{src:'PIC',id:picId,hdpic:{Id:picId}}},...overrides};
}
function collection(count=3){
 return {src:'SUHA',id:artworkId,suha:{Id:artworkId,name:'地狱绘卷',hdp:{src:'COLL',id:'bbbbbbbbbbbbbbbbbbbbbbbb',hdpcoll:{layoutMode:'PAGE',hdpIds:Array.from({length:count},(_,index)=>(index+1).toString(16).padStart(24,'0'))}}}};
}

test('single PIC mother is recognized from matching Next flight metadata without a visible pager',()=>{
 const {result}=inspect({works:[single()]});
 assert.equal(result.metadataCount,1);
 assert.equal(result.count,1);
 assert.equal(result.countSource,'page-metadata');
 assert.equal(result.title,'百鹊图卷');
});

test('PAGE collection counts its ordered hdpIds rather than alternative versions',()=>{
 const work=collection(19);
 work.suha.otherHdps=[{src:'PIC',id:picId,hdpic:{Id:picId}},{src:'COLL',hdpcoll:{layoutMode:'PAGE',hdpIds:[picId]}}];
 const {result}=inspect({works:[work]});
 assert.equal(result.metadataCount,19);
 assert.equal(result.count,19);
 assert.equal(result.countSource,'page-metadata');
 assert.equal(result.title,'地狱绘卷');
});

test('a different artwork in the page payload cannot supply the mother count or title',()=>{
 const foreign=single({id:foreignId,suha:{Id:foreignId,name:'无关作品',hdp:{src:'PIC',id:picId,hdpic:{Id:picId}}}});
 const {result}=inspect({works:[foreign]});
 assert.equal(result.metadataCount,null);
 assert.equal(result.count,null);
 assert.equal(result.countSource,null);
 assert.equal(result.title,'百鹊图卷');
});

test('absent or unknown image metadata never implies that the work has one mother',()=>{
 for(const works of [[],[{src:'SUHA',id:artworkId,suha:{Id:artworkId,name:'百鹊图卷',hdp:{src:'UNKNOWN',id:picId}}}]]){
  const {result}=inspect({works});
  assert.equal(result.metadataCount,null);
  assert.equal(result.count,null);
  assert.equal(result.countSource,null);
 }
});

test('malformed or mismatched PIC identity is rejected',()=>{
 for(const hdp of [{src:'PIC',id:picId},{src:'PIC',id:picId,hdpic:{Id:'cccccccccccccccccccccccc'}},{src:'PIC',id:'bad',hdpic:{Id:'bad'}}]){
  const work=single();work.suha.hdp=hdp;
  const {result}=inspect({works:[work]});
  assert.equal(result.metadataCount,null);
  assert.equal(result.count,null);
 }
});

test('unsupported collection layout and invalid page IDs do not produce a count',()=>{
 for(const hdpcoll of [{layoutMode:'GRID',hdpIds:[picId]},{layoutMode:'PAGE',hdpIds:[]},{layoutMode:'PAGE',hdpIds:['bad']}]){
  const work=collection();work.suha.hdp.hdpcoll=hdpcoll;
  const {result}=inspect({works:[work]});
  assert.equal(result.metadataCount,null);
  assert.equal(result.count,null);
 }
});

test('conflicting metadata for the same artwork is rejected instead of choosing one count',()=>{
 const {result}=inspect({works:[single(),collection(3)]});
 assert.equal(result.count,null);
 assert.ok(result.error,'a conflicting source needs a visible reason');
});

test('visible pager disagreement with artwork metadata is reported before any click',()=>{
 const download=element('下载原图');
 const {result}=inspect({works:[collection(3)],pager:'1 / 2',controls:[download],action:'download'});
 assert.ok(result.error,'metadata/pager mismatch needs a visible reason');
 assert.equal(download.clicked,undefined);
});

test('a valid visible pager is usable when no artwork metadata is available',()=>{
 const {result}=inspect({pager:'1 / 19'});
 assert.equal(result.metadataCount,null);
 assert.equal(result.count,19);
 assert.equal(result.countSource,'pager');
 assert.equal(result.position.part,1);
});

test('page script payloads are parsed as data and never executed',()=>{
 const {result,context}=inspect({scriptTexts:['globalThis.unexpectedScriptExecution=true;'+flight({artwork:single()})]});
 assert.equal(context.unexpectedScriptExecution,undefined);
 assert.equal(result.count,1);
});


test('a non-line-terminated text chunk cannot swallow a later artwork metadata record',()=>{
 const noise='self.__next_f.push([1,'+JSON.stringify('f:T9,arbitrary')+'])';
 const {result}=inspect({scriptTexts:[noise,flight({artwork:single()})]});
 assert.equal(result.metadataCount,1);
 assert.equal(result.title,'百鹊图卷');
});

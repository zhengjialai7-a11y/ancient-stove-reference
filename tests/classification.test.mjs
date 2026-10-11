import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const script=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const taxonomyCode=script.slice(script.indexOf('function categorySubtypeNames('),script.indexOf('function sanitizeSearch('));
const browseCode=script.slice(script.indexOf('function getBrowseRows('),script.indexOf('function getBrowseRows(')+script.slice(script.indexOf('function getBrowseRows(')).indexOf('\n}'))+'\n}';

function setup(){
 class Element{
  constructor(){this.children=[];this.value='';this.hidden=false;this.scrollTop=0;}
  replaceChildren(...children){this.children=children;}
  add(child){this.children.push(child);}
  append(...children){this.children.push(...children);}
  prepend(child){this.children.unshift(child);}
  setAttribute(name,value){this[name]=value;}
  scrollTo(){}
 }
 const nodes=new Map();
 const $=s=>{if(!nodes.has(s))nodes.set(s,new Element());return nodes.get(s);};
 const ctx=vm.createContext({$,document:{createElement:()=>new Element()},Option:class {constructor(text,value){this.text=text;this.value=value;}},sanitizeSearch(){},closeDetailPage(){},render(){},esc:String});
 vm.runInContext(`let categories=[{id:'tools',name:'生产工具'},{id:'weapons',name:'兵器与武具'}];
 let subtypes=[{category_id:'tools',name:'纺织工具'},{category_id:'tools',name:'待确认'},{category_id:'weapons',name:'弓箭'},{category_id:'weapons',name:'待确认'}];
 let refs=[{id:'a',category_id:'tools',category:'生产工具',sub_category:'纺织工具'},{id:'b',category_id:'tools',category:'生产工具',sub_category:'待确认'},{id:'c',category_id:'weapons',category:'兵器与武具',sub_category:'弓箭'},{id:'d',category_id:'weapons',category:'兵器与武具',sub_category:'待确认'}];
 let activeCategory='全部参考';`+taxonomyCode+'\n'+browseCode,ctx);
 return {$,run:code=>vm.runInContext(code,ctx)};
}

test('each category offers its own standard subtypes and retains a custom saved value',()=>{
 const f=setup();f.$('#fCategory').value='tools';
 f.run('updateReferenceSubtypeOptions()');
 assert.deepEqual(f.$('#fSubCategory').children.map(o=>o.value),['','纺织工具','待确认','__add__']);
 f.run('updateReferenceSubtypeOptions("人工细类")');
 assert.ok(f.$('#fSubCategory').children.some(o=>o.value==='人工细类'));
 f.$('#fCategory').value='weapons';f.run('updateReferenceSubtypeOptions()');
 assert.equal(f.$('#fSubCategory').value,'');
 assert.ok(!f.$('#fSubCategory').children.some(o=>o.value==='纺织工具'));
});

test('expanding and selecting non-building subtypes filters by both category and subtype',()=>{
 const f=setup();f.run('expandedCategories=new Set(["生产工具","兵器与武具"]);renderCategories()');
 const list=f.$('#categories').children.find(e=>e.className==='subcat-list');
 assert.equal(list.children.length,2);
 list.children[1].onclick();
 assert.deepEqual(Array.from(f.run('getBrowseRows().map(r=>r.id)')),['b']);
 assert.equal(f.$('#subCategoryFilter').value,'待确认');
 f.run('activeCategory="兵器与武具"');
 assert.deepEqual(Array.from(f.run('getBrowseRows().map(r=>r.id)')),['d']);
});

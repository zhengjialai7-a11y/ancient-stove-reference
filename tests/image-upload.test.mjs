import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
new vm.Script(app); // Check the complete browser script, including registration code.
const formCode=app.slice(app.indexOf('function clearPendingImage('),app.indexOf('async function deleteItem('));
const saveCode=app.slice(app.indexOf('async function uploadImage('),app.indexOf('function openCategoryModal('));
const modalCode=app.match(/function openModal\(id\)[^\n]+/)[0];

function setup(){
 const elements=new Map(),uploads=[],writes=[],revoked=[];
 const get=s=>{
  if(!elements.has(s)){
   const classes=new Set();
   elements.set(s,{value:'',textContent:'',hidden:false,disabled:false,files:[],style:{},listeners:{},
    classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)},
    addEventListener(name,handler){this.listeners[name]=handler},removeAttribute(name){delete this[name]}});
  }
  return elements.get(s);
 };
 let uploadError=null,holdUpload=null;
 const db={storage:{from:()=>({upload:async(path,file,opts)=>{uploads.push({path,file,opts});if(holdUpload)await holdUpload;return {error:uploadError}},getPublicUrl:path=>({data:{publicUrl:'https://fixture.test/'+path}})})},
  from:()=>({update:payload=>({eq:async(_,id)=>{writes.push({id,payload});return {error:null}}}),insert:async payload=>{writes.push({payload});return {error:null}}})};
 const ctx=vm.createContext({$,File,Date,URL:{createObjectURL:()=>`blob:fixture-${uploads.length}-${Math.random()}`,revokeObjectURL:url=>revoked.push(url)},crypto:{randomUUID:()=> 'fixture-id'},db,alert:message=>{throw Error(message)},loadAll:async()=>{}});
 function $(s){return get(s)}
 vm.runInContext('let pendingImageFile=null,pendingImagePreviewUrl=null,itemSaving=false,editingId=null;let refs=[];let user={id:"fixture-user"};',ctx);
 vm.runInContext(modalCode+'\n'+formCode+'\n'+saveCode,ctx);
 const run=code=>vm.runInContext(code,ctx);
 const image=new File([new Uint8Array([1,2,3])],'local.png',{type:'image/png'});
 ctx.fixtureImage=image;
 const old={id:'reference-1',category_id:'category-1',title:'原参考',image_url:'https://fixture.test/original.jpg',crop_x:.1,crop_y:.2,crop_w:.4,crop_h:.3};
 ctx.fixtureOld=old;run('refs=[fixtureOld];editItem(fixtureOld)');
 const paste=(file=image,type=file.type)=>{
  let prevented=false;
  get('#itemModal').listeners.paste({clipboardData:{items:[{kind:'file',type,getAsFile:()=>file}]},preventDefault:()=>prevented=true});
  return prevented;
 };
 return {ctx,get,run,image,paste,uploads,writes,revoked,setError:error=>uploadError=error,setHold:promise=>holdUpload=promise};
}

test('paste shows native-byte preview, uploads only on save, and resets old crop coordinates',async()=>{
 const s=setup();assert.equal(s.paste(),true);assert.equal(s.uploads.length,0);
 assert.equal(s.get('#imageUploadPreview').hidden,false);assert.match(s.get('#imageUploadStatus').textContent,/已粘贴图片/);
 await s.run('saveItem()');assert.equal(s.uploads.length,1);assert.equal(s.writes.length,1);
 assert.deepEqual(new Uint8Array(await s.uploads[0].file.arrayBuffer()),new Uint8Array(await s.image.arrayBuffer()));
 assert.equal(s.uploads[0].opts.contentType,'image/png');assert.equal(s.uploads[0].opts.upsert,false);
 for(const key of ['crop_x','crop_y','crop_w','crop_h'])assert.equal(s.writes[0].payload[key],null);
 assert.equal(s.get('#itemModal').classList.contains('show'),false);assert.equal(s.get('#imageUploadPreview').hidden,true);assert.equal(s.revoked.length,1);
});
test('local file and pasted image use the latest selection',async()=>{
 const s=setup();s.paste();s.get('#fFile').files=[s.image];s.get('#fFile').listeners.change();
 assert.equal(s.run('pendingImageFile'),s.image);assert.match(s.get('#imageUploadStatus').textContent,/本地图片/);
 assert.equal(s.revoked.length,1);s.paste();assert.match(s.get('#imageUploadStatus').textContent,/已粘贴图片/);
 await s.run('saveItem()');assert.equal(s.uploads.length,1);
});
test('ordinary text paste is untouched and hidden modal ignores image paste',()=>{
 const s=setup();let prevented=false;
 s.get('#itemModal').listeners.paste({clipboardData:{items:[{kind:'string',type:'text/plain'}]},preventDefault:()=>prevented=true});
 assert.equal(prevented,false);s.run('closeModal("itemModal")');assert.equal(s.paste(),false);assert.equal(s.run('pendingImageFile'),null);
});
test('cancel replacement keeps existing image and crop metadata',async()=>{
 const s=setup();s.paste();s.get('#clearPendingImageBtn').onclick();await s.run('saveItem()');
 assert.equal(s.uploads.length,0);assert.equal(s.writes[0].payload.image_url,'https://fixture.test/original.jpg');assert.equal('crop_x' in s.writes[0].payload,false);
});
test('opening a different reference clears pending image and error',()=>{
 const s=setup();s.paste();s.get('#saveMsg').textContent='旧错误';s.run('editItem({...fixtureOld,id:"reference-2"})');
 assert.equal(s.run('pendingImageFile'),null);assert.equal(s.get('#saveMsg').textContent,'');assert.equal(s.revoked.length,1);
});
test('failed upload retains pending image for retry and does not write a reference',async()=>{
 const s=setup();s.paste();s.setError(new Error('上传失败'));await s.run('saveItem()');
 assert.equal(s.writes.length,0);assert.equal(s.get('#imageUploadPreview').hidden,false);assert.equal(s.get('#saveItem').disabled,false);
 assert.match(s.get('#saveMsg').textContent,/上传失败/);s.setError(null);await s.run('saveItem()');assert.equal(s.writes.length,1);
});
test('double save and dismissal during upload cannot corrupt the pending operation',async()=>{
 const s=setup();s.paste();let release;s.setHold(new Promise(r=>release=r));const save=s.run('saveItem()');
 await s.run('saveItem()');s.run('closeModal("itemModal")');assert.equal(s.get('#itemModal').classList.contains('show'),true);
 assert.equal(s.uploads.length,1);release();await save;assert.equal(s.writes.length,1);
});
test('changing image URL clears stale crop while a title edit preserves it',async()=>{
 const s=setup();s.get('#fImage').value='https://fixture.test/replacement.png';await s.run('saveItem()');
 assert.equal(s.writes[0].payload.crop_w,null);assert.equal(s.uploads.length,0);
});
test('new reference can save a pasted image without an image URL',async()=>{
 const s=setup();s.run('clearForm();editingId=null;openModal("itemModal")');s.get('#fTitle').value='新增参考';s.get('#fCategory').value='category-1';s.paste();await s.run('saveItem()');
 assert.equal(s.writes[0].payload.created_by,'fixture-user');assert.match(s.writes[0].payload.image_url,/fixture-id\.png$/);
});

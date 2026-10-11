import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const ctx=vm.createContext({URLSearchParams});
vm.runInContext(readFileSync(new URL('../capture-common.js',import.meta.url),'utf8'),ctx);
const C=ctx.CaptureCommon,source='https://g2.ltfc.net/view/SUHA/61801f6cd7eb144471493e48';
test('conflicting projects keep independent uploaded progress without false source association',()=>{
 const tasks=[{source_type:'SUHA',source_id:'61801f6cd7eb144471493e48',candidate_count:3,resolved_project_id:null}];
 const projects=['百鹊图卷','地狱绘卷.棠洲安政2年原画','罗汉图'].map((title,i)=>({id:'p'+i,title,source_url:source}));
 const masters=projects.flatMap((p,i)=>Array.from({length:[1,19,2][i]},(_,n)=>({id:p.id+n,project_id:p.id,sha256:'hash',verified_sha256:null,verified_at:null})));
 const rows=C.workspaceRows(tasks,projects,masters,[{master_id:'p20',status:'draft'}]);
 assert.deepEqual(Array.from(rows,r=>r.master_count),[1,19,2]);assert.equal(rows[2].draft_count,1);
 assert.ok(rows.every(r=>r.workspace_only&&r.link_issue.includes('冲突')&&r.verified_count===0));
 const q=new URLSearchParams(C.importerURL(rows[0]).split('?')[1]);assert.equal(q.get('project_id'),'p0');assert.equal(q.has('capture_task'),false);assert.equal(q.has('source_url'),false);
});
test('a corrected association removes the extra project row without hiding other uploaded projects',()=>{
 const projects=[{id:'p0',title:'百鹊图卷',source_url:source},{id:'p1',title:'四学士图',source_url:null}];
 const masters=projects.map(p=>({id:'m'+p.id,project_id:p.id,verified_sha256:'same',sha256:'same',verified_at:'now'}));
 const rows=C.workspaceRows([{resolved_project_id:'p0'}],projects,masters,[]);
 assert.equal(rows.length,1);assert.equal(rows[0].display_title,'四学士图');assert.equal(rows[0].master_count,1);assert.equal(rows[0].verified_count,1);assert.match(rows[0].link_issue,/来源链接/);
});
test('missing favorite and misfiled artwork are visible without changing the saved project',()=>{
 const project={id:'p',title:'罗汉图',source_url:source};
 const master={id:'m',project_id:'p',original_filename:'明_佚名明人_珍禽货郎图_1.jpg'};
 const [row]=C.workspaceRows([], [project], [master], []);
 assert.match(row.link_issue,/不在当前收藏清单/);assert.equal(row.mismatched_files[0],master.original_filename);assert.equal(project.title,'罗汉图');
});
function importer(){
 const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{value:''});return elements.get(id)};
 const s=vm.createContext({CaptureCommon:C,$,updateSourceShortcut:()=>{}});
 vm.runInContext('let projects=[];',s);
 const html=readFileSync(new URL('../importer.html',import.meta.url),'utf8');
 vm.runInContext(html.slice(html.indexOf('function inferSingleFileMetadata('),html.indexOf('async function loadFile(')),s);
 return {s,$,run:code=>vm.runInContext(code,s)};
}
test('new artwork clears inherited source while same-artwork parts preserve entered source',()=>{
 const s=importer();s.$('workTitle').value='罗汉图';s.$('sourceUrl').value=source;
 s.run('inferSingleFileMetadata({name:"清_查士标_百鹊图卷_1.jpg"})');assert.equal(s.$('sourceUrl').value,'');assert.equal(s.$('author').value,'查士标');
 s.$('sourceUrl').value=source;s.run('inferSingleFileMetadata({name:"清_查士标_百鹊图卷_2.jpg"})');assert.equal(s.$('sourceUrl').value,source);
});
test('another artwork cannot be silently imported into an existing project',()=>{
 const s=importer();s.run('projects=[{id:"p",title:"罗汉图",author:"蔡山",era:"元",source_url:null}]');s.$('projectSelect').value='p';s.$('sourceUrl').value=source;
 assert.throws(()=>s.run('assertFileArtwork({name:"明_佚名明人_珍禽货郎图_1.jpg"})'),/请先切换或新建/);
 s.run('inferSingleFileMetadata({name:"元_蔡山_罗汉图_2.jpg"})');assert.equal(s.$('sourceUrl').value,'');assert.equal(s.$('workTitle').value,'罗汉图');
});

// Executed by an explicit user scan in the site's MAIN JS world.
// Read-only introspection of rendered favorite cards; never uses network APIs.
(()=>{
 const idPattern=/^[a-f0-9]{24}$/i, found=[], samples=[];
 const els=[...document.querySelectorAll('img')].slice(0,1500);
 const clean=t=>String(t||'').replace(/\s+/g,' ').trim().slice(0,115);
 const getTitle=el=>{
  let n=el;
  for(let i=0;i<5&&n;i++,n=n.parentElement){
   const t=clean(n.innerText);const m=t.match(/(?:^|\s)(\d{1,4})[.、．]\s*(.{2,85})/);
   if(m&&m[2].length<85)return {position:Number(m[1]),title:clean(m[2])};
  }
  return null;
 };
 const idFields=['sourceId','source_id','resourceId','resource_id','sourceID'];
 const checkObj=(obj,depth=0,seen=new Set())=>{
  if(!obj||typeof obj!=='object'||seen.has(obj)||seen.size>90||depth>3)return [];
  seen.add(obj);let out=[];
  for(const key of idFields){try{const v=obj[key];if(typeof v==='string'&&idPattern.test(v))out.push({id:v.toLowerCase(),field:key});}catch{}}
  if(depth>=3)return out;
  const keys=['resource','source','item','data','detail','painting','artwork','sourceInfo','resources'];
  for(const key of keys){try{const v=obj[key];if(v&&typeof v==='object'&&!Array.isArray(v))out.push(...checkObj(v,depth+1,seen));}catch{}}
  return out;
 };
 for(const img of els){
  const title=getTitle(img);if(!title)continue;
  let n=img,observed=[],componentCount=0;
  for(let i=0;i<6&&n;i++,n=n.parentElement){
   const comp=n.__vueParentComponent||n.__vue__;
   if(comp&&componentCount++<3){
    for(const obj of [comp.props,comp.setupState,comp.data])observed.push(...checkObj(obj));
   }
  }
  const ids=[...new Set(observed.map(x=>x.id))];
  if(ids.length===1)found.push({...title,sourceId:ids[0],basis:'rendered-component-single-source-id'});
  else if(samples.length<12)samples.push({...title,matchedIds:ids.length});
 }
 const unique=new Map(),ambiguous=[];
 for(const x of found){
  const key=x.position+':'+x.title;
  if(unique.has(key)&&unique.get(key).sourceId!==x.sourceId){ambiguous.push(key);unique.delete(key);}
  else if(!ambiguous.includes(key))unique.set(key,x);
 }
 return {page:location.href,imagesInspected:els.length,extracted:[...unique.values()].slice(0,1200),ambiguous:ambiguous.slice(0,30),unmatchedSamples:samples};
})()

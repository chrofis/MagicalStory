#!/usr/bin/env node
// Build trials.json (pages, picture cast, characters with ages) from trials_raw.json for the Jev review.
const fs=require('fs'),path=require('path');
const DIR=path.join(__dirname,'../../evals/runs/2026-10-09_jev-review');
const raw=JSON.parse(fs.readFileSync(path.join(DIR,'trials_raw.json'),'utf8'));
const out=raw.map(x=>{
  const pages=[...String(x.st).matchAll(/--- Page (\d+) ---\n([\s\S]*?)(?=\n--- Page \d+ ---|$)/g)].map(m=>({pageNumber:+m[1],text:m[2].trim()}));
  const cast={};
  for(const s of x.sd||[]){const d=String(s.description||'');try{if(d.trim().startsWith('{')){const m=JSON.parse(d);cast[s.pageNumber]=((m.scene||m).characters||[]).map(c=>c.name).filter(Boolean);}else{const m=JSON.parse(d.split('---METADATA---')[1]);cast[s.pageNumber]=[...(m.characters||[]).map(c=>c.name),...(m.creatures||[]).map(c=>typeof c==='string'?c:c.name)].filter(Boolean);}}catch(e){}}
  return {id:x.id,lang:x.lang,level:x.ll,date:x.created_at,characters:(x.ch||[]).map(c=>({name:c.name,age:c.age,gender:c.gender,role:c.role})),pages,pictureCast:cast,allCast:[...new Set([...(x.ch||[]).map(c=>c.name),...Object.values(cast).flat()])],briefs:(x.sd||[]).map(s=>({pageNumber:s.pageNumber,intent:(String(s.description).match(/"sceneIntent":\s*"([^"]*)"/)||[])[1]||''}))};
});
fs.writeFileSync(path.join(DIR,'trials.json'),JSON.stringify(out));
console.log(out.length,out.reduce((s,t)=>s+t.pages.length,0),'pages');

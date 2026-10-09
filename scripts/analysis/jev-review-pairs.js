#!/usr/bin/env node
// Build (page, absent figure) candidate pairs for the MISMATCH question: the figure's name is in the page text but the figure is not in the page's picture cast.
const fs=require('fs'),path=require('path');
const DIR=path.join(__dirname,'../../evals/runs/2026-10-09_jev-review');
const s=JSON.parse(fs.readFileSync(path.join(DIR,'stories.json'),'utf8'));
const isL=c=>!!c&&c.toLowerCase()!==c.toUpperCase();
function has(text,n){let i=-1;while((i=text.indexOf(n,i+1))>=0){if(!isL(text[i-1])&&!isL(text[i+n.length]))return true;}return false;}
const pairs=[];
for(const x of s){
  const mm=(x.audits['arc-informed']?.faults||[]).filter(f=>f.cat==='MISMATCH');
  for(const p of x.pages){
    const pc=x.pictureCast[p.pageNumber]||[];
    for(const n of x.allCast){
      if(pc.includes(n)) continue;
      if(!has(p.text,n)) continue;
      const sents=p.text.replace(/\s+/g,' ').split(/(?<=[.!?»])\s+/).filter(t=>t.includes(n));
      const filed=mm.some(f=>f.page===p.pageNumber&&f.text.includes(n));
      pairs.push({id:`${x.id.slice(4,17)}#p${p.pageNumber}#${n}`,story:x.id,page:p.pageNumber,figure:n,pictureCast:pc,filedByAudit:filed,sents});
    }
  }
}
fs.writeFileSync(path.join(DIR,'pairs.json'),JSON.stringify(pairs,null,1));
console.log(pairs.length,'pairs;',pairs.filter(p=>p.filedByAudit).length,'filed by arc-informed');

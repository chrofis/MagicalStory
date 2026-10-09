const fs=require('fs');const D=__dirname+'/../../evals/runs/2026-10-09_jev-review/';
const a=fs.readFileSync(D+'trials_answers.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(x=>x.kind==='pair');
const tr=JSON.parse(fs.readFileSync(D+'trials.json','utf8'));
const exp=p=>{const ks=Object.keys(p).map(Number);const t=ks.reduce((s,k)=>s+p[k],0)||1;return ks.reduce((s,k)=>s+k*p[k],0)/t/Math.max(1,ks.length-1)};
const R={};for(const x of a){const k=x.trial+'|'+x.page+'|'+x.name;R[k]=R[k]||{trial:x.trial,page:x.page,name:x.name};R[k][x.variant]=x.noul!=null?x.noul:exp(x.probs);}
const rows=Object.values(R);console.log(rows.length,'pairs');
rows.forEach((r,i)=>{const T=tr.find(t=>t.id===r.trial);const pg=T.pages.find(p=>p.pageNumber===r.page);const sents=pg.text.replace(/\s+/g,' ').split(/(?<=[.!?»])\s+/).filter(s=>s.includes(r.name));console.log(i+' ['+r.name+'] A1 '+r.A1.toFixed(2)+' A3 '+r.A3.toFixed(2)+' | '+(T.pictureCast[r.page]||[]).join('+')+' | '+sents.slice(0,2).map(s=>s.slice(0,200)).join(' // '))});
fs.writeFileSync(D+'trial_pairs.json',JSON.stringify(rows));

const fs=require('fs');const DIR=__dirname+'/../../evals/runs/2026-10-09_jev-review';
const divs=JSON.parse(fs.readFileSync(DIR+'/plan_divs.json','utf8'));const a=fs.readFileSync(DIR+'/q2_answers.jsonl','utf8').trim().split('\n').map(JSON.parse);
const R={};for(const x of a){(R[x.id]=R[x.id]||{div:x.div,page:x.page,name:x.name})[x.variant]=x.v;}
const D=Object.fromEntries(divs.map(d=>[d.id,d]));
const rows=Object.entries(R).map(([id,r])=>{const d=D[id.split('#')[0]];const f=d.findings.filter(f=>f.check===2&&(f.pages||[]).includes(r.page)&&(f.text||'').includes(r.name));return {id,...r,luna:f.length>0,N:1-r.N1,N3:1-r.N3,N4:1-Math.max(r.N4a,r.N4b)};});
const auc=(p,n)=>{let s=0;for(const x of p)for(const y of n)s+=x>y?1:x===y?.5:0;return +(s/(p.length*n.length)).toFixed(3)};
console.log(rows.length,'rows, luna flagged',rows.filter(r=>r.luna).length);
for(const v of ['N','N3','N4'])console.log(v,'auc',auc(rows.filter(r=>r.luna).map(r=>r[v]),rows.filter(r=>!r.luna).map(r=>r[v])));
const D2=D;
const show=(arr,t)=>{console.log('\n##',t);arr.forEach(r=>{const l=D2[r.id.split('#')[0]].lines[r.page];console.log(`${r.id} N(1-arrival)=${r.N.toFixed(2)} luna=${r.luna}\n  WHO ${l.who}\n  INST ${l.instant.slice(0,260)}`)})};
const sorted=rows.slice().sort((a,b)=>a.N-b.N);
show(sorted.filter(r=>!r.luna).slice(0,7),'Jev says arrival/naming staged (low N), luna silent');
show(sorted.filter(r=>r.luna).slice(0,7),'luna flags it, Jev says arrival/naming IS staged (low N)');
show(sorted.filter(r=>r.luna).slice(-7),'luna flags, Jev agrees no arrival (high N)');
show(sorted.filter(r=>!r.luna).slice(-7),'luna silent, Jev says no arrival (high N)');

const fs=require('fs');const D=__dirname+'/../../evals/runs/2026-10-09_jev-review/';
const a=fs.readFileSync(D+'trials_answers.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(x=>x.kind==='age');
const exp=p=>{const ks=Object.keys(p).map(Number);const t=ks.reduce((s,k)=>s+p[k],0)||1;return ks.reduce((s,k)=>s+k*p[k],0)/t/Math.max(1,ks.length-1)};
const rows={};
for(const x of a){const k=`${x.trial}|${x.page}|${x.name}`;rows[k]=rows[k]||{trial:x.trial,page:x.page,name:x.name,age:x.age};rows[k][x.variant]=x.noul!=null?x.noul:exp(x.probs);}
const POS=new Set(['1791500011394|5','1791500011394|6','1791218523638|3','1791218523638|4','1791218523638|5','1791497394846|3','1791497394846|4','1791497394846|5'].map(s=>s.replace(/^job_/,'')));
const R=Object.values(rows);
R.forEach(r=>{r.y=POS.has(r.trial.slice(4,17)+'|'+r.page);r.D13=Math.max(r.D2*(1-r.D1),r.D3);r.D=Math.max(r.D13, 0);});
const auc=(pos,neg)=>{let s=0;for(const p of pos)for(const n of neg)s+=p>n?1:p===n?.5:0;return +(s/(pos.length*neg.length)).toFixed(3)};
console.log('rows',R.length,'pos',R.filter(r=>r.y).length);
for(const v of ['S1','S2','D1','D2','D3','D4','D13']){const pos=R.filter(r=>r.y).map(r=>r[v]),neg=R.filter(r=>!r.y).map(r=>r[v]);console.log(v,'auc',auc(pos,neg),'pos',pos.map(x=>x.toFixed(2)).join(','));}
for(const v of ['S1','S2','D13']){console.log(v,'top rows:');R.sort((x,y)=>y[v]-x[v]).slice(0,14).forEach(r=>console.log('  ',r.trial.slice(4,17),'p'+r.page,r.name,r.age,r[v].toFixed(2),r.y?'POS':''));}

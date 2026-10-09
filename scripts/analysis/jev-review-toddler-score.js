const fs=require('fs');const D=__dirname+'/../../evals/runs/2026-10-09_jev-review/';
const a=fs.readFileSync(D+'toddler_answers.jsonl','utf8').trim().split('\n').map(JSON.parse);
const old=fs.readFileSync(D+'trials_answers.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(x=>x.kind==='age');
const R={};for(const x of a){const k=x.trial+'|'+x.page;R[k]=R[k]||{trial:x.trial,page:x.page,age:x.age};R[k][x.variant]=x.v;}
const POS=new Set(['1791500011394|5','1791500011394|6']);
const rows=Object.values(R);rows.forEach(r=>{r.y=POS.has(r.trial.slice(4,17)+'|'+r.page);r.P=r.D5*(1-r.D6);});
const auc=(pos,neg)=>{let s=0;for(const p of pos)for(const n of neg)s+=p>n?1:p===n?.5:0;return +(s/(pos.length*neg.length)).toFixed(3)};
console.log(rows.length,'rows, pos',rows.filter(r=>r.y).length);
for(const v of ['T1','T2','T3','D5','D6','P']){const f=rows.filter(r=>r.y).map(r=>r[v]),g=rows.filter(r=>!r.y).map(r=>r[v]);console.log(v,'auc',auc(f,g),'pos',f.map(x=>x.toFixed(2)).join(','),'neg max',Math.max(...g).toFixed(2),'neg>=pos-min count',g.filter(x=>x>=Math.min(...f)).length+'/'+g.length);}
for(const v of ['T1','T3','P']){console.log(v,'top');rows.sort((x,y)=>y[v]-x[v]).slice(0,8).forEach(r=>console.log('  ',r.trial.slice(4,17),'p'+r.page,'age'+r.age,r[v].toFixed(2),r.y?'POS':''));}

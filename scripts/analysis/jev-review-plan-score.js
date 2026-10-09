#!/usr/bin/env node
// Score Jev per-page plan-check questions against the luna-pro checker's findings (agreement) -> plan_metrics.json
const fs=require('fs'),path=require('path');
const DIR=path.join(__dirname,'../../evals/runs/2026-10-09_jev-review');
const divs=JSON.parse(fs.readFileSync(path.join(DIR,'plan_divs.json'),'utf8'));
const ans=fs.readFileSync(path.join(DIR,'plan_answers.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const A={};for(const a of ans){(A[a.id]=A[a.id]||{})[a.check+'|'+a.variant]=a.v;}
// luna flags: (div,page,check)
const L={};for(const d of divs)for(const f of d.findings)for(const p of f.pages||[]){L[`${d.id}#p${p}|${f.check}`]=(L[`${d.id}#p${p}|${f.check}`]||0)+1;}
const auc=(pos,neg)=>{if(!pos.length||!neg.length)return null;let s=0;for(const p of pos)for(const n of neg)s+=p>n?1:p===n?.5:0;return +(s/(pos.length*neg.length)).toFixed(3)};
// combos
const combos={
 '1:F1*F2':a=>a['1|F1']*a['1|F2'],'1:F1':a=>a['1|F1'],'1:S':a=>a['1|S'],
 '3:1-T1':a=>1-a['3|T1'],'3:T2':a=>a['3|T2'],'3:S':a=>a['3|S'],
 '5:max(P1,P2)':a=>Math.max(a['5|P1'],a['5|P2']),'5:P1':a=>a['5|P1'],'5:S':a=>a['5|S'],
 '9:DE':a=>a['9|DE'],'9:AF':a=>a['9|AF'],'9:max(DE,AF)':a=>Math.max(a['9|DE'],a['9|AF']),'9:SDE':a=>a['9|SDE'],'9:SAF':a=>a['9|SAF'],'9:max(SDE,SAF)':a=>Math.max(a['9|SDE'],a['9|SAF']),
 '10:H':a=>a['10|H'],'15:1-OP':a=>1-a['15|OP'],'8:1-LE':a=>1-a['8|LE'],'17:1-W':a=>1-a['17|W'],
};
const res={};
for(const [name,fn] of Object.entries(combos)){
  const chk=+name.split(':')[0];const rows=[];
  for(const [id,a] of Object.entries(A)){let v;try{v=fn(a);}catch(e){continue;}if(v==null||Number.isNaN(v))continue;
    // page eligible for this check? only pages where the question was asked
    rows.push({id,v,y:!!L[id+'|'+chk]});}
  const pos=rows.filter(r=>r.y),neg=rows.filter(r=>!r.y);
  const thr=[0.5,0.7,0.8,0.9].map(t=>{const tp=rows.filter(r=>r.v>=t&&r.y).length,fp=rows.filter(r=>r.v>=t&&!r.y).length,fn=rows.filter(r=>r.v<t&&r.y).length;return {t,tp,fp,fn,flagged:tp+fp};});
  res[name]={n:rows.length,lunaFlagged:pos.length,auc:auc(pos.map(r=>r.v),neg.map(r=>r.v)),thr};
}
fs.writeFileSync(path.join(DIR,'plan_metrics.json'),JSON.stringify(res,null,1));
for(const [k,v] of Object.entries(res))console.log(k.padEnd(16),'n',String(v.n).padEnd(4),'luna',String(v.lunaFlagged).padEnd(3),'auc',v.auc,' @.5 tp/fp',v.thr[0].tp+'/'+v.thr[0].fp,' @.7',v.thr[1].tp+'/'+v.thr[1].fp,' @.8',v.thr[2].tp+'/'+v.thr[2].fp);
const lat=ans.length;console.log('calls',lat,'cost',ans.reduce((s,x)=>s+x.cost,0).toFixed(4));

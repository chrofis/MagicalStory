#!/usr/bin/env node
// Plan-check Q2 (entrances) as Jev questions: per commissioned character, on the first page whose roster holds them.
// Variants: N1 noul (NAMING_DEF), N3 score, N4 decomposed (arrival act / naming act). Compared to the checker's Q2 findings.
require('dotenv').config({path:require('path').join(__dirname,'../../.env')});
const fs=require('fs'),path=require('path');
const J=require('../../server/lib/jevAudit');const PB=require('../../server/lib/promptBuilders');
const DIR=path.join(__dirname,'../../evals/runs/2026-10-09_jev-review');
const divs=JSON.parse(fs.readFileSync(DIR+'/plan_divs.json','utf8'));
const exp=p=>{const ks=Object.keys(p).map(Number);const t=ks.reduce((s,k)=>s+p[k],0)||1;return ks.reduce((s,k)=>s+k*p[k],0)/t/Math.max(1,ks.length-1)};
const lv=(...x)=>x;
(async()=>{const tasks=[];
for(const d of divs){const nums=Object.keys(d.lines).map(Number).sort((a,b)=>a-b);
 for(const n of d.commissioned){const first=nums.find(k=>{const r=d.roster[k];if(!r)return false;return [...(r.people||[]),...(r.covers||[])].some(x=>x.toLowerCase()===n.toLowerCase());});if(first==null)continue;const l=d.lines[first];if(!l.instant)continue;
  const st=`WHO IS IN FRAME: ${l.who}\nTHE INSTANT THE PICTURE SHOWS: ${l.instant}\nWHAT IS TRUE AFTER THIS PAGE: ${l.after}`;
  const id=`${d.id}#p${first}#${n}`;const add=(v,q)=>tasks.push({id,div:d.id,page:first,name:n,variant:v,state:st,q});
  add('N1',{type:'noul',instructions:`The instant stages ${n} as an ${PB.NAMING_DEF}`});
  add('N3',{type:'score',instructions:`How does the instant bring ${n} into the story?`,criteria:lv(`${n} is simply in frame already, with no arrival and no one naming ${n}`,`${n} is in frame with a weak sign of an arrival or a naming`,`${n} arrives, or is named by someone present, as a visible act`)});
  add('N4a',{type:'noul',instructions:`In the instant ${n} arrives, enters, lands or is reached by the others as a visible act.`});
  add('N4b',{type:'noul',instructions:`In the instant someone present names, greets or introduces ${n} as a visible act.`});
 }}
console.log(tasks.length,'calls');const out=fs.createWriteStream(DIR+'/q2_answers.jsonl');let i=0,cost=0;
await Promise.all(Array.from({length:6},async()=>{while(i<tasks.length){const t=tasks[i++];const r=await J.callJev({state:t.state,questions:{Q:t.q}});cost+=r.cost;const a=r.answers.Q;out.write(JSON.stringify({id:t.id,div:t.div,page:t.page,name:t.name,variant:t.variant,v:a.noul!=null?a.noul:exp(a.probabilities)})+'\n');}}));
out.end();console.log('done $'+cost.toFixed(5));})();

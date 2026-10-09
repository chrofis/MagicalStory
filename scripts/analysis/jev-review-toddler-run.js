// toddler / young-child "alone away from home" variants (T1 story-level, T2 reworded, T3 score, D5 public-place decomposition)
require('dotenv').config({path:require('path').join(__dirname,'../../.env')});
const fs=require('fs');const J=require('../../server/lib/jevAudit');
const D=__dirname+'/../../evals/runs/2026-10-09_jev-review/';
const trials=JSON.parse(fs.readFileSync(D+'trials.json','utf8'));
const exp=p=>{const ks=Object.keys(p).map(Number);const t=ks.reduce((s,k)=>s+p[k],0)||1;return ks.reduce((s,k)=>s+k*p[k],0)/t/Math.max(1,ks.length-1)};
(async()=>{
const out=fs.createWriteStream(D+'toddler_answers.jsonl');let cost=0;const tasks=[];
for(const tr of trials){const ch=tr.characters.find(c=>Number(c.age)<=4);if(!ch)continue;const n=ch.name,a=Number(ch.age);
 for(const pg of tr.pages){
  const story=tr.pages.map(p=>`--- Page ${p.pageNumber}${p.pageNumber===pg.pageNumber?' (PAGE TO JUDGE)':''} ---\n${p.text}`).join('\n\n');
  const add=(variant,state,q)=>tasks.push({trial:tr.id,page:pg.pageNumber,name:n,age:a,variant,state,q});
  add('T1',story,{type:'noul',instructions:`On the page to judge, ${n}, who is ${a} year${a==1?'':'s'} old, is at a place away from home with no grown-up named in that page or beside ${n}.`});
  add('T2',pg.text,{type:'noul',instructions:`In this scene no grown-up is named as being with ${n}, and ${n} is in a public place or has left home.`});
  add('T3',story,{type:'score',instructions:`Who is looking after ${n} on the page to judge?`,criteria:[`a grown-up is named as with ${n}, or ${n} is at home`,`no grown-up is named, but ${n} stays in a garden or room where one could be near`,`no grown-up is named and ${n} is away from home in a public place`]});
  add('D5',pg.text,{type:'noul',instructions:`${n} is in a public place away from home (a street, church, shop or park) on this page.`});
  add('D6',story,{type:'noul',instructions:`Before or on the page to judge, a grown-up who looks after ${n} has been named as being at the same place as ${n}.`});
 }}
let i=0;await Promise.all(Array.from({length:6},async()=>{while(i<tasks.length){const t=tasks[i++];const r=await J.callJev({state:t.state,questions:{Q:t.q}});cost+=r.cost;const x=r.answers.Q;out.write(JSON.stringify({trial:t.trial,page:t.page,name:t.name,age:t.age,variant:t.variant,v:x.noul!=null?x.noul:exp(x.probabilities)})+'\n');}}));
out.end();console.log(tasks.length,'calls $'+cost.toFixed(5));})();

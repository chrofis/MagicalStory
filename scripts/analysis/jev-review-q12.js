#!/usr/bin/env node
// Plan-check Q12 (each character's own action), Q15 (opening) and Q8 (last page) as Jev questions - round 2 wordings.
// Q12: per (commissioned character, page) noul "this instant is X's own act", combined by max over pages; compared to the checker's ACTION lines.
require('dotenv').config({path:require('path').join(__dirname,'../../.env')});
const fs=require('fs'),path=require('path');
const J=require('../../server/lib/jevAudit');const PB=require('../../server/lib/promptBuilders');
const DIR=path.join(__dirname,'../../evals/runs/2026-10-09_jev-review');
const divs=JSON.parse(fs.readFileSync(DIR+'/plan_divs.json','utf8'));
const raw=JSON.parse(fs.readFileSync(DIR+'/raw.json','utf8')).filter(x=>x.b);
const exp=p=>{const ks=Object.keys(p).map(Number);const t=ks.reduce((s,k)=>s+p[k],0)||1;return ks.reduce((s,k)=>s+k*p[k],0)/t/Math.max(1,ks.length-1)};
const replyOf=Object.fromEntries(raw.flatMap(s=>[[s.id.slice(4,17)+':check1',s.b.checkReply],[s.id.slice(4,17)+':recheck',s.b.recheck&&s.b.recheck.reply],...(s.b.discardedRounds||[]).map(d=>[s.id.slice(4,17)+':disc'+d.round,d.recheck&&d.recheck.reply])]));
const tasks=[];
for(const d of divs){const nums=Object.keys(d.lines).map(Number).sort((a,b)=>a-b);const reply=replyOf[d.id]||'';
 const actions={};for(const m of reply.matchAll(/^ACTION\s+([^:\n]+):\s*sentences?\s+[^—\n]*—\s*pages?\s+([^\n]+)/gim))actions[m[1].trim()]=m[2].trim();
 for(const n of d.commissioned){ if(!(n in actions))continue;
  for(const k of nums){const l=d.lines[k];if(!l.instant)continue;const st=`WHO IS IN FRAME: ${l.who}\nTHE INSTANT THE PICTURE SHOWS: ${l.instant}`;
   tasks.push({id:`${d.id}#${n}`,div:d.id,name:n,page:k,variant:'A1',state:st,actions:actions[n],q:{type:'noul',instructions:`${n} is in frame and the instant is an act of ${n} of their own: ${n} does something themselves, not only carried, watched or present.`}});
   tasks.push({id:`${d.id}#${n}`,div:d.id,name:n,page:k,variant:'A3',state:st,actions:actions[n],q:{type:'score',instructions:`What role does ${n} have in this instant?`,criteria:[`${n} is not in the instant`,`${n} is present or carried or only watches`,`${n} does an act of their own that the instant is about`]}});
 }}
 // Q15 / Q8 round 2
 const first=d.lines[nums[0]],last=d.lines[nums[nums.length-1]];
 if(first&&first.instant)tasks.push({id:`${d.id}#open`,div:d.id,page:nums[0],variant:'O3',state:`THE INSTANT THE PICTURE SHOWS: ${first.instant}`,q:{type:'score',instructions:'How does the first page open?',criteria:['on a pose, a look at the place, or someone waiting','on a mild activity','on an action already under way']}});
 const ls=(d.arc.match(/(?:^|\n)\s*(\d+)\.\s*([^\n]+)/g)||[]).pop();
 if(last&&last.instant&&ls)tasks.push({id:`${d.id}#end`,div:d.id,page:nums[nums.length-1],variant:'E3',state:`THE LAST SENTENCE OF THE STORY: ${ls.replace(/^\s*\d+\.\s*/,'')}\n\nTHE INSTANT OF THE LAST PAGE: ${last.instant}`,q:{type:'score',instructions:'Does the instant of the last page show the event told by the last sentence of the story?',criteria:['it shows a different moment, and the event of the last sentence is not shown','it shows part of that event','it shows that event itself']}});
}
console.log(tasks.length,'calls');const out=fs.createWriteStream(DIR+'/q12_answers.jsonl');let i=0,cost=0;
await_all();
async function await_all(){await Promise.all(Array.from({length:6},async()=>{while(i<tasks.length){const t=tasks[i++];const r=await J.callJev({state:t.state,questions:{Q:t.q}});cost+=r.cost;const a=r.answers.Q;out.write(JSON.stringify({id:t.id,div:t.div,name:t.name,page:t.page,variant:t.variant,actions:t.actions,v:a.noul!=null?a.noul:exp(a.probabilities)})+'\n');}}));out.end();console.log('done $'+cost.toFixed(5));}

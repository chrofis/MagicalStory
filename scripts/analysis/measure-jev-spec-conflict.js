// Measurement 2026-10-09 (docs/decisions.md 'prose-meaning sites measured'). Paid: Jev ~USD 0.002. Reads stored staging data.
const PATH_ = require('path'); const R = PATH_.join(__dirname, '../..') + '/';
require('../../node_modules/dotenv').config({path:R+'.env'});
const fs=require('fs');const J=require(R+'server/lib/jevDecisions');
const pairs=JSON.parse(fs.readFileSync(R+'evals/runs/2026-10-09_jev-specconflict/pairs_code.json'));
(async()=>{
 const reqs=pairs.map((p,i)=>({key:'p'+i,state:`${p.A.character}: ${p.A.where}\n${p.B.character}: ${p.B.where}`,questions:{Q:{type:'choice',instructions:`The two lines each describe what a figure does. Does the action of ${p.B.character} take hold of, press, or reach for a body part of ${p.A.character} that ${p.A.character}'s own action is already using?`,criteria:{s0:`yes, the same body part of ${p.A.character} is used by ${p.A.character} and also held, pressed or reached for by ${p.B.character}`,s1:'no'}}}}));
 const stats={calls:0,cost:0,ms:[],retries:0,failed:0,errors:[]};
 const ans=await J.runJevRequests(reqs,{stats,usageLabel:'jev_specconflict_measure'});
 const out=pairs.map((p,i)=>{const a=(ans.get('p'+i)||[])[0]||{};const q=a.Q;return {i,p:q&&q.probabilities&&q.probabilities.s0};});
 fs.writeFileSync(R+'evals/runs/2026-10-09_jev-specconflict/jev.json',JSON.stringify(out));
 console.log('cost',stats.cost,'calls',stats.calls,'failed',stats.failed);
 const sorted=out.filter(o=>typeof o.p==='number').sort((a,b)=>b.p-a.p);
 console.log('>=0.5:',sorted.filter(o=>o.p>=0.5).length,'>=0.3:',sorted.filter(o=>o.p>=0.3).length,'n',sorted.length);
 for(const o of sorted.slice(0,30)){const p=pairs[o.i];console.log(o.p.toFixed(2),`#${o.i} A[${p.A.character}] "${p.A.where}" | B[${p.B.character}] "${p.B.where}"`);}
})().catch(e=>{console.error(e);process.exit(1)});

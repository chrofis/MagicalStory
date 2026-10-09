require('dotenv').config({path:__dirname+'/../../.env'});
const PB=require('../../server/lib/promptBuilders');
const raw=require('../../evals/runs/2026-10-09_jev-review/raw.json').filter(x=>x.b);
const cnt={};let nchecks=0,nre=0,ndisc=0;
const add=(label,reply)=>{ if(!reply)return;const f=PB.parsePlanCheck(reply);for(const x of f){if(/^no finding/i.test(x.text||''))continue;const k=(x.check!=null?'C'+x.check:(x.code||'?'));cnt[k]=cnt[k]||{check1:0,recheck:0,disc:0};cnt[k][label]++;}};
for(const s of raw){const b=s.b;if(b.checkReply){nchecks++;add('check1',b.checkReply);}if(b.recheck&&b.recheck.reply){nre++;add('recheck',b.recheck.reply);}for(const d of b.discardedRounds||[]){if(d.recheck&&d.recheck.reply){ndisc++;add('disc',d.recheck.reply);}}}
console.log({nchecks,nre,ndisc});
console.log(Object.entries(cnt).sort((a,b)=>(+a[0].slice(1))-(+b[0].slice(1))).map(([k,v])=>k+' '+JSON.stringify(v)).join('\n'));
const x=raw[0].b;console.log(Object.keys(x.recheck));console.log(x.recheck.lines.slice(0,5));console.log(x.modelFindings.slice(0,3), (x.counterFindings||[]).slice(0,2));

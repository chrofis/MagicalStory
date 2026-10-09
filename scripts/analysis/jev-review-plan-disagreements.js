const fs=require('fs'),path=require('path');
const DIR=path.join(__dirname,'../../evals/runs/2026-10-09_jev-review');
const divs=JSON.parse(fs.readFileSync(DIR+'/plan_divs.json','utf8'));
const ans=fs.readFileSync(DIR+'/plan_answers.jsonl','utf8').trim().split('\n').map(JSON.parse);
const A={};for(const a of ans)(A[a.id]=A[a.id]||{})[a.check+'|'+a.variant]=a.v;
const [,, chk, fnName, mode, lo, hi, lim] = process.argv;
const fns={'3':a=>1-a['3|T1'],'9b':a=>a['9|AF'],'1':a=>a['1|F1']*a['1|F2'],'5':a=>a['5|P1'],'10':a=>a['10|H'],'17':a=>1-a['17|W'],'9a':a=>a['9|DE']};
const fn=fns[fnName];const out=[];
for(const d of divs)for(const n of Object.keys(d.lines)){const id=`${d.id}#p${n}`;const a=A[id];if(!a)continue;let v;try{v=fn(a)}catch(e){continue}if(v==null||isNaN(v))continue;
 const fs_=d.findings.filter(f=>f.check==+chk&&(f.pages||[]).includes(+n));const luna=fs_.length>0;
 out.push({id,d,n,v,luna,txt:fs_.map(f=>f.text).join(' | ')});}
let sel;
if(mode==='jevonly')sel=out.filter(r=>!r.luna&&r.v>=+lo);else if(mode==='lunaonly')sel=out.filter(r=>r.luna&&r.v<=+hi);else sel=out.filter(r=>r.luna&&r.v>=+lo);
sel.sort((a,b)=>b.v-a.v);console.log(mode,sel.length);
sel.slice(0,+lim||30).forEach((r,i)=>{const l=r.d.lines[r.n];console.log(`\n#${i} ${r.id} jev ${r.v.toFixed(2)} luna:${r.luna?'Y':'n'}\n WHO: ${l.who}\n INSTANT: ${l.instant}\n AFTER: ${l.after}${r.luna?'\n LUNA: '+r.txt.slice(0,250):''}`)});

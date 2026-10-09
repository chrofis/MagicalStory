require('dotenv').config({path:__dirname+'/../../.env'});
const PB=require('../../server/lib/promptBuilders');
const divs=require('../../evals/runs/2026-10-09_jev-review/plan_divs.json');
const must={},all={};
for(const d of divs){for(const f of d.findings){const r=PB.replanRank({check:f.check,text:f.text,line:'CHECK['+f.check+']: '+f.text});all[f.check]=(all[f.check]||0)+1;if(r==='must')must[f.check]=(must[f.check]||0)+1;}}
console.log('all',all);console.log('must',must);
const tm=Object.values(must).reduce((a,b)=>a+b,0);const jevshape=[1,2,3,5,9,10,15,17,8].reduce((s,k)=>s+(must[k]||0),0);console.log('must total',tm,'in Jev-shaped checks',jevshape);

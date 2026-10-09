const fs=require('fs');const DIR=__dirname+'/../../evals/runs/2026-10-09_jev-review';
const a=fs.readFileSync(DIR+'/q12_answers.jsonl','utf8').trim().split('\n').map(JSON.parse);
const divs=JSON.parse(fs.readFileSync(DIR+'/plan_divs.json','utf8'));const D=Object.fromEntries(divs.map(d=>[d.id,d]));
const auc=(p,n)=>{if(!p.length||!n.length)return null;let s=0;for(const x of p)for(const y of n)s+=x>y?1:x===y?.5:0;return +(s/(p.length*n.length)).toFixed(3)};
const R={};for(const x of a.filter(x=>x.name)){const r=R[x.id]=R[x.id]||{id:x.id,div:x.div,name:x.name,actions:x.actions,A1:{},A3:{}};r[x.variant][x.page]=x.v;}
const rows=Object.values(R).map(r=>{const none=/^none/i.test(r.actions.trim());const pages=(r.actions.match(/\d+/g)||[]).map(Number);
 const best=v=>Object.entries(r[v]).sort((p,q)=>q[1]-p[1])[0];const b1=best('A1'),b3=best('A3');
 return {...r,none,pages,max1:+b1[1],max3:+b3[1],arg1:+b1[0],arg3:+b3[0],agree1:pages.includes(+b1[0]),agree3:pages.includes(+b3[0])};});
console.log('rows',rows.length,'luna none',rows.filter(r=>r.none).length);
const nn=rows.filter(r=>!r.none);
console.log('argmax page agrees with checker page: A1',nn.filter(r=>r.agree1).length+'/'+nn.length,'A3',nn.filter(r=>r.agree3).length+'/'+nn.length);
for(const v of ['max1','max3']){console.log(v,'auc (none = positive, low score):',auc(rows.filter(r=>r.none).map(r=>1-r[v]),rows.filter(r=>!r.none).map(r=>1-r[v])));
 for(const t of [0.5,0.7,0.9]){const tp=rows.filter(r=>r.none&&r[v]<t).length,fp=rows.filter(r=>!r.none&&r[v]<t).length,fn=rows.filter(r=>r.none&&r[v]>=t).length;console.log('  <'+t,'tp',tp,'fp',fp,'fn',fn);}}
console.log('--- none rows (checker says no page stages the action):');rows.filter(r=>r.none).forEach(r=>console.log(r.id,'max1',r.max1.toFixed(2),'max3',r.max3.toFixed(2)));
// Q15 / Q8
for(const [k,label,name] of [['open','O3','Q15'],['end','E3','Q8']]){
 const rs=a.filter(x=>x.variant===label);const out=[];
 for(const x of rs){const d=D[x.div];const f=d.findings.filter(f=>f.check===(k==='open'?15:8));out.push({id:x.id,v:k==='open'?1-x.v:1-x.v,luna:f.length>0});}
 console.log(name,'n',out.length,'luna flagged',out.filter(r=>r.luna).length,'auc',auc(out.filter(r=>r.luna).map(r=>r.v),out.filter(r=>!r.luna).map(r=>r.v)));
}

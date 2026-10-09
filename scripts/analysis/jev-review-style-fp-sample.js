const fs=require('fs');const DIR=__dirname+'/../../evals/runs/2026-10-09_jev-review';
const stories=JSON.parse(fs.readFileSync(DIR+'/stories.json','utf8'));const J=require('../../server/lib/jevAudit');
const rd=f=>fs.readFileSync(DIR+'/'+f,'utf8').trim().split('\n').map(JSON.parse);
const S={};for(const a of rd('text_answers.jsonl')){(S[a.id]=S[a.id]||{})[a.variant]=a.v;}
const sf=JSON.parse(fs.readFileSync(DIR+'/style_findings.json','utf8'));const norm=s=>String(s).replace(/\s+/g,' ').replace(/[«»"„“”]/g,'').trim().toLowerCase();
const text={};for(const s of stories)for(const p of s.pages)J.splitSentences(p.text).forEach((t,i)=>text[`${s.id.slice(4,17)}#p${p.pageNumber}#s${i}`]=t);
const lab=cls=>{const q=sf.filter(f=>f.cls===cls).map(f=>({s:f.story.slice(4,17),p:f.page,q:norm(f.quote)})).filter(x=>x.q.length>8);const set=new Set();for(const [id,t] of Object.entries(text)){const n=norm(t);if(q.some(x=>id.startsWith(x.s+'#p'+x.p+'#')&&(n.includes(x.q.slice(0,40))||x.q.includes(n.slice(0,40)))))set.add(id);}return set;};
const [,, cls, expr, lo, lim, seed]=process.argv;
const set=lab(cls);const fn=new Function('r','return '+expr);
let rows=Object.keys(S).map(id=>({id,v:fn(S[id]),y:set.has(id)})).filter(r=>r.v>=+lo&&!r.y);
// deterministic spread
rows.sort((a,b)=>a.id<b.id?-1:1);const step=Math.max(1,Math.floor(rows.length/ +lim));rows=rows.filter((_,i)=>i%step===0).slice(0,+lim);
console.log(cls,expr,'FP candidates sampled',rows.length);rows.forEach((r,i)=>console.log(`#${i} ${r.v.toFixed(2)} ${r.id}: ${text[r.id].slice(0,230)}`));

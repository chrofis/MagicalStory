const fs=require('fs');const DIR=__dirname+'/../../evals/runs/2026-10-09_jev-review';
const stories=JSON.parse(fs.readFileSync(DIR+'/stories.json','utf8'));const J=require('../../server/lib/jevAudit');
const rd=f=>fs.readFileSync(DIR+'/'+f,'utf8').trim().split('\n').map(JSON.parse);
const S={};for(const a of rd('text_answers.jsonl')){(S[a.id]=S[a.id]||{})[a.variant]=a.v;}
const sf=JSON.parse(fs.readFileSync(DIR+'/style_findings.json','utf8'));const norm=s=>String(s).replace(/\s+/g,' ').replace(/[«»"„“”]/g,'').trim().toLowerCase();
const text={};for(const s of stories)for(const p of s.pages)J.splitSentences(p.text).forEach((t,i)=>text[`${s.id.slice(4,17)}#p${p.pageNumber}#s${i}`]=t);
const lab=cls=>{const q=sf.filter(f=>f.cls===cls).map(f=>({s:f.story.slice(4,17),p:f.page,q:norm(f.quote)})).filter(x=>x.q.length>8);const set=new Set();for(const [id,t] of Object.entries(text)){const n=norm(t);if(q.some(x=>id.startsWith(x.s+'#p'+x.p+'#')&&(n.includes(x.q.slice(0,40))||x.q.includes(n.slice(0,40)))))set.add(id);}return set;};
for(const [cls,fns] of [['LOOK',{L4:r=>r.L4a*(1-r.L4b),L3:r=>r.L3,L1:r=>r.L1}],['EXPLAIN',{E3:r=>r.E3,E1:r=>r.E1,'max(E1,E3)':r=>Math.max(r.E1,r.E3)}]]){
 const set=lab(cls);for(const [n,fn] of Object.entries(fns)){const rows=Object.keys(S).map(id=>({id,v:fn(S[id]),y:set.has(id)}));const pos=rows.filter(r=>r.y).map(r=>r.v).sort((a,b)=>a-b);
  const out=[];for(const rec of [0.8,0.9,1.0]){const k=Math.ceil(pos.length*(1-rec));const thr=pos[Math.min(k,pos.length-1)]-(rec===1?1e-9:0);const fl=rows.filter(r=>r.v>=thr).length;out.push(`recall ${rec}: thr ${thr.toFixed(2)} flags ${fl} (${(fl/17).toFixed(1)}/story)`);}
  console.log(cls,n,'pos',pos.length,out.join(' | '));}}

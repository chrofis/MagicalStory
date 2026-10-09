#!/usr/bin/env node
// Score text-audit Jev variants (page: PULL/ENDING; mention: CONFUSION/ENTRANCE; sentence: LOOK/EXPLAIN) against the stored LLM findings.
const fs=require('fs'),path=require('path');
const DIR=path.join(__dirname,'../../evals/runs/2026-10-09_jev-review');
const rd=f=>fs.existsSync(DIR+'/'+f)?fs.readFileSync(DIR+'/'+f,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const stories=JSON.parse(fs.readFileSync(DIR+'/stories.json','utf8'));
const auc=(p,n)=>{if(!p.length||!n.length)return null;let s=0;for(const x of p)for(const y of n)s+=x>y?1:x===y?.5:0;return +(s/(p.length*n.length)).toFixed(3)};
const thr=(rows,ts)=>ts.map(t=>({t,tp:rows.filter(r=>r.v>=t&&r.y).length,fp:rows.filter(r=>r.v>=t&&!r.y).length,fn:rows.filter(r=>r.v<t&&r.y).length}));
const out={};
// PAGE
{const A={};for(const a of rd('page_answers.jsonl')){(A[a.id]=A[a.id]||{})[a.variant]=a.v;}
 const faults=[];for(const s of stories)for(const [src,a] of Object.entries(s.audits))for(const f of a.faults)faults.push({id:s.id.slice(4,17)+'#p'+f.page,cat:f.cat,src});
 const has=(id,cat)=>faults.some(f=>f.id===id&&f.cat===cat);
 const ids=Object.keys(A);
 const pull=ids.filter(i=>A[i].PU1!=null).map(i=>({id:i,y:has(i,'PULL'),v:1-A[i].PU1,v3:1-A[i].PU3}));
 out.PULL={n:pull.length,pos:pull.filter(r=>r.y).length,auc_PU1:auc(pull.filter(r=>r.y).map(r=>r.v),pull.filter(r=>!r.y).map(r=>r.v)),auc_PU3:auc(pull.filter(r=>r.y).map(r=>r.v3),pull.filter(r=>!r.y).map(r=>r.v3))};
 const end=ids.filter(i=>A[i].EN1!=null).map(i=>({id:i,y:has(i,'ENDING'),v:A[i].EN1,v3:A[i].EN3}));
 out.ENDING={n:end.length,pos:end.filter(r=>r.y).length,auc_EN1:auc(end.filter(r=>r.y).map(r=>r.v),end.filter(r=>!r.y).map(r=>r.v)),auc_EN3:auc(end.filter(r=>r.y).map(r=>r.v3),end.filter(r=>!r.y).map(r=>r.v3)),rows:end.map(r=>[r.id,r.y,+r.v.toFixed(2),+r.v3.toFixed(2)])};
}
// MENTION
{const M={};for(const a of rd('mention_answers.jsonl')){(M[a.id]=M[a.id]||{name:a.name,page:a.page,story:a.story})[a.variant]=a.v;}
 const rows=Object.entries(M).map(([id,m])=>{const s=stories.find(x=>x.id===m.story);const fl=[];for(const [src,a] of Object.entries(s.audits))for(const f of a.faults)if(f.page===m.page&&['CONFUSION','ENTRANCE'].includes(f.cat)&&f.text.includes(m.name))fl.push(f);return {id,y:fl.length>0,v:1-m.M1,v3:1-m.M3};});
 out.MENTION={n:rows.length,pos:rows.filter(r=>r.y).length,auc_M1:auc(rows.filter(r=>r.y).map(r=>r.v),rows.filter(r=>!r.y).map(r=>r.v)),auc_M3:auc(rows.filter(r=>r.y).map(r=>r.v3),rows.filter(r=>!r.y).map(r=>r.v3)),thr_M3:thr(rows.map(r=>({v:r.v3,y:r.y})),[0.5,0.7,0.9])};
}
// SENTENCES
{const S={};for(const a of rd('text_answers.jsonl')){(S[a.id]=S[a.id]||{page:a.page,story:a.story})[a.variant]=a.v;}
 const norm=s=>String(s).replace(/\s+/g,' ').replace(/[«»"„“”]/g,'').trim().toLowerCase();
 const sf=JSON.parse(fs.readFileSync(DIR+'/style_findings.json','utf8'));
 const J=require('../../server/lib/jevAudit');
 const sentText={};for(const s of stories)for(const p of s.pages)J.splitSentences(p.text).forEach((t,i)=>sentText[`${s.id.slice(4,17)}#p${p.pageNumber}#s${i}`]=norm(t));
 const lab=(cls)=>{const q=sf.filter(f=>f.cls===cls).map(f=>({s:f.story.slice(4,17),p:f.page,q:norm(f.quote)})).filter(x=>x.q.length>8);const set=new Set();for(const [id,t] of Object.entries(sentText)){if(q.some(x=>id.startsWith(x.s+'#p'+x.p+'#')&&(t.includes(x.q.slice(0,40))||x.q.includes(t.slice(0,40)))))set.add(id);}return {set,nq:q.length};};
 for(const [cls,combos] of [['LOOK',{L1:r=>r.L1,L3:r=>r.L3,'L4a*(1-L4b)':r=>r.L4a*(1-r.L4b),L4a:r=>r.L4a}],['EXPLAIN',{E1:r=>r.E1,E3:r=>r.E3,'E4a*(1-E4b)':r=>r.E4a*(1-r.E4b),E4a:r=>r.E4a}]]){
  const {set,nq}=lab(cls);const ids=Object.keys(S).filter(i=>S[i].L1!=null||S[i].E1!=null);
  out[cls]={sentences:ids.length,quotes:nq,matchedPositives:set.size};
  for(const [name,fn] of Object.entries(combos)){const rows=ids.map(i=>({id:i,y:set.has(i),v:fn(S[i])})).filter(r=>r.v!=null&&!Number.isNaN(r.v));out[cls][name]={auc:auc(rows.filter(r=>r.y).map(r=>r.v),rows.filter(r=>!r.y).map(r=>r.v)),thr:thr(rows,[0.5,0.7,0.9]),flaggedAt70:rows.filter(r=>r.v>=0.7).length};}
 }
}
fs.writeFileSync(DIR+'/text_metrics.json',JSON.stringify(out,null,1));console.log(JSON.stringify(out,(k,v)=>k==='rows'?undefined:v,1));

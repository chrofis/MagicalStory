#!/usr/bin/env node
// Plan-check divisions (check, recheck, discarded rechecks) from stored staging beatsReviewReport, for the Jev review (2026-10-09).
require('dotenv').config({path:require('path').join(__dirname,'../../.env')});
const fs=require('fs'),path=require('path');
const PB=require('../../server/lib/promptBuilders');
const DIR=path.join(__dirname,'../../evals/runs/2026-10-09_jev-review');
const raw=JSON.parse(fs.readFileSync(path.join(DIR,'raw.json'),'utf8')).filter(x=>x.b);
function planLines(prompt){const i=String(prompt||'').indexOf('# THE PAGE PLAN');if(i<0)return null;const out={};for(const l of prompt.slice(i).split('\n')){const m=l.trim().match(/^Page\s+(\d+)\s*:\s*(.*)$/);if(m)out[m[1]]=m[2].replace(/^PLAN:\s*/,'');else if(/^# /.test(l.trim())&&Object.keys(out).length)break;}return Object.keys(out).length?out:null;}
function split(line){const p=line.split(/\s+—\s+/);if(p.length<4)return null;return {shot:p[0],who:p[1],instant:p.slice(2,p.length-1).join(' — '),after:p[p.length-1]};}
function arcOf(prompt){const m=String(prompt||'').match(/# THE STORY\n\n([\s\S]*?)\n\n# /);return m?m[1].trim():'';}
function qmap(prompt){const i=String(prompt||'').indexOf('# YOUR TASK');const o={};if(i<0)return o;for(const m of prompt.slice(i).matchAll(/^(\d+)\.\s+([A-Z][A-Za-z' ,-]{2,40}?)\./gm))o[m[1]]=m[2];return o;}
const divs=[];
for(const s of raw){const b=s.b;const comm=(b.cast&&b.cast.commissioned)||[];
  const add=(stage,prompt,reply)=>{const pl=planLines(prompt);if(!pl||!reply)return;
    const fnd=PB.parsePlanCheck(reply).filter(f=>!/^no finding/i.test(f.text||'')&&f.check!=null).map(f=>({check:f.check,text:f.text,pages:PB.findingPages({line:f.text})}));
    let roster={};try{const r=PB.parsePlanCheckRoster(reply);for(const [n,v] of r)roster[n]={people:v.people,covers:v.covers,things:v.things,unlisted:v.unlisted};}catch(e){}
    divs.push({id:s.id.slice(4,17)+':'+stage,story:s.id,stage,lang:s.lang,commissioned:comm,lines:Object.fromEntries(Object.entries(pl).map(([n,l])=>[n,{raw:l,...(split(l)||{})}])),roster,findings:fnd,arc:arcOf(prompt),qmap:qmap(prompt),asks17:/^\s*17(?:[.):–—-]|\s)/m.test(reply)});};
  add('check1',b.prompt,b.checkReply);
  if(b.recheck)add('recheck',b.recheck.prompt,b.recheck.reply);
  (b.discardedRounds||[]).forEach((d,i)=>{if(d.recheck)add('disc'+d.round,d.recheck.prompt,d.recheck.reply);});
}
fs.writeFileSync(path.join(DIR,'plan_divs.json'),JSON.stringify(divs));
const pages=divs.reduce((s,d)=>s+Object.keys(d.lines).length,0);
console.log(divs.length,'divisions',pages,'page lines;', divs.reduce((s,d)=>s+d.findings.length,0),'findings; stages:',divs.reduce((m,d)=>(m[d.stage.replace(/\d+/,'')]=(m[d.stage.replace(/\d+/,'')]||0)+1,m),{}));
console.log('split ok',divs.reduce((s,d)=>s+Object.values(d.lines).filter(l=>l.instant).length,0));

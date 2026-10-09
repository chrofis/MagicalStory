#!/usr/bin/env node
// Extract stored plan-check and text-audit outputs from staging for the Jev review measurement (2026-10-09).
// Writes evals/runs/2026-10-09_jev-review/{raw.json,stories.json}. Story text: gitignored/GDPR, do not commit.
require('dotenv').config({path:require('path').join(__dirname,'../../.env')});
const {Pool}=require('pg'),fs=require('fs'),path=require('path');
const OUT=path.join(__dirname,'../../evals/runs/2026-10-09_jev-review');
const FAULT=/^FAULT(?:\[([A-Z]+)\])?:\s*p(?:age)?\s*(\d+)\s*[—–:.-]?\s*([\s\S]*)$/i;
function parseFaults(raw){return String(raw||'').split('\n').map(l=>l.trim().match(FAULT)).filter(Boolean).map(m=>({cat:(m[1]||'').toUpperCase(),page:+m[2],text:m[3].trim()}));}
function pagesOf(prompt){const i=prompt.indexOf('# THE PAGES');const s=prompt.slice(i);const out=[];for(const m of s.matchAll(/--- Page (\d+) ---\n([\s\S]*?)(?=\n--- Page \d+ ---|\n\nRead the pages|$)/g))out.push({pageNumber:+m[1],text:m[2].trim()});return out;}
(async()=>{
const pool=new Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:false}});
const r=await pool.query(`SELECT id, created_at, data->'language' lang, data->'beatsReviewReport' b, data->'textRefineReport' t, data->'sceneDescriptions' sd FROM stories WHERE created_at>now()-interval '30 days' AND data ? 'beatsReviewReport' ORDER BY created_at desc`);
fs.mkdirSync(OUT,{recursive:true});
fs.writeFileSync(path.join(OUT,'raw.json'),JSON.stringify(r.rows));
const stories=[];
for(const x of r.rows){ if(!x.t||!x.t.audits) continue;
  const blind=x.t.audits.find(a=>a.source==='blind'); if(!blind||!blind.prompt) continue;
  const pages=pagesOf(blind.prompt); if(!pages.length) continue;
  const cast={};
  for(const s of x.sd||[]){ const d=String(s.description||''); const j=d.split('---METADATA---')[1]; try{const m=JSON.parse(j);cast[s.pageNumber]=[...(m.characters||[]).map(c=>c.name),...(m.creatures||[]).map(c=>typeof c==='string'?c:c.name)].filter(Boolean);}catch(e){} }
  stories.push({id:x.id,date:x.created_at,lang:x.lang,pages,pictureCast:cast,allCast:(x.b&&x.b.cast&&x.b.cast.all)||[],
    audits:Object.fromEntries(x.t.audits.map(a=>[a.source,{model:a.modelKey,faults:parseFaults(a.raw),cost:a.cost}])),ledger:x.t.findingLedger||[]});
}
fs.writeFileSync(path.join(OUT,'stories.json'),JSON.stringify(stories));
console.log(r.rows.length,'rows;',stories.length,'stories with text audits; pages',stories.reduce((s,x)=>s+x.pages.length,0));
await pool.end();})();

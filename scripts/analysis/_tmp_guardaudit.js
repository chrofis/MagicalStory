require('dotenv').config();
const { Pool } = require('pg');
const isBareProperName = (s) => /^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß]+$/.test(s);
const splitComposite = (s) => s.split(/\s*\+\s*/).map(p=>p.trim()).filter(Boolean);
const SQL = `
 SELECT s.id, s.data->>'title' AS t,
        (e->>'pageNumber')::int AS pn,
        e->>'sceneDescription' AS sd
 FROM stories s, jsonb_array_elements(s.data->'sceneImages') e
 WHERE s.id = ANY($1)`;
(async()=>{
 const tgt=[], act=[]; let pages=0, stories=0;
 for (const [env,cs] of [['staging',process.env.STAGING_DATABASE_URL],['prod',process.env.DATABASE_URL]]) {
  const p=new Pool({connectionString:cs,ssl:{rejectUnauthorized:false}});
  const ids=(await p.query("SELECT id FROM stories WHERE data->'sceneImages' IS NOT NULL ORDER BY created_at DESC LIMIT 12")).rows.map(r=>r.id);
  stories+=ids.length;
  const r=await p.query(SQL,[ids]);
  for (const row of r.rows) {
    const raw=String(row.sd||'').split('---METADATA---')[1];
    if (!raw) continue;
    let md; try { md=JSON.parse(raw.trim()); } catch { continue; }
    pages++;
    const set=new Set((md.characters||[]).map(c=>(c&&c.name||'').trim()).filter(Boolean));
    for (const i of (md.interactions||[])) {
      if (!i||!i.character||!i.object) continue;
      const miss=splitComposite(String(i.character).trim()).find(x=>!set.has(x));
      if (miss) act.push({miss, story:row.t, p:row.pn});
      else if (isBareProperName(String(i.object).trim()) && !set.has(String(i.object).trim()))
        tgt.push({obj:String(i.object).trim(), story:row.t, p:row.pn});
    }
  }
  await p.end();
 }
 console.log(`scanned ${stories} stories / ${pages} pages with metadata\n`);
 const tally=(arr,k)=>{const m={};arr.forEach(x=>m[x[k]]=(m[x[k]]||0)+1);return Object.entries(m).sort((a,b)=>b[1]-a[1]);};
 console.log('### TARGET guard (object looks like a proper name) fired '+tgt.length+'x');
 tally(tgt,'obj').forEach(([o,n])=>console.log('   '+String(n).padStart(3)+'x  '+o));
 console.log('\n### ACTOR guard (actor not in page cast) fired '+act.length+'x');
 tally(act,'miss').forEach(([o,n])=>console.log('   '+String(n).padStart(3)+'x  '+o));
})();

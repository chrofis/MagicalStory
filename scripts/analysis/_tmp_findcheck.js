require('dotenv').config();
const { Pool } = require('pg');
const { extractSceneMetadata } = require('../../server/lib/sceneMetadata');
const { checkPage } = require('../../server/lib/sceneBriefCheck');
const SQL=`SELECT s.id, s.data->>'title' t, s.data->'visualBible' vb, s.data->'characters' cast,
  (e->>'pageNumber')::int pn, e->>'sceneDescription' sd
  FROM stories s, jsonb_array_elements(s.data->'sceneImages') e WHERE s.id = ANY($1)`;
(async()=>{
 let fired=0, pages=0;
 for (const [env,cs] of [['staging',process.env.STAGING_DATABASE_URL],['prod',process.env.DATABASE_URL]]) {
  const p=new Pool({connectionString:cs,ssl:{rejectUnauthorized:false}});
  const ids=(await p.query("SELECT id FROM stories WHERE data->'sceneImages' IS NOT NULL ORDER BY created_at DESC LIMIT 12")).rows.map(r=>r.id);
  for (const row of (await p.query(SQL,[ids])).rows) {
    if (!row.sd || !row.sd.includes('---METADATA---')) continue;
    pages++;
    const md=extractSceneMetadata(row.sd);
    const cast=(row.cast||[]).map(c=>c&&c.name).filter(Boolean);
    for (const f of checkPage({pageNumber:row.pn,brief:row.sd,metadata:md},cast,row.vb)) {
      if (f.type==='interaction_actor_unknown') { fired++; console.log(`${env} "${String(row.t).slice(0,34)}" p${row.pn}: ${f.names.join(', ')}`); }
    }
  }
  await p.end();
 }
 console.log(`\ninteraction_actor_unknown fired ${fired}x over ${pages} pages`);
})();

require('dotenv').config();
const { Pool } = require('pg');
const s2 = require('./survey2.json').filter(o=>o.bedPages.length&&o.ncr);
const seen=new Set();
(async()=>{
 for (const [env,url] of [['staging',process.env.STAGING_DATABASE_URL],['prod',process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL]]){
  const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false}});
  for(const o of s2.filter(o=>o.env===env && !seen.has(o.id))){ seen.add(o.id);
   const r=await pool.query(`SELECT data->'beatsReviewReport'->'briefsIn' AS bi FROM stories WHERE id=$1`,[o.id]);
   console.log('\n##',env,o.id,o.title);
   for(const b of r.rows[0].bi){ if(o.bedPages.includes(b.pageNumber)){ const t=((String(b.brief||'').match(/PLAN:\s*([\s\S]*)$/i)||[])[1]||'').trim(); console.log(' p'+b.pageNumber+': '+t.slice(0,330)); } }
  }
  await pool.end();
 }
})();

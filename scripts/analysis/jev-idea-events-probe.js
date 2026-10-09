require('dotenv').config({path:'.env'});
const { Pool } = require('pg');
for (const [nm,url] of [['staging',process.env.STAGING_DATABASE_URL],['prod',process.env.DATABASE_URL]]) {
 const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
 (async()=>{
  const c=await pool.query(`select column_name from information_schema.columns where table_name='idea_events'`);
  console.log(nm,c.rows.map(r=>r.column_name).join(','));
  const r=await pool.query(`select event, count(*), min(occurred_at) mn, max(occurred_at) mx from idea_events group by 1`);
  console.log(nm,JSON.stringify(r.rows));
  const s=await pool.query(`select * from idea_events where event='idea_generated' order by occurred_at desc limit 2`);
  console.log(JSON.stringify(s.rows).slice(0,1800));
  await pool.end();
 })().catch(e=>console.log(nm,'ERR',e.message));
}

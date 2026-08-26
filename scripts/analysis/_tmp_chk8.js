require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='story_images' ORDER BY ordinal_position`);
  console.log('cols:', cols.rows.map(r => r.column_name).join(', '));
  const r = await pool.query(`SELECT * FROM story_images WHERE story_id=$1 AND page_number=17`, ['job_1787514321173_gvs2ojo4o0n']);
  for (const row of r.rows) {
    const o = {};
    for (const [k, v] of Object.entries(row)) o[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + `…(${v.length})` : v;
    console.log(JSON.stringify(o, null, 1));
  }
  await pool.end();
})().catch(e => console.error('FAIL', e.message));

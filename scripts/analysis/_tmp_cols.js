require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='story_jobs' ORDER BY ordinal_position`);
  console.log(r.rows.map(x => x.column_name + ':' + x.data_type).join('\n'));
  await pool.end();
})().catch(e => console.error(e.message));

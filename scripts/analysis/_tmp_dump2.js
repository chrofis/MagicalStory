require('dotenv').config();
const { Pool } = require('pg');
const [env, jobId] = process.argv.slice(2);
const cs = env === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
(async () => {
  const s = await pool.query(`SELECT id, created_at, data FROM stories WHERE id=$1`, [jobId]);
  if (!s.rows.length) { console.log('NO STORY for', jobId); await pool.end(); return; }
  const row = s.rows[0];
  const d = row.data || {};
  console.log('STORY', row.id, '|', d.title, '| created', row.created_at, '| pages', (d.sceneImages||[]).length);
  console.log('DATA KEYS:', Object.keys(d).join(', '));
  const p0 = (d.sceneImages||[])[0] || {};
  console.log('PAGE KEYS:', Object.keys(p0).join(', '));
  require('fs').writeFileSync(process.env.OUT, JSON.stringify({id:row.id,title:d.title,created:row.created_at,data:d}));
  await pool.end();
})();

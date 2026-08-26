require('dotenv').config();
const { Pool } = require('pg');
const target = process.argv[2];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const jobId = process.argv[3];
(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const j = await pool.query(`SELECT result_data FROM story_jobs WHERE id = $1`, [jobId]);
  const rd = j.rows[0].result_data || {};
  console.log(`\n=== ${target.toUpperCase()} "${rd.title}"`);
  const log = rd.generationLog;
  const lines = Array.isArray(log) ? log.map(x => typeof x === 'string' ? x : JSON.stringify(x)) : String(log || '').split('\n');
  console.log('log lines:', lines.length);
  const re = /composit|scale.?repair|plate|depopulat|depth.?spread|ghost|blend|refus|abort/i;
  const hits = lines.filter(l => re.test(l));
  console.log('matching lines:', hits.length);
  hits.slice(0, 60).forEach(l => console.log('  ' + l.slice(0, 300)));
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

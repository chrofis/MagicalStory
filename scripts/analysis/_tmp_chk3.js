require('dotenv').config();
const { Pool } = require('pg');
const target = process.argv[2];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const jobId = process.argv[3];
const pages = process.argv.slice(4).map(Number);
(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const j = await pool.query(`SELECT result_data FROM story_jobs WHERE id = $1`, [jobId]);
  const rd = j.rows[0].result_data || {};
  const imgs = rd.sceneImages || [];
  console.log(`\n=== ${target.toUpperCase()} "${rd.title}"`);
  const nonNull = imgs.filter(p => p.compositeDebug).map(p => p.pageNumber);
  console.log('pages with non-null compositeDebug:', nonNull.join(',') || 'none');
  for (const p of imgs) {
    if (!pages.includes(p.pageNumber)) continue;
    console.log(`\n--- p${p.pageNumber}`);
    const m = p.sceneMetadata || {};
    console.log('characters:', JSON.stringify((m.characters || []).map(c => ({ n: c.name, d: c.depth || c.position }))));
    console.log('setting:', m.setting, '| indoor:', m.indoor);
    const cd = p.compositeDebug;
    if (!cd) { console.log('compositeDebug: NULL'); continue; }
    const s = JSON.stringify(cd, null, 1);
    console.log('compositeDebug:', s.length > 3000 ? s.slice(0, 3000) + '\n...[truncated]' : s);
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

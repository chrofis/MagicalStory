require('dotenv').config();
const { Pool } = require('pg');
const { needsScaleRepair } = require('../../server/lib/scaleRepair');
const target = process.argv[2];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const jobId = process.argv[3];
(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const j = await pool.query(`SELECT result_data FROM story_jobs WHERE id = $1`, [jobId]);
  const rd = j.rows[0].result_data || {};
  const imgs = rd.sceneImages || [];
  console.log(`\n=== ${target.toUpperCase()} ${jobId}  "${rd.title}"  pages=${imgs.length}`);
  const vb = rd.visualBible || {};
  console.log('VB pools:', Object.entries(vb).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}:${v.length}`).join(' '));
  let gateTrue = 0;
  for (const p of imgs) {
    const meta = p.sceneMetadata || p.metadata || {};
    let gate = null;
    try { gate = needsScaleRepair(meta); } catch (e) { gate = 'ERR:' + e.message; }
    const co = p.compositeOutcome;
    if (gate) gateTrue++;
    if (gate || co) {
      console.log(`  p${p.pageNumber}: gate=${JSON.stringify(gate)} outcome=${co ? JSON.stringify(co).slice(0, 350) : 'NONE'}`);
    }
  }
  console.log(`gate-true pages: ${gateTrue}/${imgs.length}; pages with compositeOutcome: ${imgs.filter(p => p.compositeOutcome).length}`);
  console.log('keys on p1:', Object.keys(imgs[0] || {}).join(','));
  await pool.end();
})().catch(e => { console.error('FAIL', e.message, e.stack.split('\n')[1]); process.exit(1); });

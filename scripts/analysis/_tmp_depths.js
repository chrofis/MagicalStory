require('dotenv').config();
const { Pool } = require('pg');
const { needsScaleRepair } = require('../../server/lib/scaleRepair');

const target = process.argv[2];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const jobId = process.argv[3];

(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const j = await pool.query('SELECT result_data FROM story_jobs WHERE id = $1', [jobId]);
  const rd = j.rows[0].result_data || {};
  const imgs = rd.sceneImages || [];
  console.log(`\n=== ${target.toUpperCase()} "${rd.title}" — ${imgs.length} pages\n`);
  const tally = { foreground: 0, midground: 0, background: 0, none: 0 };
  for (const p of imgs) {
    const chars = p.sceneMetadata?.fullData?.characters || [];
    const depths = chars.map(c => (c.depth || '').toLowerCase() || 'none');
    depths.forEach(d => { tally[d] = (tally[d] || 0) + 1; });
    const hasBg = depths.includes('background');
    const hasFg = depths.includes('foreground');
    const gate = needsScaleRepair(p.sceneMetadata);
    const mark = gate ? 'GATE OPEN' : (hasBg && hasFg ? 'fg+bg but blocked' : '');
    console.log(
      `p${String(p.pageNumber).padStart(2)}  ${String(chars.length).padStart(2)} chars  `
      + `[${depths.join(', ') || '—'}]  ${mark}`
    );
  }
  console.log('\ndepth labels across the whole book:', JSON.stringify(tally));
  console.log('pages declaring any background character:',
    imgs.filter(p => (p.sceneMetadata?.fullData?.characters || [])
      .some(c => (c.depth || '').toLowerCase() === 'background')).length);
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

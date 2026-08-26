require('dotenv').config();
const { Pool } = require('pg');

const target = process.argv[2];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const jobId = process.argv[3];
const want = process.argv.slice(4).map(Number);

(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });

  const j = await pool.query(
    `SELECT result_data, created_at, completed_at,
            to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_naive
       FROM story_jobs WHERE id = $1`, [jobId]);
  const rd = j.rows[0].result_data || {};
  console.log(`\n=== ${target.toUpperCase()} "${rd.title}"  (job row created ${j.rows[0].created_naive} UTC-naive)`);

  const imgs = rd.sceneImages || [];
  for (const p of imgs) {
    if (!want.includes(p.pageNumber)) continue;
    const fd = p.sceneMetadata?.fullData || {};
    console.log(`\n--- p${p.pageNumber}  shot=${fd.shot}  objects=${(fd.objects || []).join(',')}`);
    (fd.characters || []).forEach(c =>
      console.log(`    ${String(c.name).padEnd(10)} depth=${String(c.depth).padEnd(11)} position="${c.position}"`));
    console.log('    interactions:', JSON.stringify(fd.interactions || []).slice(0, 300));
    console.log('    compositeOutcome    :', JSON.stringify(p.compositeOutcome || null));
    console.log('    compositeAbortReason:', p.compositeAbortReason || '(absent)');
    console.log('    compositeDepthSpread:', p.compositeDepthSpread ?? '(absent)');
    console.log('    hasCompositeStages  :', p.hasCompositeStages ?? '(absent)');
    console.log('    bestSource          :', p.bestSource, '| versions:', (p.imageVersions || []).length);
  }

  const rows = await pool.query(
    `SELECT page_number, image_type, version_index FROM story_images
      WHERE story_id = $1 AND image_type LIKE 'composite%' ORDER BY page_number, image_type`, [jobId]);
  console.log('\ncomposite_* image rows stored:', rows.rows.length
    ? rows.rows.map(r => `p${r.page_number}:${r.image_type}`).join('  ') : 'NONE');

  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

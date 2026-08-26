require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const OUT = 'scripts/analysis/_tmp_848/';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const e = await pool.query('SELECT results, status, error FROM testlab_experiments WHERE id = 848');
  const r = (e.rows[0].results || [])[0] || {};
  console.log('status:', e.rows[0].status, '| ok:', r.ok, '| cost:', r.cost);
  console.log('facing:', r.facing, '| blend:', r.blend ?? r.blended ?? '(key?)');
  console.log('\nall steps:');
  (r.steps || []).forEach(s => console.log(`  v${s.versionIndex}  ${s.label}`));
  console.log('\nplate bboxes (detected on the PLATE, before paste):');
  for (const [n, b] of Object.entries(r.bboxes || {})) {
    console.log(`  ${n.padEnd(8)} ${String(b.width).padStart(4)}x${String(b.height).padStart(4)}  at (${b.x},${b.y})`);
  }
  const hs = Object.values(r.bboxes || {}).map(b => b.height);
  if (hs.length >= 2) console.log(`  depth spread on plate: ${(Math.max(...hs) / Math.min(...hs)).toFixed(2)}x`);
  console.log('\nother result keys:', Object.keys(r).join(', '));

  // Download every tl_step frame for this page.
  const rows = await pool.query(
    `SELECT version_index, image_url FROM story_images
      WHERE story_id = $1 AND page_number = 6 AND image_type = 'tl_step'
        AND version_index = ANY($2::int[]) ORDER BY version_index`,
    ['job_1786780194082_s980g4s9a', (r.steps || []).map(s => s.versionIndex)]);
  const byIdx = new Map((r.steps || []).map(s => [s.versionIndex, s.label]));
  for (const row of rows.rows) {
    const buf = Buffer.from(await (await fetch(row.image_url)).arrayBuffer());
    const safe = String(byIdx.get(row.version_index) || 'step').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    const f = `${OUT}v${row.version_index}-${safe}.jpg`;
    fs.writeFileSync(f, buf);
    console.log('  wrote', f, buf.length);
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

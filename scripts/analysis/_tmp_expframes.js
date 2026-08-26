// Pull any scene_composite experiment's result + frames: node _tmp_expframes.js <expId>
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const ID = Number(process.argv[2]);
const OUT = `scripts/analysis/_tmp_e${ID}/`;
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const e = await pool.query('SELECT results, status, error FROM testlab_experiments WHERE id = $1', [ID]);
  const r = (e.rows[0].results || [])[0] || {};
  console.log('status:', e.rows[0].status, '| ok:', r.ok, '| cost:', r.cost, '| elapsedMs:', r.elapsedMs);
  console.log('blend prompt chars:', String(r.blendPrompt || '').length, '| source:', r.blendPromptSource);
  for (const [n, b] of Object.entries(r.bboxes || {})) console.log(`  plate ${n}: ${b.width}x${b.height}`);
  (r.placements || []).forEach(p => console.log(`  placed ${p.name}: via=${p.via} painted=${p.paintedBox?.h}px full=${p.paintedFull ?? '-'}`));
  const steps = (r.steps || []).concat(r.imageType ? [{ label: 'FINAL', imageType: r.imageType, versionIndex: r.versionIndex }] : []);
  for (const st of steps) {
    const rows = await pool.query(
      `SELECT image_url FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type=$3 AND version_index=$4`,
      [r.storyId, r.pageNumber, st.imageType, st.versionIndex]);
    if (!rows.rows.length) continue;
    const buf = Buffer.from(await (await fetch(rows.rows[0].image_url)).arrayBuffer());
    const safe = String(st.label).replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    fs.writeFileSync(`${OUT}${safe}.jpg`, buf);
    console.log('  wrote', `${OUT}${safe}.jpg`, buf.length);
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

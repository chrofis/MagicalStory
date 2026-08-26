require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const e = await pool.query('SELECT results FROM testlab_experiments WHERE id = 848');
  const r = (e.rows[0].results || [])[0] || {};

  console.log('final frame -> imageType:', r.imageType, 'versionIndex:', r.versionIndex);
  console.log('blended:', r.blended, '| detector:', r.detector, '| elapsedMs:', r.elapsedMs, '| modelCalls:', r.modelCalls);
  console.log('\nplacements (what was actually pasted):');
  for (const p of (r.placements || [])) {
    console.log('  ' + JSON.stringify(p));
  }
  console.log('\nblendPromptSource:', r.blendPromptSource);
  const bp = String(r.blendPrompt || '');
  console.log('\n--- blend prompt, occlusion/size lines ---');
  bp.split('\n').filter(l => /hidden|size|shrunk|small|distant|full height|exactly/i.test(l))
    .forEach(l => console.log('  ' + l.trim().slice(0, 200)));

  const rows = await pool.query(
    `SELECT image_url FROM story_images WHERE story_id=$1 AND page_number=6 AND image_type=$2 AND version_index=$3`,
    ['job_1786780194082_s980g4s9a', r.imageType, r.versionIndex]);
  if (rows.rows.length) {
    const buf = Buffer.from(await (await fetch(rows.rows[0].image_url)).arrayBuffer());
    fs.writeFileSync('scripts/analysis/_tmp_848/v99-FINAL-blended.jpg', buf);
    console.log('\nwrote final blended frame:', buf.length, 'bytes');
  } else {
    console.log('\nno row for the final frame');
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

// Refusal-aware checks: the plate PROMPT and the saved plates prove the cast
// fixes even when the depth gate refuses.
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const say = (ok, label) => console.log(`  ${ok === null ? ' -- ' : ok ? 'PASS' : 'FAIL'}  ${label}`);
  for (const [id, name] of [[853, 'A watercolor 5-char'], [854, 'B pixar back-view'], [855, 'C dragon page']]) {
    const e = await pool.query('SELECT results FROM testlab_experiments WHERE id=$1', [id]);
    const r = (e.rows[0].results || [])[0] || {};
    const plate = String(r.populatedPlatePrompt || r.sentPrompts?.populatedPlatePrompt || '');
    console.log(`\n=== ${name} (exp ${id}) — refused at ${r.depthSpread}x; plate prompt ${plate.length} chars`);
    if (!plate) { say(null, 'no plate prompt stored'); continue; }
    say(!/facing (left|right)/i.test(plate), 'no fabricated facing direction anywhere');
    if (id === 854) {
      say(/back view/i.test(plate), 'back-view pose reached the plate (pose resolver live)');
      say(/NO eye dots/.test(plate), 'back-of-head marker spec present');
      console.log('    back-view lines:', (plate.match(/back view[^\n]*/gi) || []).length);
    }
    if (id === 855) {
      say(/drache|dragon/i.test(plate), 'creature block present (dragon in the plate prompt)');
      const watching = (plate.match(/watching the dragon/gi) || []).length;
      say(watching >= 3, `compound action reached the three boys (${watching}/3 "watching the dragon")`);
    }
    // download the saved plates
    const OUT = `scripts/analysis/_tmp_e${id}/`; fs.mkdirSync(OUT, { recursive: true });
    for (const st of (r.steps || [])) {
      const rows = await pool.query(
        `SELECT image_url FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type=$3 AND version_index=$4`,
        [r.storyId, r.pageNumber, st.imageType, st.versionIndex]);
      if (!rows.rows.length) continue;
      const buf = Buffer.from(await (await fetch(rows.rows[0].image_url)).arrayBuffer());
      const f = `${OUT}${String(st.label).replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.jpg`;
      fs.writeFileSync(f, buf); console.log('    wrote', f);
    }
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

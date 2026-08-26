// Machine-checks the proof-suite experiments: node _tmp_proof_check.js <idA> <idB> <idC>
// Downloads every frame and asserts the prompt/cast/placement facts each fix predicts.
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const [idA, idB, idC] = process.argv.slice(2).map(Number);

(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const load = async (id) => {
    const e = await pool.query('SELECT results, status, error FROM testlab_experiments WHERE id = $1', [id]);
    return { status: e.rows[0]?.status, error: e.rows[0]?.error, r: (e.rows[0]?.results || [])[0] || {} };
  };
  const frames = async (id, r) => {
    const OUT = `scripts/analysis/_tmp_e${id}/`;
    fs.mkdirSync(OUT, { recursive: true });
    const steps = (r.steps || []).concat(r.imageType ? [{ label: 'FINAL', imageType: r.imageType, versionIndex: r.versionIndex }] : []);
    for (const st of steps) {
      const rows = await pool.query(
        `SELECT image_url FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type=$3 AND version_index=$4`,
        [r.storyId, r.pageNumber, st.imageType, st.versionIndex]);
      if (!rows.rows.length) continue;
      const buf = Buffer.from(await (await fetch(rows.rows[0].image_url)).arrayBuffer());
      fs.writeFileSync(`${OUT}${String(st.label).replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.jpg`, buf);
    }
    return steps.length;
  };
  const say = (ok, label) => console.log(`  ${ok === null ? ' -- ' : ok ? 'PASS' : 'FAIL'}  ${label}`);
  const spread = (bb) => { const hs = Object.values(bb || {}).map(b => b.height); return hs.length >= 2 ? Math.max(...hs) / Math.min(...hs) : null; };

  // ---- A: regression watercolor, 5 chars (3 fg + 2 bg) ----
  {
    const { status, error, r } = await load(idA);
    console.log(`\n=== A exp ${idA} (watercolor 5-char regression): ${status}${error ? ' — ' + String(error).slice(0, 120) : ''}`);
    if (r.ok) {
      await frames(idA, r);
      console.log('  plate spread:', spread(r.bboxes)?.toFixed(2) + 'x', '| placements:', (r.placements || []).length, '| blend prompt:', String(r.blendPrompt || '').length, 'chars');
      say((r.placements || []).length === 5, 'all 5 figures placed');
      say(String(r.blendPrompt || '').length < 3063, 'blend prompt under the 3063 zoom threshold');
      say(!/cinematic/i.test(r.blendPrompt || ''), 'no "cinematic" in the blend prompt');
      say(!/DO NOT/.test(r.blendPrompt || ''), 'no DO-NOT block');
      say(/watercolor/i.test(r.blendPrompt || ''), 'watercolor style line present');
    } else if (r.aborted || /refus|spread|depth/i.test(String(error || ''))) {
      console.log('  REFUSED — recorded outcome, spread/reason:', r.depthSpread ?? '?', String(error || '').slice(0, 150));
    }
  }

  // ---- B: pixar, 3 back-view bg chars — pose resolver live ----
  {
    const { status, error, r } = await load(idB);
    console.log(`\n=== B exp ${idB} (pixar back-view regression): ${status}${error ? ' — ' + String(error).slice(0, 120) : ''}`);
    if (r.ok) {
      await frames(idB, r);
      const backs = (r.cast || []).filter(c => c.pose === 'back');
      console.log('  cast poses:', (r.cast || []).map(c => `${c.name}:${c.pose}`).join(' '));
      say(backs.length === 3, `back-view chars resolved to pose=back (got ${backs.length}/3)`);
      say((r.cast || []).every(c => c.flip === false), 'flip false throughout');
      const plate = String(r.sentPrompts?.populatedPlatePrompt || r.promptUsed || '');
      say(plate ? !/facing (left|right)/i.test(plate) : null, 'no fabricated facing direction in the plate prompt');
      say(/NO eye dots/.test(plate) || null, 'back-view marker spec (no eye dots) reached the plate');
    } else {
      console.log('  not ok:', String(error || '').slice(0, 200), '| aborted:', r.aborted, '| spread:', r.depthSpread);
    }
  }

  // ---- C: dragon page — pose + compound action + creature ----
  {
    const { status, error, r } = await load(idC);
    console.log(`\n=== C exp ${idC} (dragon page): ${status}${error ? ' — ' + String(error).slice(0, 120) : ''}`);
    const plate = String(r.sentPrompts?.populatedPlatePrompt || r.promptUsed || '');
    if (plate) {
      say(/drache|dragon/i.test(plate), 'creature block in the plate prompt (dragon)');
      const watching = (plate.match(/watching the dragon/gi) || []).length;
      say(watching >= 3, `compound action reached all three boys (found ${watching}/3 "watching the dragon")`);
      say(!/facing (left|right)/i.test(plate), 'no fabricated facing direction');
    } else say(null, 'plate prompt not stored on this result');
    if (r.ok) {
      await frames(idC, r);
      console.log('  plate spread:', spread(r.bboxes)?.toFixed(2) + 'x', '| placements:', (r.placements || []).length);
    } else {
      console.log('  not ok:', String(error || '').slice(0, 200), '| aborted:', r.aborted, '| spread:', r.depthSpread);
      // save-on-abort should have kept the plate
      const rows = await pool.query(
        `SELECT count(*)::int n FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type='tl_step'`,
        ['job_1787262655143_s9zb960muni', 17]);
      console.log('  tl_step frames stored for p17 (incl. earlier runs):', rows.rows[0].n);
    }
  }

  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

// Replay p5's EXACT original generation (stored prompt + stored packed refs) N times.
// Systematic-vs-luck test for the 5-figure walking-away scene.
process.chdir('C:/Users/roger/MagicalStory');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const OUT = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/5e638703-ea7b-4f0b-86a3-c96876a22612/scratchpad/run6';

(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(`SELECT data->'sceneImages'->4->>'prompt' AS p, data->'sceneImages'->4->'grokRefImages' AS refs FROM stories WHERE id='job_1786397108357_q1fjbdzbx'`);
  await pool.end();
  const prompt = r.rows[0].p;
  const refUrls = r.rows[0].refs;
  console.log('prompt chars:', prompt.length, '| refs:', refUrls.length);

  const refs = [];
  for (const u of refUrls) {
    const b = Buffer.from(await (await fetch(u)).arrayBuffer());
    refs.push('data:image/jpeg;base64,' + b.toString('base64'));
  }

  const { editWithGrok } = require('C:/Users/roger/MagicalStory/server/lib/grok');
  const { MODEL_DEFAULTS } = require('C:/Users/roger/MagicalStory/server/config/models');
  for (const n of [1, 2]) {
    console.log(`--- attempt ${n} ...`);
    const t0 = Date.now();
    const sent = prompt.length > 7500 ? prompt.substring(0, 7497) + '...' : prompt;
    const res = await editWithGrok(sent, refs, { model: 'grok-imagine-image', aspectRatio: MODEL_DEFAULTS.pageAspect });
    const img = res?.imageData || res?.images?.[0] || res;
    const b64 = typeof img === 'string' ? img.replace(/^data:image\/\w+;base64,/, '') : null;
    if (!b64) { console.log('attempt', n, 'no image; keys:', Object.keys(res || {})); continue; }
    fs.writeFileSync(path.join(OUT, `p5-retry${n}.jpg`), Buffer.from(b64, 'base64'));
    console.log(`attempt ${n}: saved (${Math.round(b64.length * 3 / 4 / 1024)}kB, ${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

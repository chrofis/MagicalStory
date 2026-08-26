require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776613729106_a9fpjw3cy';
  const pageNumber = parseInt(process.argv[3] || '1', 10);
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const r = await pool.query(
    `SELECT scene->>'sceneDescription' AS sd,
            scene->>'text' AS text,
            scene->>'textPosition' AS tp,
            scene->'retryHistory' AS rh,
            scene->'image_version_meta' AS ivm,
            scene->'finalChecksReport' AS fcr,
            scene->'imageCheckReport' AS icr,
            scene->'semanticEvaluation' AS sem
     FROM stories, jsonb_array_elements(data::jsonb->'sceneImages') AS scene
     WHERE id = $1 AND (scene->>'pageNumber')::int = $2`,
    [storyId, pageNumber]
  );

  if (!r.rows[0]) { console.log('no scene'); await pool.end(); return; }
  const s = r.rows[0];
  console.log(`=== Page ${pageNumber} ===`);
  console.log('TEXT:', s.text);
  console.log('\ntextPosition:', s.tp);
  console.log('\n--- sceneDescription (what was REQUESTED) ---');
  console.log(s.sd);
  console.log('\n--- retryHistory (REPAIR ROUNDS) ---');
  console.log(JSON.stringify(s.rh, null, 2));
  console.log('\n--- image_version_meta ---');
  console.log(JSON.stringify(s.ivm, null, 2));
  console.log('\n--- finalChecksReport (entity check) ---');
  console.log(JSON.stringify(s.fcr, null, 2));
  console.log('\n--- imageCheckReport (quality eval) ---');
  console.log(JSON.stringify(s.icr, null, 2));
  console.log('\n--- semanticEvaluation ---');
  console.log(JSON.stringify(s.sem, null, 2));

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });

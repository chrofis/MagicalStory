require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776613729106_a9fpjw3cy';
  const pageNumber = parseInt(process.argv[3] || '4', 10);
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Get all keys in scene
  const r = await pool.query(
    `SELECT (SELECT jsonb_agg(k) FROM jsonb_object_keys(scene) k) AS keys
     FROM stories, jsonb_array_elements(data::jsonb->'sceneImages') AS scene
     WHERE id = $1 AND (scene->>'pageNumber')::int = $2`,
    [storyId, pageNumber]
  );
  console.log('scene keys:', r.rows[0]?.keys);

  // Get retryHistory full bbox + threeStage info
  const r2 = await pool.query(
    `SELECT jsonb_array_elements(scene->'retryHistory') AS h
     FROM stories, jsonb_array_elements(data::jsonb->'sceneImages') AS scene
     WHERE id = $1 AND (scene->>'pageNumber')::int = $2`,
    [storyId, pageNumber]
  );
  for (const row of r2.rows) {
    const h = row.h;
    if (h.bboxDetection) {
      delete h.bboxDetection.rawPrompt;
      delete h.bboxDetection.rawResponse;
    }
    console.log('---');
    console.log(JSON.stringify(h, null, 2).slice(0, 5000));
  }

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });

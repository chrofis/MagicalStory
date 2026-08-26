require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776601005131_7dxzq9184';
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const r = await pool.query(
    `SELECT jsonb_path_query(data::jsonb, '$.sceneImages[*].sceneDescription') AS sd,
            jsonb_path_query(data::jsonb, '$.sceneImages[*].pageNumber') AS pn
     FROM stories WHERE id = $1`,
    [storyId]
  );
  // This gives rows paired, let's re-fetch properly
  const q2 = await pool.query(
    `SELECT scene->>'pageNumber' AS pn, scene->>'sceneDescription' AS sd, scene->>'textPosition' AS tp, scene->>'sceneExpansionPrompt' AS sep
     FROM stories, jsonb_array_elements(data::jsonb->'sceneImages') AS scene
     WHERE id = $1 AND (scene->>'pageNumber')::int = 9`,
    [storyId]
  );
  for (const row of q2.rows) {
    console.log(`Page ${row.pn} textPosition=${row.tp}`);
    console.log('\nsceneDescription:\n' + row.sd);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });

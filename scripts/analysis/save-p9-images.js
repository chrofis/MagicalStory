require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
(async () => {
  const storyId = process.argv[2] || 'job_1776601005131_7dxzq9184';
  const pageNumber = parseInt(process.argv[3] || '9', 10);
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const out = path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads', `story-p${pageNumber}`);
  fs.mkdirSync(out, { recursive: true });
  const r = await pool.query(
    `SELECT version_index, image_data FROM story_images
     WHERE story_id = $1 AND page_number = $2 AND image_type = 'scene'
     ORDER BY version_index ASC`,
    [storyId, pageNumber]
  );
  for (const row of r.rows) {
    const b64 = row.image_data.replace(/^data:image\/[a-z]+;base64,/, '');
    const file = path.join(out, `v${row.version_index}.jpg`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(`saved ${file} (${Math.round(row.image_data.length/1024)}KB)`);
  }
  // also empty scene
  const q2 = await pool.query(
    `SELECT scene->>'emptySceneImage' AS img
     FROM stories, jsonb_array_elements(data::jsonb->'sceneImages') AS scene
     WHERE id = $1 AND (scene->>'pageNumber')::int = $2`,
    [storyId, pageNumber]
  );
  if (q2.rows[0]?.img) {
    const b64 = q2.rows[0].img.replace(/^data:image\/[a-z]+;base64,/, '');
    const file = path.join(out, `empty.jpg`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(`saved empty scene ${file}`);
  } else {
    console.log('no emptySceneImage found');
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });

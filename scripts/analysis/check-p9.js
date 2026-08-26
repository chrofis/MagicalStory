require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776601005131_7dxzq9184';
  const pageNumber = parseInt(process.argv[3] || '9', 10);
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Scene slim
  const s = await pool.query(
    `SELECT jsonb_path_query(data::jsonb, '$.sceneImages[*] ? (@.pageNumber == $pn)', jsonb_build_object('pn', $2::int)) AS scene
     FROM stories WHERE id = $1`,
    [storyId, pageNumber]
  );
  const scene = s.rows[0]?.scene;
  if (scene) {
    const clean = JSON.parse(JSON.stringify(scene));
    for (const k of ['imageData', 'imageVersions', 'emptySceneImage']) delete clean[k];
    const stripLong = (o) => {
      for (const k in o) {
        if (typeof o[k] === 'string' && o[k].length > 800) o[k] = `<${Math.round(o[k].length/1024)}KB>`;
        else if (typeof o[k] === 'object' && o[k] !== null) stripLong(o[k]);
      }
    };
    stripLong(clean);
    console.log('=== scene ' + pageNumber + ' ===');
    console.log('text:', clean.text);
    console.log('\ntextPosition:', clean.textPosition);
    console.log('textRect:', JSON.stringify(clean.textRect));
    console.log('\nsceneMetadata:', JSON.stringify(clean.sceneMetadata, null, 2));
    console.log('\nsceneDescription:\n', clean.sceneDescription?.slice(0, 2500));
    console.log('\nretryHistory:', JSON.stringify(clean.retryHistory, null, 2));
  }

  // Versions
  const v = await pool.query(
    `SELECT version_index, length(image_data) AS bytes, image_data
     FROM story_images WHERE story_id = $1 AND page_number = $2 AND image_type = 'scene'
     ORDER BY version_index ASC`,
    [storyId, pageNumber]
  );
  const sharp = require('sharp');
  console.log('\n=== versions ===');
  for (const row of v.rows) {
    const b64 = row.image_data.replace(/^data:image\/[a-z]+;base64,/, '');
    const meta = await sharp(Buffer.from(b64, 'base64')).metadata();
    console.log(`v${row.version_index}: ${meta.width}x${meta.height} ${meta.format} ${Math.round(row.bytes/1024)}KB`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });

require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2];
  if (!storyId) {
    console.error('Usage: node scripts/analysis/check-p9.js <storyId> [pageNumber]');
    process.exit(1);
  }
  const pageNumber = parseInt(process.argv[3] || '9', 10);
  const url = process.env.STAGING_DATABASE_URL;
  if (!url) {
    console.error('STAGING_DATABASE_URL not set (this script reads staging by design)');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

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
    console.log('\nsceneMetadata:', JSON.stringify(clean.sceneMetadata, null, 2));
    console.log('\nsceneDescription:\n', clean.sceneDescription?.slice(0, 2500));
    console.log('\nretryHistory:', JSON.stringify(clean.retryHistory, null, 2));
  }

  // Versions
  const v = await pool.query(
    `SELECT version_index, length(image_data) AS bytes, image_data, image_url
     FROM story_images WHERE story_id = $1 AND page_number = $2 AND image_type = 'scene'
     ORDER BY version_index ASC`,
    [storyId, pageNumber]
  );
  const sharp = require('sharp');
  console.log('\n=== versions ===');
  for (const row of v.rows) {
    let buf;
    let img = row.image_data;
    if (img) {
      if (typeof img === 'string' && img.startsWith('data:')) {
        img = img.replace(/^data:image\/\w+;base64,/, '');
      }
      buf = Buffer.isBuffer(img) ? img : Buffer.from(img, 'base64');
    } else if (row.image_url) {
      console.log(`v${row.version_index}: image_data is NULL — fetching from R2: ${row.image_url}`);
      const r = await fetch(row.image_url);
      if (!r.ok) {
        console.error(`v${row.version_index}: R2 fetch failed: HTTP ${r.status}`);
        continue;
      }
      buf = Buffer.from(await r.arrayBuffer());
    } else {
      console.warn(`v${row.version_index}: row has neither image_data nor image_url — skipping`);
      continue;
    }
    const meta = await sharp(buf).metadata();
    console.log(`v${row.version_index}: ${meta.width}x${meta.height} ${meta.format} ${Math.round(buf.length/1024)}KB`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });

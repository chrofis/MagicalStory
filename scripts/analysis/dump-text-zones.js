#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const jobId = process.argv[2];
  const outDir = path.join('tmp', `text-zones-${jobId}`);
  fs.mkdirSync(outDir, { recursive: true });

  const { rows } = await pool.query(
    `SELECT data FROM stories WHERE id = $1`, [jobId]
  );
  if (!rows[0]) { console.error('no story'); process.exit(1); }
  const data = rows[0].data;
  const sceneImages = data.sceneImages || [];

  // Get active versions per page
  const meta = data.image_version_meta || {};

  console.log(`\nStory: ${data.title}`);
  console.log(`Pages: ${sceneImages.length}\n`);
  console.log('PAGE | textPosition  | textZoneDescription');
  console.log('-----+---------------+---------------------');

  const imgRows = await pool.query(
    `SELECT page_number, version_index, image_data FROM story_images
     WHERE story_id = $1 AND image_type = 'scene'
     ORDER BY page_number, version_index`, [jobId]);

  // Build active per-page map
  const versionMetaResult = await pool.query(
    `SELECT image_version_meta FROM stories WHERE id = $1`, [jobId]);
  const vMeta = versionMetaResult.rows[0]?.image_version_meta || {};

  for (const scene of sceneImages) {
    const p = scene.pageNumber;
    const tp = scene.textPosition || '(none)';
    const td = scene.textZoneDescription || '(none)';
    console.log(`P${String(p).padStart(2)}  | ${tp.padEnd(13)} | ${td.slice(0, 120)}`);

    // Save active image
    const activeIdx = vMeta[String(p)]?.activeVersion ?? 0;
    const row = imgRows.rows.find(r => r.page_number === p && r.version_index === activeIdx)
             || imgRows.rows.find(r => r.page_number === p);
    if (row?.image_data) {
      const b64 = (row.image_data || '').replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(outDir, `p${String(p).padStart(2, '0')}-${tp}.png`), Buffer.from(b64, 'base64'));
    }
  }

  console.log(`\nImages saved to: ${outDir}`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });

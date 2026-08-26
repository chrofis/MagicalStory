#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const jobId = process.argv[2];
  const outDir = path.join('tmp', `empty-scenes-${jobId}`);
  fs.mkdirSync(outDir, { recursive: true });

  // Empty scenes are stored as version_index = -1 (or as a separate image_type)
  // Try image_type first, then fallback to scene with negative version
  const r1 = await pool.query(
    `SELECT image_type, page_number, version_index, length(image_data) as bytes
     FROM story_images WHERE story_id = $1 ORDER BY page_number, image_type, version_index`,
    [jobId]
  );
  // Show what's in the table
  const types = new Set(r1.rows.map(r => r.image_type));
  console.log('image_types in table:', [...types].join(', '));
  console.log('\nrows:');
  r1.rows.slice(0, 30).forEach(r => console.log(`  ${r.image_type} p${r.page_number} v${r.version_index} ${r.bytes}b`));

  // Empty scene rows: image_type = 'empty_scene' or 'scene_empty'
  const emptyType = [...types].find(t => /empty/i.test(t));
  if (!emptyType) {
    console.log('\nNo empty-scene rows in story_images. Checking sceneImages JSON...');
    const r2 = await pool.query(`SELECT data->'sceneImages' as si FROM stories WHERE id = $1`, [jobId]);
    const sceneImages = r2.rows[0]?.si || [];
    let found = 0;
    for (const s of sceneImages) {
      if (s.emptySceneImage) {
        const b64 = s.emptySceneImage.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(path.join(outDir, `p${String(s.pageNumber).padStart(2, '0')}-empty.png`), Buffer.from(b64, 'base64'));
        found++;
      }
    }
    console.log(`Saved ${found} empty scenes from sceneImages JSON to ${outDir}`);
  } else {
    const r3 = await pool.query(
      `SELECT page_number, image_data FROM story_images WHERE story_id = $1 AND image_type = $2 ORDER BY page_number`,
      [jobId, emptyType]
    );
    let found = 0;
    for (const row of r3.rows) {
      const b64 = (row.image_data || '').replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(outDir, `p${String(row.page_number).padStart(2, '0')}-empty.png`), Buffer.from(b64, 'base64'));
      found++;
    }
    console.log(`Saved ${found} empty scenes from image_type=${emptyType} to ${outDir}`);
  }

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });

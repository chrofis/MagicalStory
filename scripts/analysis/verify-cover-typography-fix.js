'use strict';
// Verify Part 2: applyCoverTypography now bakes the title into EVERY cover
// version, so the served imageVersions[active] row carries the title.
// Non-destructive: reconstructs the story's covers in memory, runs the real
// function, checks each version is titled, renders the active front cover.
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const OUT = 'C:/Users/roger/AppData/Local/Temp/covers';

(async () => {
  const storyId = 'job_1784404956456_ggvjxti9d';
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sres = await pool.query('SELECT data, image_version_meta FROM stories WHERE id=$1', [storyId]);
  let d = sres.rows[0].data; if (typeof d === 'string') d = JSON.parse(d);
  const vm = sres.rows[0].image_version_meta || {};
  const toDataUri = (buf) => 'data:image/jpeg;base64,' + buf.toString('base64');

  // Reconstruct coverImages with imageVersions[].imageData (textless art from story_images)
  const coverImages = {};
  for (const key of ['frontCover', 'initialPage', 'backCover']) {
    const rows = await pool.query(
      "SELECT version_index, image_url FROM story_images WHERE story_id=$1 AND image_type=$2 ORDER BY version_index",
      [storyId, key]);
    const versions = [];
    for (const r of rows.rows) {
      const buf = Buffer.from(await (await fetch(r.image_url)).arrayBuffer());
      versions[r.version_index] = { imageData: toDataUri(buf) };
    }
    coverImages[key] = {
      imageData: versions[0]?.imageData,
      imageVersions: versions.filter(Boolean),
      bboxDetection: d.coverImages[key]?.bboxDetection || { figures: [] },
    };
  }
  await pool.end();

  // Run the REAL pipeline function (now a unit-testable module export)
  const { applyCoverTypography } = require('../../server/lib/coverTypography');
  await applyCoverTypography(coverImages, { title: d.title, dedication: 'Für alle, die zum ersten Mal loslassen.', seed: storyId });

  console.log(`Title: "${d.title}"\n`);
  for (const key of ['frontCover', 'initialPage', 'backCover']) {
    const c = coverImages[key];
    const activeIdx = vm[key]?.activeVersion ?? 0;
    const titledCount = c.imageVersions.filter(v => v.typography).length;
    console.log(`${key}: ${titledCount}/${c.imageVersions.length} versions titled | active=v${activeIdx} titled=${!!c.imageVersions[activeIdx]?.typography} | artImageData(textless) kept=${!!c.artImageData}`);
    // render active served version
    const active = c.imageVersions[activeIdx];
    if (active?.imageData) {
      fs.writeFileSync(`${OUT}/${key}_SERVED_titled.jpg`, Buffer.from(active.imageData.split(',')[1], 'base64'));
    }
  }
  console.log('\nRendered served (active) versions -> *_SERVED_titled.jpg');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

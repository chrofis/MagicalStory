#!/usr/bin/env node
/**
 * Download all images for a story from the story_images table.
 * Usage: node scripts/admin/download-story-images.js <storyId>
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function download() {
  const storyId = process.argv[2];
  if (!storyId) {
    console.log('Usage: node scripts/admin/download-story-images.js <storyId>');
    process.exit(1);
  }

  // Get story metadata
  const storyResult = await pool.query(
    'SELECT metadata, image_version_meta FROM stories WHERE id = $1',
    [storyId]
  );
  if (storyResult.rows.length === 0) {
    console.log('Story not found:', storyId);
    process.exit(1);
  }

  const story = storyResult.rows[0];
  const title = story.metadata?.title || 'Unknown';
  const versionMeta = story.image_version_meta || {};
  console.log(`Story: ${title}`);
  console.log(`ID: ${storyId}`);

  // Get all images
  const imgResult = await pool.query(
    `SELECT image_type, page_number, version_index, image_data, quality_score, generated_at
     FROM story_images WHERE story_id = $1
     ORDER BY image_type, page_number, version_index`,
    [storyId]
  );

  console.log(`\nTotal images in DB: ${imgResult.rows.length}`);

  // Create output directory
  const safeName = title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
  const outDir = path.join('output', `story-images-${safeName}`);
  fs.mkdirSync(path.join(outDir, 'scenes'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'covers'), { recursive: true });

  let saved = 0;
  for (const img of imgResult.rows) {
    const base64 = img.image_data?.replace(/^data:image\/\w+;base64,/, '');
    if (!base64) continue;

    const isScene = img.image_type === 'scene';
    const subDir = isScene ? 'scenes' : 'covers';

    // Determine if this is the active version
    const pageKey = String(img.page_number);
    const activeVersion = versionMeta[pageKey]?.activeVersion ?? 0;
    const isActive = img.version_index === activeVersion;
    const activeTag = isActive ? '_ACTIVE' : '';

    let filename;
    if (isScene) {
      filename = `page${String(img.page_number).padStart(2, '0')}_v${img.version_index}${activeTag}.jpg`;
    } else {
      filename = `${img.image_type}_v${img.version_index}${activeTag}.jpg`;
    }

    const filepath = path.join(outDir, subDir, filename);
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
    saved++;

    const score = img.quality_score ? ` (score: ${img.quality_score})` : '';
    console.log(`  Saved: ${subDir}/${filename}${score}`);
  }

  console.log(`\nSaved ${saved} images to: ${path.resolve(outDir)}`);
  pool.end();
}

download().catch(e => { console.error(e); process.exit(1); });

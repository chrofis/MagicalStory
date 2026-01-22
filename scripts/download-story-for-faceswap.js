#!/usr/bin/env node
/**
 * Download story images and avatars for face swap testing
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function download() {
  const storyId = process.argv[2] || 'job_1769031058744_ta1cov9bi';

  // Get story data
  const result = await pool.query('SELECT data, metadata FROM stories WHERE id = $1', [storyId]);
  if (result.rows.length === 0) {
    console.log('Story not found:', storyId);
    process.exit(1);
  }

  const data = result.rows[0].data;
  const metadata = result.rows[0].metadata;

  console.log('Story:', metadata.title);
  console.log('Pages:', data.sceneImages?.length || 0);

  // Create output directory
  const outDir = path.join('output', 'faceswap-test');
  fs.mkdirSync(path.join(outDir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'avatars'), { recursive: true });

  // Save scene images
  let savedPages = 0;
  for (const scene of (data.sceneImages || [])) {
    if (scene.imageData) {
      const base64 = scene.imageData.replace(/^data:image\/\w+;base64,/, '');
      const filename = 'page' + String(scene.pageNumber).padStart(2, '0') + '.jpg';
      fs.writeFileSync(path.join(outDir, 'pages', filename), Buffer.from(base64, 'base64'));
      savedPages++;
    }
  }
  console.log('Saved', savedPages, 'page images');

  // Get characters from data (has avatars) - metadata.characters only has names
  const characters = data.characters || [];
  console.log('Characters:', characters.length);

  // Save character avatars
  let savedAvatars = 0;

  for (const char of characters) {
    const charDir = path.join(outDir, 'avatars', char.name);
    fs.mkdirSync(charDir, { recursive: true });

    console.log('  -', char.name);

    // Save face photo
    if (char.photoUrl?.startsWith('data:image')) {
      const base64 = char.photoUrl.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(charDir, 'face.jpg'), Buffer.from(base64, 'base64'));
      savedAvatars++;
    }

    // Save styled avatars if available
    const avatars = char.avatars || {};
    if (avatars.styledAvatars) {
      for (const [style, categories] of Object.entries(avatars.styledAvatars)) {
        if (!categories) continue;
        for (const [cat, value] of Object.entries(categories)) {
          if (cat === 'costumed' && typeof value === 'object') {
            // Handle costumed subcategories
            for (const [costume, costumeData] of Object.entries(value)) {
              const imgData = typeof costumeData === 'string' ? costumeData : costumeData?.imageData;
              if (imgData?.startsWith('data:image')) {
                const base64 = imgData.replace(/^data:image\/\w+;base64,/, '');
                fs.writeFileSync(path.join(charDir, `styled_${style}_costumed_${costume}.jpg`), Buffer.from(base64, 'base64'));
                savedAvatars++;
              }
            }
          } else {
            const imgData = typeof value === 'string' ? value : value?.imageData;
            if (imgData?.startsWith('data:image')) {
              const base64 = imgData.replace(/^data:image\/\w+;base64,/, '');
              fs.writeFileSync(path.join(charDir, `styled_${style}_${cat}.jpg`), Buffer.from(base64, 'base64'));
              savedAvatars++;
            }
          }
        }
      }
    }

    // Save base avatars (standard, winter, summer, etc.)
    for (const key of ['standard', 'winter', 'summer']) {
      const value = avatars[key];
      const imgData = typeof value === 'string' ? value : value?.imageData;
      if (imgData?.startsWith('data:image')) {
        const base64 = imgData.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(path.join(charDir, `base_${key}.jpg`), Buffer.from(base64, 'base64'));
        savedAvatars++;
      }
    }

    // Save costumed avatars
    if (avatars.costumed) {
      for (const [costume, value] of Object.entries(avatars.costumed)) {
        const imgData = typeof value === 'string' ? value : value?.imageData;
        if (imgData?.startsWith('data:image')) {
          const base64 = imgData.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(path.join(charDir, `base_costumed_${costume}.jpg`), Buffer.from(base64, 'base64'));
          savedAvatars++;
        }
      }
    }
  }

  console.log('Saved', savedAvatars, 'avatar images');
  console.log('\nOutput directory:', path.resolve(outDir));

  pool.end();
}

download().catch(e => { console.error(e); process.exit(1); });

// Step 1+2: pull active page images and recorded bbox detections from DB
// Writes page images to tmp/bbox-investigation/p{N}.{ext}
// Writes recorded detections to tmp/bbox-investigation/recorded-boxes.json

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const STORY_ID = 'job_1776965594352_um33rf9xl';
const OUT_DIR = path.join(__dirname, '..', '..', 'tmp', 'bbox-investigation');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

function extFromDataUri(dataUri) {
  const m = /^data:image\/(\w+);base64,/.exec(dataUri || '');
  if (!m) return 'jpg';
  return m[1] === 'jpeg' ? 'jpg' : m[1];
}

function bufferFromDataUri(dataUri) {
  const m = /^data:image\/\w+;base64,(.*)$/.exec(dataUri || '');
  if (!m) return null;
  return Buffer.from(m[1], 'base64');
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Get sceneImages[] with bestSource + imageVersions
  const { rows: storyRows } = await pool.query(
    `SELECT data->'sceneImages' AS scene_images, data->'characters' AS characters FROM stories WHERE id = $1`,
    [STORY_ID]
  );
  if (!storyRows.length) throw new Error(`story ${STORY_ID} not found`);
  const sceneImages = storyRows[0].scene_images;
  const characters = storyRows[0].characters || [];

  console.log(`Story has ${sceneImages.length} sceneImages, ${characters.length} characters`);

  // Get all rows from story_images for this story (type='scene')
  const { rows: imgRows } = await pool.query(
    `SELECT page_number, version_index, image_type, image_data
     FROM story_images
     WHERE story_id = $1 AND image_type = 'scene'
     ORDER BY page_number, version_index`,
    [STORY_ID]
  );
  const byPage = new Map();
  for (const r of imgRows) {
    if (!byPage.has(r.page_number)) byPage.set(r.page_number, new Map());
    byPage.get(r.page_number).set(r.version_index, r.image_data);
  }

  const recorded = {
    storyId: STORY_ID,
    characters: characters.map(c => ({ name: c.name, description: c.physical?.description || c.description || '' })),
    pages: []
  };

  for (let i = 0; i < sceneImages.length; i++) {
    const pageNum = i + 1;
    const si = sceneImages[i];
    const bestSource = si.bestSource || 'original';
    const versions = si.imageVersions || [];

    // Find active version_index from imageVersions array order
    const activeIdx = versions.findIndex(v => v.source === bestSource);
    const chosenIdx = activeIdx >= 0 ? activeIdx : 0;
    const activeVersion = versions[chosenIdx] || {};

    // Pull the image from story_images
    const pageImages = byPage.get(pageNum) || new Map();
    let imgData = pageImages.get(chosenIdx);
    if (!imgData) {
      // fallback: highest version present
      const keys = Array.from(pageImages.keys()).sort((a, b) => b - a);
      if (keys.length) imgData = pageImages.get(keys[0]);
    }

    if (!imgData) {
      console.log(`  p${pageNum}: NO IMAGE FOUND`);
      continue;
    }

    const ext = extFromDataUri(imgData);
    const buf = bufferFromDataUri(imgData);
    if (!buf) {
      console.log(`  p${pageNum}: invalid data uri`);
      continue;
    }
    const outPath = path.join(OUT_DIR, `p${pageNum}.${ext}`);
    fs.writeFileSync(outPath, buf);
    console.log(`  p${pageNum}: saved ${outPath} (source=${bestSource}, vIdx=${chosenIdx})`);

    // Extract bboxDetection from the active version and its retryHistory
    const retryHistory = si.retryHistory || [];
    const pageRecord = {
      page: pageNum,
      bestSource,
      activeVersionIndex: chosenIdx,
      activeVersionSource: activeVersion.source,
      textPosition: si.textPosition || null,
      sceneDescription: (si.sceneDescription || '').slice(0, 300),
      imageFile: path.basename(outPath),
      activeBboxDetection: activeVersion.bboxDetection || null,
      retryBboxes: retryHistory.map(h => ({
        attempt: h.attempt,
        source: h.source,
        bboxDetection: h.bboxDetection || null,
      })),
    };
    recorded.pages.push(pageRecord);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'recorded-boxes.json'), JSON.stringify(recorded, null, 2));
  console.log(`Wrote recorded-boxes.json with ${recorded.pages.length} pages`);

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });

/**
 * Test the union-feather composite using ONLY the stored v0/v1/v2/v3 images
 * for page 2 of job_1777923092665_wkhxd3mg9. No Grok calls.
 *
 * For each transition (v0→v1, v1→v2, v2→v3):
 *   - sceneBuffer  = previous round's image
 *   - grokRawBuf   = next round's stored image
 *   - oldSilhouette = rembg over Franziska's bbox crop in sceneBuffer
 *   - newSilhouette = rembg over Franziska's bbox crop in grokRawBuf
 *   - leak ratio    = (newSilhouette pixels NOT in oldSilhouette) / oldSilhouette pixels
 *   - feather ON if leak < 0.15, else union(old∪new) feather
 *   - composite grokRawBuf onto sceneBuffer using the chosen mask
 *   - dump the new composite alongside diagnostic masks
 *
 * What the user can see by comparing:
 *   - input.jpg               = the previous-round image (sceneBuffer)
 *   - stored-output.jpg       = whatever was saved as the round's output
 *   - new-composite.jpg       = what the new union-feather logic would produce
 *   - mask-old.png / mask-new.png / mask-union.png
 *
 * Usage:  node scripts/analysis/test-union-feather-p2.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Pool } = require('pg');
const { fetchImageBytes } = require('../../server/lib/r2');

const STORY_ID = 'job_1777923092665_wkhxd3mg9';
const PAGE_NUMBER = 2;
const TARGET_CHARACTER = 'Franziska';

const OUT_DIR = path.join(__dirname, '..', '..', 'tmp', 'union-feather-test-p2');

// ---------------- helpers (mirror images.js where relevant) ----------------

async function rembgSilhouettePng(imgBuf) {
  // Same JSON contract as server/lib/images.js fetchSilhouettePng()
  const url = 'http://127.0.0.1:5000/silhouette-edge';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: `data:image/jpeg;base64,${imgBuf.toString('base64')}`,
      color: [255, 255, 255],
      alpha: 255,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`silhouette-edge HTTP ${res.status}`);
  const j = await res.json();
  const m = j?.image?.match?.(/^data:image\/\w+;base64,(.+)$/);
  if (!j?.success || !m) throw new Error('silhouette-edge bad response');
  return Buffer.from(m[1], 'base64');
}

// Fallback: contrast-based silhouette via Sharp threshold (rough but works
// for testing without the Python service running).
async function thresholdSilhouettePng(imgBuf) {
  const meta = await sharp(imgBuf).metadata();
  // Greyscale + threshold at midpoint; figure = darker than background here
  const grey = await sharp(imgBuf).greyscale().normalise().raw().toBuffer();
  const out = Buffer.alloc(meta.width * meta.height);
  for (let i = 0; i < grey.length; i++) {
    out[i] = grey[i] < 200 ? 255 : 0;
  }
  // Build a 4-channel PNG (R=255, G=0, B=255, A=mask) so the alpha channel
  // matches the rembg output shape.
  const rgba = Buffer.alloc(meta.width * meta.height * 4);
  for (let i = 0; i < out.length; i++) {
    rgba[i * 4 + 0] = 255;
    rgba[i * 4 + 1] = 0;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = out[i];
  }
  return sharp(rgba, { raw: { width: meta.width, height: meta.height, channels: 4 } }).png().toBuffer();
}

// Solid rectangular mask the size of the crop. Mirrors production's fallback
// at images.js:8987-8990 ("silhouette-edge unavailable — falling back to
// rectangular hatch"). When the Python service is unreachable, this is the
// mask production actually uses too — so comparing against this is the most
// faithful reproduction of what would have happened.
async function rectMaskPng(imgBuf) {
  const meta = await sharp(imgBuf).metadata();
  const rgba = Buffer.alloc(meta.width * meta.height * 4);
  for (let i = 0; i < meta.width * meta.height; i++) {
    rgba[i * 4 + 0] = 255;
    rgba[i * 4 + 1] = 0;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = 255;
  }
  return sharp(rgba, { raw: { width: meta.width, height: meta.height, channels: 4 } }).png().toBuffer();
}

async function getSilhouette(imgBuf) {
  try {
    return await rembgSilhouettePng(imgBuf);
  } catch (err) {
    console.warn(`  ⚠️ rembg unreachable (${err.message}) — using rectangular bbox mask (matches production fallback)`);
    return await rectMaskPng(imgBuf);
  }
}

async function loadStoredVersion(pool, versionIndex) {
  const r = await pool.query(
    `SELECT image_url, image_data FROM story_images
     WHERE story_id = $1 AND image_type = 'scene' AND page_number = $2 AND version_index = $3`,
    [STORY_ID, PAGE_NUMBER, versionIndex]
  );
  if (!r.rows[0]) throw new Error(`v${versionIndex} not found in story_images`);
  if (r.rows[0].image_data) return r.rows[0].image_data;
  if (r.rows[0].image_url) {
    const buf = await fetchImageBytes(r.rows[0].image_url);
    if (!buf) throw new Error(`R2 fetch returned empty for v${versionIndex}`);
    return buf;
  }
  throw new Error(`v${versionIndex} has no data`);
}

async function processTransition(label, sceneBuffer, grokRawBuf, bbox, dirOut) {
  fs.mkdirSync(dirOut, { recursive: true });
  fs.writeFileSync(path.join(dirOut, 'input.jpg'), sceneBuffer);
  fs.writeFileSync(path.join(dirOut, 'stored-output.jpg'), grokRawBuf);

  const sceneMeta = await sharp(sceneBuffer).metadata();
  const [ymin, xmin, ymax, xmax] = bbox;
  const hatchLeft = Math.floor(xmin * sceneMeta.width);
  const hatchTop = Math.floor(ymin * sceneMeta.height);
  const hatchWidth = Math.max(1, Math.ceil((xmax - xmin) * sceneMeta.width));
  const hatchHeight = Math.max(1, Math.ceil((ymax - ymin) * sceneMeta.height));

  // Resize stored output to scene dims if needed (defensive — should be same)
  const grokAtSourceDims = await sharp(grokRawBuf)
    .resize(sceneMeta.width, sceneMeta.height, { fit: 'fill' })
    .jpeg({ quality: 95 })
    .toBuffer();

  // Old silhouette from sceneBuffer's hatch region
  const sceneCrop = await sharp(sceneBuffer)
    .extract({ left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight })
    .jpeg({ quality: 90 }).toBuffer();
  const oldSilhouette = await getSilhouette(sceneCrop);
  // Save a viewable greyscale visualisation: alpha channel shown as L. White
  // = pixels that get repainted (Grok), black = pixels left untouched (v0).
  const oldVis = await sharp(oldSilhouette).extractChannel(3).png().toBuffer();
  fs.writeFileSync(path.join(dirOut, 'mask-old-bbox-region.png'), oldVis);

  // New silhouette from grokRawBuf's hatch region
  const grokCrop = await sharp(grokAtSourceDims)
    .extract({ left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight })
    .jpeg({ quality: 90 }).toBuffer();
  const newSilhouette = await getSilhouette(grokCrop);
  const newVis = await sharp(newSilhouette).extractChannel(3).png().toBuffer();
  fs.writeFileSync(path.join(dirOut, 'mask-new-bbox-region.png'), newVis);

  const oldAlpha = await sharp(oldSilhouette).extractChannel(3).raw().toBuffer();
  const newAlpha = await sharp(newSilhouette).extractChannel(3).raw().toBuffer();
  let oldPx = 0, newPx = 0, both = 0, newOnly = 0;
  const len = Math.min(oldAlpha.length, newAlpha.length);
  for (let i = 0; i < len; i++) {
    const o = oldAlpha[i] > 128;
    const n = newAlpha[i] > 128;
    if (o) oldPx++;
    if (n) newPx++;
    if (o && n) both++;
    if (n && !o) newOnly++;
  }
  const leakRatio = oldPx > 0 ? newOnly / oldPx : 1;
  const overlapRatio = oldPx > 0 ? both / oldPx : 0;
  const FEATHER_LEAK_THRESHOLD = 0.15;
  const canFeather = leakRatio < FEATHER_LEAK_THRESHOLD;

  console.log(`\n=== ${label} ===`);
  console.log(`  bbox px: ${hatchWidth}x${hatchHeight} at (${hatchLeft},${hatchTop})`);
  console.log(`  oldSilhouette pixels: ${oldPx}`);
  console.log(`  newSilhouette pixels: ${newPx}`);
  console.log(`  overlap (old∩new):    ${both}  (${(overlapRatio * 100).toFixed(1)}% of old)`);
  console.log(`  newOnly (new\\old):    ${newOnly}  (${(leakRatio * 100).toFixed(1)}% of old) [threshold 15%]`);
  console.log(`  → feather decision:   ${canFeather ? 'ON (clean)' : 'OFF → use UNION'}`);

  const FEATHER_PX = 6;
  // Mirrors the FIXED compositeWithMask in images.js — uses explicit RGBA mask
  // + dest-in (joinChannel was silently dropping the mask, see commit log).
  const compositeWith = async (silhouettePng) => {
    const featheredRGB = await sharp({
      create: { width: sceneMeta.width, height: sceneMeta.height, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([{ input: silhouettePng, top: hatchTop, left: hatchLeft }])
      .blur(FEATHER_PX)
      .png()
      .toBuffer();
    const featheredAlpha = await sharp(featheredRGB).extractChannel(0).raw().toBuffer();

    const W = sceneMeta.width, H = sceneMeta.height;
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba[i*4+0] = 255; rgba[i*4+1] = 255; rgba[i*4+2] = 255;
      rgba[i*4+3] = featheredAlpha[i];
    }
    const rgbaMaskPng = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();

    const grokWithAlpha = await sharp(grokAtSourceDims)
      .ensureAlpha(1)
      .composite([{ input: rgbaMaskPng, blend: 'dest-in' }])
      .png()
      .toBuffer();

    return sharp(sceneBuffer)
      .composite([{ input: grokWithAlpha, top: 0, left: 0, blend: 'over' }])
      .jpeg({ quality: 95 })
      .toBuffer();
  };

  let newOutput;
  let usedMask = 'old';
  // Build & dump the actual feathered scene-dim mask the composite uses.
  // White = Grok pixels written, black = v0 pixels preserved, grey = blend.
  const dumpFeatheredMask = async (silhouettePng, fname) => {
    const featheredRGB = await sharp({
      create: { width: sceneMeta.width, height: sceneMeta.height, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([{ input: silhouettePng, top: hatchTop, left: hatchLeft }])
      .blur(FEATHER_PX)
      .png().toBuffer();
    const featheredMask = await sharp(featheredRGB).extractChannel(0).png().toBuffer();
    fs.writeFileSync(path.join(dirOut, fname), featheredMask);
  };
  if (canFeather) {
    await dumpFeatheredMask(oldSilhouette, 'mask-feathered-scene.png');
    newOutput = await compositeWith(oldSilhouette);
    usedMask = 'old';
  } else {
    // Build union mask: pixel-wise OR of old and new alpha channels
    const oldAlphaMono = await sharp(oldSilhouette).extractChannel(3).toColorspace('b-w').png().toBuffer();
    const newAlphaMono = await sharp(newSilhouette).extractChannel(3).toColorspace('b-w').png().toBuffer();
    const unionAlpha = await sharp(oldAlphaMono)
      .composite([{ input: newAlphaMono, blend: 'add' }])
      .png()
      .toBuffer();
    const unionSilhouette = await sharp({
      create: { width: hatchWidth, height: hatchHeight, channels: 3, background: { r: 255, g: 0, b: 255 } }
    })
      .joinChannel(unionAlpha)
      .png()
      .toBuffer();
    const unionVis = await sharp(unionSilhouette).extractChannel(3).png().toBuffer();
    fs.writeFileSync(path.join(dirOut, 'mask-union-bbox-region.png'), unionVis);
    await dumpFeatheredMask(unionSilhouette, 'mask-feathered-scene.png');
    newOutput = await compositeWith(unionSilhouette);
    usedMask = 'union';
  }
  fs.writeFileSync(path.join(dirOut, `new-composite-${usedMask}-feather.jpg`), newOutput);

  console.log(`  → wrote new-composite-${usedMask}-feather.jpg in ${path.basename(dirOut)}/`);
  return { leakRatio, overlapRatio, canFeather, usedMask };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Set DATABASE_PUBLIC_URL or DATABASE_URL');
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  console.log(`Loading story ${STORY_ID} ...`);
  const r = await pool.query(`SELECT data FROM stories WHERE id = $1`, [STORY_ID]);
  const story = r.rows[0].data;
  const page = story.sceneImages.find(p => p.pageNumber === PAGE_NUMBER);

  // Use bbox from each version's bboxDetection (Franziska's body)
  const findFranziskaBbox = (version) => {
    const figs = version?.bboxDetection?.figures || [];
    const fig = figs.find(f => (f.name || '').toLowerCase() === TARGET_CHARACTER.toLowerCase());
    if (!fig?.bodyBox) return null;
    const bb = fig.bodyBox;
    return Array.isArray(bb) ? bb : [bb.y, bb.x, bb.y + bb.height, bb.x + bb.width];
  };

  const versions = page.imageVersions || [];
  const v0 = versions.find(v => v.source === 'original');
  const v1 = versions.find(v => v.source === 'char-fix-round-1');
  const v2 = versions.find(v => v.source === 'char-fix-round-2');
  const v3 = versions.find(v => v.source === 'char-fix-round-3');

  console.log(`Loading v0..v3 from R2 ...`);
  const buffers = {
    v0: await loadStoredVersion(pool, 0),
    v1: await loadStoredVersion(pool, 1),
    v2: await loadStoredVersion(pool, 2),
    v3: await loadStoredVersion(pool, 3),
  };

  // Run transitions; bbox uses the input version's detection (= what the
  // pipeline would have used at repair time).
  const stats = [];
  if (v0 && v1) {
    const bbox = findFranziskaBbox(v0);
    if (!bbox) console.warn('  ⚠️ no Franziska bbox on v0');
    else stats.push({ label: 'v0 → v1', ...await processTransition('v0 → v1', buffers.v0, buffers.v1, bbox, path.join(OUT_DIR, 'v0-to-v1')) });
  }
  if (v1 && v2) {
    const bbox = findFranziskaBbox(v1);
    if (!bbox) console.warn('  ⚠️ no Franziska bbox on v1');
    else stats.push({ label: 'v1 → v2', ...await processTransition('v1 → v2', buffers.v1, buffers.v2, bbox, path.join(OUT_DIR, 'v1-to-v2')) });
  }
  if (v2 && v3) {
    const bbox = findFranziskaBbox(v2);
    if (!bbox) console.warn('  ⚠️ no Franziska bbox on v2');
    else stats.push({ label: 'v2 → v3', ...await processTransition('v2 → v3', buffers.v2, buffers.v3, bbox, path.join(OUT_DIR, 'v2-to-v3')) });
  }

  await pool.end();

  console.log(`\n========== SUMMARY ==========`);
  for (const s of stats) {
    console.log(`  ${s.label}: leak=${(s.leakRatio*100).toFixed(1)}%  overlap=${(s.overlapRatio*100).toFixed(1)}%  decision=${s.canFeather ? 'feather ON (clean)' : 'feather OFF → UNION fallback used'}`);
  }
  console.log(`\nAll outputs in: ${OUT_DIR}`);
}

main().catch(err => {
  console.error('Fatal:', err.stack || err.message);
  process.exit(1);
});

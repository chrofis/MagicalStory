#!/usr/bin/env node
/**
 * Issue #3 reproducer: character repair wiping a foreground character that
 * overlaps the target's bbox.
 *
 * Picks a real story page from the local DB where the repaired character
 * (e.g. Noah on p2 of job_1778525478433_fkl0f12x4) has another character
 * (Emma) standing in front of them — i.e. neighbour bbox overlaps target
 * bbox.
 *
 * Calls repairCharacterMismatchWithGrok in body-blended mode using the SAME
 * inputs the pipeline used (bbox, faceBbox, protectedFaces, protectedBodies,
 * avatar photo, sceneDescription). Saves before / after / blendMask / Grok
 * raw / cropped neighbour zone to disk.
 *
 * Run twice to A/B: once after `git stash`-ing the fix, once with the fix.
 *
 * Usage
 *   node scripts/test-char-repair-overlap.js \
 *     --story=job_1778525478433_fkl0f12x4 --page=2 --char=Noah \
 *     --tag=v1
 *
 * Output: tests/char-repair-overlap/<story>_p<page>_<char>_<tag>/
 */
'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'tests', 'char-repair-overlap');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.+)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const STORY = args.story || 'job_1778525478433_fkl0f12x4';
const PAGE = Number(args.page || 2);
const CHAR = args.char || 'Noah';
const TAG = args.tag || 'run';

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query(`SELECT id, data FROM stories WHERE id = $1`, [STORY]);
  if (!rows.length) {
    console.error(`Story not found: ${STORY}`);
    process.exit(1);
  }
  const story = rows[0].data;
  const scene = (story.sceneImages || []).find(s => Number(s.pageNumber) === PAGE);
  if (!scene) {
    console.error(`Page ${PAGE} not found in story`);
    process.exit(1);
  }

  // Fetch the latest scene image (use the "best" version index from story_images).
  const imgRows = await pool.query(
    `SELECT version_index, image_url, image_data FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type='scene' ORDER BY version_index DESC LIMIT 1`,
    [STORY, PAGE]
  );
  if (!imgRows.rows.length) {
    console.error('No story_images row for that page');
    process.exit(1);
  }
  const imgRow = imgRows.rows[0];

  let sceneBuffer;
  if (imgRow.image_data) {
    sceneBuffer = imgRow.image_data;
  } else if (imgRow.image_url) {
    const res = await fetch(imgRow.image_url);
    sceneBuffer = Buffer.from(await res.arrayBuffer());
  } else {
    console.error('No image data or URL for page');
    process.exit(1);
  }
  console.log(`Loaded scene image v${imgRow.version_index}, ${sceneBuffer.length} bytes`);

  // Find target + neighbours from scene.bboxDetection.figures.
  const figs = (scene.bboxDetection?.figures) || [];
  const target = figs.find(f => (f.name || '').toLowerCase() === CHAR.toLowerCase());
  if (!target) {
    console.error(`No figure named ${CHAR} in bboxDetection. Available: ${figs.map(f => f.name).join(', ')}`);
    process.exit(1);
  }
  const toRect = b => Array.isArray(b) ? b : (b ? [b.y, b.x, b.y + b.height, b.x + b.width] : null);
  const targetBody = toRect(target.bodyBox);
  const targetFace = toRect(target.faceBox);
  if (!targetBody) {
    console.error(`No bodyBox for ${CHAR}`);
    process.exit(1);
  }

  const protectedFaces = [];
  const protectedBodies = [];
  for (const fig of figs) {
    if (!fig.name || fig.name === 'UNKNOWN') continue;
    if (fig.name.toLowerCase() === CHAR.toLowerCase()) continue;
    if (fig.faceBox) protectedFaces.push(toRect(fig.faceBox));
    if (fig.bodyBox) protectedBodies.push(toRect(fig.bodyBox));
  }
  console.log(`Target body=${targetBody.map(v => (v * 100).toFixed(0)).join(',')}`);
  console.log(`ProtectedBodies (${protectedBodies.length}):`);
  for (const [i, b] of protectedBodies.entries()) {
    const overlap = b[1] < targetBody[3] && b[3] > targetBody[1] && b[0] < targetBody[2] && b[2] > targetBody[0];
    console.log(`  ${figs.filter(f => f.name && f.name !== 'UNKNOWN' && f.name.toLowerCase() !== CHAR.toLowerCase())[i]?.name}: ${b.map(v => (v * 100).toFixed(0)).join(',')}${overlap ? '  <-- OVERLAPS TARGET' : ''}`);
  }

  // Look up the avatar photo for this char in this scene's clothing.
  const char = (story.characters || []).find(c => c.name?.toLowerCase() === CHAR.toLowerCase());
  if (!char) {
    console.error(`No character record for ${CHAR}`);
    process.exit(1);
  }
  const clothingCategory = scene.sceneCharacterClothing?.[CHAR] || 'standard';
  console.log(`Clothing category for this scene: ${clothingCategory}`);
  // Avatar URL: prefer styled (matches what unified pipeline uses), fall back to standard.
  const artStyle = story.artStyle || 'cartoon';
  const styledForCloth = char.avatars?.styledAvatars?.[artStyle]?.[clothingCategory];
  const avatarUrl =
    (styledForCloth?.imageUrl) ||
    char.avatars?.styledAvatars?.[artStyle]?.standard?.imageUrl ||
    char.avatars?.[`${clothingCategory}Url`] ||
    char.avatars?.standardUrl ||
    null;
  if (!avatarUrl) {
    console.error(`No avatar URL for ${CHAR} (artStyle=${artStyle}, clothing=${clothingCategory})`);
    process.exit(1);
  }
  console.log(`Avatar URL: ${avatarUrl}`);
  const aRes = await fetch(avatarUrl);
  if (!aRes.ok) {
    console.error(`Failed to fetch avatar: ${aRes.status}`);
    process.exit(1);
  }
  const avatarBuf = Buffer.from(await aRes.arrayBuffer());
  const avatarUri = `data:image/jpeg;base64,${avatarBuf.toString('base64')}`;
  const photoType = styledForCloth ? `styled-${clothingCategory}` : 'face';

  // Output dir
  const outDir = path.join(OUT_ROOT, `${STORY}_p${PAGE}_${CHAR}_${TAG}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'before.jpg'), sceneBuffer);
  console.log(`Out dir: ${outDir}`);

  // Crop the neighbour-overlap zone for visual diff.
  const meta = await sharp(sceneBuffer).metadata();
  const overlapNeighbour = protectedBodies.find(b =>
    b[1] < targetBody[3] && b[3] > targetBody[1] && b[0] < targetBody[2] && b[2] > targetBody[0]
  );
  if (overlapNeighbour) {
    const oxmin = Math.max(targetBody[1], overlapNeighbour[1]);
    const oxmax = Math.min(targetBody[3], overlapNeighbour[3]);
    const oymin = Math.max(targetBody[0], overlapNeighbour[0]);
    const oymax = Math.min(targetBody[2], overlapNeighbour[2]);
    fs.writeFileSync(path.join(outDir, 'overlap_zone.txt'),
      `target body  : ${targetBody.join(',')}\n` +
      `neighbour body: ${overlapNeighbour.join(',')}\n` +
      `overlap zone: y=[${oymin.toFixed(3)},${oymax.toFixed(3)}] x=[${oxmin.toFixed(3)},${oxmax.toFixed(3)}]\n` +
      `pixels       : ${Math.floor(oxmin * meta.width)},${Math.floor(oymin * meta.height)} - ${Math.floor(oxmax * meta.width)},${Math.floor(oymax * meta.height)}\n`
    );
  }

  // Now call repairCharacterMismatchWithGrok in body-blended mode.
  const { repairCharacterMismatch } = require('../server/lib/images');
  const sceneAsDataUri = `data:image/jpeg;base64,${sceneBuffer.toString('base64')}`;

  console.log('Calling repair…');
  const t0 = Date.now();
  const result = await repairCharacterMismatch(
    sceneAsDataUri,
    avatarUri,
    targetBody,
    CHAR,
    {
      imageBackend: 'grok',
      issueDescription: 'clothing color mismatch',
      clothingDescription: char.avatars?.clothing?.[clothingCategory] || '',
      photoType,
      sceneDescription: scene.sceneDescription || scene.text || '',
      faceBbox: targetFace || undefined,
      protectedFaces,
      protectedBodies,
      whiteoutTarget: 'body',
      textPosition: scene.textPosition || null,
      useFullScene: true,
      includeDebug: true,
    }
  );
  console.log(`Repair done in ${((Date.now() - t0) / 1000).toFixed(1)}s, method=${result.method}`);

  if (result.imageData) {
    const after = Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    fs.writeFileSync(path.join(outDir, 'after.jpg'), after);

    // Also crop the neighbour region from before and after for side-by-side
    if (overlapNeighbour) {
      const [fymin, fxmin, fymax, fxmax] = overlapNeighbour;
      const left = Math.max(0, Math.floor(fxmin * meta.width));
      const top = Math.max(0, Math.floor(fymin * meta.height));
      const w = Math.min(meta.width - left, Math.ceil((fxmax - fxmin) * meta.width));
      const h = Math.min(meta.height - top, Math.ceil((fymax - fymin) * meta.height));
      await sharp(sceneBuffer).extract({ left, top, width: w, height: h }).jpeg({ quality: 92 }).toFile(path.join(outDir, 'before_neighbour_crop.jpg'));
      await sharp(after).extract({ left, top, width: w, height: h }).jpeg({ quality: 92 }).toFile(path.join(outDir, 'after_neighbour_crop.jpg'));
    }
  }
  // blended-mode and fullScene/cutout/blackout stash debug data in different
  // places — accept either flat or comparison.* shape.
  const dump = (label, dataUri) => {
    if (!dataUri) return;
    fs.writeFileSync(path.join(outDir, label),
      Buffer.from(dataUri.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  };
  dump('blend_mask.jpg',        result.blendMask        || result.comparison?.blendMask);
  dump('scene_sent_to_grok.jpg', result.blackoutImage   || result.comparison?.blackoutImage);
  dump('grok_raw.jpg',           result.grokRawResult   || result.comparison?.grokRawResult);
  dump('cropped_avatar.jpg',     result.croppedAvatar   || result.comparison?.croppedAvatar);
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
    story: STORY, page: PAGE, char: CHAR, tag: TAG,
    method: result.method,
    cost: result.usage?.cost,
    targetBody,
    targetFace,
    protectedBodies,
    protectedFaces,
  }, null, 2));

  await pool.end();
  console.log(`Done. ${outDir}`);
})().catch(e => { console.error(e); process.exit(1); });

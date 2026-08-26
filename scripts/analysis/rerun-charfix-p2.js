/**
 * Re-run char-fix on page 2 of job_1777923092665_wkhxd3mg9 with the new
 * union-feather fallback. Dumps:
 *   - v0 (input)               input-v0.jpg
 *   - Grok's raw repaint        grok-raw.jpg
 *   - mask sent to Grok         masked-input.png
 *   - old silhouette            silhouette-old.png
 *   - new silhouette            silhouette-new.png  (if available)
 *   - feather decision + ratio  in console
 *   - new composited result     output-newcompo.jpg
 *
 * Tries Franziska as the fix target (the actual char-fixed character on this page).
 *
 * Usage:  node scripts/analysis/rerun-charfix-p2.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { fetchImageBytes } = require('../../server/lib/r2');
const {
  repairCharacterMismatch,
} = require('../../server/lib/images');
const { getStyledAvatarForClothing } = require('../../server/lib/entityConsistency');
const { getFacePhoto, parseCharacterClothing } = require('../../server/lib/storyHelpers');

const STORY_ID = 'job_1777923092665_wkhxd3mg9';
const PAGE_NUMBER = 2;
const TARGET_CHARACTER = 'Franziska';

const OUT_DIR = path.join(__dirname, '..', '..', 'tmp', 'charfix-rerun-p2');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Set DATABASE_PUBLIC_URL or DATABASE_URL');
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  console.log(`Loading story ${STORY_ID} ...`);
  const r = await pool.query(`SELECT data FROM stories WHERE id = $1`, [STORY_ID]);
  if (!r.rows[0]) throw new Error('Story not found');
  const story = r.rows[0].data;

  // Find page 2's v0 (original, before any char-fix)
  const sceneImages = story.sceneImages || [];
  const page = sceneImages.find(p => p.pageNumber === PAGE_NUMBER);
  if (!page) throw new Error(`Page ${PAGE_NUMBER} not found`);
  const v0 = (page.imageVersions || []).find(v => v.source === 'original');
  if (!v0) throw new Error('v0 (original) not found in imageVersions');

  console.log(`Found v0 (original), score=${v0.qualityScore}`);

  // Pull v0 imageData. May be inline base64 or an https R2 URL.
  let v0DataUri = v0.imageData;
  if (!v0DataUri || /^https?:\/\//i.test(v0DataUri || '')) {
    // Fetch from story_images by version_index 0
    const ri = await pool.query(
      `SELECT image_url, image_data FROM story_images
       WHERE story_id = $1 AND image_type = 'scene' AND page_number = $2 AND version_index = 0`,
      [STORY_ID, PAGE_NUMBER]
    );
    if (!ri.rows[0]) throw new Error('story_images row for v0 not found');
    if (ri.rows[0].image_data) {
      v0DataUri = `data:image/jpeg;base64,${ri.rows[0].image_data.toString('base64')}`;
    } else if (ri.rows[0].image_url) {
      console.log(`Fetching v0 from R2: ${ri.rows[0].image_url}`);
      const buf = await fetchImageBytes(ri.rows[0].image_url);
      if (!buf) throw new Error('R2 fetch returned empty');
      v0DataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
    } else {
      throw new Error('story_images row has neither image_data nor image_url');
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'input-v0.jpg'),
    Buffer.from(v0DataUri.replace(/^data:image\/\w+;base64,/, ''), 'base64')
  );
  console.log(`  → wrote input-v0.jpg`);

  // Find Franziska's body bbox on v0
  const figs = v0.bboxDetection?.figures || [];
  const franziskaFig = figs.find(f => (f.name || '').toLowerCase() === TARGET_CHARACTER.toLowerCase());
  if (!franziskaFig?.bodyBox) throw new Error(`No Franziska body bbox in v0 bboxDetection`);
  const bb = franziskaFig.bodyBox;
  const bbox = Array.isArray(bb) ? bb : [bb.y, bb.x, bb.y + bb.height, bb.x + bb.width];
  const faceBbox = franziskaFig.faceBox
    ? (Array.isArray(franziskaFig.faceBox) ? franziskaFig.faceBox : [franziskaFig.faceBox.y, franziskaFig.faceBox.x, franziskaFig.faceBox.y + franziskaFig.faceBox.height, franziskaFig.faceBox.x + franziskaFig.faceBox.width])
    : null;
  console.log(`Franziska bbox: [${bbox.map(v => (v*100).toFixed(0)+'%').join(', ')}]`);
  if (faceBbox) console.log(`Franziska faceBox: [${faceBbox.map(v => (v*100).toFixed(0)+'%').join(', ')}]`);

  // Resolve costumed:mittelalterlich avatar (same path the pipeline uses on this scene)
  const characters = story.characters || [];
  const character = characters.find(c => c.name === TARGET_CHARACTER);
  if (!character) throw new Error(`Character ${TARGET_CHARACTER} not found in story`);
  // perCharClothing usually empty on stored pages — derive from sceneDescription
  // metadata, the same way executeCharFixAction does at runtime.
  let clothingCategory = page.perCharClothing?.[TARGET_CHARACTER];
  if (!clothingCategory) {
    const parsed = parseCharacterClothing(page.description || page.sceneDescription || '') || {};
    clothingCategory = parsed[TARGET_CHARACTER] || 'standard';
  }
  console.log(`Resolving avatar (clothing=${clothingCategory}, artStyle=${story.artStyle})`);
  const styled = await getStyledAvatarForClothing(character, story.artStyle || 'watercolor', clothingCategory);
  const avatarPhoto = styled || getFacePhoto(character);
  if (!avatarPhoto) throw new Error('No avatar resolved');
  const photoType = styled
    ? (clothingCategory.startsWith('costumed') ? `costumed-${clothingCategory.split(':')[1] || 'default'}` : `styled-${clothingCategory}`)
    : 'face';
  console.log(`  avatar photoType=${photoType}`);

  fs.writeFileSync(
    path.join(OUT_DIR, 'avatar.jpg'),
    Buffer.from(avatarPhoto.replace(/^data:image\/\w+;base64,/, ''), 'base64')
  );

  // Call char-fix with includeDebug so we capture the masked input + Grok raw output
  console.log(`Running char-fix...`);
  const issueDescription = (v0.fixableIssues || [])
    .filter(it => (it.character || '').toLowerCase() === TARGET_CHARACTER.toLowerCase())
    .map(it => it.description || it.issue)
    .join(' | ') || 'clothing should match the costumed reference';
  const result = await repairCharacterMismatch(v0DataUri, avatarPhoto, bbox, TARGET_CHARACTER, {
    faceBbox,
    photoType,
    useFullScene: true,
    includeDebug: true,
    issueDescription,
    sceneDescription: page.description || page.sceneDescription || '',
    artStyle: story.artStyle || 'watercolor',
    textPosition: page.textPosition || null,
  });

  if (!result.imageData) {
    console.error('char-fix returned no imageData. method=' + result.method + ' error=' + (result.error || 'unknown'));
    process.exit(1);
  }

  // Dump everything for inspection
  const dec = result.debug ? '(debug fields included)' : '(no debug)';
  console.log(`\nDone. method=${result.method} ${dec}`);

  fs.writeFileSync(
    path.join(OUT_DIR, 'output-newcompo.jpg'),
    Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64')
  );
  console.log(`  → wrote output-newcompo.jpg`);

  if (result.comparison?.blackoutImage) {
    fs.writeFileSync(
      path.join(OUT_DIR, 'masked-input.png'),
      Buffer.from(result.comparison.blackoutImage.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    );
    console.log(`  → wrote masked-input.png`);
  }
  if (result.comparison?.grokRawResult) {
    fs.writeFileSync(
      path.join(OUT_DIR, 'grok-raw.jpg'),
      Buffer.from(result.comparison.grokRawResult.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    );
    console.log(`  → wrote grok-raw.jpg`);
  }
  if (result.comparison?.before) {
    fs.writeFileSync(
      path.join(OUT_DIR, 'before-from-call.jpg'),
      Buffer.from(result.comparison.before.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    );
  }

  // Also write the actual stored v1 (char-fix-round-1) for visual A/B
  const v1 = (page.imageVersions || []).find(v => v.source === 'char-fix-round-1');
  if (v1) {
    let v1DataUri = v1.imageData;
    if (!v1DataUri || /^https?:\/\//i.test(v1DataUri || '')) {
      const ri1 = await pool.query(
        `SELECT image_url, image_data FROM story_images
         WHERE story_id = $1 AND image_type = 'scene' AND page_number = $2 AND version_index = 1`,
        [STORY_ID, PAGE_NUMBER]
      );
      if (ri1.rows[0]?.image_data) {
        v1DataUri = `data:image/jpeg;base64,${ri1.rows[0].image_data.toString('base64')}`;
      } else if (ri1.rows[0]?.image_url) {
        const buf = await fetchImageBytes(ri1.rows[0].image_url);
        if (buf) v1DataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
      }
    }
    if (v1DataUri) {
      fs.writeFileSync(
        path.join(OUT_DIR, 'old-v1-stored.jpg'),
        Buffer.from(v1DataUri.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      );
      console.log(`  → wrote old-v1-stored.jpg (the originally saved char-fix-round-1)`);
    }
  }

  await pool.end();

  console.log(`\nAll outputs in: ${OUT_DIR}`);
  console.log(`Open these to compare:`);
  console.log(`  input-v0.jpg          ← the starting image (Franziska in plain green top)`);
  console.log(`  old-v1-stored.jpg     ← what the production pipeline produced`);
  console.log(`  output-newcompo.jpg   ← what the NEW union-feather fallback produces now`);
  console.log(`  masked-input.png      ← what was sent to Grok (crosshatched figure region)`);
  console.log(`  grok-raw.jpg          ← Grok's raw output before compositing`);
}

main().catch(err => {
  console.error('Fatal:', err.stack || err.message);
  process.exit(1);
});

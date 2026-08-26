// Purple-line test — load empty scene, draw L-shape guide along the mask
// boundary, tell Grok the corner is reserved for text, see if characters
// stay out. Reads a real story page from DB; overrides textPosition if
// the scene was saved with a wrong one.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Pool } = require('pg');

const OUT_DIR = __dirname;
const STORY_ID = 'job_1776286048220_aj0q6y71p';
const PAGE = 5;
const OVERRIDE_POS = 'bottom-right'; // corrected — empty area is bottom-right

(async () => {
  process.chdir(path.resolve(__dirname, '../..')); // so relative requires work
  const { loadPromptTemplates } = require('../../server/services/prompts');
  const { generateImageOnly } = require('../../server/lib/images');
  const { detectAndLightenTextRegion } = require('../../server/lib/textRegion');
  const { getTextAreaMask } = require('../../server/lib/textMasks');
  await loadPromptTemplates();

  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const d = await pool.query('SELECT data FROM stories WHERE id=$1', [STORY_ID]);
  const scene = d.rows[0].data.sceneImages.find(s => s.pageNumber === PAGE);
  const langLevel = d.rows[0].data.languageLevel || 'standard';
  const emptyR = await pool.query("SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='empty_scene' AND page_number=$2 AND version_index=0", [STORY_ID, PAGE]);
  await pool.end();

  const textPos = OVERRIDE_POS;
  const emptyBuf = Buffer.from(emptyR.rows[0].image_data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const meta = await sharp(emptyBuf).metadata();

  // Find where the white zone of the mask starts (top edge + left edge for corners).
  const maskDataUri = getTextAreaMask(textPos, langLevel);
  const maskB64 = maskDataUri.replace(/^data:image\/\w+;base64,/, '');
  const mraw = await sharp(Buffer.from(maskB64, 'base64')).greyscale().raw().toBuffer({ resolveWithObject: true });
  let firstWhiteY = -1, firstWhiteX = -1, lastWhiteX = -1;
  for (let y = 0; y < mraw.info.height && firstWhiteY === -1; y++)
    for (let x = 0; x < mraw.info.width; x++) if (mraw.data[y*mraw.info.width+x] > 200) { firstWhiteY = y; break; }
  for (let x = 0; x < mraw.info.width; x++)
    for (let y = 0; y < mraw.info.height; y++) if (mraw.data[y*mraw.info.width+x] > 200) {
      if (firstWhiteX === -1) firstWhiteX = x;
      lastWhiteX = x;
      break;
    }
  const lineY = Math.round(meta.height * (firstWhiteY / mraw.info.height));
  const isFull = textPos.endsWith('-full');
  const isLeft = textPos.includes('left');
  // For corners, draw an L along the two inside edges of the calm zone.
  // For -full positions, just a horizontal line.
  let lineX = null;
  if (!isFull) {
    lineX = isLeft
      ? Math.round(meta.width * (lastWhiteX / mraw.info.width))
      : Math.round(meta.width * (firstWhiteX / mraw.info.width));
  }
  const thickness = Math.max(24, Math.round(meta.height * 0.03));

  const rects = [`<rect x="0" y="${lineY - Math.floor(thickness/2)}" width="${meta.width}" height="${thickness}" fill="#a020f0"/>`];
  if (lineX != null) {
    // Vertical segment of the L — only from the horizontal line down to the bottom
    rects.push(`<rect x="${lineX - Math.floor(thickness/2)}" y="${lineY}" width="${thickness}" height="${meta.height - lineY}" fill="#a020f0"/>`);
  }
  const svg = `<svg width="${meta.width}" height="${meta.height}">${rects.join('')}</svg>`;
  const sceneWithLine = await sharp(emptyBuf).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
  fs.writeFileSync(path.join(OUT_DIR, 'purple_input.jpg'), sceneWithLine);
  console.log('textPos:', textPos, '| lineY:', lineY, 'lineX:', lineX, '| scene:', meta.width+'x'+meta.height);

  const cornerName = isFull
    ? (textPos.startsWith('top') ? 'top strip' : 'bottom strip')
    : `${textPos.startsWith('top') ? 'upper' : 'lower'} ${isLeft ? 'left' : 'right'} corner`;
  const calmSide = isFull
    ? (textPos.startsWith('top') ? 'above the line' : 'below the line')
    : `inside the L-shape (the ${cornerName})`;
  const actionSide = `outside the L-shape / away from the ${cornerName}`;

  const linePrefix = `**PURPLE LINE RULES (HIGHEST PRIORITY — READ BEFORE ANYTHING ELSE):**
1. A thick purple L-shape is painted on the reference scene. It outlines the ${cornerName} of the image.
2. ALL CHARACTERS must be placed ${actionSide}. No character body part may appear ${calmSide}.
3. The ${cornerName} (${calmSide}) must stay calm — soft continuation of the natural scene, no characters, no objects, no detail.
4. The purple marks MUST NOT appear in the output. Remove them.

---

`;
  let prompt = linePrefix + (scene.prompt || '');
  if (prompt.length > 7500) prompt = prompt.substring(0, 7500);

  console.log('calling Grok...');
  const sceneDataUri = `data:image/jpeg;base64,${sceneWithLine.toString('base64')}`;
  const result = await generateImageOnly(prompt, scene.referencePhotos || [], {
    imageBackendOverride: 'grok',
    landmarkPhotos: scene.landmarkPhotos || [],
    visualBibleGrid: null,
    sceneBackground: sceneDataUri,
    textAreaMask: null,
    pageNumber: PAGE,
    skipCache: true,
    aspectRatio: '3:4',
  });
  if (!result?.imageData) { console.error('no image'); process.exit(1); }
  fs.writeFileSync(path.join(OUT_DIR, 'purple_output.jpg'), Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  const detect = await detectAndLightenTextRegion(result.imageData, textPos, PAGE);
  console.log('coverage:', (detect.score * 100).toFixed(1) + '% (required ~20% for this page)');
  process.exit(0);
})().catch(e => { console.error('ERR:', e); process.exit(1); });

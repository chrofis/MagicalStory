// White-overlay test: pre-brighten the calm corner with a semi-transparent
// white wash (shaped like the triangle mask) instead of marking the boundary
// with a line. Tells Grok in the prompt: "keep this bright area bright".
// Auto-numbers output files so runs don't overwrite each other.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Pool } = require('pg');

const OUT_DIR = __dirname;
const STORY_ID = 'job_1776286048220_aj0q6y71p';
const PAGE = 5;
const OVERRIDE_POS = 'bottom-right';
const AREA_PCT = 0.25;
const OVERLAY_OPACITY = 0.55; // how strongly to brighten the corner (0-1)

function nextRunIndex(prefix) {
  const existing = fs.readdirSync(OUT_DIR).filter(f => f.startsWith(prefix + '_') && /_(\d{3})_/.test(f));
  const nums = existing.map(f => parseInt(f.match(/_(\d{3})_/)[1], 10)).filter(n => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return String(next).padStart(3, '0');
}
const RUN_ID = nextRunIndex('wh');
const out = (name) => path.join(OUT_DIR, `wh_${RUN_ID}_${name}`);

(async () => {
  const { loadPromptTemplates } = require('../../server/services/prompts');
  const { generateImageOnly } = require('../../server/lib/images');
  const { detectAndLightenTextRegion } = require('../../server/lib/textRegion');
  await loadPromptTemplates();

  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  const r = await pool.query(`
    SELECT scene FROM stories, jsonb_array_elements(data->'sceneImages') scene
    WHERE stories.id=$1 AND (scene->>'pageNumber')::int=$2
  `, [STORY_ID, PAGE]);
  const scene = r.rows[0].scene;
  const emptyR = await pool.query("SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='empty_scene' AND page_number=$2 AND version_index=0", [STORY_ID, PAGE]);
  await pool.end();

  const textPos = OVERRIDE_POS;
  const emptyBuf = Buffer.from(emptyR.rows[0].image_data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const meta = await sharp(emptyBuf).metadata();
  const W = meta.width, H = meta.height;

  // Build a feathered triangular white overlay at the calm corner.
  // Shape: right-triangle with its right-angle at the frame corner, legs = √(2·area)×dim.
  const scale = Math.sqrt(2 * AREA_PCT);
  const legW = Math.round(W * scale);
  const legH = Math.round(H * scale);
  const isTop = textPos.startsWith('top');
  const isLeft = textPos.includes('left');
  const cx = isLeft ? 0 : W;
  const cy = isTop ? 0 : H;
  const ax = isLeft ? legW : W - legW;
  const ay = cy;
  const bx = cx;
  const by = isTop ? legH : H - legH;
  const poly = `${cx},${cy} ${ax},${ay} ${bx},${by}`;
  const overlayAlpha = Math.round(OVERLAY_OPACITY * 255);

  // Render the triangle as a soft-edged white mask, then composite with alpha.
  const triMaskSvg = `<svg width="${W}" height="${H}"><polygon points="${poly}" fill="white"/></svg>`;
  const softMask = await sharp(Buffer.from(triMaskSvg)).blur(Math.round(Math.min(W,H) * 0.03)).toBuffer();
  // Pack as RGBA: R=255 G=255 B=255, A=softMask * opacity
  const { data: maskData, info: maskInfo } = await sharp(softMask).greyscale().raw().toBuffer({ resolveWithObject: true });
  const rgbaBuf = Buffer.alloc(maskInfo.width * maskInfo.height * 4);
  for (let i = 0; i < maskData.length; i++) {
    rgbaBuf[i*4] = 255;
    rgbaBuf[i*4+1] = 255;
    rgbaBuf[i*4+2] = 255;
    rgbaBuf[i*4+3] = Math.round((maskData[i] / 255) * overlayAlpha);
  }
  const overlayPng = await sharp(rgbaBuf, { raw: { width: maskInfo.width, height: maskInfo.height, channels: 4 } }).png().toBuffer();

  const sceneWithOverlay = await sharp(emptyBuf)
    .composite([{ input: overlayPng, top: 0, left: 0, blend: 'over' }])
    .jpeg({ quality: 92 })
    .toBuffer();
  fs.writeFileSync(out('input.jpg'), sceneWithOverlay);
  console.log('saved', path.basename(out('input.jpg')), `(overlay ${Math.round(OVERLAY_OPACITY * 100)}% white on ${textPos} corner)`);

  const linePrefix = `**TEXT-ZONE BRIGHTNESS (HIGHEST PRIORITY):**
The reference scene has a brightened triangular patch in the ${textPos.replace('-', '-')} corner. That patch is where story text will be printed over the image.
- PRESERVE that bright, soft, low-contrast look in your output — keep the ${textPos.replace('-', '-')} corner lighter and simpler than the rest of the scene.
- NO characters, NO major objects, NO action in that bright corner. Move all characters OUT of it.
- Continue the natural background (same ground, same sky) into the bright area, but softer and lighter than the surrounding scene.

---

`;
  let prompt = linePrefix + (scene.prompt || '');
  if (prompt.length > 7500) prompt = prompt.substring(0, 7500);
  console.log('prompt length:', prompt.length);

  const sceneDataUri = `data:image/jpeg;base64,${sceneWithOverlay.toString('base64')}`;
  console.log('calling Grok...');
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
  fs.writeFileSync(out('output.jpg'), Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  const detect = await detectAndLightenTextRegion(result.imageData, textPos, PAGE);
  console.log('run', RUN_ID, 'coverage:', (detect.score * 100).toFixed(1) + '%');
  console.log('output:', path.basename(out('output.jpg')));
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

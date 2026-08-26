// Draw a purple diagonal along the TRIANGLE mask's hypotenuse (no baked mask).
// Tests whether Grok respects the line boundary better with a triangle shape
// than with the rectangle-aligned L we tried before.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Pool } = require('pg');

const OUT_DIR = __dirname;
const STORY_ID = 'job_1776286048220_aj0q6y71p';
const PAGE = 5;
const OVERRIDE_POS = 'bottom-right';
const AREA_PCT = 0.25; // medium

// Auto-numbered output files — every run writes to a fresh sequence so no
// prior test result is overwritten. Counter survives across runs via filesystem.
function nextRunIndex(prefix) {
  const existing = fs.readdirSync(OUT_DIR).filter(f => f.startsWith(prefix + '_') && /_(\d{3})_/.test(f));
  const nums = existing.map(f => parseInt(f.match(/_(\d{3})_/)[1], 10)).filter(n => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return String(next).padStart(3, '0');
}
const RUN_ID = nextRunIndex('tri');
const out = (name) => path.join(OUT_DIR, `tri_${RUN_ID}_${name}`);

(async () => {
  process.chdir(path.resolve(__dirname, '../..'));
  const { loadPromptTemplates } = require('../../server/services/prompts');
  const { generateImageOnly } = require('../../server/lib/images');
  const { detectAndLightenTextRegion } = require('../../server/lib/textRegion');
  await loadPromptTemplates();

  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const d = await pool.query('SELECT data FROM stories WHERE id=$1', [STORY_ID]);
  const scene = d.rows[0].data.sceneImages.find(s => s.pageNumber === PAGE);
  const emptyR = await pool.query("SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='empty_scene' AND page_number=$2 AND version_index=0", [STORY_ID, PAGE]);
  await pool.end();

  const textPos = OVERRIDE_POS;
  const emptyBuf = Buffer.from(emptyR.rows[0].image_data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const meta = await sharp(emptyBuf).metadata();
  const W = meta.width, H = meta.height;

  // Triangle vertices for bottom-right corner with area = AREA_PCT × frame.
  // Leg scale = √(2 × area) so a right triangle hits that area.
  const scale = Math.sqrt(2 * AREA_PCT);
  const legW = Math.round(W * scale);
  const legH = Math.round(H * scale);
  const isTop = textPos.startsWith('top');
  const isLeft = textPos.includes('left');
  const cx = isLeft ? 0 : W;
  const cy = isTop ? 0 : H;
  const ax = isLeft ? legW : W - legW; // end of bottom/top edge leg
  const ay = cy;
  const bx = cx;
  const by = isTop ? legH : H - legH;  // end of side edge leg
  // Hypotenuse from (ax,ay) to (bx,by)
  console.log(`triangle corner=(${cx},${cy}) leg-end-A=(${ax},${ay}) leg-end-B=(${bx},${by})`);

  const thickness = Math.max(24, Math.round(Math.min(W, H) * 0.03));
  const svg = `<svg width="${W}" height="${H}">
    <line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#a020f0" stroke-width="${thickness}" stroke-linecap="round"/>
  </svg>`;
  const sceneWithLine = await sharp(emptyBuf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();
  fs.writeFileSync(out('input.jpg'), sceneWithLine);
  console.log('saved', path.basename(out('input.jpg')));

  const linePrefix = `**PURPLE LINE RULES (HIGHEST PRIORITY — READ BEFORE ANYTHING ELSE):**
1. A thick purple diagonal line is painted across the reference scene. It marks the boundary of a triangular calm zone in the BOTTOM-RIGHT corner.
2. ALL CHARACTERS must be placed on the UPPER-LEFT side of the purple line. No character body part (head, torso, feet, hands) may cross into the bottom-right triangle.
3. The bottom-right triangle (below/right of the purple line) must stay calm — soft continuation of the natural scene (cobblestones, ground, sky), no characters, no objects, no action.
4. The purple line MUST NOT appear in the output. Remove it.

---

`;
  let prompt = linePrefix + (scene.prompt || '');
  if (prompt.length > 7500) prompt = prompt.substring(0, 7500);
  console.log('prompt length:', prompt.length);

  const sceneDataUri = `data:image/jpeg;base64,${sceneWithLine.toString('base64')}`;
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
})().catch(e => { console.error('ERR:', e); process.exit(1); });

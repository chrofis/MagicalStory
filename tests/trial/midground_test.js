// Test the new COMPOSITION rules (midground size + foreground-empty).
// No mask, no purple line — pure prompt test. Empty scene + real page prompt.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Pool } = require('pg');

const OUT_DIR = __dirname;
const STORY_ID = 'job_1776286048220_aj0q6y71p';
const PAGE = 5;

function nextRunIndex(prefix) {
  const existing = fs.readdirSync(OUT_DIR).filter(f => f.startsWith(prefix + '_') && /_(\d{3})_/.test(f));
  const nums = existing.map(f => parseInt(f.match(/_(\d{3})_/)[1], 10)).filter(n => !isNaN(n));
  return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
}
const RUN_ID = nextRunIndex('mg');
const out = (name) => path.join(OUT_DIR, `mg_${RUN_ID}_${name}`);

(async () => {
  const { loadPromptTemplates, PROMPT_TEMPLATES, fillTemplate } = require('../../server/services/prompts');
  const { generateImageOnly } = require('../../server/lib/images');
  const { detectAndLightenTextRegion } = require('../../server/lib/textRegion');
  await loadPromptTemplates();

  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(`
    SELECT scene FROM stories, jsonb_array_elements(data->'sceneImages') scene
    WHERE stories.id=$1 AND (scene->>'pageNumber')::int=$2
  `, [STORY_ID, PAGE]);
  const scene = r.rows[0].scene;
  const emptyR = await pool.query("SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='empty_scene' AND page_number=$2 AND version_index=0", [STORY_ID, PAGE]);
  await pool.end();

  // The prompt we REBUILD using the updated image-generation.txt template.
  // We can't use scene.prompt as-is because it was generated with the old template.
  // Cheapest reliable way: take scene.prompt and replace the COMPOSITION block
  // with the new one from the template.
  const oldComposition = /\*\*COMPOSITION:\*\*[\s\S]*?(?=\n\n\{REQUIRED_OBJECTS\}|\n\n\*\*|$)/;
  const newTemplate = PROMPT_TEMPLATES.imageGeneration;
  const newCompBlock = (newTemplate.match(/\*\*COMPOSITION:\*\*[\s\S]*?(?=\n\n\{)/) || [''])[0];

  let prompt = scene.prompt || '';
  // Try to replace the COMPOSITION section in the stored prompt with the new one
  const compRe = /\*\*COMPOSITION:\*\*[\s\S]*?(?=\n\n\*\*[A-Z]|\n\n(?:REQUIRED|TEXT|ART))/;
  if (compRe.test(prompt)) {
    prompt = prompt.replace(compRe, newCompBlock + '\n\n');
    console.log('replaced COMPOSITION block (old+new lengths:', scene.prompt.length, '→', prompt.length + ')');
  } else {
    // Fallback — append new composition rules at the end
    prompt = prompt + '\n\n' + newCompBlock;
    console.log('appended new COMPOSITION block (prompt grew to', prompt.length, 'chars)');
  }
  if (prompt.length > 7500) prompt = prompt.substring(0, 7500);
  fs.writeFileSync(out('prompt.txt'), prompt);
  console.log('prompt saved, length:', prompt.length);

  const emptyBuf = Buffer.from(emptyR.rows[0].image_data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  fs.writeFileSync(out('input.jpg'), emptyBuf);

  const sceneDataUri = `data:image/jpeg;base64,${emptyBuf.toString('base64')}`;
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
  const detect = await detectAndLightenTextRegion(result.imageData, scene.textPosition || 'bottom-right', PAGE);
  console.log('run', RUN_ID, 'coverage:', (detect.score * 100).toFixed(1) + '%');
  console.log('saved:', path.basename(out('input.jpg')), '|', path.basename(out('output.jpg')));
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * Per-scene test harness for prompt/mask iteration.
 *
 * Fetches a specific story + page from the DB, caches everything we need
 * locally (scene prompt rebuilt with CURRENT templates, empty scene, all
 * character photos, landmark photos, VB grid, the mask), and runs Grok
 * with whichever variant you want. Outputs go into a per-scene folder
 * with auto-numbered run IDs so nothing overwrites.
 *
 * Usage
 * -----
 *   # Fetch + cache a scene's context (run once per scene):
 *   node scripts/test-scene.js fetch <storyId> <pageNum>
 *
 *   # Run Grok with options (cache must exist):
 *   node scripts/test-scene.js run <storyId> <pageNum> [options]
 *
 * Options
 *   --overlay <none|white|line-h|line-diag>   visual guide on the empty scene
 *   --mask <on|off>                            attach the text-area mask to Grok
 *   --prompt <path>                            use a custom prompt file instead
 *                                              of the template-built one
 *   --pos <top-left|top-right|top-full|bottom-*>  override textPosition
 *   --opacity <0.0-1.0>                        overlay opacity (default 0.55)
 *   --prefix <str>                             extra instruction prepended to prompt
 *
 * Examples
 *   node scripts/test-scene.js fetch job_177... 5
 *   node scripts/test-scene.js run job_177... 5 --overlay white --mask off
 *   node scripts/test-scene.js run job_177... 5 --overlay line-diag --pos bottom-right
 *   node scripts/test-scene.js run job_177... 5 --prompt ./my-prompt.txt
 *
 * Output layout
 *   tests/trial/<storyId>_p<page>/
 *     context.json       — cached scene data (no images)
 *     empty_scene.jpg    — background used as sceneBackground
 *     char_1_<name>.*    — each character's reference photo
 *     landmarks/         — landmark photos
 *     mask_<pos>.png     — the text-area mask for this page's textPosition
 *     prompt_base.txt    — the CURRENT production prompt rebuilt from templates
 *     runs/<NNN>_<tag>/  — per-run outputs
 *       input.jpg        — what went to Grok (scene maybe + overlay)
 *       output.jpg       — Grok's result
 *       prompt.txt       — exact prompt sent
 *       meta.json        — variant options + coverage score
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const TRIAL_DIR = path.join(ROOT, 'tests', 'trial');

// ─────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────
const [,, cmd, storyId, pageArg, ...rest] = process.argv;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
      flags[key] = val;
    }
  }
  return flags;
}

if (!cmd || !['fetch', 'run', 'help'].includes(cmd)) {
  die(`Usage:
  node scripts/test-scene.js fetch <storyId> <pageNum>
  node scripts/test-scene.js run <storyId> <pageNum> [options]

Run with "help" to see all options.`);
}

if (cmd === 'help') {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 45).join('\n'));
  process.exit(0);
}

if (!storyId || !pageArg) die('Missing <storyId> <pageNum>');
const pageNum = parseInt(pageArg, 10);
if (isNaN(pageNum)) die('<pageNum> must be a number');

const SCENE_DIR = path.join(TRIAL_DIR, `${storyId}_p${pageNum}`);
fs.mkdirSync(SCENE_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
}

function saveDataUri(dataUri, baseName) {
  if (!dataUri || !dataUri.startsWith('data:image')) return null;
  const b64 = dataUri.replace(/^data:image\/\w+;base64,/, '');
  const ext = dataUri.match(/^data:image\/(\w+)/)?.[1] || 'jpg';
  const file = path.join(SCENE_DIR, `${baseName}.${ext}`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

function nextRunIndex() {
  const runsDir = path.join(SCENE_DIR, 'runs');
  if (!fs.existsSync(runsDir)) return '001';
  const existing = fs.readdirSync(runsDir).map(f => parseInt(f.slice(0, 3), 10)).filter(n => !isNaN(n));
  return String((existing.length ? Math.max(...existing) : 0) + 1).padStart(3, '0');
}

// ─────────────────────────────────────────────────────────────────────
// FETCH — pull story/page data and cache it
// ─────────────────────────────────────────────────────────────────────
async function doFetch() {
  console.log(`Fetching ${storyId} P${pageNum}...`);
  const pool = makePool();
  const t0 = Date.now();

  // Targeted query: just the scene we want + the story's languageLevel.
  const r = await pool.query(`
    SELECT
      (scene)::text as scene_text,
      data->>'languageLevel' as language_level,
      data->>'language' as language,
      data->>'artStyle' as art_style
    FROM stories, jsonb_array_elements(data->'sceneImages') scene
    WHERE stories.id=$1 AND (scene->>'pageNumber')::int=$2
  `, [storyId, pageNum]);

  if (r.rows.length === 0) {
    await pool.end();
    die(`No scene found for story=${storyId} page=${pageNum}`);
  }

  const scene = JSON.parse(r.rows[0].scene_text);
  const languageLevel = r.rows[0].language_level || 'standard';
  const language = r.rows[0].language || 'de';
  const artStyle = r.rows[0].art_style || 'pixar';

  // Empty scene — primary: story_images table (any version)
  const emptyR = await pool.query(
    "SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='empty_scene' AND page_number=$2 ORDER BY version_index LIMIT 1",
    [storyId, pageNum]
  );
  // Fallback: emptySceneImage field still in JSONB (older pipeline, not yet stripped)
  let emptyJsonR = null;
  if (!emptyR.rows[0]) {
    emptyJsonR = await pool.query(`
      SELECT scene->>'emptySceneImage' as img
      FROM stories, jsonb_array_elements(data->'sceneImages') scene
      WHERE stories.id=$1 AND (scene->>'pageNumber')::int=$2
    `, [storyId, pageNum]);
  }
  console.log(`fetched in ${Date.now() - t0}ms`);
  await pool.end();

  // Save scene metadata (no image data) to context.json
  const context = {
    storyId,
    pageNum,
    languageLevel,
    language,
    artStyle,
    textPosition: scene.textPosition,
    sceneDescription: scene.sceneDescription,
    sceneText: scene.text,
    sceneMetadata: scene.sceneMetadata,
    storedPrompt: scene.prompt, // the stored production prompt (may be stale)
    characterCount: (scene.referencePhotos || []).length,
    landmarkCount: (scene.landmarkPhotos || []).length,
    hasVbGrid: !!scene.visualBibleGrid,
    fetchedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(SCENE_DIR, 'context.json'), JSON.stringify(context, null, 2));

  // Empty scene — save raw + bake white overlay
  const emptyImageData = emptyR.rows[0]?.image_data || emptyJsonR?.rows[0]?.img || null;
  if (emptyImageData) {
    const src = emptyR.rows[0] ? 'story_images' : 'scene JSONB';
    const emptyB64 = emptyImageData.replace(/^data:image\/\w+;base64,/, '');
    const emptyBuf = Buffer.from(emptyB64, 'base64');
    fs.writeFileSync(path.join(SCENE_DIR, 'empty_scene.jpg'), emptyBuf);
    console.log(`saved empty_scene.jpg (from ${src})`);
    // Pre-bake white overlay so runs can always send it to Grok without extra flags
    const meta = await sharp(emptyBuf).metadata();
    const overlaidBuf = await applyOverlay(emptyBuf, meta.width, meta.height, scene.textPosition || 'top-left', 'white', 0.55);
    fs.writeFileSync(path.join(SCENE_DIR, 'empty_scene_overlay.jpg'), overlaidBuf);
    console.log('saved empty_scene_overlay.jpg (white overlay baked in)');
  } else {
    console.log('(no empty scene found — using first landmark as background fallback)');
    // Fallback: first landmark photo as scene background
    const firstLandmark = (scene.landmarkPhotos || [])[0];
    if (firstLandmark?.photoData) {
      const lmB64 = firstLandmark.photoData.replace(/^data:image\/\w+;base64,/, '');
      const lmBuf = Buffer.from(lmB64, 'base64');
      fs.writeFileSync(path.join(SCENE_DIR, 'empty_scene.jpg'), lmBuf);
      console.log('saved empty_scene.jpg (from landmark: ' + firstLandmark.name + ')');
      const lmMeta = await sharp(lmBuf).metadata();
      const overlaidBuf = await applyOverlay(lmBuf, lmMeta.width, lmMeta.height, scene.textPosition || 'top-left', 'white', 0.55);
      fs.writeFileSync(path.join(SCENE_DIR, 'empty_scene_overlay.jpg'), overlaidBuf);
      console.log('saved empty_scene_overlay.jpg (white overlay baked in)');
    }
  }

  // Character photos
  const refs = scene.referencePhotos || [];
  const charDir = path.join(SCENE_DIR, 'characters');
  fs.mkdirSync(charDir, { recursive: true });
  for (let i = 0; i < refs.length; i++) {
    const p = refs[i];
    const url = p.photoUrl || p.photoData;
    const tag = `${p.name || 'char'}-${p.photoType || 'main'}`.replace(/[^a-z0-9_-]/gi, '_');
    const saved = saveDataUri(url, path.join('characters', `${i + 1}_${tag}`));
    if (saved) console.log('saved character:', path.basename(saved));
  }
  // Also save a ref-metadata file (names, photoTypes, clothingDescription) so we can reconstruct photo refs later
  fs.writeFileSync(path.join(SCENE_DIR, 'characters', '_meta.json'), JSON.stringify(refs.map(r => ({
    name: r.name, photoType: r.photoType, clothingCategory: r.clothingCategory,
    clothingDescription: r.clothingDescription, description: r.description,
  })), null, 2));

  // Landmark photos
  const landmarks = scene.landmarkPhotos || [];
  const lmDir = path.join(SCENE_DIR, 'landmarks');
  fs.mkdirSync(lmDir, { recursive: true });
  for (let i = 0; i < landmarks.length; i++) {
    const saved = saveDataUri(landmarks[i].photoData, path.join('landmarks', `${i + 1}_${(landmarks[i].name || 'lm').replace(/[^a-z0-9_-]/gi, '_')}`));
    if (saved) console.log('saved landmark:', path.basename(saved));
  }
  fs.writeFileSync(path.join(lmDir, '_meta.json'), JSON.stringify(landmarks.map(l => ({
    name: l.name, attribution: l.attribution, source: l.source,
  })), null, 2));

  // VB grid
  if (scene.visualBibleGrid) saveDataUri(scene.visualBibleGrid, 'vb_grid');

  // Mask for this page's textPosition
  const { getTextAreaMask } = require(path.join(ROOT, 'server/lib/textMasks'));
  const maskUri = getTextAreaMask(scene.textPosition || 'top-left', languageLevel);
  if (maskUri) {
    saveDataUri(maskUri, `mask_${scene.textPosition || 'top-left'}_${languageLevel}`);
  }

  // Rebuild the prompt using the CURRENT production templates
  console.log('\nrebuilding prompt from CURRENT templates...');
  const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const { buildImagePrompt } = require(path.join(ROOT, 'server/lib/storyHelpers'));
  try {
    // buildImagePrompt signature:
    // (sceneDescription, inputData, sceneCharacters, visualBible,
    //  pageNumber, referencePhotos, options)
    const inputData = { artStyle, language, ageFrom: 3, ageTo: 8, languageLevel };
    const rebuilt = buildImagePrompt(
      scene.sceneDescription,
      inputData,
      scene.sceneCharacters || null,
      null,                   // visualBible
      pageNum,
      scene.referencePhotos || null,
      { textPosition: scene.textPosition }
    );
    fs.writeFileSync(path.join(SCENE_DIR, 'prompt_rebuilt.txt'), rebuilt);
    console.log('saved prompt_rebuilt.txt (', rebuilt.length, 'chars) — artStyle=' + artStyle);
  } catch (e) {
    console.warn('buildImagePrompt failed:', e.message, '— will fall back to stored prompt at run time');
  }
  fs.writeFileSync(path.join(SCENE_DIR, 'prompt_stored.txt'), scene.prompt || '');
  console.log('saved prompt_stored.txt (stale, for reference)');

  console.log(`\n✅ Scene cache ready: ${SCENE_DIR}`);
  console.log(`Next:  node scripts/test-scene.js run ${storyId} ${pageNum} [--overlay white] [--mask on]`);
}

// ─────────────────────────────────────────────────────────────────────
// RUN — use cached data, apply variant, send to Grok
// ─────────────────────────────────────────────────────────────────────
async function doRun() {
  const flags = parseFlags(rest);
  const overlay = flags.overlay || 'white';  // default: white overlay (unified); none | white | line-h | line-diag
  const maskOn = flags.mask === 'on';
  const promptFile = flags.prompt || null;
  const opacity = parseFloat(flags.opacity || '0.55');
  const posOverride = flags.pos || null;
  const extraPrefix = flags.prefix || '';

  if (!fs.existsSync(path.join(SCENE_DIR, 'context.json'))) {
    die(`No cache for this scene. Run first:  node scripts/test-scene.js fetch ${storyId} ${pageNum}`);
  }
  const context = JSON.parse(fs.readFileSync(path.join(SCENE_DIR, 'context.json'), 'utf8'));
  const textPos = posOverride || context.textPosition || 'top-left';
  console.log(`Scene: P${context.pageNum}, textPos=${textPos}, chars=${context.characterCount}, overlay=${overlay}, mask=${maskOn ? 'on' : 'off'}`);

  // Load empty scene — prefer pre-overlaid version (baked during fetch)
  const overlayPrebuilt = path.join(SCENE_DIR, 'empty_scene_overlay.jpg');
  const rawEmpty = path.join(SCENE_DIR, 'empty_scene.jpg');
  let emptyBuf = null, sceneDataUri = null;
  if (overlay === 'none') {
    // Explicit none: use raw (no overlay)
    if (fs.existsSync(rawEmpty)) {
      emptyBuf = fs.readFileSync(rawEmpty);
      console.log('using raw empty_scene (overlay=none)');
    }
  } else if (overlay === 'white' && fs.existsSync(overlayPrebuilt)) {
    // Default unified path: use the pre-baked overlay from fetch
    emptyBuf = fs.readFileSync(overlayPrebuilt);
    console.log('using pre-baked empty_scene_overlay.jpg');
  } else if (fs.existsSync(rawEmpty)) {
    // Other overlay types or overlay requested but no prebuilt
    emptyBuf = fs.readFileSync(rawEmpty);
    const meta = await sharp(emptyBuf).metadata();
    emptyBuf = await applyOverlay(emptyBuf, meta.width, meta.height, textPos, overlay, opacity);
    console.log(`applied ${overlay} overlay at runtime`);
  } else {
    console.log('(no empty_scene cached — running without sceneBackground)');
  }
  if (emptyBuf) {
    sceneDataUri = `data:image/jpeg;base64,${emptyBuf.toString('base64')}`;
  }

  // Rebuild the production reference photos list from disk
  const refsDir = path.join(SCENE_DIR, 'characters');
  const charMeta = JSON.parse(fs.readFileSync(path.join(refsDir, '_meta.json'), 'utf8'));
  const referencePhotos = charMeta.map((m, i) => {
    const files = fs.readdirSync(refsDir).filter(f => f.startsWith(`${i + 1}_`) && !f.endsWith('.json'));
    if (!files.length) return null;
    const buf = fs.readFileSync(path.join(refsDir, files[0]));
    const ext = path.extname(files[0]).slice(1);
    return {
      name: m.name,
      photoType: m.photoType,
      clothingCategory: m.clothingCategory,
      clothingDescription: m.clothingDescription,
      description: m.description,
      photoUrl: `data:image/${ext};base64,${buf.toString('base64')}`,
    };
  }).filter(Boolean);
  console.log(`loaded ${referencePhotos.length} character photos from cache`);

  // Landmark photos
  const lmDir = path.join(SCENE_DIR, 'landmarks');
  let landmarkPhotos = [];
  if (fs.existsSync(path.join(lmDir, '_meta.json'))) {
    const lmMeta = JSON.parse(fs.readFileSync(path.join(lmDir, '_meta.json'), 'utf8'));
    landmarkPhotos = lmMeta.map((m, i) => {
      const files = fs.readdirSync(lmDir).filter(f => f.startsWith(`${i + 1}_`) && !f.endsWith('.json'));
      if (!files.length) return null;
      const buf = fs.readFileSync(path.join(lmDir, files[0]));
      return { name: m.name, photoData: `data:image/jpeg;base64,${buf.toString('base64')}` };
    }).filter(Boolean);
  }

  // Build prompt: custom file > rebuilt from templates > stored (as last resort)
  let prompt;
  if (promptFile) {
    prompt = fs.readFileSync(promptFile, 'utf8');
    console.log(`using custom prompt from ${promptFile} (${prompt.length} chars)`);
  } else if (fs.existsSync(path.join(SCENE_DIR, 'prompt_rebuilt.txt'))) {
    prompt = fs.readFileSync(path.join(SCENE_DIR, 'prompt_rebuilt.txt'), 'utf8');
    console.log(`using CURRENT-template rebuilt prompt (${prompt.length} chars)`);
  } else {
    prompt = fs.readFileSync(path.join(SCENE_DIR, 'prompt_stored.txt'), 'utf8');
    console.log(`⚠ using STORED prompt (may be stale) (${prompt.length} chars)`);
  }
  if (extraPrefix) prompt = extraPrefix + '\n\n---\n\n' + prompt;
  if (prompt.length > 7500) { prompt = prompt.substring(0, 7500); console.log('prompt truncated to 7500'); }

  // Mask
  let maskUri = null;
  if (maskOn) {
    const maskFiles = fs.readdirSync(SCENE_DIR).filter(f => f.startsWith('mask_') && f.endsWith('.png'));
    if (maskFiles.length) {
      const mbuf = fs.readFileSync(path.join(SCENE_DIR, maskFiles[0]));
      maskUri = `data:image/png;base64,${mbuf.toString('base64')}`;
      console.log('attaching mask:', maskFiles[0]);
    }
  }

  // Run output dir
  const runId = nextRunIndex();
  const tag = [overlay, maskOn ? 'mask' : 'nomask', posOverride ? `pos-${posOverride}` : ''].filter(Boolean).join('_');
  const runDir = path.join(SCENE_DIR, 'runs', `${runId}_${tag}`);
  fs.mkdirSync(runDir, { recursive: true });

  if (emptyBuf) fs.writeFileSync(path.join(runDir, 'input.jpg'), emptyBuf);
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt);

  // Call Grok via the same code path production uses
  const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const { generateImageOnly } = require(path.join(ROOT, 'server/lib/images'));
  const { detectAndLightenTextRegion } = require(path.join(ROOT, 'server/lib/textRegion'));

  console.log('calling Grok...');
  const t0 = Date.now();
  const result = await generateImageOnly(prompt, referencePhotos, {
    imageBackendOverride: 'grok',
    landmarkPhotos,
    visualBibleGrid: null,
    sceneBackground: sceneDataUri,
    textAreaMask: maskUri,
    pageNumber: pageNum,
    skipCache: true,
    aspectRatio: '3:4',
  });
  const elapsed = Date.now() - t0;
  if (!result?.imageData) { console.error('no image returned'); process.exit(1); }

  fs.writeFileSync(path.join(runDir, 'output.jpg'), Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  const detect = await detectAndLightenTextRegion(result.imageData, textPos, pageNum);
  const coverage = (detect.score * 100);

  const runMeta = { runId, tag, overlay, maskOn, posOverride, opacity, extraPrefix: extraPrefix || null, elapsedMs: elapsed, modelId: result.modelId, coveragePct: Number(coverage.toFixed(1)), textPos, detectedPos: detect.position };
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(runMeta, null, 2));

  console.log(`\n✅ run ${runId} done in ${(elapsed / 1000).toFixed(1)}s, coverage ${coverage.toFixed(1)}%`);
  console.log(`   → ${path.relative(ROOT, runDir)}/`);
}

// ─────────────────────────────────────────────────────────────────────
// OVERLAY painters
// ─────────────────────────────────────────────────────────────────────
async function applyOverlay(buf, W, H, textPos, kind, opacity) {
  const { getTextAreaMask } = require(path.join(ROOT, 'server/lib/textMasks'));
  const isTop = textPos.startsWith('top');
  const isLeft = textPos.includes('left');
  const isFull = textPos.includes('full');

  // Find the mask's white-zone boundary so overlays line up with production masks
  const context = JSON.parse(fs.readFileSync(path.join(SCENE_DIR, 'context.json'), 'utf8'));
  const langLevel = context.languageLevel || 'standard';
  const maskUri = getTextAreaMask(textPos, langLevel);
  const maskRaw = await sharp(Buffer.from(maskUri.replace(/^data:image\/\w+;base64,/, ''), 'base64')).greyscale().raw().toBuffer({ resolveWithObject: true });
  let firstWhiteY = -1, firstWhiteX = -1, lastWhiteX = -1;
  for (let y = 0; y < maskRaw.info.height && firstWhiteY === -1; y++)
    for (let x = 0; x < maskRaw.info.width; x++)
      if (maskRaw.data[y * maskRaw.info.width + x] > 200) { firstWhiteY = y; break; }
  for (let x = 0; x < maskRaw.info.width; x++) {
    for (let y = 0; y < maskRaw.info.height; y++) {
      if (maskRaw.data[y * maskRaw.info.width + x] > 200) {
        if (firstWhiteX === -1) firstWhiteX = x;
        lastWhiteX = x;
        break;
      }
    }
  }
  const lineY = Math.round(H * (firstWhiteY / maskRaw.info.height));
  const thickness = Math.max(24, Math.round(Math.min(W, H) * 0.03));

  if (kind === 'white') {
    // Triangular (or strip) white wash shaped like the mask's white zone
    const scale = Math.sqrt(2 * 0.25);
    const legW = Math.round(W * scale);
    const legH = Math.round(H * scale);
    const cx = isLeft ? 0 : W;
    const cy = isTop ? 0 : H;
    const ax = isLeft ? legW : W - legW;
    const ay = cy;
    const bx = cx;
    const by = isTop ? legH : H - legH;
    const poly = isFull
      ? (isTop ? `0,0 ${W},0 ${W},${Math.round(H*0.25)} 0,${Math.round(H*0.25)}`
               : `0,${H-Math.round(H*0.25)} ${W},${H-Math.round(H*0.25)} ${W},${H} 0,${H}`)
      : `${cx},${cy} ${ax},${ay} ${bx},${by}`;
    const svg = `<svg width="${W}" height="${H}"><polygon points="${poly}" fill="white"/></svg>`;
    const softMask = await sharp(Buffer.from(svg)).blur(Math.round(Math.min(W,H) * 0.03)).toBuffer();
    const { data, info } = await sharp(softMask).greyscale().raw().toBuffer({ resolveWithObject: true });
    const rgba = Buffer.alloc(info.width * info.height * 4);
    for (let i = 0; i < data.length; i++) {
      rgba[i*4] = 255; rgba[i*4+1] = 255; rgba[i*4+2] = 255;
      rgba[i*4+3] = Math.round((data[i] / 255) * opacity * 255);
    }
    const overlayPng = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    return sharp(buf).composite([{ input: overlayPng, top: 0, left: 0, blend: 'over' }]).jpeg({ quality: 92 }).toBuffer();
  }

  if (kind === 'line-h') {
    // Horizontal purple line at mask's white-zone top edge
    const svg = `<svg width="${W}" height="${H}"><rect x="0" y="${lineY - Math.floor(thickness/2)}" width="${W}" height="${thickness}" fill="#a020f0"/></svg>`;
    return sharp(buf).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
  }

  if (kind === 'line-diag') {
    // Diagonal purple line along the triangle hypotenuse
    const scale = Math.sqrt(2 * 0.25);
    const legW = Math.round(W * scale), legH = Math.round(H * scale);
    const cx = isLeft ? 0 : W, cy = isTop ? 0 : H;
    const ax = isLeft ? legW : W - legW, ay = cy;
    const bx = cx, by = isTop ? legH : H - legH;
    const svg = `<svg width="${W}" height="${H}"><line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#a020f0" stroke-width="${thickness}" stroke-linecap="round"/></svg>`;
    return sharp(buf).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
  }

  return buf;
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────
(async () => {
  if (cmd === 'fetch') await doFetch();
  else if (cmd === 'run') await doRun();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.stack || e.message); process.exit(1); });

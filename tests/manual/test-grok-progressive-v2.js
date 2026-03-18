/**
 * Test: Progressive character placement with Grok Imagine (v2)
 *
 * Step 1: Generate scene with 3 characters + 8 numbered ghost placeholders
 *         Ghosts 1-4 on left, ghosts 5-8 on right
 * Step 2: Pass result image + 2 ref images (2 chars each) → fill ghosts 1-4
 * Step 3: Pass result image + 2 ref images (2 chars each) → fill ghosts 5-8
 *
 * Reference images: 2 character grids stitched SIDE BY SIDE (full height preserved)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_API_URL = 'https://api.x.ai/v1';

if (!XAI_API_KEY) {
  console.error('XAI_API_KEY not set');
  process.exit(1);
}

const CHAR_DIR = path.join(__dirname, '..', 'fixtures', 'characters');
const OUT_DIR = path.join(__dirname, '..', 'fixtures', 'grok-char-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Characters split into groups
const INITIAL_3 = ['Lukas.jpg', 'Manuel.jpg', 'Sophie.jpg'];
const LEFT_PAIR_A = ['Franziska.jpg', 'Roger.jpg'];     // Ghosts 1-2
const LEFT_PAIR_B = ['Werner.jpg', 'Uschi.jpg'];         // Ghosts 3-4
const RIGHT_PAIR_A = ['Verena.jpg', 'Köbi.jpg'];         // Ghosts 5-6
const RIGHT_PAIR_B = ['Marcel.jpg', 'Lukas.jpg'];        // Ghosts 7-8 (Lukas again as test)

const INITIAL_NAMES = [
  'Lukas (boy ~8, blue striped hoodie)',
  'Manuel (boy ~12, dark sweater with tree print)',
  'Sophie (girl ~11, burgundy jacket, floral skirt)'
];
const LEFT_NAMES = [
  'Franziska (woman ~40, floral navy dress)',
  'Roger (man ~45, glasses, grey zip hoodie)',
  'Werner (man ~70, salmon polo shirt)',
  'Uschi (woman ~65, green v-neck sweater, necklace)'
];
const RIGHT_NAMES = [
  'Verena (woman ~40, brown straight hair)',
  'Köbi (man ~45, green-black plaid sweater)',
  'Marcel (man ~50, dark hair)',
  'Extra guest (boy, blue striped hoodie)'
];

async function loadImage(filename) {
  return fs.readFileSync(path.join(CHAR_DIR, filename));
}

/**
 * Stitch 2 images side by side, preserving full height.
 * Returns a data URI.
 */
async function stitchSideBySide(buf1, buf2, targetHeight = 768) {
  const img1 = sharp(buf1).resize({ height: targetHeight, withoutEnlargement: true });
  const img2 = sharp(buf2).resize({ height: targetHeight, withoutEnlargement: true });

  const meta1 = await img1.toBuffer({ resolveWithObject: true });
  const meta2 = await img2.toBuffer({ resolveWithObject: true });

  const gap = 8;
  const totalWidth = meta1.info.width + gap + meta2.info.width;

  const stitched = await sharp({
    create: { width: totalWidth, height: targetHeight, channels: 3, background: { r: 255, g: 255, b: 255 } }
  }).composite([
    { input: meta1.data, left: 0, top: 0 },
    { input: meta2.data, left: meta1.info.width + gap, top: 0 }
  ]).jpeg({ quality: 90 }).toBuffer();

  return `data:image/jpeg;base64,${stitched.toString('base64')}`;
}

async function grokEdit(prompt, referenceImages) {
  const body = {
    model: 'grok-imagine-image',
    prompt,
    response_format: 'b64_json',
    aspect_ratio: '16:9',
  };

  if (referenceImages.length === 1) {
    body.image = { url: referenceImages[0], type: 'image_url' };
  } else {
    body.images = referenceImages.map(url => ({ url, type: 'image_url' }));
  }

  const start = Date.now();
  console.log(`  Sending to Grok (${referenceImages.length} refs, prompt: ${prompt.length} chars)...`);
  const response = await fetch(`${XAI_API_URL}/images/edits`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Grok API error ${response.status}: ${err.substring(0, 300)}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - start;
  console.log(`  Done in ${elapsed}ms ($0.02)`);

  return `data:image/jpeg;base64,${data.data[0].b64_json}`;
}

function saveImage(dataUri, filename) {
  const base64 = dataUri.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(path.join(OUT_DIR, filename), Buffer.from(base64, 'base64'));
  console.log(`  Saved: ${filename}`);
}

async function runTest() {
  console.log('Loading character images...');

  // Load raw buffers
  const initial = [];
  for (const f of INITIAL_3) initial.push(await loadImage(f));
  const leftA = [await loadImage(LEFT_PAIR_A[0]), await loadImage(LEFT_PAIR_A[1])];
  const leftB = [await loadImage(LEFT_PAIR_B[0]), await loadImage(LEFT_PAIR_B[1])];
  const rightA = [await loadImage(RIGHT_PAIR_A[0]), await loadImage(RIGHT_PAIR_A[1])];
  const rightB = [await loadImage(RIGHT_PAIR_B[0]), await loadImage(RIGHT_PAIR_B[1])];

  // ============================================================
  // PREPARE: Stitch reference pairs and save for inspection
  // ============================================================
  console.log('\nPreparing reference images (2 chars side by side)...');

  const refLeftA = await stitchSideBySide(leftA[0], leftA[1]);
  saveImage(refLeftA, 'v2_ref_left_1-2_franziska_roger.jpg');

  const refLeftB = await stitchSideBySide(leftB[0], leftB[1]);
  saveImage(refLeftB, 'v2_ref_left_3-4_werner_uschi.jpg');

  const refRightA = await stitchSideBySide(rightA[0], rightA[1]);
  saveImage(refRightA, 'v2_ref_right_5-6_verena_kobi.jpg');

  const refRightB = await stitchSideBySide(rightB[0], rightB[1]);
  saveImage(refRightB, 'v2_ref_right_7-8_marcel_lukas.jpg');

  console.log('\n✅ Reference images saved. Check them before continuing.');
  console.log('Press Enter to continue with Grok calls, or Ctrl+C to abort...');

  // Wait for user confirmation
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  // ============================================================
  // STEP 1: 3 characters + 8 numbered ghost placeholders
  // ============================================================
  console.log('\n═══════════════════════════════════════════════');
  console.log('STEP 1: 3 characters + 8 numbered ghosts');
  console.log('═══════════════════════════════════════════════');

  // Load initial 3 as data URIs
  const initialUris = initial.map(buf => `data:image/jpeg;base64,${buf.toString('base64')}`);

  const step1Prompt = `Generate a SINGLE watercolor illustration. Soft brushstrokes, wet-on-wet technique, visible paper texture.

SCENE: A large rectangular wooden dinner table in a warm cozy dining room. Candlelight. Wide 16:9 view showing the full table from front.

Around the table are 11 seats:

CENTER (back of table, facing camera): 3 REAL people from reference photos:
  - ${INITIAL_NAMES[0]} (center)
  - ${INITIAL_NAMES[1]} (center-left)
  - ${INITIAL_NAMES[2]} (center-right)

LEFT side of table (4 numbered ghost placeholders):
  - Ghost #1 (closest to front-left)
  - Ghost #2
  - Ghost #3
  - Ghost #4 (closest to back-left)

RIGHT side of table (4 numbered ghost placeholders):
  - Ghost #5 (closest to front-right)
  - Ghost #6
  - Ghost #7
  - Ghost #8 (closest to back-right)

IMPORTANT:
- The 3 center people must match reference photos exactly (face, clothing, age)
- The 8 ghosts are translucent grey-blue silhouettes with their NUMBER (1-8) clearly visible above each
- Ghosts should be seated in chairs, human-shaped but transparent and featureless`;

  console.log('Generating step 1...');
  const step1Result = await grokEdit(step1Prompt, initialUris);
  saveImage(step1Result, 'v2_step1_3chars_8ghosts.jpg');

  // ============================================================
  // STEP 2: Fill ghosts 1-4 (left side)
  // ============================================================
  console.log('\n═══════════════════════════════════════════════');
  console.log('STEP 2: Replace ghosts 1-4 (left side)');
  console.log('═══════════════════════════════════════════════');

  const step2Prompt = `Image 1 is the current scene. Keep ALL existing real people exactly as they are. Keep ghosts 5-8 on the right unchanged.

Replace the 4 ghost silhouettes on the LEFT side (ghosts #1-#4) with real characters from the reference images:

Image 2 shows 2 people side by side:
  - LEFT person in Image 2 → replace Ghost #1: ${LEFT_NAMES[0]}
  - RIGHT person in Image 2 → replace Ghost #2: ${LEFT_NAMES[1]}

Image 3 shows 2 people side by side:
  - LEFT person in Image 3 → replace Ghost #3: ${LEFT_NAMES[2]}
  - RIGHT person in Image 3 → replace Ghost #4: ${LEFT_NAMES[3]}

Match each character's face, clothing, and age from their reference. Keep watercolor style consistent with the scene.`;

  console.log('Generating step 2...');
  const step2Result = await grokEdit(step2Prompt, [step1Result, refLeftA, refLeftB]);
  saveImage(step2Result, 'v2_step2_7chars_4ghosts.jpg');

  // ============================================================
  // STEP 3: Fill ghosts 5-8 (right side)
  // ============================================================
  console.log('\n═══════════════════════════════════════════════');
  console.log('STEP 3: Replace ghosts 5-8 (right side)');
  console.log('═══════════════════════════════════════════════');

  const step3Prompt = `Image 1 is the current scene. Keep ALL existing real people exactly as they are (all 7 people on center and left).

Replace the 4 remaining ghost silhouettes on the RIGHT side (ghosts #5-#8) with real characters from the reference images:

Image 2 shows 2 people side by side:
  - LEFT person in Image 2 → replace Ghost #5: ${RIGHT_NAMES[0]}
  - RIGHT person in Image 2 → replace Ghost #6: ${RIGHT_NAMES[1]}

Image 3 shows 2 people side by side:
  - LEFT person in Image 3 → replace Ghost #7: ${RIGHT_NAMES[2]}
  - RIGHT person in Image 3 → replace Ghost #8: ${RIGHT_NAMES[3]}

Match each character's face, clothing, and age from their reference. Keep watercolor style consistent. All ghosts should now be replaced with real people.`;

  console.log('Generating step 3...');
  const step3Result = await grokEdit(step3Prompt, [step2Result, refRightA, refRightB]);
  saveImage(step3Result, 'v2_step3_11chars_final.jpg');

  console.log('\n═══════════════════════════════════════════════');
  console.log('DONE! Results in tests/fixtures/grok-char-test/');
  console.log('  v2_step1_3chars_8ghosts.jpg');
  console.log('  v2_step2_7chars_4ghosts.jpg');
  console.log('  v2_step3_11chars_final.jpg');
  console.log('  Total cost: $0.06 (3 Grok edits)');
  console.log('═══════════════════════════════════════════════');

  process.exit(0);
}

runTest().catch(e => { console.error('Test failed:', e); process.exit(1); });

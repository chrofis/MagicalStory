/**
 * Test: Progressive character placement with Grok Imagine
 *
 * Step 1: Generate scene with 3 characters + 8 ghost placeholders (4 left, 4 right)
 * Step 2: Pass result + 4 new character refs → fill the 4 left ghost spots
 * Step 3: Pass result + 4 new character refs → fill the 4 right ghost spots
 *
 * Uses body-front crops from the 2x2 grids for cleaner references.
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

// All 11 characters (3 initial + 4 left + 4 right)
const INITIAL_3 = ['Lukas.jpg', 'Manuel.jpg', 'Sophie.jpg'];
const LEFT_4 = ['Franziska.jpg', 'Roger.jpg', 'Werner.jpg', 'Uschi.jpg'];
const RIGHT_4 = ['Verena.jpg', 'Köbi.jpg', 'Marcel.jpg', 'Lukas.jpg']; // Lukas again as 11th

const INITIAL_NAMES = ['Lukas (boy ~8, blue striped hoodie)', 'Manuel (boy ~12, dark sweater)', 'Sophie (girl ~11, burgundy jacket)'];
const LEFT_NAMES = ['Franziska (woman ~40, floral dress)', 'Roger (man ~45, glasses, grey hoodie)', 'Werner (man ~70, salmon polo)', 'Uschi (woman ~65, green v-neck)'];
const RIGHT_NAMES = ['Verena (woman ~40, brown hair)', 'Köbi (man ~45, green plaid sweater)', 'Marcel (man ~50, dark hair)', 'Lukas again (boy ~8, different angle)'];

async function loadImage(filename) {
  const buf = fs.readFileSync(path.join(CHAR_DIR, filename));
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function stitch2x2(dataUris, targetSize = 768) {
  // Arrange up to 4 images in a 2x2 grid
  const buffers = [];
  for (const uri of dataUris) {
    const base64 = uri.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    // Resize each to half the target
    const half = Math.floor(targetSize / 2);
    const resized = await sharp(buf)
      .resize(half, half, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();
    buffers.push(resized);
  }

  const half = Math.floor(targetSize / 2);
  const composites = [];
  const positions = [[0, 0], [half, 0], [0, half], [half, half]];
  for (let i = 0; i < buffers.length && i < 4; i++) {
    composites.push({ input: buffers[i], left: positions[i][0], top: positions[i][1] });
  }

  const grid = await sharp({
    create: { width: targetSize, height: targetSize, channels: 3, background: { r: 255, g: 255, b: 255 } }
  }).composite(composites).jpeg({ quality: 90 }).toBuffer();

  return `data:image/jpeg;base64,${grid.toString('base64')}`;
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
  console.log('Loading character images...\n');

  // Load all images
  const initial = [];
  for (const f of INITIAL_3) initial.push(await loadImage(f));
  const left = [];
  for (const f of LEFT_4) left.push(await loadImage(f));
  const right = [];
  for (const f of RIGHT_4) right.push(await loadImage(f));

  // ============================================================
  // STEP 1: 3 characters + 8 ghost placeholders
  // ============================================================
  console.log('═══════════════════════════════════════════════');
  console.log('STEP 1: 3 characters + 8 ghost silhouettes');
  console.log('═══════════════════════════════════════════════');

  const step1Prompt = `Generate a SINGLE watercolor illustration. Soft brushstrokes, wet-on-wet technique, visible paper texture, delicate washes.

SCENE: A large rectangular wooden dinner table in a warm, cozy dining room. Warm candlelight. Wide angle view showing the full table.

Around the table are 11 seats total:
- CENTER back: 3 real people (match the reference photos exactly)
  1. ${INITIAL_NAMES[0]} - sitting center-back
  2. ${INITIAL_NAMES[1]} - sitting center-back left
  3. ${INITIAL_NAMES[2]} - sitting center-back right

- LEFT side of table: 4 GHOST silhouettes (translucent grey-blue figures, no facial features, like empty placeholder spirits waiting to be filled). Label them "?" above each.

- RIGHT side of table: 4 GHOST silhouettes (same translucent grey-blue placeholder figures with "?" labels).

The 3 real characters must be fully detailed with recognizable faces and clothing from reference images. The 8 ghosts are clearly placeholder silhouettes — transparent, featureless, obviously not real people.`;

  // 3 character images as 3 separate slots
  console.log('Generating step 1...');
  const step1Result = await grokEdit(step1Prompt, initial);
  saveImage(step1Result, 'progressive_step1_3chars_8ghosts.jpg');

  // ============================================================
  // STEP 2: Fill left 4 ghost spots
  // ============================================================
  console.log('\n═══════════════════════════════════════════════');
  console.log('STEP 2: Fill 4 LEFT ghost spots');
  console.log('═══════════════════════════════════════════════');

  // Stitch 4 left characters into a 2x2 grid
  const leftGrid = await stitch2x2(left);
  saveImage(leftGrid, 'progressive_step2_left_refs.jpg');

  const step2Prompt = `This is an existing watercolor illustration of people sitting around a dinner table.

Image 1 is the CURRENT scene — keep everything exactly as it is. Do NOT change the 3 real people already seated (center back).

Image 2 shows 4 NEW characters in a 2x2 grid. Replace the 4 GHOST silhouettes on the LEFT side of the table with these real characters:
- Top-left of grid: ${LEFT_NAMES[0]} → replace leftmost ghost
- Top-right of grid: ${LEFT_NAMES[1]} → replace second ghost from left
- Bottom-left of grid: ${LEFT_NAMES[2]} → replace third ghost
- Bottom-right of grid: ${LEFT_NAMES[3]} → replace fourth ghost

Keep the 4 ghosts on the RIGHT side unchanged. Keep the watercolor style consistent. Match each new character's face and clothing from the reference grid.`;

  console.log('Generating step 2...');
  const step2Result = await grokEdit(step2Prompt, [step1Result, leftGrid]);
  saveImage(step2Result, 'progressive_step2_7chars_4ghosts.jpg');

  // ============================================================
  // STEP 3: Fill right 4 ghost spots
  // ============================================================
  console.log('\n═══════════════════════════════════════════════');
  console.log('STEP 3: Fill 4 RIGHT ghost spots');
  console.log('═══════════════════════════════════════════════');

  // Stitch 4 right characters into a 2x2 grid
  const rightGrid = await stitch2x2(right);
  saveImage(rightGrid, 'progressive_step3_right_refs.jpg');

  const step3Prompt = `This is an existing watercolor illustration of people sitting around a dinner table.

Image 1 is the CURRENT scene — keep everything exactly as it is. Do NOT change ANY of the 7 real people already seated.

Image 2 shows 4 NEW characters in a 2x2 grid. Replace the 4 remaining GHOST silhouettes on the RIGHT side of the table with these real characters:
- Top-left of grid: ${RIGHT_NAMES[0]} → replace rightmost ghost closest to front
- Top-right of grid: ${RIGHT_NAMES[1]} → replace second ghost from right
- Bottom-left of grid: ${RIGHT_NAMES[2]} → replace third ghost
- Bottom-right of grid: ${RIGHT_NAMES[3]} → replace fourth ghost

All ghosts should now be replaced. Keep the watercolor style consistent. Match each new character's face and clothing from the reference grid.`;

  console.log('Generating step 3...');
  const step3Result = await grokEdit(step3Prompt, [step2Result, rightGrid]);
  saveImage(step3Result, 'progressive_step3_11chars_final.jpg');

  // ============================================================
  console.log('\n═══════════════════════════════════════════════');
  console.log('DONE! Results in tests/fixtures/grok-char-test/');
  console.log('  progressive_step1_3chars_8ghosts.jpg');
  console.log('  progressive_step2_7chars_4ghosts.jpg');
  console.log('  progressive_step3_11chars_final.jpg');
  console.log('  Total cost: $0.06 (3 Grok edits)');
  console.log('═══════════════════════════════════════════════');
}

runTest().catch(e => console.error('Test failed:', e));

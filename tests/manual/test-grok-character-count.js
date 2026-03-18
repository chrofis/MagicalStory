/**
 * Test: How many characters can Grok Imagine reproduce in a single image?
 *
 * Test 1: One shot - all characters as reference, generate scene
 * Test 2: Progressive - first 3, then add 3 more, etc.
 *
 * Characters are sent as stitched reference images (max 3 slots).
 * Prompt asks Grok to place them around a large table.
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

// Character files (skip "Lukas from story")
const CHARACTERS = [
  'Lukas.jpg', 'Manuel.jpg', 'Sophie.jpg', 'Franziska.jpg', 'Roger.jpg',
  'Werner.jpg', 'Uschi.jpg', 'Verena.jpg', 'Köbi.jpg', 'Marcel.jpg'
];

const CHAR_NAMES = [
  'Lukas (boy, ~8)', 'Manuel (boy, ~12)', 'Sophie (girl, ~11)', 'Franziska (woman, ~40)', 'Roger (man, ~45)',
  'Werner (man, ~70)', 'Uschi (woman, ~65)', 'Verena (woman, ~40)', 'Köbi (man, ~45)', 'Marcel (man, ~50)'
];

async function loadImage(filename) {
  const buf = fs.readFileSync(path.join(CHAR_DIR, filename));
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function stitchImages(dataUris, targetHeight = 768) {
  const buffers = dataUris.map(uri => {
    const base64 = uri.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(base64, 'base64');
  });

  if (buffers.length === 1) {
    const resized = await sharp(buffers[0])
      .resize({ height: targetHeight, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return `data:image/jpeg;base64,${resized.toString('base64')}`;
  }

  const resized = [];
  for (const buf of buffers) {
    const img = sharp(buf).resize({ height: targetHeight, withoutEnlargement: true });
    const meta = await img.toBuffer({ resolveWithObject: true });
    resized.push({ buffer: meta.data, width: meta.info.width, height: meta.info.height });
  }

  const gap = 4;
  const totalWidth = resized.reduce((sum, r) => sum + r.width, 0) + gap * (resized.length - 1);

  const composites = [];
  let x = 0;
  for (const r of resized) {
    composites.push({ input: r.buffer, left: x, top: 0 });
    x += r.width + gap;
  }

  const stitched = await sharp({
    create: { width: totalWidth, height: targetHeight, channels: 3, background: { r: 255, g: 255, b: 255 } }
  }).composite(composites).jpeg({ quality: 85 }).toBuffer();

  // Pad to square
  const meta = await sharp(stitched).metadata();
  if (meta.width !== meta.height) {
    const size = Math.max(meta.width, meta.height);
    const padded = await sharp(stitched)
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    return `data:image/jpeg;base64,${padded.toString('base64')}`;
  }

  return `data:image/jpeg;base64,${stitched.toString('base64')}`;
}

async function grokEdit(prompt, referenceImages) {
  const body = {
    model: 'grok-imagine-image',
    prompt,
    response_format: 'b64_json',
    aspect_ratio: '1:1',
  };

  if (referenceImages.length === 1) {
    body.image = { url: referenceImages[0], type: 'image_url' };
  } else if (referenceImages.length > 1) {
    body.images = referenceImages.map(url => ({ url, type: 'image_url' }));
  }

  const start = Date.now();
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
    throw new Error(`Grok API error ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  const elapsed = Date.now() - start;
  console.log(`  Grok edit complete in ${elapsed}ms`);

  return `data:image/jpeg;base64,${data.data[0].b64_json}`;
}

function saveImage(dataUri, filename) {
  const base64 = dataUri.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(path.join(OUT_DIR, filename), Buffer.from(base64, 'base64'));
  console.log(`  Saved: ${filename}`);
}

async function runTest() {
  console.log('Loading character images...');
  const charImages = [];
  for (const file of CHARACTERS) {
    charImages.push(await loadImage(file));
  }
  console.log(`Loaded ${charImages.length} characters\n`);

  const basePrompt = (names) => `Generate a SINGLE illustration in classic watercolor painting style with visible brushstrokes, soft color bleeds, wet-on-wet technique, delicate washes, paper texture visible through transparent layers, gentle color gradients, hand-painted quality. No split screen, no panels, no grid. One continuous scene.

SCENE: All characters are sitting around a large round wooden table in a cozy living room. Warm lighting, fireplace in background. Each character is clearly visible and recognizable.

CHARACTERS (match reference images exactly):
${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Each character must be clearly visible with recognizable face and clothing from their reference image. No extra people.`;

  // ============================================================
  // TEST 1: All 10 characters in one shot (3 ref image slots)
  // ============================================================
  console.log('═══════════════════════════════════════════════');
  console.log('TEST 1: All 10 characters in one shot');
  console.log('═══════════════════════════════════════════════');

  // Split 10 chars into 3 groups for 3 reference slots
  const group1 = charImages.slice(0, 4);  // Lukas, Manuel, Sophie, Franziska
  const group2 = charImages.slice(4, 7);  // Roger, Werner, Uschi
  const group3 = charImages.slice(7, 10); // Verena, Köbi, Marcel

  console.log('Stitching 3 reference images (4+3+3 characters)...');
  const ref1 = await stitchImages(group1);
  const ref2 = await stitchImages(group2);
  const ref3 = await stitchImages(group3);

  const prompt10 = basePrompt(CHAR_NAMES);
  console.log(`Prompt: ${prompt10.length} chars`);
  console.log('Generating...');
  try {
    const result = await grokEdit(prompt10, [ref1, ref2, ref3]);
    saveImage(result, 'test1_all10_watercolor.jpg');
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
  }

  // ============================================================
  // TEST 2: 3 characters only
  // ============================================================
  console.log('\n═══════════════════════════════════════════════');
  console.log('TEST 2: 3 characters (Lukas, Manuel, Sophie)');
  console.log('═══════════════════════════════════════════════');

  const names3 = CHAR_NAMES.slice(0, 3);
  const ref3chars = [];
  for (let i = 0; i < 3; i++) {
    // Each character gets its own slot
    ref3chars.push(charImages[i]);
  }

  const prompt3 = basePrompt(names3);
  console.log(`Prompt: ${prompt3.length} chars`);
  console.log('Generating...');
  try {
    const result = await grokEdit(prompt3, ref3chars);
    saveImage(result, 'test2_3chars_watercolor.jpg');
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
  }

  // ============================================================
  // TEST 3: 5 characters (add Franziska, Roger)
  // ============================================================
  console.log('\n═══════════════════════════════════════════════');
  console.log('TEST 3: 5 characters (+ Franziska, Roger)');
  console.log('═══════════════════════════════════════════════');

  const names5 = CHAR_NAMES.slice(0, 5);
  const refSlot1 = await stitchImages([charImages[0], charImages[1]]); // Lukas, Manuel
  const refSlot2 = await stitchImages([charImages[2], charImages[3]]); // Sophie, Franziska
  const refSlot3 = charImages[4]; // Roger alone

  const prompt5 = basePrompt(names5);
  console.log(`Prompt: ${prompt5.length} chars`);
  console.log('Generating...');
  try {
    const result = await grokEdit(prompt5, [refSlot1, refSlot2, refSlot3]);
    saveImage(result, 'test3_5chars_watercolor.jpg');
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
  }

  // ============================================================
  // TEST 4: 8 characters
  // ============================================================
  console.log('\n═══════════════════════════════════════════════');
  console.log('TEST 4: 8 characters (+ Werner, Uschi, Verena)');
  console.log('═══════════════════════════════════════════════');

  const names8 = CHAR_NAMES.slice(0, 8);
  const refSlotA = await stitchImages(charImages.slice(0, 3));  // Lukas, Manuel, Sophie
  const refSlotB = await stitchImages(charImages.slice(3, 6));  // Franziska, Roger, Werner
  const refSlotC = await stitchImages(charImages.slice(6, 8));  // Uschi, Verena

  const prompt8 = basePrompt(names8);
  console.log(`Prompt: ${prompt8.length} chars`);
  console.log('Generating...');
  try {
    const result = await grokEdit(prompt8, [refSlotA, refSlotB, refSlotC]);
    saveImage(result, 'test4_8chars_watercolor.jpg');
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log('DONE! Results in tests/fixtures/grok-char-test/');
  console.log('═══════════════════════════════════════════════');
}

runTest().catch(e => console.error('Test failed:', e));

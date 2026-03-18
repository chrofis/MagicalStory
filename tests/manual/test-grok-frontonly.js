/**
 * Test: Grok with front-facing body crops only (left column of 2x2 grid)
 *
 * Extract only the front-facing body (bottom-left of each 2x2 grid).
 * Send up to 4 people per reference image, max 3 ref slots.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_API_URL = 'https://api.x.ai/v1';

if (!XAI_API_KEY) { console.error('XAI_API_KEY not set'); process.exit(1); }

const CHAR_DIR = path.join(__dirname, '..', 'fixtures', 'characters');
const OUT_DIR = path.join(__dirname, '..', 'fixtures', 'grok-char-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

const ALL_CHARS = [
  { file: 'Lukas.jpg', name: 'Lukas (boy ~8, blue striped hoodie)' },
  { file: 'Manuel.jpg', name: 'Manuel (boy ~12, dark sweater)' },
  { file: 'Sophie.jpg', name: 'Sophie (girl ~11, burgundy jacket, floral skirt)' },
  { file: 'Franziska.jpg', name: 'Franziska (woman ~40, floral navy dress)' },
  { file: 'Roger.jpg', name: 'Roger (man ~45, glasses, grey hoodie)' },
  { file: 'Werner.jpg', name: 'Werner (man ~70, salmon polo)' },
  { file: 'Uschi.jpg', name: 'Uschi (woman ~65, green v-neck, red glasses)' },
  { file: 'Verena.jpg', name: 'Verena (woman ~40, brown hair)' },
  { file: 'Köbi.jpg', name: 'Köbi (man ~45, green plaid sweater)' },
  { file: 'Marcel.jpg', name: 'Marcel (man ~50, dark hair)' },
];

/**
 * Extract left column (front face + front body) from a 2x2 grid.
 * The grid is 768x1344 — left column is 0..384, full height.
 */
async function extractFrontColumn(filename) {
  const buf = fs.readFileSync(path.join(CHAR_DIR, filename));
  const meta = await sharp(buf).metadata();
  const halfW = Math.floor(meta.width / 2);

  const front = await sharp(buf)
    .extract({ left: 0, top: 0, width: halfW, height: meta.height })
    .resize({ height: 768, withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  return front;
}

/**
 * Stitch multiple buffers side by side, pad to square.
 */
async function stitchSideBySide(buffers, targetHeight = 768) {
  const resized = [];
  for (const buf of buffers) {
    const img = sharp(buf).resize({ height: targetHeight, withoutEnlargement: true });
    const meta = await img.toBuffer({ resolveWithObject: true });
    resized.push({ buffer: meta.data, width: meta.info.width, height: meta.info.height });
  }

  const gap = 6;
  const totalWidth = resized.reduce((sum, r) => sum + r.width, 0) + gap * (resized.length - 1);

  const composites = [];
  let x = 0;
  for (const r of resized) {
    composites.push({ input: r.buffer, left: x, top: 0 });
    x += r.width + gap;
  }

  const stitched = await sharp({
    create: { width: totalWidth, height: targetHeight, channels: 3, background: { r: 255, g: 255, b: 255 } }
  }).composite(composites).jpeg({ quality: 90 }).toBuffer();

  // Pad to square
  const meta = await sharp(stitched).metadata();
  if (meta.width !== meta.height) {
    const size = Math.max(meta.width, meta.height);
    return sharp(stitched)
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 90 })
      .toBuffer();
  }
  return stitched;
}

function bufToUri(buf) {
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

function saveBuffer(buf, filename) {
  fs.writeFileSync(path.join(OUT_DIR, filename), buf);
  console.log(`  Saved: ${filename}`);
}

function saveUri(uri, filename) {
  const base64 = uri.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(path.join(OUT_DIR, filename), Buffer.from(base64, 'base64'));
  console.log(`  Saved: ${filename}`);
}

async function grokEdit(prompt, refUris) {
  const body = {
    model: 'grok-imagine-image',
    prompt,
    response_format: 'b64_json',
    aspect_ratio: '1:1',
  };
  if (refUris.length === 1) {
    body.image = { url: refUris[0], type: 'image_url' };
  } else {
    body.images = refUris.map(url => ({ url, type: 'image_url' }));
  }
  const start = Date.now();
  console.log(`  Grok edit (${refUris.length} refs, ${prompt.length} chars)...`);
  const res = await fetch(`${XAI_API_URL}/images/edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Grok ${res.status}: ${(await res.text()).substring(0, 200)}`);
  const data = await res.json();
  console.log(`  Done in ${Date.now() - start}ms`);
  return `data:image/jpeg;base64,${data.data[0].b64_json}`;
}

const prompt = (names) => `Generate a SINGLE watercolor illustration. Soft brushstrokes, wet-on-wet, paper texture, delicate washes.

SCENE: All characters sitting around a large round wooden table in a cozy dining room. Warm candlelight, fireplace in background. Each person clearly visible and recognizable.

CHARACTERS (match reference images exactly — each reference shows face front + body front):
${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Show exactly ${names.length} people, no more, no less. Match faces and clothing from references.`;

async function runTest() {
  // Extract all front columns
  console.log('Extracting front-facing crops from 2x2 grids...');
  const fronts = [];
  for (const c of ALL_CHARS) {
    fronts.push(await extractFrontColumn(c.file));
  }
  console.log(`Extracted ${fronts.length} front crops\n`);

  // Save individual crops for inspection
  for (let i = 0; i < fronts.length; i++) {
    saveBuffer(fronts[i], `v3_crop_${ALL_CHARS[i].file}`);
  }

  // ── TEST A: 3 characters (1 per slot) ──
  console.log('\n═══════════════════════════════════════');
  console.log('TEST A: 3 characters (1 per ref slot)');
  console.log('═══════════════════════════════════════');
  const refA = fronts.slice(0, 3).map(bufToUri);
  const resA = await grokEdit(prompt(ALL_CHARS.slice(0, 3).map(c => c.name)), refA);
  saveUri(resA, 'v3_test_3chars.jpg');

  // ── TEST B: 5 characters (2+2+1 per slot) ──
  console.log('\n═══════════════════════════════════════');
  console.log('TEST B: 5 characters (2+2+1 per slot)');
  console.log('═══════════════════════════════════════');
  const refB1 = await stitchSideBySide([fronts[0], fronts[1]]);
  const refB2 = await stitchSideBySide([fronts[2], fronts[3]]);
  const refB3 = fronts[4];
  saveBuffer(refB1, 'v3_ref_5chars_slot1.jpg');
  saveBuffer(refB2, 'v3_ref_5chars_slot2.jpg');
  const resB = await grokEdit(prompt(ALL_CHARS.slice(0, 5).map(c => c.name)), [bufToUri(refB1), bufToUri(refB2), bufToUri(refB3)]);
  saveUri(resB, 'v3_test_5chars.jpg');

  // ── TEST C: 8 characters (3+3+2 per slot) ──
  console.log('\n═══════════════════════════════════════');
  console.log('TEST C: 8 characters (3+3+2 per slot)');
  console.log('═══════════════════════════════════════');
  const refC1 = await stitchSideBySide([fronts[0], fronts[1], fronts[2]]);
  const refC2 = await stitchSideBySide([fronts[3], fronts[4], fronts[5]]);
  const refC3 = await stitchSideBySide([fronts[6], fronts[7]]);
  saveBuffer(refC1, 'v3_ref_8chars_slot1.jpg');
  saveBuffer(refC2, 'v3_ref_8chars_slot2.jpg');
  saveBuffer(refC3, 'v3_ref_8chars_slot3.jpg');
  const resC = await grokEdit(prompt(ALL_CHARS.slice(0, 8).map(c => c.name)), [bufToUri(refC1), bufToUri(refC2), bufToUri(refC3)]);
  saveUri(resC, 'v3_test_8chars.jpg');

  // ── TEST D: 4 characters (4 in one slot, 1 image only) ──
  console.log('\n═══════════════════════════════════════');
  console.log('TEST D: 4 characters (4 stitched, 1 ref)');
  console.log('═══════════════════════════════════════');
  const refD = await stitchSideBySide([fronts[0], fronts[1], fronts[2], fronts[3]]);
  saveBuffer(refD, 'v3_ref_4chars_single.jpg');
  const resD = await grokEdit(prompt(ALL_CHARS.slice(0, 4).map(c => c.name)), [bufToUri(refD)]);
  saveUri(resD, 'v3_test_4chars_single.jpg');

  console.log('\n═══════════════════════════════════════');
  console.log('DONE! All results in tests/fixtures/grok-char-test/v3_*');
  console.log('═══════════════════════════════════════');
}

runTest().catch(e => { console.error('Failed:', e); process.exit(1); });

/**
 * Trial: Blended character repair — 4 characters, Gemini bbox detection
 *
 * 1. Ask Gemini to detect all character bounding boxes
 * 2. Pick 4 characters
 * 3. For each: blackout → Grok repair → blend onto original
 * 4. Save each step
 *
 * Usage: node tests/manual/test-blended-repair.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { editWithGrok, cropToFrontColumn } = require('../../server/lib/grok');

const FIXTURES = path.join(__dirname, '../fixtures/grok-char-test');
const OUTPUT_DIR = path.join(__dirname, '../fixtures');

const SCENE_FILE = 'v3_test_8chars.jpg';
const BLEND_PADDING = 0.5;
const FEATHER_PX = 30;

// Which avatars to use for repair (pick 4)
const REPAIR_AVATARS = {
  'Roger':     'v3_crop_Roger.jpg',
  'Verena':    'v3_crop_Verena.jpg',
  'Uschi':     'v3_crop_Uschi.jpg',
  'Sophie':    'v3_crop_Sophie.jpg',
};

async function detectBboxesWithGemini(imageBase64) {
  const apiKey = process.env.GEMINI_API_KEY;
  const prompt = `Detect ALL human figures in this children's book illustration.

For each person, give me their body bounding box in pixel coordinates (the image is 1024x1024).

Return a JSON array like this example:
[
  {"name": "boy in striped shirt", "body_box_px": [top, left, bottom, right]},
  {"name": "woman in green sweater", "body_box_px": [top, left, bottom, right]}
]

Where top/left/bottom/right are pixel values from 0 to 1024. Return ALL visible people.`;

  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
        { text: prompt }
      ]}],
      generationConfig: { maxOutputTokens: 4000, temperature: 0.1, responseMimeType: 'application/json' },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      ]
    })
  });

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log('  Raw Gemini response (first 500 chars):', text.substring(0, 500));
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in Gemini response');
  let jsonText = jsonMatch[0].replace(/,(\s*[\]\}])/g, '$1');
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    console.log('  JSON parse failed, trying relaxed parse...');
    console.log('  Problem area:', jsonText.substring(Math.max(0, e.message.match(/position (\d+)/)?.[1] - 30 || 0), (e.message.match(/position (\d+)/)?.[1] || 0) + 50));
    // Use Function-based eval as fallback for relaxed JSON
    return (new Function('return ' + jsonText))();
  }
}

async function main() {
  console.log('=== Blended Repair Trial: 4 chars, Gemini bboxes ===\n');

  const sceneBuffer = fs.readFileSync(path.join(FIXTURES, SCENE_FILE));
  const sceneMeta = await sharp(sceneBuffer).metadata();
  const sceneBase64 = sceneBuffer.toString('base64');
  console.log(`Scene: ${SCENE_FILE} (${sceneMeta.width}x${sceneMeta.height})\n`);

  // Step 1: Detect bboxes
  console.log('Detecting bboxes with Gemini...');
  const figures = await detectBboxesWithGemini(sceneBase64);
  // Gemini may return {name: {body_box_px}} or {name, body_box_px} — normalize both
  const validFigures = figures
    .map(f => {
      // Flat format: { name: "...", body_box_px: [...] }
      if (f.body_box_px) return { name: f.name, px: f.body_box_px };
      // Nested format: { "boy in striped shirt": { body_box_px: [...] } }
      const key = Object.keys(f)[0];
      if (key && f[key]?.body_box_px) return { name: key, px: f[key].body_box_px };
      return null;
    })
    .filter(f => f && f.px.length === 4)
    .map(f => {
      const [top, left, bottom, right] = f.px;
      return { name: f.name, body_box: [top / 1024, left / 1024, bottom / 1024, right / 1024] };
    });
  console.log(`Found ${figures.length} figures (${validFigures.length} with body_box):`);
  validFigures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name} — body: [${f.body_box.map(v => v.toFixed(2)).join(', ')}]`));

  // Save original
  fs.writeFileSync(path.join(OUTPUT_DIR, 'blended_00_original.jpg'), sceneBuffer);
  console.log('\nSaved: blended_00_original.jpg');

  // Step 2: Repair 4 characters sequentially
  let currentResult = sceneBuffer;
  const repairNames = Object.keys(REPAIR_AVATARS);
  let totalCost = 0;

  for (let i = 0; i < repairNames.length; i++) {
    const charName = repairNames[i];
    const step = i + 1;
    console.log(`\n── Step ${step}/4: Repairing ${charName} ──`);

    // Find best matching figure by description (user picks from detected figures)
    // For now just use figure index order — user can adjust
    const figureIdx = i < validFigures.length ? i : 0;
    const figure = validFigures[figureIdx];
    const bbox = figure.body_box;
    console.log(`  Using figure: "${figure.name}" bbox: [${bbox.map(v => v.toFixed(2)).join(', ')}]`);

    // Load avatar
    const avatarBuffer = fs.readFileSync(path.join(FIXTURES, REPAIR_AVATARS[charName]));
    const croppedAvatar = await cropToFrontColumn(avatarBuffer);
    const avatarDataUri = `data:image/jpeg;base64,${croppedAvatar.toString('base64')}`;

    // Blackout on current result
    const [ymin, xmin, ymax, xmax] = bbox;
    const bboxLeft = Math.floor(xmin * sceneMeta.width);
    const bboxTop = Math.floor(ymin * sceneMeta.height);
    const bboxWidth = Math.max(1, Math.ceil((xmax - xmin) * sceneMeta.width));
    const bboxHeight = Math.max(1, Math.ceil((ymax - ymin) * sceneMeta.height));

    const overlay = await sharp({
      create: { width: bboxWidth, height: bboxHeight, channels: 4, background: { r: 200, g: 0, b: 100, alpha: 0.6 } }
    }).png().toBuffer();

    const blackoutBuffer = await sharp(currentResult)
      .composite([{ input: overlay, left: bboxLeft, top: bboxTop }])
      .jpeg({ quality: 90 }).toBuffer();

    // Send to Grok
    const centerX = Math.round(((xmin + xmax) / 2) * 100);
    const centerY = Math.round(((ymin + ymax) / 2) * 100);
    const hPos = centerX < 33 ? 'left side' : centerX > 66 ? 'right side' : 'center';
    const vPos = centerY < 33 ? 'upper' : centerY > 66 ? 'lower' : 'middle';

    const prompt = `Fix the character at the ${vPos} ${hPos} (marked with magenta overlay). Replace their face, hair, and skin tone to match the reference photo of ${charName}. Keep pose, background, art style, and all other characters unchanged.`;

    console.log(`  Sending to Grok...`);
    const grokResult = await editWithGrok(prompt, [avatarDataUri, `data:image/jpeg;base64,${blackoutBuffer.toString('base64')}`]);

    if (!grokResult.imageData) { console.error(`  No image returned!`); continue; }
    totalCost += grokResult.usage?.cost || 0.02;

    const grokBuffer = Buffer.from(grokResult.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');

    // Resize if needed
    const grokMeta = await sharp(grokBuffer).metadata();
    let grokResized = grokBuffer;
    if (grokMeta.width !== sceneMeta.width || grokMeta.height !== sceneMeta.height) {
      grokResized = await sharp(grokBuffer).resize(sceneMeta.width, sceneMeta.height, { fit: 'fill' }).jpeg({ quality: 95 }).toBuffer();
    }

    // Save Grok's raw output
    const grokFile = `blended_${String(step).padStart(2, '0')}a_grok_${charName}.jpg`;
    fs.writeFileSync(path.join(OUTPUT_DIR, grokFile), grokResized);
    console.log(`  Saved: ${grokFile} (Grok raw)`);

    // Blend onto current result
    currentResult = await blendRegion(currentResult, grokResized, bbox, sceneMeta);

    const filename = `blended_${String(step).padStart(2, '0')}b_blend_${charName}.jpg`;
    fs.writeFileSync(path.join(OUTPUT_DIR, filename), currentResult);
    console.log(`  Saved: ${filename} (blended) — $${totalCost.toFixed(2)} total`);
  }

  console.log(`\n=== Done! 4 Grok calls, $${totalCost.toFixed(2)} total ===`);
  console.log('Compare blended_00_original.jpg vs blended_04_Sophie.jpg');
  console.log('Background/table/fireplace should be pristine in the blended result.');
}

async function blendRegion(currentBuffer, grokBuffer, bbox, sceneMeta) {
  const [ymin, xmin, ymax, xmax] = bbox;
  const padX = (xmax - xmin) * BLEND_PADDING;
  const padY = (ymax - ymin) * BLEND_PADDING;

  const bXmin = Math.max(0, xmin - padX);
  const bYmin = Math.max(0, ymin - padY);
  const bXmax = Math.min(1, xmax + padX);
  const bYmax = Math.min(1, ymax + padY);

  const left = Math.floor(bXmin * sceneMeta.width);
  const top = Math.floor(bYmin * sceneMeta.height);
  const width = Math.min(sceneMeta.width - left, Math.ceil((bXmax - bXmin) * sceneMeta.width));
  const height = Math.min(sceneMeta.height - top, Math.ceil((bYmax - bYmin) * sceneMeta.height));

  const grokRegion = await sharp(grokBuffer).extract({ left, top, width, height }).raw().toBuffer();
  const currRegion = await sharp(currentBuffer).extract({ left, top, width, height }).raw().toBuffer();

  const mask = createFeatheredMask(width, height, FEATHER_PX);
  const blended = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const a = mask[i] / 255;
    const idx = i * 3;
    blended[idx] = Math.round(currRegion[idx] * (1 - a) + grokRegion[idx] * a);
    blended[idx + 1] = Math.round(currRegion[idx + 1] * (1 - a) + grokRegion[idx + 1] * a);
    blended[idx + 2] = Math.round(currRegion[idx + 2] * (1 - a) + grokRegion[idx + 2] * a);
  }

  const blendedRegion = await sharp(blended, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  return sharp(currentBuffer).composite([{ input: blendedRegion, left, top }]).jpeg({ quality: 93 }).toBuffer();
}

function createFeatheredMask(w, h, feather) {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      mask[y * w + x] = Math.min(255, Math.round(Math.min(x, w - 1 - x, y, h - 1 - y) / feather * 255));
  return mask;
}

main().catch(err => { console.error('Error:', err); process.exit(1); });

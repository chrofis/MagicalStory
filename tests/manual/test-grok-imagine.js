/**
 * Test script for Grok Imagine API (xAI Aurora)
 * Uses real avatars from story: "Lukas und die geheime Ninja-Ladestation"
 *
 * Tests:
 * 1. Single character scene (Lukas in bedroom, oil painting style)
 * 2. Two characters scene (Lukas + Roger, same scene)
 * 3. Three reference images (Lukas + Roger + scene style reference)
 * 4. Standard vs Pro quality comparison
 *
 * Usage:
 *   node tests/manual/test-grok-imagine.js
 *
 * Requires XAI_API_KEY in .env file
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.XAI_API_KEY;
const BASE_URL = 'https://api.x.ai/v1';
const AVATAR_DIR = path.join(__dirname, '..', 'fixtures', 'grok-test', 'input');
const OUTPUT_DIR = path.join(__dirname, '..', 'fixtures', 'grok-test', 'output');

if (!API_KEY) {
  console.error('❌ XAI_API_KEY not found in .env file');
  console.error('   Get your key at: https://console.x.ai');
  console.error('   Then add to .env: XAI_API_KEY=xai-...');
  process.exit(1);
}

// Check avatars exist
const avatars = {
  lukas: path.join(AVATAR_DIR, 'lukas-standard.jpg'),
  roger: path.join(AVATAR_DIR, 'roger-standard.jpg'),
  sophie: path.join(AVATAR_DIR, 'sophie-standard.jpg'),
  franziska: path.join(AVATAR_DIR, 'franziska-standard.jpg'),
  manuel: path.join(AVATAR_DIR, 'manuel-standard.jpg'),
};

for (const [name, p] of Object.entries(avatars)) {
  if (!fs.existsSync(p)) {
    console.error(`❌ Avatar not found: ${p}`);
    console.error('   Run: node tests/manual/download-avatars.js');
    process.exit(1);
  }
}

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function toDataUrl(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function generateImage(prompt, options = {}) {
  const body = {
    model: options.model || 'grok-imagine-image',
    prompt,
    n: 1,
    response_format: 'b64_json',
  };
  if (options.aspect_ratio) body.aspect_ratio = options.aspect_ratio;

  const response = await fetch(`${BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Generation failed (${response.status}): ${error}`);
  }
  return response.json();
}

async function editImage(prompt, imageDataUrls, options = {}) {
  const body = {
    model: options.model || 'grok-imagine-image',
    prompt,
    response_format: 'b64_json',
  };

  if (imageDataUrls.length === 1) {
    body.image = { url: imageDataUrls[0], type: 'image_url' };
  } else {
    body.images = imageDataUrls.map(url => ({ url, type: 'image_url' }));
  }

  const response = await fetch(`${BASE_URL}/images/edits`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Edit failed (${response.status}): ${error}`);
  }
  return response.json();
}

function save(result, name) {
  const buffer = Buffer.from(result.data[0].b64_json, 'base64');
  const filepath = path.join(OUTPUT_DIR, name + '.png');
  fs.writeFileSync(filepath, buffer);
  console.log(`   Saved: ${name}.png (${Math.round(buffer.length / 1024)}KB)`);
}

async function runTest(label, fn) {
  console.log(`\n── ${label} ──`);
  try {
    const start = Date.now();
    await fn();
    console.log(`   ✅ Done (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } catch (error) {
    console.error(`   ❌ Failed: ${error.message}`);
  }
}

async function main() {
  console.log('=== GROK IMAGINE API TEST ===');
  console.log(`API Key: ${API_KEY.substring(0, 8)}...`);
  console.log(`Avatars: ${Object.keys(avatars).join(', ')}`);
  console.log(`Story: "Lukas und die geheime Ninja-Ladestation" (oil painting style)`);

  // ── Test 1: Single character with avatar reference ──
  await runTest('Test 1: Lukas alone in bedroom (single ref)', async () => {
    const result = await editImage(
      'Generate an illustration of this boy (Lukas, age 7) sitting upright in bed clutching a stuffed elephant to his chest, star-patterned blanket pulled up high. Warm bedroom at night, bedside lamp casting golden light, soft shadows. Oil painting illustration style for a children\'s book. Keep the boy\'s face and appearance exactly as shown in the reference image.',
      [toDataUrl(avatars.lukas)],
      { aspect_ratio: '1:1' }
    );
    save(result, '1-lukas-bedroom-single');
  });

  // ── Test 2: Two characters with avatar references ──
  await runTest('Test 2: Lukas + Roger in bedroom (two refs)', async () => {
    const result = await editImage(
      'Generate an illustration with these two characters. The boy (first image, Lukas, age 7) sits in bed clutching a stuffed elephant. The man (second image, Roger, his father, bearded) sits on the bed edge facing the boy with a warm smile. Cozy bedroom at night, warm lamp lighting, star-patterned blanket. Oil painting illustration style for a children\'s book. Keep both faces exactly as shown in the reference images.',
      [toDataUrl(avatars.lukas), toDataUrl(avatars.roger)],
    );
    save(result, '2-lukas-roger-bedroom-two');
  });

  // ── Test 3: Three characters ──
  await runTest('Test 3: Lukas + Sophie + Franziska in kitchen (three refs)', async () => {
    const result = await editImage(
      'Generate an illustration with these three characters at a breakfast table. The boy (first image, Lukas, age 7) sits at the table eating cereal. The girl (second image, Sophie, age 5, his sister) sits next to him reaching for toast. The woman (third image, Franziska, their mother, glasses) stands behind them pouring orange juice. Bright morning kitchen, sunlight through window, cheerful atmosphere. Oil painting illustration style for a children\'s book. Keep all three faces exactly as shown in the reference images.',
      [toDataUrl(avatars.lukas), toDataUrl(avatars.sophie), toDataUrl(avatars.franziska)],
    );
    save(result, '3-family-kitchen-three');
  });

  console.log('\n=== TESTS COMPLETE ===');
  console.log(`Output: tests/fixtures/grok-test/output/`);
  console.log('Cost: 3 images x $0.02 = $0.06');
}

main().catch(console.error);

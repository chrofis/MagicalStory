#!/usr/bin/env node
/**
 * Generate photo-realistic portraits for demo family members via Gemini,
 * then upload them as character photos to the corresponding demo account.
 * Reads portrait prompts from tests/helpers/demo-families.json.
 *
 * Usage:
 *   node scripts/admin/generate-demo-photos.js                    # All families
 *   node scripts/admin/generate-demo-photos.js --family=berger    # Single family
 *
 * Requires:
 *   - GEMINI_API_KEY in .env
 *   - Demo users already created (run setup-demo-user.js first)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoStory2026!';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash-image';
const FAMILIES_PATH = path.join(__dirname, '..', '..', 'tests', 'helpers', 'demo-families.json');

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not found in environment. Add it to .env');
  process.exit(1);
}

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] || 'true';
  }
  return out;
}

async function generatePortrait(prompt, name) {
  console.log(`  Generating portrait for ${name}...`);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      temperature: 0.4,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Gemini API error (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const candidates = data.candidates || [];
  if (candidates.length === 0) throw new Error(`No candidates for ${name}`);

  const parts = candidates[0].content?.parts || [];
  const imagePart = parts.find(p => p.inlineData);
  if (!imagePart) {
    const textPart = parts.find(p => p.text);
    throw new Error(`No image for ${name}. Text: ${textPart?.text || 'none'}`);
  }

  const rawBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
  const rawKb = Math.round(rawBuffer.length / 1024);
  const jpegBuffer = await sharp(rawBuffer)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  const jpegBase64 = jpegBuffer.toString('base64');
  const jpegKb = Math.round(jpegBuffer.length / 1024);

  console.log(`  Generated ${name}: ${rawKb}KB → ${jpegKb}KB (JPEG)`);
  return `data:image/jpeg;base64,${jpegBase64}`;
}

async function processFamily(apiBase, family) {
  console.log(`\n── ${family.label} (${family.email}) ──────────────────`);

  // 1. Login
  console.log('1. Logging in...');
  const loginRes = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: family.email, password: DEMO_PASSWORD }),
  });
  if (!loginRes.ok) {
    throw new Error(`Login failed for ${family.email}: ${loginRes.status} ${await loginRes.text()}`);
  }
  const { token } = await loginRes.json();

  // 2. Fetch existing characters
  console.log('2. Fetching existing characters...');
  const charRes = await fetch(`${apiBase}/api/characters`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!charRes.ok) throw new Error(`Fetch failed: ${charRes.status}`);
  const charData = await charRes.json();
  const characters = charData.characters || [];
  if (characters.length === 0) {
    throw new Error(`No characters on ${family.email}. Run setup-demo-user.js first.`);
  }

  // 3. Generate portraits
  console.log(`3. Generating ${family.characters.length} portraits...`);
  const photos = {};
  for (const charDef of family.characters) {
    try {
      photos[charDef.id] = await generatePortrait(charDef.portraitPrompt, charDef.name);
    } catch (err) {
      console.error(`   Failed to generate ${charDef.name}: ${err.message}`);
    }
  }
  console.log(`   Generated ${Object.keys(photos).length}/${family.characters.length}`);

  // 4. Upload
  console.log('4. Uploading to character profiles...');
  const updated = characters.map(char => {
    const photo = photos[char.id];
    if (!photo) return char;
    return {
      ...char,
      photos: { ...(char.photos || {}), original: photo, face: photo },
    };
  });

  const saveRes = await fetch(`${apiBase}/api/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      characters: updated,
      relationships: charData.relationships || {},
      relationshipTexts: charData.relationshipTexts || {},
      customRelationships: charData.customRelationships || [],
      customStrengths: charData.customStrengths || [],
      customWeaknesses: charData.customWeaknesses || [],
      customFears: charData.customFears || [],
    }),
  });
  if (!saveRes.ok) throw new Error(`Save failed: ${saveRes.status} ${await saveRes.text()}`);
  const result = await saveRes.json();
  console.log(`   Saved ${result.count} characters with photos.`);
}

async function main() {
  const args = parseArgs();
  const baseUrl = (process.env.TEST_BASE_URL || 'https://magicalstory.ch').replace(/\/$/, '');
  const apiBase = baseUrl.includes('localhost:5173') ? 'http://localhost:3000' : baseUrl;

  const { families } = JSON.parse(fs.readFileSync(FAMILIES_PATH, 'utf-8'));
  const targetFamilies = args.family ? families.filter(f => f.id === args.family) : families;

  if (targetFamilies.length === 0) {
    throw new Error(`No family matched --family=${args.family}. Known: ${families.map(f => f.id).join(', ')}`);
  }

  console.log(`Generating demo portraits → ${apiBase}`);
  console.log(`Families: ${targetFamilies.map(f => f.id).join(', ')}`);

  for (const family of targetFamilies) {
    await processFamily(apiBase, family);
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log('Done. Demo families have photo-realistic portraits.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

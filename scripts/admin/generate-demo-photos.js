#!/usr/bin/env node
/**
 * Generate photo-realistic portraits for demo family members via Gemini,
 * then upload them as character photos to the corresponding demo account.
 * Reads portrait prompts from tests/helpers/demo-families.json.
 *
 * Usage:
 *   node scripts/admin/generate-demo-photos.js                       # All families, upload only
 *   node scripts/admin/generate-demo-photos.js --family=berger       # Single family
 *   node scripts/admin/generate-demo-photos.js --family=berger --only=Werner  # Single character
 *   node scripts/admin/generate-demo-photos.js --save-to=./demo-photos  # Also save to disk
 *   node scripts/admin/generate-demo-photos.js --save-to=./demo-photos --no-upload  # Disk only
 *
 * Default save location when --save-to is passed without a value:
 *   tests/fixtures/demo-photos/{family}/{name}.jpg  (gitignored — local inspection only)
 *
 * Requires:
 *   - GEMINI_API_KEY in .env
 *   - Demo users already created (run setup-demo-user.js first), unless --no-upload
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

async function generateJpegBuffer(prompt, name) {
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
  const jpegKb = Math.round(jpegBuffer.length / 1024);

  console.log(`  Generated ${name}: ${rawKb}KB → ${jpegKb}KB (JPEG)`);
  return jpegBuffer;
}

function bufferToDataUri(buf) {
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function processFamily(apiBase, family, opts) {
  const { saveDir, doUpload, only } = opts;
  console.log(`\n── ${family.label} (${family.email}) ──────────────────`);

  // Filter characters when --only=<name> is set (case-insensitive name match).
  const charsToGenerate = only
    ? family.characters.filter(c => c.name.toLowerCase() === only.toLowerCase())
    : family.characters;
  if (only && charsToGenerate.length === 0) {
    console.log(`   No character matching "${only}" in family ${family.id} — skipping.`);
    return;
  }

  // 1. Generate portraits
  console.log(`1. Generating ${charsToGenerate.length} portrait(s)...`);
  const portraits = {};  // characterId → Buffer
  for (const charDef of charsToGenerate) {
    try {
      portraits[charDef.id] = await generateJpegBuffer(charDef.portraitPrompt, charDef.name);
    } catch (err) {
      console.error(`   Failed to generate ${charDef.name}: ${err.message}`);
    }
  }
  console.log(`   Generated ${Object.keys(portraits).length}/${charsToGenerate.length}`);

  // 2. Save to disk (optional)
  if (saveDir) {
    const familyDir = path.join(saveDir, family.id);
    fs.mkdirSync(familyDir, { recursive: true });
    for (const charDef of charsToGenerate) {
      const buf = portraits[charDef.id];
      if (!buf) continue;
      const filePath = path.join(familyDir, `${charDef.name}.jpg`);
      fs.writeFileSync(filePath, buf);
      console.log(`   Saved ${path.relative(process.cwd(), filePath)}`);
    }
  }

  // 3. Upload (optional)
  if (!doUpload) {
    console.log('   (--no-upload: skipping upload to demo account)');
    return;
  }

  console.log('2. Logging in...');
  const loginRes = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: family.email, password: DEMO_PASSWORD }),
  });
  if (!loginRes.ok) {
    throw new Error(`Login failed for ${family.email}: ${loginRes.status} ${await loginRes.text()}`);
  }
  const { token } = await loginRes.json();

  console.log('3. Fetching existing characters...');
  const charRes = await fetch(`${apiBase}/api/characters`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!charRes.ok) throw new Error(`Fetch failed: ${charRes.status}`);
  const charData = await charRes.json();
  const characters = charData.characters || [];
  if (characters.length === 0) {
    throw new Error(`No characters on ${family.email}. Run setup-demo-user.js first.`);
  }

  console.log('4. Uploading to character profiles...');
  const updated = characters.map(char => {
    const buf = portraits[char.id];
    if (!buf) return char;
    const dataUri = bufferToDataUri(buf);
    return {
      ...char,
      photos: { ...(char.photos || {}), original: dataUri, face: dataUri },
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

  // Resolve --save-to: explicit path, or "true" → default to tests/fixtures/demo-photos
  const DEFAULT_SAVE_DIR = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'demo-photos');
  const saveDir = args['save-to'] === 'true'
    ? DEFAULT_SAVE_DIR
    : args['save-to'] ? path.resolve(args['save-to']) : null;
  const doUpload = args['no-upload'] !== 'true';

  if (!doUpload && !saveDir) {
    throw new Error('--no-upload requires --save-to=<dir> (otherwise nothing happens).');
  }

  console.log(`Generating demo portraits${doUpload ? ` → ${apiBase}` : ' (no upload)'}`);
  if (saveDir) console.log(`Saving JPEGs to: ${saveDir}`);
  console.log(`Families: ${targetFamilies.map(f => f.id).join(', ')}`);

  const only = args.only || null;
  if (only) console.log(`Filter: only character "${only}"`);

  for (const family of targetFamilies) {
    await processFamily(apiBase, family, { saveDir, doUpload, only });
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log('Done. Demo families have photo-realistic portraits.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

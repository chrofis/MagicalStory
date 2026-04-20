#!/usr/bin/env node
/**
 * Showcase orchestrator — generate ONE fresh homepage demo story end-to-end.
 *
 * For each run:
 *   1. Pick a rotation entry (default: next from rotation state file)
 *   2. Create a fresh, timestamped demo account (demo-{family}-{YYYYMMDD-HHmm}@magicalstory.ch)
 *   3. Upload characters + curated photos from tests/fixtures/demo-photos/{family}/
 *   4. Trigger the Playwright spec against that account → server begins generation
 *
 * Each run is fully isolated — old stories stay accessible on their original accounts,
 * new run starts from a clean slate.
 *
 * Usage:
 *   node scripts/admin/showcase.js                         # next rotation entry, prod
 *   node scripts/admin/showcase.js --entry=7               # specific rotation index (Miller/EN/Space)
 *   node scripts/admin/showcase.js --upload-only           # create account + upload, skip Playwright
 *   TEST_BASE_URL=http://localhost:5173 node scripts/admin/showcase.js  # local backend
 *
 * Prereqs:
 *   - Photos exist in tests/fixtures/demo-photos/{family}/{Name}.jpg
 *     → run `node scripts/admin/generate-demo-photos.js --family=<id> --save-to=true --no-upload`
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FAMILIES_PATH = path.join(__dirname, '..', '..', 'tests', 'helpers', 'demo-families.json');
const ROTATION_PATH = path.join(__dirname, '..', '..', 'tests', 'helpers', 'demo-rotation.json');
const STATE_PATH = path.join(__dirname, '..', '..', 'tests', 'demo-rotation-state.json');
const PHOTOS_DIR = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'demo-photos');
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoStory2026!';

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] || 'true';
  }
  return out;
}

function shortTimeId() {
  // Base36 minute-counter (~7 chars). Keeps the email under the 30-char username
  // truncation that auth.js applies on insert. Two showcases in the same minute
  // would collide — acceptable for manual gallery generation.
  return Math.floor(Date.now() / 60000).toString(36);
}

function showcaseEmail(family) {
  // Format: demo-{family-initial}-{base36-minutes}@magicalstory.ch  (≤ 30 chars)
  // e.g. "demo-b-djts1k@magicalstory.ch" = 29 chars. The 30-char cap comes from
  // sanitizeString in server/middleware/validation.js, which truncates the
  // username field that doubles as the email in auth.js.
  return `demo-${family.id[0]}-${shortTimeId()}@magicalstory.ch`;
}

function loadEntries() {
  return JSON.parse(fs.readFileSync(ROTATION_PATH, 'utf-8')).entries;
}

function loadFamilies() {
  return JSON.parse(fs.readFileSync(FAMILIES_PATH, 'utf-8')).families;
}

function pickEntry(args, entries) {
  if (args.entry !== undefined) {
    const idx = parseInt(args.entry, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= entries.length) {
      throw new Error(`--entry must be 0..${entries.length - 1}, got ${args.entry}`);
    }
    return entries[idx];
  }
  let state = { currentIndex: 0 };
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { /* default */ }
  return entries[state.currentIndex % entries.length];
}

function loadPhotosForFamily(family) {
  const dir = path.join(PHOTOS_DIR, family.id);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `No photos for family "${family.id}" at ${dir}\n` +
      `Generate them first:\n` +
      `  node scripts/admin/generate-demo-photos.js --family=${family.id} --save-to=true --no-upload`
    );
  }
  const photos = {};
  for (const charDef of family.characters) {
    const filePath = path.join(dir, `${charDef.name}.jpg`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing photo for ${charDef.name}: ${filePath}`);
    }
    const buf = fs.readFileSync(filePath);
    photos[charDef.id] = `data:image/jpeg;base64,${buf.toString('base64')}`;
  }
  return photos;
}

async function provisionAccount(apiBase, email, family, photos) {
  console.log(`\n── Provisioning ${email} ──────────────────`);

  console.log('1. Registering...');
  const registerRes = await fetch(`${apiBase}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: email,
      email,
      password: DEMO_PASSWORD,
      _formStartTime: Date.now() - 5000,
    }),
  });
  if (!registerRes.ok) {
    const err = await registerRes.json().catch(() => ({}));
    if (err.error?.includes('already exists') || err.message?.includes('already exists')) {
      console.log('   Account already exists (timestamp collision?) — using existing.');
    } else {
      throw new Error(`Registration failed: ${registerRes.status} ${JSON.stringify(err)}`);
    }
  }

  console.log('2. Logging in...');
  const loginRes = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: email, password: DEMO_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  const { token, user } = await loginRes.json();
  console.log(`   id=${user.id}, credits=${user.credits}`);

  console.log(`3. Saving ${family.characters.length} characters with photos...`);
  const charactersWithPhotos = family.characters.map(c => ({
    ...c,
    photos: { original: photos[c.id], face: photos[c.id] },
  }));

  const saveRes = await fetch(`${apiBase}/api/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      characters: charactersWithPhotos,
      relationships: family.relationships,
      relationshipTexts: {},
      customRelationships: [],
      customStrengths: [],
      customWeaknesses: [],
      customFears: [],
    }),
  });
  if (!saveRes.ok) throw new Error(`Save failed: ${saveRes.status} ${await saveRes.text()}`);
  const result = await saveRes.json();
  console.log(`   Saved ${result.count} characters.`);

  return { userId: user.id, credits: user.credits };
}

async function main() {
  const args = parseArgs();
  const baseUrl = (process.env.TEST_BASE_URL || 'https://magicalstory.ch').replace(/\/$/, '');
  const apiBase = baseUrl.includes('localhost:5173') ? 'http://localhost:3000' : baseUrl;

  const entries = loadEntries();
  const families = loadFamilies();
  const entry = pickEntry(args, entries);
  const family = families.find(f => f.id === entry.familyId);
  if (!family) throw new Error(`Family not found: ${entry.familyId}`);

  console.log('═══ Showcase Run ════════════════════════════════════════');
  console.log(`  Entry:    #${entry.index} — ${entry.description}`);
  console.log(`  Family:   ${family.label} (${family.id})`);
  console.log(`  Language: ${entry.language}`);
  console.log(`  Topic:    ${entry.storyCategory} → ${entry.storyTopic}`);
  console.log(`  Style:    ${entry.artStyle}`);
  console.log(`  Backend:  ${apiBase}`);
  console.log('═══════════════════════════════════════════════════════════');

  const photos = loadPhotosForFamily(family);
  console.log(`Loaded ${Object.keys(photos).length} photos from disk.`);

  const email = showcaseEmail(family);
  if (email.length > 30) {
    throw new Error(`Generated email exceeds 30-char auth cap: ${email} (${email.length} chars)`);
  }
  await provisionAccount(apiBase, email, family, photos);

  console.log('\n── Account ready ──────────────────────────────────────────');
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);

  if (args['upload-only']) {
    console.log('\n--upload-only flag set — skipping Playwright. Done.');
    return;
  }

  console.log('\n── Triggering Playwright story generation ──────────────────');
  const env = {
    ...process.env,
    DEMO_EMAIL: email,
    DEMO_PASSWORD,
    DEMO_ENTRY_INDEX: String(entry.index),
  };
  const result = spawnSync(
    'npx',
    ['playwright', 'test', 'tests/demo-story.spec.ts', '--project=demo-story', '--workers=1'],
    { stdio: 'inherit', env, shell: true }
  );

  if (result.status !== 0) {
    console.error(`\nPlaywright exited with code ${result.status}.`);
    process.exit(result.status || 1);
  }

  console.log('\nShowcase complete. Story is generating server-side (5–10 min).');
  console.log(`Check progress on the demo account: ${email}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

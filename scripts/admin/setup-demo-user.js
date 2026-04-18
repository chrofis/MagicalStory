#!/usr/bin/env node
/**
 * Setup demo users (one per family) with pre-loaded characters.
 * Idempotent — safe to run multiple times per environment.
 *
 * Reads family definitions from tests/helpers/demo-families.json.
 *
 * Usage:
 *   node scripts/admin/setup-demo-user.js                         # All families, production
 *   node scripts/admin/setup-demo-user.js --family=berger         # Single family
 *   DEMO_PASSWORD=xxx node scripts/admin/setup-demo-user.js       # Custom password
 *   TEST_BASE_URL=http://localhost:5173 node scripts/admin/setup-demo-user.js  # Local
 */

const fs = require('fs');
const path = require('path');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoStory2026!';
const FAMILIES_PATH = path.join(__dirname, '..', '..', 'tests', 'helpers', 'demo-families.json');

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] || 'true';
  }
  return out;
}

async function setupOneFamily(apiBase, family) {
  const email = family.email;
  console.log(`\n── ${family.label} (${email}) ──────────────────`);

  // 1. Register (or detect existing)
  console.log('1. Registering user...');
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
      console.log('   User already exists — skipping registration.');
    } else {
      throw new Error(`Registration failed: ${registerRes.status} ${JSON.stringify(err)}`);
    }
  }

  // 2. Login
  console.log('2. Logging in...');
  const loginRes = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: email, password: DEMO_PASSWORD }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  }

  const { token, user } = await loginRes.json();
  console.log(`   Logged in as: ${user.email} (id: ${user.id}, credits: ${user.credits})`);

  // 3. Save characters
  console.log(`3. Saving ${family.characters.length} characters...`);
  const charRes = await fetch(`${apiBase}/api/characters`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      characters: family.characters,
      relationships: family.relationships,
      relationshipTexts: {},
      customRelationships: [],
      customStrengths: [],
      customWeaknesses: [],
      customFears: [],
    }),
  });

  if (!charRes.ok) {
    throw new Error(`Character save failed: ${charRes.status} ${await charRes.text()}`);
  }

  const charResult = await charRes.json();
  console.log(`   Saved ${charResult.count} characters.`);
  console.log(`   Members: ${family.characters.map(c => `${c.name} (${c.age})`).join(', ')}`);
}

async function main() {
  const args = parseArgs();
  const baseUrl = (process.env.TEST_BASE_URL || 'https://magicalstory.ch').replace(/\/$/, '');
  const apiBase = baseUrl.includes('localhost:5173')
    ? 'http://localhost:3000'
    : baseUrl;

  const { families } = JSON.parse(fs.readFileSync(FAMILIES_PATH, 'utf-8'));

  const targetFamilies = args.family
    ? families.filter(f => f.id === args.family)
    : families;

  if (targetFamilies.length === 0) {
    throw new Error(`No family matched --family=${args.family}. Known: ${families.map(f => f.id).join(', ')}`);
  }

  console.log(`Setting up demo users against: ${apiBase}`);
  console.log(`Families: ${targetFamilies.map(f => f.id).join(', ')}`);

  for (const family of targetFamilies) {
    await setupOneFamily(apiBase, family);
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log('Setup complete.');
  console.log(`Password (all accounts): ${DEMO_PASSWORD}`);
  console.log('To top up credits (if needed):');
  for (const family of targetFamilies) {
    console.log(`  UPDATE users SET credits = -1 WHERE email = '${family.email}';`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

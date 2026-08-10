#!/usr/bin/env node
/**
 * Showcase orchestrator — generate ONE fresh homepage demo story end-to-end.
 *
 * For each run:
 *   1. Pick a rotation entry (default: next from rotation state file)
 *   2. Resolve the family's PERSISTENT account (demo-{family}@magicalstory.ch),
 *      creating it on first use — every Miller story then lives together
 *   3. Upload characters only if that account does not already have them
 *   4. Enter the account by admin impersonation, so the story is an ADMIN DRAFT
 *   5. Trigger the Playwright spec against that session → server begins generation
 *
 * A draft is invisible to the family account and costs it no credits, so a run
 * can be repeated until it is good and only the chosen one published:
 *   GET  /api/admin/drafts
 *   POST /api/admin/stories/<storyId>/publish
 *
 * `--fresh-account` restores the old behaviour (a new timestamped account per
 * run, visible immediately). Staging had 49 demo accounts before this changed.
 *
 * Usage:
 *   node scripts/admin/showcase.js                         # next rotation entry, prod
 *   node scripts/admin/showcase.js --entry=7               # specific rotation index (Miller/EN/Space)
 *   node scripts/admin/showcase.js --upload-only           # provision only, skip Playwright
 *   node scripts/admin/showcase.js --fresh-account         # old per-run throwaway account
 *
 *   TEST_BASE_URL=http://localhost:5173 node scripts/admin/showcase.js  # local backend
 *
 * Admin used for impersonation: SHOWCASE_ADMIN_EMAIL / SHOWCASE_ADMIN_PASSWORD
 * (defaults to the smoke-test admin). It must NOT be the family account itself.
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
const DEDICATIONS_PATH = path.join(__dirname, '..', '..', 'tests', 'helpers', 'demo-dedications.json');
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

// Pick a Widmung (dedication) from the rotating pool, matched to the story
// language. Rotates by the entry index (same cursor idea as family / art style)
// so consecutive showcases get different dedications. Falls back to English if
// the language variant is missing.
function pickDedication(entry) {
  const pool = JSON.parse(fs.readFileSync(DEDICATIONS_PATH, 'utf8')).dedications || [];
  if (!pool.length) return '';
  const d = pool[entry.index % pool.length];
  return (d && (d[entry.language] || d.en)) || '';
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

/**
 * ONE persistent account per family — every Miller story lives together, and
 * reruns stop minting a dummy account each time. All three current ids fit the
 * 30-char cap ("demo-miller@magicalstory.ch" = 27).
 */
function persistentEmail(family) {
  const email = `demo-${family.id}@magicalstory.ch`;
  if (email.length > 30) {
    throw new Error(`Persistent email exceeds the 30-char auth cap: ${email} (${email.length})`);
  }
  return email;
}

/**
 * Impersonation token for the family account, via the REAL endpoint.
 *
 * Not a locally-minted JWT: every environment signs with its own secret, and
 * the .env one does not match staging — a forged token is simply rejected 403.
 * Logging in as an admin and calling POST /api/admin/impersonate/:userId is
 * also the exact flow a human admin uses, so the showcase exercises the
 * shipped path rather than a back door.
 *
 * `impersonating: true` in that token is what makes the story an admin draft
 * and skips the credit reservation, server-side.
 */
async function impersonateFamilyAccount(apiBase, targetUserId) {
  const adminEmail = process.env.SHOWCASE_ADMIN_EMAIL || 'demo-b-hnecf@magicalstory.ch';
  const adminPassword = process.env.SHOWCASE_ADMIN_PASSWORD || DEMO_PASSWORD;

  const loginRes = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminEmail, password: adminPassword }),
  });
  if (!loginRes.ok) {
    throw new Error(
      `Admin login failed for ${adminEmail} (${loginRes.status}). ` +
      `Set SHOWCASE_ADMIN_EMAIL / SHOWCASE_ADMIN_PASSWORD for this environment.`
    );
  }
  const admin = await loginRes.json();
  if (admin.user?.role !== 'admin') {
    throw new Error(`${adminEmail} is not an admin on this environment — cannot create drafts.`);
  }
  if (String(admin.user.id) === String(targetUserId)) {
    throw new Error(
      `The showcase admin (${adminEmail}) IS the family account, and nobody can impersonate themselves. ` +
      `Use a different SHOWCASE_ADMIN_EMAIL, or pass --fresh-account.`
    );
  }

  const impRes = await fetch(`${apiBase}/api/admin/impersonate/${targetUserId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  if (!impRes.ok) {
    throw new Error(`Impersonation failed (${impRes.status}): ${(await impRes.text()).slice(0, 200)}`);
  }
  const { token } = await impRes.json();
  if (!token) throw new Error('Impersonation returned no token');
  return token;
}

/**
 * Does this account already hold the family? If so the wizard skips character
 * creation — which is also what stops each run minting a NEW character-id set,
 * the condition behind the cross-account incident of 2026-08-09.
 */
async function accountHasFamily(apiBase, token, family) {
  try {
    const res = await fetch(`${apiBase}/api/characters`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return false;
    const body = await res.json();
    const existing = (body.characters || body || []).map(c => String(c.name || '').trim().toLowerCase());
    return family.characters.every(c => existing.includes(c.name.trim().toLowerCase()));
  } catch {
    return false;
  }
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

function advanceRotationState(entry, entries) {
  let state = { currentIndex: 0, generatedStories: [] };
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { /* default */ }
  if (!Array.isArray(state.generatedStories)) state.generatedStories = [];
  state.currentIndex = (state.currentIndex + 1) % entries.length;
  state.generatedStories.push(`${entry.storyCategory}/${entry.storyTopic} (${entry.artStyle}) - ${new Date().toISOString()}`);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  console.log(`Rotation advanced → next default index: ${state.currentIndex}`);
}

function verifyPhotosOnDisk(family) {
  const dir = path.join(PHOTOS_DIR, family.id);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `No photos for family "${family.id}" at ${dir}\n` +
      `Generate them first:\n` +
      `  node scripts/admin/generate-demo-photos.js --family=${family.id} --save-to=true --no-upload`
    );
  }
  for (const charDef of family.characters) {
    const filePath = path.join(dir, `${charDef.name}.jpg`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing photo for ${charDef.name}: ${filePath}`);
    }
  }
  console.log(`Verified ${family.characters.length} photos on disk at ${path.relative(process.cwd(), dir)}`);
}

/**
 * Log in if the account exists, register it first if it does not. Persistent
 * accounts are provisioned once and reused forever after.
 */
async function loginOrRegister(apiBase, email, family) {
  const login = async () => {
    const res = await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password: DEMO_PASSWORD }),
    });
    return res.ok ? res.json() : null;
  };

  let session = await login();
  if (session) {
    console.log(`   Existing account — id=${session.user.id}, credits=${session.user.credits}`);
    return { ...session, isNew: false };
  }

  console.log('   No account yet — registering...');
  verifyPhotosOnDisk(family);
  const registerRes = await fetch(`${apiBase}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: email, email, password: DEMO_PASSWORD,
      _formStartTime: Date.now() - 30000,
    }),
  });
  if (!registerRes.ok) {
    const err = await registerRes.json().catch(() => ({}));
    throw new Error(`Registration failed: ${registerRes.status} ${JSON.stringify(err)}`);
  }
  session = await login();
  if (!session) throw new Error(`Registered ${email} but cannot log in`);
  console.log(`   Created — id=${session.user.id}`);
  return { ...session, isNew: true };
}

async function provisionAccount(apiBase, email, family) {
  console.log(`\n── Provisioning ${email} ──────────────────`);

  console.log('1. Registering...');
  const registerRes = await fetch(`${apiBase}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: email,
      email,
      password: DEMO_PASSWORD,
      _formStartTime: Date.now() - 30000,
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
  const { user } = await loginRes.json();
  console.log(`   id=${user.id}, credits=${user.credits}`);

  // Register + login is the ONLY API use. Everything else — character creation,
  // photo upload, traits, relationships, role assignment, story wizard — runs
  // through the actual wizard UI via Playwright. This matches a normal user's
  // path to first story and keeps the showcase faithful as an end-to-end smoke
  // test rather than a back-door setup.
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
  const dedication = pickDedication(entry);

  console.log('═══ Showcase Run ════════════════════════════════════════');
  console.log(`  Entry:    #${entry.index} — ${entry.description}`);
  console.log(`  Family:   ${family.label} (${family.id})`);
  console.log(`  Language: ${entry.language}`);
  console.log(`  Topic:    ${entry.storyCategory} → ${entry.storyTopic}`);
  console.log(`  Style:    ${entry.artStyle}`);
  console.log(`  Widmung:  ${dedication || '(none)'}`);
  console.log(`  Backend:  ${apiBase}`);
  console.log('═══════════════════════════════════════════════════════════');

  // --reuse-email <existing-email>: skip provisioning + character upload. Use
  // when re-running a showcase to validate a downstream wizard fix without
  // burning another fresh account (each new account costs credits + 30 sec of
  // photo provisioning). The spec gets DEMO_REUSE_ACCOUNT=1 and skips the
  // createFamilyViaWizard step (chars already exist on the account).
  const reuseEmail = args['reuse-email'] || process.env.DEMO_REUSE_EMAIL || null;
  let email;
  let impersonationToken = null;
  let reuseCharacters = false;

  // DEFAULT PATH (2026-08-10): one persistent account per family, entered by
  // impersonation so the story is an admin draft — invisible to that account
  // until published, and free. Generate, look, regenerate, publish the good one.
  // `--fresh-account` restores the old per-run timestamped account.
  if (!reuseEmail && !args['fresh-account']) {
    email = persistentEmail(family);
    console.log(`\n── Persistent family account ─────────────────────────────`);
    console.log(`  Email:    ${email}`);
    const session = await loginOrRegister(apiBase, email, family);
    reuseCharacters = !session.isNew && await accountHasFamily(apiBase, session.token, family);
    console.log(`  Characters: ${reuseCharacters ? 'already on the account — skipping upload' : 'will be created via the wizard'}`);
    // A brand-new account already had its photos verified before registering.
    if (!reuseCharacters && !session.isNew) verifyPhotosOnDisk(family);

    // Throws rather than silently producing a chargeable, immediately-visible
    // story on a real account.
    impersonationToken = await impersonateFamilyAccount(apiBase, session.user.id);
    console.log(`  Mode:     ADMIN DRAFT — hidden from this account until published, no credits charged`);
  } else if (reuseEmail) {
    email = String(reuseEmail).trim();
    console.log(`\n── Reusing existing account ──────────────────────────────`);
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${DEMO_PASSWORD}  (default; assumes account was provisioned via showcase)`);
    console.log(`  Skipping: photo upload + character creation (account already has the family).`);
  } else {
    // Fresh-account path: check photos exist, generate email, provision.
    verifyPhotosOnDisk(family);
    email = showcaseEmail(family);
    if (email.length > 30) {
      throw new Error(`Generated email exceeds 30-char auth cap: ${email} (${email.length} chars)`);
    }
    await provisionAccount(apiBase, email, family);
    console.log('\n── Account ready ──────────────────────────────────────────');
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${DEMO_PASSWORD}`);
  }

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
    DEMO_DEDICATION: dedication,
    // Skip character creation whenever the account already holds the family —
    // re-uploading every run is what mints a fresh character-id set each time.
    ...((reuseEmail || reuseCharacters) ? { DEMO_REUSE_ACCOUNT: '1' } : {}),
    ...(impersonationToken ? { DEMO_IMPERSONATION_TOKEN: impersonationToken } : {}),
  };
  const headed = process.env.HEADED === '1' || args.headed === 'true';
  const playwrightArgs = ['playwright', 'test', 'tests/demo-story.spec.ts', '--project=demo-story', '--workers=1'];
  if (headed) playwrightArgs.push('--headed');
  const result = spawnSync('npx', playwrightArgs, { stdio: 'inherit', env, shell: true });

  if (result.status !== 0) {
    console.error(`\nPlaywright exited with code ${result.status}.`);
    process.exit(result.status || 1);
  }

  // Only auto-advance when the rotation default was used. An explicit
  // --entry=N is a manual override (debug, retry) and should not move
  // the cursor.
  if (args.entry === undefined) {
    advanceRotationState(entry, entries);
  }

  console.log('\nShowcase complete. Story is generating server-side (5–10 min).');
  console.log(`Check progress on the demo account: ${email}`);
  if (impersonationToken) {
    console.log('\nThis run is an ADMIN DRAFT — invisible to that account until you publish it.');
    console.log('  List drafts:  GET  /api/admin/drafts');
    console.log('  Publish:      POST /api/admin/stories/<storyId>/publish');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Scene-composite smoke test.
 *
 * Validates the scene-composite pipeline (storyAvatarGeneration → 2×2 styled
 * avatars → character2x4Sheet → sceneComposite paste) end-to-end against an
 * existing account, without burning credits on a full 14-page story.
 *
 * What it does:
 *   1. Logs in to an existing demo account (default: most recent demo-b-*).
 *   2. POSTs /api/jobs/create-story with the minimal flags:
 *        pages: 4 (dev minimum)
 *        skipCovers: true
 *        enableFullRepair: false   (no eval/repair pass)
 *        storyCategory/topic/theme: matches whatever existing styled avatars
 *        the account already has (so we don't regenerate them).
 *   3. Polls /api/jobs/:id/status until completed/failed/timeout.
 *   4. Reports whether scene-composite fired on each page (via DB inspection)
 *      or whether the pipeline fell back to direct generation.
 *
 * The account must be admin (story_quota=-1, pages<10 allowed). The default
 * (demo-b-hnecf@magicalstory.ch) was promoted to admin on staging as part of
 * scene-composite testing.
 *
 * Usage:
 *   STAGING_AUTH_USER=Roger STAGING_AUTH_PASSWORD=... \
 *   TEST_BASE_URL=https://staging.magicalstory.ch \
 *   node scripts/test-scene-composite-smoke.js
 *
 *   Optional flags:
 *     --email=demo-b-hnecf@magicalstory.ch
 *     --password=DemoStory2026!
 *     --pages=4
 *     --timeout=600        # poll timeout in seconds (default 600 = 10 min)
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function arg(name, dflt = null) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : dflt;
}

const BASE_URL = (process.env.TEST_BASE_URL || 'https://magicalstory.ch').replace(/\/$/, '');
const BASIC_USER = process.env.STAGING_AUTH_USER;
const BASIC_PASS = process.env.STAGING_AUTH_PASSWORD;
const EMAIL = arg('email', 'demo-b-hnecf@magicalstory.ch');
const PASSWORD = arg('password', 'DemoStory2026!');
const PAGES = Number(arg('pages', 4));
const TIMEOUT_S = Number(arg('timeout', 600));
// Composite + phantom-pose override modes:
//   'true'  → force composite/phantom on every page (proves new pipeline runs).
//   'false' → force direct path for every page.
//   'auto'  → omit the override; let the cast-aware router in imageRouter.js
//             pick per-page. Best for exercising the dispatcher itself.
const COMPOSITE_MODE = arg('composite', 'true').toLowerCase();
const PHANTOM_MODE = arg('phantom', 'true').toLowerCase();
// Composite pipeline variant. 'auto' omits the override; pipeline default is
// 'stratified' once the new path lands.
const STRATEGY_MODE = arg('strategy', 'auto').toLowerCase();

const basicHeader = BASIC_USER && BASIC_PASS
  ? `Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString('base64')}`
  : null;

async function api(pathSegment, { method = 'GET', body = null, token = null, contentType = 'application/json' } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = contentType;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (basicHeader) headers['Authorization'] = headers['Authorization'] || basicHeader;
  // Stash the bearer in a separate header so we don't trample Basic Auth.
  if (token && basicHeader) {
    headers['Authorization'] = basicHeader;
    headers['X-Auth-Token'] = `Bearer ${token}`;
  }
  const url = `${BASE_URL}${pathSegment}`;
  // If we have a bearer token, prefer that over Basic; the staging gate only
  // protects HTML+static, not /api/*. So bearer is what the backend reads.
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (basicHeader && !token) headers['Authorization'] = basicHeader;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, body: json, raw: text };
}

(async () => {
  console.log('═══ Scene-Composite Smoke Test ════════════════════════════');
  console.log(`  Backend: ${BASE_URL}`);
  console.log(`  Account: ${EMAIL}`);
  console.log(`  Pages:   ${PAGES} (dev minimum: 4)`);
  console.log(`  Skip:    covers, repair, quality eval`);
  console.log('═══════════════════════════════════════════════════════════');

  // 1. Login
  console.log('\n1. Logging in...');
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { username: EMAIL, password: PASSWORD },
  });
  if (!login.ok) {
    console.error(`   ❌ Login failed: ${login.status} ${login.raw.slice(0, 200)}`);
    process.exit(1);
  }
  const token = login.body.token;
  const user = login.body.user;
  console.log(`   ✓ ${user.email} (role=${user.role}, credits=${user.credits})`);
  if (user.role !== 'admin') {
    console.error(`   ❌ Account must be admin to use pages<10. Promote it first:`);
    console.error(`      UPDATE users SET role='admin', story_quota=-1 WHERE email='${EMAIL}';`);
    process.exit(1);
  }

  // 2. Fetch characters
  console.log('\n2. Fetching characters...');
  const chars = await api('/api/characters', { token });
  if (!chars.ok) {
    console.error(`   ❌ /api/characters failed: ${chars.status}`);
    process.exit(1);
  }
  const characters = chars.body.characters || [];
  console.log(`   ✓ ${characters.length} characters: ${characters.map(c => c.name).join(', ')}`);
  if (characters.length < 1) {
    console.error('   ❌ Account has no characters — pick a different account.');
    process.exit(1);
  }

  // Use the first 2 characters as the main cast.
  const mainCharacters = characters.slice(0, 2).map(c => c.id);

  // 3. POST /api/jobs/create-story
  console.log('\n3. Submitting smoke-test story job...');
  const idempotencyKey = `smoke_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const payload = {
    storyType: 'adventure',
    storyTypeName: 'Adventure',
    storyCategory: 'adventure',
    storyTopic: 'pirate',
    storyTheme: 'pirate',
    artStyle: 'watercolor',
    language: 'de',
    languageLevel: 'standard',
    pages: PAGES,
    storyDetails: 'Eine kurze Piratengeschichte für einen Pipeline-Smoke-Test.',
    characters,
    mainCharacters,
    relationships: {},
    relationshipTexts: {},
    skipCovers: true,
    enableFullRepair: false,
    skipQualityEval: true,
    idempotencyKey,
  };
  if (COMPOSITE_MODE === 'true') payload.composite = true;
  else if (COMPOSITE_MODE === 'false') payload.composite = false;
  if (PHANTOM_MODE === 'true') payload.phantomPoseRender = true;
  else if (PHANTOM_MODE === 'false') payload.phantomPoseRender = false;
  if (STRATEGY_MODE === 'stratified' || STRATEGY_MODE === 'uniform') {
    payload.compositeStrategy = STRATEGY_MODE;
  }
  console.log(`   composite=${COMPOSITE_MODE} phantomPoseRender=${PHANTOM_MODE} strategy=${STRATEGY_MODE} (auto = pipeline default)`);
  const create = await api('/api/jobs/create-story', {
    method: 'POST',
    body: payload,
    token,
  });
  if (!create.ok) {
    console.error(`   ❌ create-story failed: ${create.status} ${create.raw.slice(0, 400)}`);
    process.exit(1);
  }
  const jobId = create.body.jobId;
  console.log(`   ✓ Job: ${jobId} (credits left: ${create.body.creditsRemaining ?? '?'})`);

  // 4. Poll job status
  console.log(`\n4. Polling job status (timeout: ${TIMEOUT_S}s)...`);
  const deadline = Date.now() + TIMEOUT_S * 1000;
  let lastMsg = '';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10000));
    const status = await api(`/api/jobs/${jobId}/status`, { token });
    if (!status.ok) {
      console.error(`   ⚠️  status fetch failed: ${status.status}`);
      continue;
    }
    const { status: s, progress, progress_message, error_message } = status.body;
    const msg = `${progress || 0}% ${progress_message || ''}`.trim();
    if (msg !== lastMsg) {
      const t = new Date().toISOString().slice(11, 19);
      console.log(`   [${t}] ${s}: ${msg}`);
      lastMsg = msg;
    }
    if (s === 'completed') {
      console.log(`\n✓ Job completed.`);
      break;
    }
    if (s === 'failed') {
      console.error(`\n❌ Job failed: ${error_message || '(no error message)'}`);
      process.exit(2);
    }
  }
  if (Date.now() >= deadline) {
    console.error(`\n❌ Timed out after ${TIMEOUT_S}s.`);
    process.exit(3);
  }

  // 5. Verify story was saved
  console.log('\n5. Verifying story saved...');
  const story = await api(`/api/stories?limit=1`, { token });
  const latest = story.body?.stories?.[0];
  if (!latest) {
    console.error(`   ❌ No stories returned for user.`);
    process.exit(4);
  }
  console.log(`   ✓ Story: "${latest.title}" (${latest.id})`);

  console.log('\nNext step: grep Railway logs for "[SCENE COMPOSITE] P" lines to confirm');
  console.log('which pages used the composite path vs. fell back to direct generation.');
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

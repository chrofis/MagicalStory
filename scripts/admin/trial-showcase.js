#!/usr/bin/env node
/**
 * Trial showcase — run ONE real trial story end-to-end and report it.
 *
 * The trial equivalent of scripts/admin/showcase.js. Drives the same public
 * trial API the /try wizard uses (no browser): analyze-photo →
 * generate-preview-avatar → create-anonymous-account → create-story → poll.
 * Turnstile and the fingerprint check are bypassed with the purpose-scoped
 * admin HMAC from GET /api/trial/admin-bypass-token (5-min TTL, admin JWT
 * required) — the same bypass tests/trial-to-full.spec.ts uses.
 *
 * WHY NOT Playwright: the wizard flow is a thin client over these endpoints;
 * driving them directly removes browser flakiness and the Turnstile problem,
 * and makes the run reproducible from a rotation file.
 *
 * A trial has EXACTLY ONE character. Rotation entries therefore name a single
 * curated demo face (tests/fixtures/demo-photos/{family}/{face}).
 *
 * Usage:
 *   node scripts/admin/trial-showcase.js                  # next rotation entry, STAGING
 *   node scripts/admin/trial-showcase.js --entry=2        # specific entry
 *   node scripts/admin/trial-showcase.js --base=https://magicalstory.ch
 *   node scripts/admin/trial-showcase.js --dry-run        # print the plan, call nothing paid
 *   node scripts/admin/trial-showcase.js --no-wait        # fire and exit (job id printed)
 *
 * COST: one trial = 5 pages + title page + one preview avatar ≈ CHF 0.20–0.35.
 * Per CLAUDE.md this is a paid run — only launch when the owner asked for it.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { ch, chTime } = require('../lib/chTime');

const ROTATION_PATH = path.join(__dirname, '..', '..', 'tests', 'helpers', 'trial-rotation.json');
const STATE_PATH = path.join(__dirname, '..', '..', 'tests', 'trial-showcase-state.json');
const PHOTO_ROOT = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'demo-photos');
const DEFAULT_BASE = 'https://staging.magicalstory.ch';
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

function parseArgs() {
  const out = { base: DEFAULT_BASE, entry: null, dryRun: false, wait: true, over: {} };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--entry=')) out.entry = Number(a.split('=')[1]);
    else if (a.startsWith('--base=')) out.base = a.split('=')[1].replace(/\/$/, '');
    // Per-run overrides of the rotation entry — e.g. --theme=wizard picks the
    // wizard costume (adventure topics in server/config/trialCostumes.js).
    else if (a.startsWith('--category=')) out.over.storyCategory = a.split('=')[1];
    else if (a.startsWith('--topic=')) out.over.storyTopic = a.split('=')[1];
    else if (a.startsWith('--theme=')) out.over.storyTheme = a.split('=')[1];
    else if (a.startsWith('--details=')) out.over.storyDetails = a.slice('--details='.length);
    // Without this the server geolocates the caller's IP — every run from the
    // owner's machine landed in Adlikon.
    else if (a.startsWith('--city=')) out.over.city = a.split('=')[1];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-wait') out.wait = false;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); process.exit(1); }
  }
  return out;
}

function pickEntry(explicitIndex) {
  const { entries } = JSON.parse(fs.readFileSync(ROTATION_PATH, 'utf8'));
  if (explicitIndex != null) {
    const e = entries.find(x => x.index === explicitIndex);
    if (!e) { console.error(`no rotation entry with index ${explicitIndex} (0..${entries.length - 1})`); process.exit(1); }
    return { entry: e, entries };
  }
  let next = 0;
  try { next = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).nextIndex ?? 0; } catch { /* first run */ }
  const entry = entries.find(x => x.index === next % entries.length) || entries[0];
  return { entry, entries };
}

function advanceState(entry, entries) {
  const nextIndex = (entry.index + 1) % entries.length;
  fs.writeFileSync(STATE_PATH, JSON.stringify({ nextIndex, lastRunAt: new Date().toISOString(), lastEntry: entry.index }, null, 2) + '\n');
}

function adminJwt(base) {
  // Canonical path (CLAUDE.md → "Admin API auth"). Never hand-roll a login.
  const args = [path.join(__dirname, 'get-admin-token.js')];
  if (!/staging\./.test(base)) args.push(`--base=${base}`);
  return execFileSync('node', args, { encoding: 'utf8' }).trim();
}

async function api(base, route, { method = 'POST', body, bearer, raw = false } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text.slice(0, 300)}`);
  if (raw) return text;
  try { return JSON.parse(text); } catch { return text; }
}

function faceDataUri(entry) {
  const p = path.join(PHOTO_ROOT, entry.family, entry.face);
  if (!fs.existsSync(p)) {
    console.error(`photo not found: ${p}\nGenerate demo photos first (scripts/admin/generate-demo-photos.js) or fix the rotation entry.`);
    process.exit(1);
  }
  return 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');
}

(async () => {
  const args = parseArgs();
  const picked = pickEntry(args.entry);
  const entries = picked.entries;
  const entry = { ...picked.entry, ...args.over };
  const envLabel = /staging\./.test(args.base) ? 'STAGING' : 'PRODUCTION';

  console.log('─'.repeat(72));
  console.log(`TRIAL SHOWCASE — entry ${entry.index}: ${entry.description}`);
  console.log(`  environment : ${envLabel} (${args.base})`);
  console.log(`  character   : ${entry.name} (${entry.age}, ${entry.gender}) — ${entry.family}/${entry.face}`);
  console.log(`  story       : ${entry.storyCategory}${entry.storyTopic ? ` / ${entry.storyTopic}` : ''} [${entry.language}]`);
  console.log(`  started     : ${ch(new Date())}`);
  console.log('─'.repeat(72));

  if (args.dryRun) {
    console.log('--dry-run: no paid calls made. Photo resolves:', path.join(PHOTO_ROOT, entry.family, entry.face));
    return;
  }

  const t0 = Date.now();
  const jwt = adminJwt(args.base);
  const { token: adminToken } = await api(args.base, '/api/trial/admin-bypass-token', { method: 'GET', bearer: jwt });
  console.log(`[${chTime(new Date())}] admin bypass token acquired (Turnstile + fingerprint skipped)`);

  const facePhoto = faceDataUri(entry);

  // 1. Photo analysis — same call the wizard makes; yields the physical traits
  //    the trial writer needs (hair/eyes/skin) plus the face box.
  const analysis = await api(args.base, '/api/trial/analyze-photo', { body: { imageData: facePhoto, adminToken } });
  const traits = analysis.traits || analysis.physical || {};
  console.log(`[${chTime(new Date())}] photo analysed — faces: ${analysis.faces?.length ?? 'n/a'}, traits: ${Object.keys(traits).join(',') || 'none'}`);

  // 2. Preview avatar — the wizard generates one before account creation, and
  //    the pipeline seeds avatars.standard from it. Skipping it would diverge
  //    from the real trial path.
  let previewAvatar = null;
  try {
    const av = await api(args.base, '/api/trial/generate-preview-avatar', {
      body: { name: entry.name, age: entry.age, gender: entry.gender, facePhoto, adminToken },
    });
    previewAvatar = av.avatarImage || null;
    console.log(`[${chTime(new Date())}] preview avatar generated`);
  } catch (e) {
    console.warn(`[${chTime(new Date())}] preview avatar failed (${e.message.slice(0, 120)}) — continuing without it`);
  }

  // 3. Anonymous trial account (fresh every run → the one-trial-per-user cap
  //    never blocks a showcase).
  const acct = await api(args.base, '/api/trial/create-anonymous-account', {
    body: {
      name: entry.name, age: entry.age, gender: entry.gender,
      traits, facePhoto, previewAvatar, adminToken,
    },
  });
  console.log(`[${chTime(new Date())}] trial account ${acct.userId} created`);

  // 4. Start the story.
  const started = await api(args.base, '/api/trial/create-story', {
    bearer: acct.sessionToken,
    body: {
      storyCategory: entry.storyCategory,
      storyTopic: entry.storyTopic || '',
      storyTheme: entry.storyTheme || '',
      storyDetails: entry.storyDetails || '',
      language: entry.language,
      ...(entry.city ? { userLocation: { city: entry.city, country: 'Switzerland' } } : {}),
    },
  });
  const jobId = started.jobId || started.id;
  console.log(`[${chTime(new Date())}] story job ${jobId} started`);
  advanceState(entry, entries);

  if (!args.wait) {
    console.log(`--no-wait: poll yourself → GET ${args.base}/api/trial/job-status/${jobId}`);
    return;
  }

  // 5. Poll to completion.
  let last = -1;
  while (Date.now() - t0 < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 10000));
    let st;
    try {
      st = await api(args.base, `/api/trial/job-status/${jobId}`, { method: 'GET', bearer: acct.sessionToken });
    } catch (e) { console.warn(`  poll error: ${e.message.slice(0, 120)}`); continue; }
    if (st.progress !== last) {
      console.log(`  [${chTime(new Date())}] ${st.status}: ${st.progress}% ${st.progress_message || st.progressMessage || ''}`);
      last = st.progress;
    }
    if (st.status === 'completed' || st.status === 'failed') {
      const secs = Math.round((Date.now() - t0) / 1000);
      console.log('─'.repeat(72));
      console.log(`${st.status.toUpperCase()} in ${secs}s (${(secs / 60).toFixed(1)} min)`);
      if (st.error_message) console.log(`error: ${st.error_message}`);
      console.log(`story : ${args.base}/create?storyId=${jobId}`);
      console.log(`job   : ${jobId}`);
      console.log(`Compare against the trial speed baseline: 123s end-to-end (last real prod trial, 5 pages).`);
      console.log('─'.repeat(72));
      process.exit(st.status === 'completed' ? 0 : 1);
    }
  }
  console.error(`timeout after ${Math.round(POLL_TIMEOUT_MS / 60000)} min — job ${jobId} still running`);
  process.exit(2);
})().catch(e => { console.error(`trial-showcase failed: ${e.message}`); process.exit(1); });

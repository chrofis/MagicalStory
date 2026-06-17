#!/usr/bin/env node
/**
 * Cross-browser diagnostic for the /try funnel: where do users actually get
 * stuck — the intro, the consent gate, the photo upload, face detection, or
 * the avatar-gen wait?
 *
 * Walks intro → consent → photo upload → face detect → name/gender → avatar
 * preview ready (Next enabled). STOPS before story generation (cheap).
 *
 * Uses an admin JWT to bypass Turnstile/fingerprint (Playwright can't solve
 * Cloudflare) — so this tests UI MECHANICS across engines, NOT the Turnstile
 * challenge real users hit. Run sequentially (16GB RAM safety).
 *
 * Usage: node tests/manual/trial-funnel-probe.js
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { chromium, firefox, webkit, devices } = require('@playwright/test');
const jwt = require('jsonwebtoken');

const BASE = process.env.TEST_BASE_URL || 'https://magicalstory.ch';
const PHOTO = 'C:/Users/roger/OneDrive/Pictures/For automatic testing/Roger.jpg';
const OUT = path.resolve(__dirname, '..', '_probe');
fs.mkdirSync(OUT, { recursive: true });

function adminJwt() {
  return jwt.sign(
    { id: '1764881868108', userId: '1764881868108', username: 'rogerfischer',
      role: 'admin', email: 'rogerfischer@hotmail.com', emailVerified: true },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );
}

const MATRIX = [
  { id: 'desktop-chrome',  engine: chromium, device: devices['Desktop Chrome'] },
  { id: 'desktop-firefox', engine: firefox,  device: devices['Desktop Firefox'] },
  { id: 'desktop-safari',  engine: webkit,   device: devices['Desktop Safari'] },
  { id: 'mobile-chrome',   engine: chromium, device: devices['Pixel 5'] },
  { id: 'mobile-safari',   engine: webkit,   device: devices['iPhone 12'] },
];

async function probe({ id, engine, device }) {
  const r = { id, stalledAt: null, errors: [], failed: [], avatarMs: null, milestones: [] };
  const token = adminJwt();
  const browser = await engine.launch();
  const ctx = await browser.newContext({
    ...device,
    ...(process.env.STAGING_AUTH_PASSWORD && BASE.includes('staging')
      ? { httpCredentials: { username: process.env.STAGING_AUTH_USER || 'staging', password: process.env.STAGING_AUTH_PASSWORD } }
      : {}),
  });
  await ctx.addInitScript((t) => window.localStorage.setItem('auth_token', t), token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => r.errors.push(String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') r.errors.push('[console] ' + m.text().slice(0, 160)); });
  page.on('requestfailed', (req) => r.failed.push(`${req.method()} ${req.url().slice(0, 90)} — ${req.failure()?.errorText || '?'}`));

  const shot = async (name) => { try { await page.screenshot({ path: path.join(OUT, `${id}-${name}.png`), fullPage: false }); } catch {} };
  const mark = (m) => { r.milestones.push(m); };

  try {
    await page.goto(`${BASE}/try`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    mark('loaded'); await shot('1-intro');

    // Intro CTA
    try {
      await page.locator('button.bg-indigo-500').first().click({ timeout: 10000 });
      mark('intro-cta');
    } catch { r.stalledAt = 'intro-cta'; throw new Error('intro CTA not clickable'); }

    // Consent checkboxes (click each svg)
    const rows = page.locator('div.flex.items-start.gap-3.cursor-pointer.group');
    try {
      await rows.first().waitFor({ state: 'visible', timeout: 20000 });
      const n = await rows.count();
      for (let i = 0; i < n; i++) await rows.nth(i).locator('svg').first().click({ force: true });
      mark(`consent(${n})`);
    } catch { r.stalledAt = 'consent'; await shot('2-consent-fail'); throw new Error('consent rows not found'); }
    await shot('2-consent');

    // Photo upload
    try {
      await page.locator('input[type=file]').first().setInputFiles(PHOTO);
      mark('photo-set');
    } catch { r.stalledAt = 'photo-upload'; throw new Error('file input not usable: ' + id); }

    // Face detection → a non-empty preview image appears
    try {
      await page.locator('img[alt]').filter({ hasNot: page.locator('[alt=""]') }).first()
        .waitFor({ state: 'visible', timeout: 60000 });
      mark('face-detected');
    } catch { r.stalledAt = 'face-detection'; await shot('3-face-fail'); throw new Error('face detection timed out'); }
    await page.waitForTimeout(2000);
    await shot('3-after-upload');

    // Name + gender
    try {
      await page.locator('input[type=text]').filter({ hasNot: page.locator('[type=file]') }).first().fill('Probe');
      await page.getByRole('button', { name: /^(boy|junge|gar[çc]on|male|m[äa]nnlich)\s*$/i }).first().click({ timeout: 10000 });
      mark('name-gender');
    } catch { r.stalledAt = 'name-gender'; await shot('4-namegender-fail'); throw new Error('name/gender controls missing'); }

    // Avatar preview generation — Next flips from disabled to enabled
    const t0 = Date.now();
    try {
      const next = page.locator('button').filter({ hasText: /^(weiter|next|continue|suivant)\s*$/i }).first();
      await next.waitFor({ state: 'visible', timeout: 5000 });
      await next.click({ trial: true, timeout: 130000 }); // trial:true waits for actionable(enabled) without firing
      r.avatarMs = Date.now() - t0;
      mark('avatar-ready');
    } catch { r.stalledAt = 'avatar-generation'; r.avatarMs = Date.now() - t0; await shot('5-avatar-fail'); throw new Error('avatar gen / Next never enabled'); }
    await shot('5-next-enabled');
    mark('REACHED-TOPIC-STEP (stopped here, no story gen)');
  } catch (e) {
    r.errors.push('FLOW: ' + e.message);
  } finally {
    await browser.close();
  }
  return r;
}

(async () => {
  const only = process.argv[2];
  const matrix = only ? MATRIX.filter((m) => m.id === only) : MATRIX;
  console.log(`Probing ${BASE}/try across ${matrix.length} browser(s) (admin-bypass; Turnstile NOT exercised)\n`);
  const results = [];
  for (const m of matrix) {
    process.stdout.write(`▶ ${m.id} ... `);
    const r = await probe(m);
    console.log(r.stalledAt ? `STALLED at ${r.stalledAt}` : `OK (avatar ${Math.round((r.avatarMs||0)/1000)}s)`);
    results.push(r);
  }
  console.log('\n══════════ SUMMARY ══════════');
  for (const r of results) {
    console.log(`\n■ ${r.id}`);
    console.log('  reached:', r.milestones.join(' → ') || '(nothing)');
    console.log('  result:', r.stalledAt ? `❌ STALLED at ${r.stalledAt}` : '✅ reached topic step');
    if (r.avatarMs != null) console.log('  avatar gen:', Math.round(r.avatarMs / 1000) + 's');
    if (r.errors.length) console.log('  errors:', JSON.stringify(r.errors.slice(0, 5), null, 1));
    if (r.failed.length) console.log('  failed requests:', JSON.stringify(r.failed.slice(0, 5), null, 1));
  }
  console.log(`\nScreenshots: ${OUT}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });

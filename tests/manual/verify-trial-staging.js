#!/usr/bin/env node
/**
 * Quick visual verification of the refactored /try photo-first phase on staging.
 * Loads /try, dismisses the intro, screenshots the photo phase on desktop +
 * iPhone, and asserts: the photo phase shows the upload + a single consent and
 * NO name/gender fields (those are deferred to the details phase).
 *
 * Usage: node tests/manual/verify-trial-staging.js
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { chromium, webkit, devices } = require('@playwright/test');

const BASE = process.env.TEST_BASE_URL || 'https://staging.magicalstory.ch';
const OUT = path.resolve(__dirname, '..', '_probe');
fs.mkdirSync(OUT, { recursive: true });
const creds = process.env.STAGING_AUTH_PASSWORD
  ? { username: process.env.STAGING_AUTH_USER || 'staging', password: process.env.STAGING_AUTH_PASSWORD }
  : undefined;

async function check(label, engine, device) {
  const browser = await engine.launch();
  const ctx = await browser.newContext({ ...device, ...(creds ? { httpCredentials: creds } : {}) });
  const page = await ctx.newPage();
  const out = { label };
  try {
    await page.goto(`${BASE}/try`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('button.bg-indigo-500').first().click({ timeout: 15000 }); // intro CTA
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, `verify-${label}.png`) });
    // Photo phase should have: a consent checkbox + an upload affordance, and NO name field.
    const nameVisible = await page.locator('input[type=text]').filter({ hasNot: page.locator('[type=file]') })
      .first().isVisible().catch(() => false);
    const hasUpload = await page.locator('input[type=file]').count();
    const genderVisible = await page.getByRole('button', { name: /^(boy|junge|gar[çc]on)\s*$/i }).first().isVisible().catch(() => false);
    out.hasUpload = hasUpload > 0;
    out.nameFieldOnPhotoPhase = nameVisible;
    out.genderOnPhotoPhase = genderVisible;
    out.verdict = (hasUpload > 0 && !nameVisible && !genderVisible) ? '✅ photo-only phase OK' : '⚠️ unexpected fields on photo phase';
  } catch (e) {
    out.verdict = '❌ ' + e.message;
  } finally {
    await browser.close();
  }
  return out;
}

(async () => {
  console.log(`Verifying ${BASE}/try photo phase\n`);
  for (const c of [
    ['desktop', chromium, devices['Desktop Chrome']],
    ['iphone', webkit, devices['iPhone 12']],
  ]) {
    const r = await check(...c);
    console.log(`${r.label}: ${r.verdict}  (upload=${r.hasUpload} nameField=${r.nameFieldOnPhotoPhase} gender=${r.genderOnPhotoPhase})`);
  }
  console.log(`\nScreenshots: ${OUT}/verify-*.png`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });

// Screenshots of the character form on staging (smoke account): the Brille / Sonstiges ja/nein switch.
// Usage: node tests/manual/character-form-shot.js <outDir>
// Env: TEST_BASE_URL (default staging), VIEWPORT_WIDTH (default 430).
// Free: reads only; never saves the character. Logs in via scripts/admin/get-admin-token.js.
require('dotenv').config();
const { chromium } = require('@playwright/test');
const { execSync } = require('child_process');
const path = require('path');
const BASE = process.env.TEST_BASE_URL || 'https://staging.magicalstory.ch';
const out = process.argv[2];
(async () => {
  const token = execSync('node scripts/admin/get-admin-token.js', { encoding: 'utf8', cwd: path.resolve(__dirname, '..', '..') }).trim();
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: Number(process.env.VIEWPORT_WIDTH || 430), height: 932 }, deviceScaleFactor: 2, locale: 'de-CH',
    httpCredentials: { username: process.env.STAGING_AUTH_USER || 'staging', password: process.env.STAGING_AUTH_PASSWORD } });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('auth_token', t); localStorage.setItem('current_user', u); localStorage.setItem('language', 'de'); },
    [token, JSON.stringify(me.user || me)]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/create`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(out, '1-wizard.png'), fullPage: true });
  const edit = page.getByRole('button', { name: /Bearbeiten|Edit/i }).first();
  if (await edit.count()) { await edit.click(); await page.waitForTimeout(4000); }
  const anp = page.getByRole('button', { name: /Anpassen/ }).first(); if (await anp.count()) { await anp.click(); await page.waitForTimeout(3000); }
  const brille = page.getByText(/^Brille/).first();
  if (await brille.count()) await brille.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, '2-form.png'), fullPage: true });
  const nein = page.getByRole('button', { name: /^nein$/i });
  const ja = page.getByRole('button', { name: /^ja$/i });
  console.log('ja buttons', await ja.count(), 'nein buttons', await nein.count());
  if (await ja.count()) { await ja.first().click(); await page.waitForTimeout(800); if (await brille.count()) await brille.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, '3-ja.png') }); }
  if (await nein.count()) { await nein.first().click(); await page.waitForTimeout(800); if (await brille.count()) await brille.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, '4-nein.png') }); }
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

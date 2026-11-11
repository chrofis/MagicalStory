// Screenshot of the book builder (order page) on staging for a smoke-account story with blank pages.
// Usage: node tests/manual/book-builder-shot.js <outDir> [storyId[,storyId...]] [tick]
// Free: only reads (book-page-info, square covers are reused). Logs in via scripts/admin/get-admin-token.js.
require('dotenv').config();
const { chromium } = require('@playwright/test');
const { execSync } = require('child_process');
const path = require('path');
const BASE = process.env.TEST_BASE_URL || 'https://staging.magicalstory.ch';
const out = process.argv[2];
const storyId = process.argv[3] || 'job_1794128424739_0j933o99i5u';
const tick = process.argv[4] === 'tick';
(async () => {
  const token = execSync('node scripts/admin/get-admin-token.js', { encoding: 'utf8', cwd: path.resolve(__dirname, '..', '..') }).trim();
  const H = { Authorization: `Bearer ${token}` };
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: H })).json();
  const ids = storyId.split(',');
  const titles = [];
  for (const id of ids) { const m = await (await fetch(`${BASE}/api/stories/${id}/quick-metadata`, { headers: H })).json(); titles.push(m.title || (m.story && m.story.title)); }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, locale: 'de-CH',
    httpCredentials: { username: process.env.STAGING_AUTH_USER || 'staging', password: process.env.STAGING_AUTH_PASSWORD } });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('auth_token', t); localStorage.setItem('current_user', u); localStorage.setItem('language', 'de'); },
    [token, JSON.stringify(me.user || me)]);
  const page = await ctx.newPage();
  // The real customer path: My Stories -> "Hinzufügen" on the story card -> "Buch erstellen".
  await page.goto(`${BASE}/stories`, { waitUntil: 'domcontentloaded' });
  // My Stories auto-loads 18 stories, then shows a "load all" button; older test stories sit behind it.
  await page.waitForTimeout(6000);
  const loadAll = page.getByRole('button', { name: /Alle (Geschichten )?(laden|anzeigen)|Load all|Show all/i });
  if (await loadAll.count()) { await loadAll.first().click(); await page.waitForTimeout(8000); }
  for (const title of titles) {
    const card = page.locator('div').filter({ hasText: title }).filter({ has: page.getByRole('button', { name: /^Hinzufügen$/ }) }).last();
    await card.getByRole('button', { name: /^Hinzufügen$/ }).click({ timeout: 60000 });
  }
  await page.getByRole('button', { name: /Buch erstellen/ }).first().click();
  await page.waitForURL(/book-builder/);
  await page.waitForTimeout(15000);
  if (tick) { await page.getByRole('radio', { name: /leeren Seiten drucken|leere Seite drucken/ }).last().click(); await page.waitForTimeout(500); }
  await page.screenshot({ path: path.join(out, 'full.png'), fullPage: true });
  const btn = page.getByRole('button', { name: /Buch bestellen|Bestellen|Order/ }).last();
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: path.join(out, 'button.png') });
  console.log('button disabled:', await btn.isDisabled().catch(e => 'n/a ' + e.message));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

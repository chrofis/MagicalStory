#!/usr/bin/env node
/**
 * Open Google Ads Asset Studio via Playwright with a persistent browser profile.
 *
 * First run: a Chromium window opens, you sign in to your Google account manually,
 * then press Enter in the terminal. Session is stored in scripts/ads/.playwright-profile
 * (git-ignored) — subsequent runs reuse the login, no re-auth needed.
 *
 * Usage:
 *   node scripts/ads/inspect-assetstudio.js [url]
 *   # defaults to the Asset Studio URL supplied by the user
 */
const { chromium } = require('@playwright/test');
const path = require('path');
const readline = require('readline');

const DEFAULT_URL = 'https://ads.google.com/aw/assetstudio?ocid=8067682495&euid=6447865379&__u=5176301771&uscid=8067682495&__c=7813413255&authuser=0';

function waitForEnter(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => { rl.close(); resolve(); });
  });
}

(async () => {
  const url = process.argv[2] || DEFAULT_URL;
  const profileDir = path.join(__dirname, '.playwright-profile');

  console.log(`→ Launching Chromium with persistent profile at ${profileDir}`);
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    // Use channel: 'chrome' if you'd rather use installed Chrome; default is bundled Chromium.
  });
  const page = context.pages()[0] || await context.newPage();

  console.log(`→ Navigating to Asset Studio`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Let the page settle; Ads UI is heavy on JS.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  const currentUrl = page.url();
  const title = await page.title();
  console.log(`\nCurrent URL: ${currentUrl}`);
  console.log(`Page title:  ${title}`);

  if (/accounts\.google\.com/.test(currentUrl)) {
    console.log('\n⚠️  Redirected to Google sign-in — this profile is not authenticated.');
    console.log('   Sign in in the browser window, click through any 2FA, land back on ads.google.com.');
    await waitForEnter('   When you are on the Asset Studio page, press Enter here to continue → ');
  }

  // Dump page info
  const outDir = path.join(__dirname, '..', '..', 'tmp', 'ads-inspect');
  require('fs').mkdirSync(outDir, { recursive: true });
  const shotPath = path.join(outDir, `assetstudio-${Date.now()}.png`);
  await page.screenshot({ path: shotPath, fullPage: true });
  console.log(`\n📸 Screenshot saved: ${shotPath}`);

  // Extract visible buttons and tabs for quick orientation
  const controls = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a[role="button"], [role="tab"]')];
    return els
      .filter(e => e.offsetParent !== null)
      .map(e => ({
        tag: e.tagName.toLowerCase(),
        role: e.getAttribute('role') || '',
        text: (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 80),
      }))
      .filter(c => c.text)
      .slice(0, 60);
  });
  console.log(`\nVisible controls on page (first 60):`);
  for (const c of controls) console.log(`  [${c.tag}${c.role ? ' ' + c.role : ''}] ${c.text}`);

  console.log('\nBrowser stays open. Close it manually when done, or Ctrl+C the script.');
  await waitForEnter('Press Enter to close the browser and exit → ');
  await context.close();
})().catch((e) => { console.error(e); process.exit(1); });

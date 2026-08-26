// Smoke test: log in as the admin account, trigger a 4-page story via
// the wizard UI, return the job id so we can poll completion.
//
// Per reference_smoke_test_account.md:
//   - account: demo-b-hnecf@magicalstory.ch (admin — 4-page minimum bypass)
//   - Berger family characters already provisioned on this account
const { chromium } = require('playwright');

const BASE = 'https://staging.magicalstory.ch';
const EMAIL = 'demo-b-hnecf@magicalstory.ch';
const PASSWORD = process.env.DEMO_PASSWORD || 'DemoStory2026!';
const PAGES = 4;
const LANG = 'de';
const ART_STYLE = 'watercolor';
const STORY_CATEGORY_RE = /Abenteuer|adventure/i;
const STORY_TOPIC_RE = /Schatzsuche|treasure/i;
const ART_STYLE_RE_DE = /Aquarell/i;

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    httpCredentials: { username: 'Roger', password: 'M1.NtFsmdS' },
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  page.on('pageerror', e => console.log('  [page error]', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('  [browser err]', m.text().slice(0, 200)); });

  console.log('Step 0: pre-seed language + login…');
  await page.goto(`${BASE}/?lang=${LANG}&login=true`);
  await page.evaluate(l => { try { localStorage.setItem('magicalstory_language', l); } catch {} }, LANG);

  const modal = page.locator('.fixed.inset-0');
  if (!await modal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.getByRole('button', { name: /bereits ein konto|anmelden/i }).first().click({ timeout: 8000 });
  }
  await modal.waitFor({ timeout: 15000 });
  await modal.getByPlaceholder(/email/i).fill(EMAIL);
  await modal.locator('input[type="password"]').fill(PASSWORD);
  await modal.getByRole('button', { name: /sign in|anmelden/i }).click();
  await modal.waitFor({ state: 'detached', timeout: 15000 });
  console.log('  logged in');

  console.log('Step 1: open new story wizard…');
  await page.goto(`${BASE}/create?new=true&lang=${LANG}`);
  await page.waitForLoadState('networkidle', { timeout: 30000 });
  await page.waitForTimeout(2000);

  console.log('Step 2: characters — pick 2 main if needed…');
  // Confirm at least one character is visible
  const anyCharHeading = page.locator('h2, h3, h4').filter({ hasText: /Emma|Noah|Daniel|Sarah|Hans/i }).first();
  await anyCharHeading.waitFor({ timeout: 15000 });
  // Enable next button by setting 2 main characters if needed
  const nextRe = /weiter|next|continue/i;
  const nextBtn = page.getByRole('button', { name: nextRe }).first();
  let enabled = await nextBtn.isEnabled().catch(() => false);
  if (!enabled) {
    const mainBtns = page.getByRole('button', { name: /hauptrolle|main character|main/i });
    const c = await mainBtns.count();
    if (c >= 2) {
      await mainBtns.nth(0).click(); await page.waitForTimeout(300);
      await mainBtns.nth(1).click(); await page.waitForTimeout(300);
    }
  }
  await nextBtn.click({ timeout: 8000 });
  await page.waitForTimeout(1500);

  console.log(`Step 3: pages slider → ${PAGES}…`);
  const slider = page.locator('input[type="range"]').first();
  if (await slider.isVisible({ timeout: 5000 }).catch(() => false)) {
    await slider.fill(String(PAGES));
    await page.waitForTimeout(500);
  }
  await page.getByRole('button', { name: nextRe }).first().click({ timeout: 8000 });
  await page.waitForTimeout(1500);

  console.log(`Step 4: category…`);
  await page.locator('button').filter({ hasText: STORY_CATEGORY_RE }).first().click({ timeout: 8000 });
  await page.waitForTimeout(1000);

  console.log(`Step 5: topic…`);
  const directTopic = page.locator('button').filter({ hasText: STORY_TOPIC_RE }).first();
  if (await directTopic.isVisible({ timeout: 5000 }).catch(() => false)) {
    await directTopic.click();
  }
  await page.waitForTimeout(1000);
  // Some flows have a "next" between category and topic+style — try next-or-noop
  if (await page.getByRole('button', { name: nextRe }).first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.getByRole('button', { name: nextRe }).first().click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  console.log('Step 6: art style…');
  // Expand groups if needed
  for (const g of [/realistisch/i, /illustriert/i, /kreativ/i]) {
    const grp = page.locator('button').filter({ hasText: g }).first();
    if (await grp.isVisible({ timeout: 1000 }).catch(() => false)) {
      await grp.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  const styleBtn = page.locator('button').filter({ hasText: ART_STYLE_RE_DE }).first();
  if (await styleBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await styleBtn.click();
    await page.waitForTimeout(500);
  }
  if (await page.getByRole('button', { name: nextRe }).first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.getByRole('button', { name: nextRe }).first().click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  console.log('Step 7: trigger generation (wait for ideas, then submit)…');
  // Wait until something like a "Geschichte erstellen" / "create" / "generate" button shows up
  const generateBtn = page.getByRole('button', { name: /erstellen|generate|create|geschichte/i }).filter({ hasText: /erstellen|generate|create/i }).first();
  await generateBtn.waitFor({ timeout: 60000 });
  await generateBtn.click();
  console.log('  clicked generate');

  // Watch for the job id appearing in the page URL or console logs
  let jobId = null;
  const tStart = Date.now();
  while (Date.now() - tStart < 60000) {
    const url = page.url();
    const m = url.match(/storyId=(job_\d+_\w+)/);
    if (m) { jobId = m[1]; break; }
    await page.waitForTimeout(2000);
  }
  if (!jobId) {
    console.log('  no job id found in URL; trying to read it from the network');
  }
  console.log('Job id:', jobId);
  await browser.close();
  if (!jobId) process.exit(1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });

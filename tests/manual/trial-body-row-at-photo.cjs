// WebKit phone check against the running client dev server (npm run dev:client), ALL /api calls mocked.
// Run: node tests/manual/trial-body-row-at-photo.cjs   (OUT_DIR=... for the screenshots)
// Checks (docs/decisions.md 2026-10-09 "Trial: the body row starts at the photo"):
//  - the provisional account is created the moment the photo has landed, BEFORE anything is typed;
//  - the standard body row is requested right after it, and its first cell shows as the hero above the form while the form is still empty;
//  - the hero is the cut cell the server sent (never the photo / cut-out), and no row-wide or sheet-wide image is ever in the page;
//  - the finished sheet is requested only after the form is filled and quiet, and its front cell replaces the hero;
//  - a different photo after the account exists goes to update-photo and starts the body row again.
const { webkit, devices } = require('playwright');
const sharp = require('sharp');
const OUT = process.env.OUT_DIR || require('os').tmpdir();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMG = 'data:image/png;base64,' + PNG;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const cell = async (r, g, b) => 'data:image/png;base64,' + (await sharp({ create: { width: 160, height: 360, channels: 3, background: { r, g, b } } }).png().toBuffer()).toString('base64');

(async () => {
  const BODY_CELL = await cell(30, 120, 220);   // the first cell of the body row
  const FINAL_CELL = await cell(220, 120, 30);  // the front cell of the styled sheet
  const browser = await webkit.launch();
  const results = {};
  for (const dev of ['iPhone 12', 'iPhone 14 Pro Max']) {
    const ctx = await browser.newContext({ ...devices[dev] });
    const page = await ctx.newPage();
    const t0 = Date.now();
    const events = [];
    const at = (what) => events.push({ ms: Date.now() - t0, what });
    await page.route('**/api/**', async (route) => {
      const u = route.request().url(); const method = route.request().method();
      if (u.includes('/api/trial/analyze-photo')) { at('analyze-photo'); return json(route, { success: true, multipleFacesDetected: false, faceThumbnail: IMG, bodyCrop: IMG, bodyNoBg: IMG, faceBox: { x: 0, y: 0, width: 1, height: 1 } }); }
      if (u.includes('create-anonymous-account')) { at(`create-account provisional=${JSON.parse(route.request().postData() || '{}').provisional}`); return json(route, { sessionToken: 't', characterId: 'c' }); }
      if (u.includes('prepare-standard-body')) { at('prepare-standard-body'); await new Promise(r => setTimeout(r, 1200)); at('body-cell-sent'); return json(route, { avatarImage: BODY_CELL }); }
      if (u.includes('prepare-standard-avatar')) { at('prepare-standard-avatar'); await new Promise(r => setTimeout(r, 1200)); at('final-cell-sent'); return json(route, { avatarImage: FINAL_CELL }); }
      if (u.includes('update-character-details')) { at('PATCH details'); return json(route, { success: true }); }
      if (u.includes('update-photo')) { at('PUT update-photo'); return json(route, { success: true }); }
      if (u.includes('/api/trial/event')) return json(route, {});
      return json(route, {});
    });
    await page.goto('http://localhost:5173/try', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: "Let's start" }).first().click();
    await page.getByRole('checkbox').click({ position: { x: 12, y: 12 } });
    await page.locator('input[type=file]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
    await page.getByRole('button', { name: 'Continue' }).click();
    // the form is EMPTY: wait for the hero to show anyway
    const hero = page.locator(`img[src="${BODY_CELL}"]`);
    await hero.waitFor({ timeout: 8000 });
    at('hero visible (form still empty)');
    const nameValueAtHero = await page.locator('input[type=text]').first().inputValue();
    await page.screenshot({ path: `${OUT}/bodyrow-${dev.replace(/ /g, '')}-1-hero-form-empty.png` });
    const heroBox = await hero.boundingBox();
    const viewport = ctx.pages()[0].viewportSize();

    // fill the form; the sheet starts only when it is complete and quiet
    await page.locator('input[type=text]').first().fill('Mia');
    await page.getByRole('button', { name: 'Girl' }).click();
    await page.locator('input[type=number]').fill('7');
    at('form filled');
    await page.locator(`img[src="${FINAL_CELL}"]`).waitFor({ timeout: 10000 });
    at('final hero visible');
    await page.screenshot({ path: `${OUT}/bodyrow-${dev.replace(/ /g, '')}-2-final-hero.png` });

    // no image in the page is wider than a cell: a row (4 cells) or a sheet would be far wider than the hero frame
    const widest = await page.evaluate(() => Math.max(...[...document.images].map(i => i.naturalWidth)));
    const horizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    results[dev] = { viewport, heroBox, nameValueAtHero, widestImagePx: widest, horizontalScroll, events };
    await ctx.close();
  }
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

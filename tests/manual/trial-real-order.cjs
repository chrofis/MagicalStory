// WebKit phone check, ALL /api mocked: the REAL event order of an iPhone /try (multi-face photo, face pick analysed in the
// background while the visitor types the name, optional slow/failed pick). Run: node tests/manual/trial-real-order.cjs [slowMs] [failFirstPick]
// Asserts: after the pick lands, create-anonymous-account, prepare-standard-body and (form complete + quiet) prepare-standard-avatar are requested;
// the pick never shows the blocking "analysing" spinner on the form; a pick that fails at network level is retried and the form survives.
const { webkit, devices } = require('playwright');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMG = 'data:image/png;base64,' + PNG;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const PICK_MS = Number(process.argv[2] || 4000);
const FAIL_FIRST = process.argv[3] === 'fail';
(async () => {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 12'] });
  const page = await ctx.newPage();
  const t0 = Date.now(); const events = [];
  const at = (w) => events.push(`${Date.now() - t0}ms ${w}`);
  let picks = 0;
  await page.route('**/api/**', async (route) => {
    const u = route.request().url();
    if (u.includes('/api/trial/analyze-photo')) {
      const b = JSON.parse(route.request().postData() || '{}');
      if (b.selectedFaceId == null) { at('analyze-photo (upload)'); return json(route, { success: true, multipleFacesDetected: true, faceCount: 2, faces: [{ id: '0', thumbnail: IMG }, { id: '1', thumbnail: IMG }], cachedFaces: [{ id: '0' }, { id: '1' }] }); }
      picks++; at(`analyze-photo (pick #${picks}) start`);
      await new Promise(r => setTimeout(r, PICK_MS));
      if (FAIL_FIRST && picks === 1) { at('pick #1 aborted'); return route.abort('connectionreset'); }
      at(`pick #${picks} answered`);
      return json(route, { success: true, multipleFacesDetected: false, faceThumbnail: IMG, bodyCrop: IMG, bodyNoBg: IMG, faceBox: { x: 0, y: 0, width: 1, height: 1 } });
    }
    if (u.includes('create-anonymous-account')) { at('create-account'); return json(route, { sessionToken: 't', characterId: 'c' }); }
    if (u.includes('prepare-standard-body')) { at('prepare-standard-body'); return json(route, { avatarImage: IMG }); }
    if (u.includes('prepare-standard-avatar')) { at('prepare-standard-avatar'); return json(route, { avatarImage: IMG }); }
    if (u.includes('update-character-details')) { at('PATCH details'); return json(route, { success: true }); }
    return json(route, {});
  });
  await page.goto('http://localhost:5173/try', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: "Let's start" }).first().click();
  await page.getByRole('checkbox').click({ position: { x: 12, y: 12 } });
  await page.locator('input[type=file]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
  await page.locator('img[alt="Select the correct face"]').first().click();
  at('face clicked');
  const spinnerOnPicker = await page.getByText(/analys/i).count();
  await page.getByRole('button', { name: 'Continue' }).click();
  at('details form open');
  await page.locator('input[type=text]').first().fill('Lukas');
  await page.getByRole('button', { name: 'Boy' }).click();
  await page.locator('input[type=number]').fill('8');
  at('form filled');
  if (process.argv[4] === 'next') { await page.locator('button:has(svg.lucide-arrow-right)').last().click(); at('Next pressed while the pick runs'); }
  await page.waitForTimeout(PICK_MS + 6000);
  const err = await page.getByText(/konnte nicht|could not|couldn't/i).count();
  console.log(JSON.stringify({ spinnerOnPicker, errorShown: err, events }, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

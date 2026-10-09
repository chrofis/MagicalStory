// WebKit check against the running client dev server (npm run dev:client), all /api calls mocked. Run: node tests/manual/trial-face-pick-background.cjs
const { webkit, devices } = require('playwright');
const OUT = process.env.OUT_DIR || require('os').tmpdir();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMG = 'data:image/png;base64,' + PNG;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
(async () => {
  const browser = await webkit.launch();
  const results = {};
  for (const dev of ['iPhone 12', 'iPhone 14 Pro Max']) {
    for (const failPick of [false, true]) {
    const ctx = await browser.newContext({ ...devices[dev] });
    const page = await ctx.newPage();
    const calls = []; let releasePick; const pickGate = new Promise(r => (releasePick = r));
    await page.route('**/api/**', async (route) => {
      const u = route.request().url(); const body = route.request().postData() || '';
      if (u.includes('/api/trial/analyze-photo')) {
        if (!body.includes('selectedFaceId')) { calls.push('analyze1'); return json(route, { success: true, multipleFacesDetected: true, faces: [{ id: 0, thumbnail: IMG }, { id: 1, thumbnail: IMG }], cachedFaces: [{ id: 0 }, { id: 1 }] }); }
        calls.push('analyzePick'); await pickGate;
        if (failPick) return json(route, { error: 'x' }, 502);
        return json(route, { success: true, faceThumbnail: IMG, bodyCrop: IMG, bodyNoBg: IMG, faceBox: { x: 0, y: 0, width: 1, height: 1 } });
      }
      if (u.includes('create-anonymous-account')) { calls.push('createAccount'); return json(route, { sessionToken: 't', characterId: 'c' }); }
      if (u.includes('prepare-standard-avatar')) { calls.push('avatar'); return json(route, { avatarImage: IMG }); }
      return json(route, {});
    });
    await page.goto('http://localhost:5173/try', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: "Let's start" }).first().click();
    await page.getByRole('checkbox').click({ position: { x: 12, y: 12 } });
    await page.locator('input[type=file]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
    await page.locator('img[alt="Select the correct face"]').first().waitFor();
    await page.locator('img[alt="Select the correct face"]').first().click();
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Continue' }).click();
    const name = page.getByPlaceholder(/./).first();
    await page.locator('input[type=text]').first().fill('Mia');
    const tName = Date.now() - t0;
    await page.getByRole('button', { name: 'Girl' }).click();
    await page.locator('input[type=number]').fill('7');
    const nextBtn = page.getByRole('button', { name: /Next/ });
    const enabledWhilePending = await nextBtn.isEnabled();
    await nextBtn.click();
    await page.waitForTimeout(800);
    const pendingCalls = [...calls];
    await page.screenshot({ path: `${OUT}/pick-${dev.replace(/ /g, '')}-${failPick ? 'fail' : 'ok'}-pending.png` });
    releasePick();
    await page.waitForTimeout(1500);
    const url = page.url();
    const errText = await page.locator('.text-red-600').allTextContents();
    const faceBack = await page.locator('img[alt="Select the correct face"]').count();
    await page.screenshot({ path: `${OUT}/pick-${dev.replace(/ /g, '')}-${failPick ? 'fail' : 'ok'}-after.png` });
    results[`${dev} ${failPick ? 'fail' : 'ok'}`] = { tNameFilledMs: tName, enabledWhilePending, callsWhilePending: pendingCalls, callsAfter: calls, errText, faceButtonsBack: faceBack, bodyText: (await page.locator('h2').allTextContents()) };
    await ctx.close();
    }
  }
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
})();

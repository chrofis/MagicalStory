// WebKit check against the running client dev server (npm run dev:client), all /api calls mocked except the idea stream, which a
// local SSE server delivers the way the real one does (partial text, a pause, the final text, done). Run: node tests/manual/trial-idea-box-autogrow.cjs
// Asserts (owner 2026-10-09): no idea text is rendered while it streams (spinner only); once complete the whole idea shows with no inner
// scrolling (scrollHeight <= clientHeight) at 375 px and on desktop, and the height does not change afterwards.
const http = require('http');
const sse = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const ev = (o) => res.write(`data: ${JSON.stringify(o)}

`);
  ev({ story1: IDEA.slice(0, 60), story2: IDEA.slice(0, 40), isFinal: false });
  setTimeout(() => ev({ story1: IDEA.slice(0, 200), story2: IDEA.slice(0, 120), isFinal: false }), 800);
  setTimeout(() => ev({ story1: IDEA, isFinal: true }), 1600);
  setTimeout(() => { ev({ story2: IDEA, isFinal: true }); ev({ done: true }); res.end(); }, 2600);
});
const { webkit, devices } = require('playwright');
const OUT = process.env.OUT_DIR || require('os').tmpdir();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMG = 'data:image/png;base64,' + PNG;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const words = (n, w) => Array.from({ length: n }, (_, i) => w[i % w.length]).join(' ');
const IDEA = 'Der kleine Mia Fuchs Titel\n' + words(80, ['Mia', 'möchte', 'unbedingt', 'das', 'Schiff', 'erreichen,', 'doch', 'ein', 'Sturm', 'fegt', 'über', 'den', 'Hafen.']);
(async () => {
  await new Promise(r => sse.listen(5191, r));
  const browser = await webkit.launch(); const res = {};
  for (const dev of ['iPhone 375', 'iPhone 14 Pro Max', 'Desktop Safari']) {
    const ctx = await browser.newContext(dev === 'iPhone 375' ? { ...devices['iPhone 12'], viewport: { width: 375, height: 812 } } : { ...devices[dev] }); const page = await ctx.newPage();
    await page.addInitScript(() => { window.__leak = false; setInterval(() => { if (/Hafen|Schiff/.test(document.body?.innerText || '')) window.__leak = true; }, 30); });
    await page.route('**/api/**', async (route) => {
      const u = route.request().url();
      if (u.includes('analyze-photo')) return json(route, { success: true, faceThumbnail: IMG, bodyCrop: IMG, bodyNoBg: IMG, faceBox: { x: 0, y: 0, width: 1, height: 1 } });
      if (u.includes('create-anonymous-account')) return json(route, { sessionToken: 't', characterId: 'c' });
      if (u.includes('prepare-standard-avatar')) return json(route, { avatarImage: IMG });
      if (u.includes('generate-ideas-stream')) {
        const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ev({ story1: IDEA, story2: IDEA, isFinal: true }) + ev({ done: true }) });
      }
      if (u.includes('/api/user/location')) return json(route, { city: 'Baden', region: 'AG', country: 'CH' });
      return json(route, {});
    });
    await page.goto('http://localhost:5173/try', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: "Let's start" }).first().click();
    await page.getByRole('checkbox').click({ position: { x: 12, y: 12 } });
    await page.locator('input[type=file]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
    await page.locator('img[alt=Character]').waitFor();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.locator('input[type=text]').first().fill('Mia');
    await page.getByRole('button', { name: 'Girl' }).click();
    await page.locator('input[type=number]').fill('7');
    await page.getByRole('button', { name: /Next/ }).click();
    await page.waitForTimeout(1500);
    for (let k = 0; k < 6 && !(await page.locator('textarea').count()); k++) {
      const opt = page.locator('button').filter({ hasText: /Adventure|Life Skills|Courage|Friend|Animals|Space/ }).first();
      if (await opt.count()) await opt.click(); else break;
      await page.waitForTimeout(700);
    }
    // while it streams: no idea text in the page, only spinners
    await page.waitForTimeout(1300);
    const textWhileStreaming = 'see leakedStreamedText';
    await page.waitForTimeout(2800);
    const m0 = await page.evaluate(() => [...document.querySelectorAll('textarea')].map(t => t.clientHeight));
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => ({
      areas: [...document.querySelectorAll('textarea')].map(t => ({ sh: t.scrollHeight, ch: t.clientHeight, fs: getComputedStyle(t).fontSize, words: t.value.split(/\s+/).length })),
      docW: document.documentElement.scrollWidth, vw: window.innerWidth,
    }));
    res[dev] = { leakedStreamedText: await page.evaluate(() => window.__leak), textWhileStreaming, heightsRightAfterDone: m0, h2: await page.locator('h2').allTextContents(), ...m };
    await page.screenshot({ path: `${OUT}/ideas-${dev.replace(/ /g, '')}.png`, fullPage: true });
    await ctx.close();
  }
  console.log(JSON.stringify(res, null, 1)); await browser.close(); sse.close();
})();

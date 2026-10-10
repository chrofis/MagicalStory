import { test, expect, devices } from '@playwright/test';
import sharp from 'sharp';
import path from 'path';

// Owner iPhone trial (user 10e1d43c, 2026-10-10): avatar pictures cut at head and feet. The slides here are SYNTHETIC stand-ins
// (no real child's photo in git) with the aspect ratios of the real stored cells (head ~260x465, body ~260x560) and a red bar on
// the very top edge and a blue bar on the very bottom edge, so a crop of either edge shows as a missing marker in the screenshot.
// Frames checked: the hero on the character / topic steps (TrialHeroAvatar) and the waiting-screen slide, at iPhone sizes
// 375x667, 390x664 (Safari with its toolbar) and 430x739.
//   cd client && npx vite --port 5201   then
//   TEST_BASE_URL=http://localhost:5201 npx playwright test tests/e2e/trial-avatar-frames.spec.ts --project=trial-viewer-webkit
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'webkit' });

const SIZES = [{ width: 375, height: 667 }, { width: 390, height: 664 }, { width: 430, height: 739 }];
const KINDS = { head: { w: 260, h: 465 }, body: { w: 260, h: 560 } };

async function slide(kind: 'head' | 'body') {
  const { w, h } = KINDS[kind];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#f4efe6"/>
    <circle cx="${w / 2}" cy="${h * 0.22}" r="${w * 0.2}" fill="#8a6a4a"/><rect x="${w * 0.25}" y="${h * 0.38}" width="${w * 0.5}" height="${h * 0.5}" fill="#3a5a9a"/>
    <rect width="${w}" height="6" fill="#ff0000"/><rect y="${h - 6}" width="${w}" height="6" fill="#0000ff"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
}

async function mockApi(page: any, jobStatus?: object) {
  const bodies = { head: await slide('head'), body: await slide('body') };
  await page.route('**/*', async (route: any) => {
    const url = route.request().url();
    const m = url.match(/x\.test\/(head|body)-/);
    if (m) return route.fulfill({ contentType: 'image/jpeg', body: bodies[m[1] as 'head' | 'body'] });
    if (jobStatus && /\/api\/trial\/job-status\//.test(url)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(jobStatus) });
    if (/\/api\//.test(url)) return route.fulfill({ contentType: 'application/json', body: '{}' });
    return route.continue();
  });
}

/** Whole picture inside its frame, object-fit contain, and both edge markers visible in the rendered pixels of the frame. */
async function expectWhole(page: any, img: any, frame: any, shot: string) {
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalHeight > 0)).toBe(true);
  const r = await img.evaluate((el: HTMLImageElement) => {
    const rr = el.getBoundingClientRect(); const f = el.parentElement!.getBoundingClientRect();
    const s = Math.min(rr.width / el.naturalWidth, rr.height / el.naturalHeight); const w = el.naturalWidth * s, h = el.naturalHeight * s;
    return { fit: getComputedStyle(el).objectFit, img: rr.toJSON(), frame: f.toJSON(), top: rr.top + (rr.height - h) / 2, bottom: rr.top + (rr.height + h) / 2 };
  });
  expect(r.fit).toBe('contain');
  expect(r.img.top).toBeGreaterThanOrEqual(r.frame.top - 0.5);
  expect(r.img.bottom).toBeLessThanOrEqual(r.frame.bottom + 0.5);
  expect(r.top).toBeGreaterThanOrEqual(r.frame.top - 0.5);
  expect(r.bottom).toBeLessThanOrEqual(r.frame.bottom + 0.5);
  await frame.scrollIntoViewIfNeeded();
  const png = await frame.screenshot({ path: shot });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let red = 0, blue = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] > 200 && data[i + 1] < 70 && data[i + 2] < 70) red++;
    if (data[i + 2] > 200 && data[i] < 70 && data[i + 1] < 70) blue++;
  }
  expect(red, 'top edge marker visible').toBeGreaterThan(20);
  expect(blue, 'bottom edge marker visible').toBeGreaterThan(20);
}

const shotDir = () => process.env.SHOT_DIR || test.info().outputDir;

for (const size of SIZES) {
  for (const kind of ['head', 'body'] as const) {
    test(`hero avatar (${kind}) whole in its frame at ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      await mockApi(page);
      await page.goto('/try');
      await page.evaluate(async ({ file }) => {
        const React: any = await import('/node_modules/.vite/deps/react.js' as any);
        const dom: any = await import('/node_modules/.vite/deps/react-dom_client.js' as any);
        const createRoot = dom.createRoot || dom.default.createRoot;
        const { default: Hero } = await import('/src/pages/trial/TrialHeroAvatar.tsx' as any);
        const host = document.createElement('div');
        host.id = 'hero-host';
        host.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fff;display:flex;justify-content:center;padding:16px';
        document.body.appendChild(host);
        createRoot(host).render((React.default || React).createElement(Hero, { src: `https://x.test/${file}`, alt: 'hero' }));
      }, { file: `${kind}-hero.jpg` });
      const img = page.locator('#hero-host img');
      await expect(img).toBeVisible();
      await expectWhole(page, img, page.locator('#hero-host [data-testid=trial-hero-avatar]'), path.join(shotDir(), `hero-${kind}-${size.width}x${size.height}.png`));
    });

    test(`waiting-screen slide (${kind}) whole in its frame at ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      await mockApi(page, { jobId: 'j', status: 'generating', progress: 10, avatarSlides: [`https://x.test/${kind}-slide-${'a'.repeat(24)}.jpg`] });
      await page.addInitScript(() => { localStorage.setItem('trial_gen_session_token', 'tok'); localStorage.setItem('trial_gen_job_id', 'j'); });
      await page.goto('/trial-generation');
      const img = page.locator(`img[src*="x.test/${kind}-slide"]`).first();
      await expect(img).toBeVisible({ timeout: 15000 });
      await expectWhole(page, img, img.locator('xpath=..'), path.join(shotDir(), `wait-${kind}-${size.width}x${size.height}.png`));
    });
  }
}

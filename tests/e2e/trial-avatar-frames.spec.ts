import { test, expect, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Owner iPhone trial (user 10e1d43c, 2026-10-10): "full body images are still cut at top and bottom". The slides are the
// REAL stored cells of that trial (head 266x463, body 253-266x557-561, about 1:2). Every place that shows one must keep the
// whole picture inside its frame: the hero on the character / topic steps (TrialHeroAvatar) and the waiting-screen slide.
//   cd client && npx vite --port 5201   then
//   TEST_BASE_URL=http://localhost:5201 npx playwright test tests/e2e/trial-avatar-frames.spec.ts --project=trial-viewer-webkit
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'webkit' });

const dir = path.join(__dirname, 'assets', 'trial-slides');
const SLIDES = fs.readdirSync(dir).filter(f => f.endsWith('.jpeg'));

async function mockApi(page: any, jobStatus?: object) {
  await page.route('**/*', async (route: any) => {
    const url = route.request().url();
    const m = url.match(/\/slides\/([^/?]+\.jpeg)/) || url.match(/x\.test\/([^/?]+\.jpeg)/);
    if (m) return route.fulfill({ contentType: 'image/jpeg', body: fs.readFileSync(path.join(dir, m[1])) });
    if (jobStatus && /\/api\/trial\/job-status\//.test(url)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(jobStatus) });
    if (/\/api\//.test(url)) return route.fulfill({ contentType: 'application/json', body: '{}' });
    return route.continue();
  });
}

/** The painted picture of an object-fit:contain image, as a box inside the element box. */
function containedBox(el: HTMLImageElement) {
  const r = el.getBoundingClientRect();
  const scale = Math.min(r.width / el.naturalWidth, r.height / el.naturalHeight);
  const w = el.naturalWidth * scale, h = el.naturalHeight * scale;
  return { top: r.top + (r.height - h) / 2, bottom: r.top + (r.height + h) / 2, left: r.left + (r.width - w) / 2, right: r.left + (r.width + w) / 2 };
}

for (const width of [375, 430]) {
  for (const slide of SLIDES) {
    test(`hero avatar ${slide} lies whole inside its frame at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await mockApi(page);
      await page.goto('/try');
      await page.evaluate(async ({ file }) => {
        const React = await import('/node_modules/.vite/deps/react.js' as any);
        const dom: any = await import('/node_modules/.vite/deps/react-dom_client.js' as any);
        const createRoot = dom.createRoot || dom.default.createRoot;
        const { default: Hero } = await import('/src/pages/trial/TrialHeroAvatar.tsx' as any);
        const host = document.createElement('div');
        host.id = 'hero-host';
        host.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fff;display:flex;justify-content:center;padding:16px';
        document.body.appendChild(host);
        createRoot(host).render((React.default || React).createElement(Hero, { src: `https://x.test/${file}`, alt: 'hero' }));
      }, { file: slide });
      const img = page.locator('#hero-host img');
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalHeight > 0)).toBe(true);
      const r = await img.evaluate((el: HTMLImageElement) => ({
        fit: getComputedStyle(el).objectFit,
        img: el.getBoundingClientRect().toJSON(),
        frame: el.parentElement!.getBoundingClientRect().toJSON(),
        painted: (() => { const rr = el.getBoundingClientRect(); const s = Math.min(rr.width / el.naturalWidth, rr.height / el.naturalHeight); const w = el.naturalWidth * s, h = el.naturalHeight * s; return { top: rr.top + (rr.height - h) / 2, bottom: rr.top + (rr.height + h) / 2, left: rr.left + (rr.width - w) / 2, right: rr.left + (rr.width + w) / 2 }; })(),
      }));
      expect(r.fit).toBe('contain');
      expect(r.img.top).toBeGreaterThanOrEqual(r.frame.top - 0.5);
      expect(r.img.bottom).toBeLessThanOrEqual(r.frame.bottom + 0.5);
      expect(r.img.left).toBeGreaterThanOrEqual(r.frame.left - 0.5);
      expect(r.img.right).toBeLessThanOrEqual(r.frame.right + 0.5);
      expect(r.painted.top).toBeGreaterThanOrEqual(r.frame.top - 0.5);
      expect(r.painted.bottom).toBeLessThanOrEqual(r.frame.bottom + 0.5);
      await page.screenshot({ path: path.join(process.env.SHOT_DIR || test.info().outputDir, `hero-${slide.replace('.jpeg', '')}-${width}.png`) });
    });

    test(`waiting-screen slide ${slide} lies whole inside its frame at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await mockApi(page, { jobId: 'j', status: 'generating', progress: 10, avatarSlides: [`https://x.test/${slide}`] });
      await page.addInitScript(() => { localStorage.setItem('trial_gen_session_token', 'tok'); localStorage.setItem('trial_gen_job_id', 'j'); });
      await page.goto('/trial-generation');
      const img = page.locator(`img[src$="${slide}"]`).first();
      await expect(img).toBeVisible({ timeout: 15000 });
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalHeight > 0)).toBe(true);
      const r = await img.evaluate((el: HTMLImageElement) => {
        const rr = el.getBoundingClientRect(); const f = el.parentElement!.getBoundingClientRect();
        const s = Math.min(rr.width / el.naturalWidth, rr.height / el.naturalHeight); const w = el.naturalWidth * s, h = el.naturalHeight * s;
        return { fit: getComputedStyle(el).objectFit, img: rr.toJSON(), frame: f.toJSON(), painted: { top: rr.top + (rr.height - h) / 2, bottom: rr.top + (rr.height + h) / 2 } };
      });
      expect(r.fit).toBe('contain');
      expect(r.img.top).toBeGreaterThanOrEqual(r.frame.top - 0.5);
      expect(r.img.bottom).toBeLessThanOrEqual(r.frame.bottom + 0.5);
      expect(r.painted.top).toBeGreaterThanOrEqual(r.frame.top - 0.5);
      expect(r.painted.bottom).toBeLessThanOrEqual(r.frame.bottom + 0.5);
      await page.screenshot({ path: path.join(process.env.SHOT_DIR || test.info().outputDir, `wait-${slide.replace('.jpeg', '')}-${width}.png`) });
    });
  }
}

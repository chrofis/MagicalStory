import { test, expect, devices } from '@playwright/test';
import sharp from 'sharp';

// A full-body avatar slide is a 1:2 cell. On iPhone WebKit the old frame (in-flow <img> with max-h-full inside an
// aspect-ratio box) rendered it at its natural height (508px in a 320px frame) and overflow-hidden cut head and feet
// (owner, 2026-10-09: "avatars are cut at head and feet for the full body ones"). The picture must lie inside its frame.
//   TEST_BASE_URL=http://localhost:5173 npx playwright test tests/e2e/trial-waiting-slide-frame.spec.ts --project=trial-viewer-webkit
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'webkit' });

test('a full-body slide lies whole inside its frame on iPhone WebKit', async ({ page }) => {
  const body = await sharp({ create: { width: 259, height: 567, channels: 3, background: '#f4efe6' } }).jpeg().toBuffer();
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (/slide-body\.jpg/.test(url)) return route.fulfill({ contentType: 'image/jpeg', body });
    if (/\/api\/trial\/job-status\//.test(url)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobId: 'j', status: 'generating', progress: 10, avatarSlides: ['https://x.test/slide-body.jpg'] }) });
    if (/\/api\//.test(url)) return route.fulfill({ contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await page.addInitScript(() => { localStorage.setItem('trial_gen_session_token', 'tok'); localStorage.setItem('trial_gen_job_id', 'j'); });
  await page.goto('/trial-generation');
  const img = page.locator('img[src$="slide-body.jpg"]').first();
  await expect(img).toBeVisible({ timeout: 15000 });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalHeight > 0)).toBe(true);
  const { i, f } = await img.evaluate((el: any) => ({ i: el.getBoundingClientRect().toJSON(), f: el.parentElement.getBoundingClientRect().toJSON() }));
  expect(i.top).toBeGreaterThanOrEqual(f.top - 0.5);
  expect(i.bottom).toBeLessThanOrEqual(f.bottom + 0.5);
  expect(i.left).toBeGreaterThanOrEqual(f.left - 0.5);
  expect(i.right).toBeLessThanOrEqual(f.right + 0.5);
});

import { test, expect, devices } from '@playwright/test';

// Owner iPhone trial (2026-10-10): "showing the story is like in a box, losing screen space, and there is no arrow for
// next page". Owner, final: arrows over the page image as soon as pages are readable (also while generating), none on the avatar slideshow.
//   TEST_BASE_URL=http://localhost:5201 npx playwright test tests/e2e/trial-book-fullwidth-arrows.spec.ts --project=trial-viewer-webkit
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'webkit' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const IMG = (n: string) => `https://images-staging.magicalstory.ch/stories/job_x/${n}.jpg`;
const text = (n: number) => ({ pageNumber: n, locked: n > 2, ...(n > 2 ? { teaser: `Teaser ${n}` } : { text: `Page ${n} text.` }) });

const SIZES = [{ width: 375, height: 667 }, { width: 390, height: 664 }, { width: 430, height: 739 }];
const SHOTS = process.env.SHOT_DIR;

for (const { width, height } of SIZES) {
  for (const status of ['generating', 'completed'] as const) {
    test(`${status}: page arrows on the image at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (/images-staging\.magicalstory\.ch/.test(url)) return route.fulfill({ contentType: 'image/png', body: PNG });
        if (/\/api\/trial\/job-status\//.test(url)) {
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
            jobId: 'job_x', status, progress: status === 'completed' ? 100 : 30, storyTitle: 'Der Test', totalPages: 6, unlocked: false,
            pages: [1, 2, 3, 4, 5, 6].filter(n => status === 'completed' || n <= 3).map(n => ({ ...text(n), imageData: IMG(`p${n}`) })), titlePageImage: IMG('cover'), titlePageTitle: 'Der Test' }) });
        }
        if (/\/api\//.test(url)) return route.fulfill({ contentType: 'application/json', body: '{}' });
        return route.continue();
      });
      await page.addInitScript(() => {
        localStorage.setItem('trial_gen_session_token', 'tok'); localStorage.setItem('trial_gen_job_id', 'job_x'); localStorage.setItem('trial_gen_character_name', 'Max');
      });
      await page.goto('/trial-generation');
      const next = page.getByRole('button', { name: 'Next page' });
      const prev = page.getByRole('button', { name: 'Previous page' });
      await page.waitForTimeout(4500);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${status}-${width}x${height}.png` });
      const book = page.locator('.book-viewer');
      await expect(book).toBeVisible({ timeout: 20000 });
      const box = (await book.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(width - 2); // no boxed margins
      for (const b of [next, prev]) {
        await expect(b).toBeVisible();
        const bb = (await b.boundingBox())!;
        // on the image: the arrow lies inside the book's box, in the first screen (no scrolling)
        expect(bb.x).toBeGreaterThanOrEqual(box.x - 1);
        expect(bb.x + bb.width).toBeLessThanOrEqual(box.x + box.width + 1);
        expect(bb.y).toBeGreaterThanOrEqual(box.y);
        expect(bb.y + bb.height).toBeLessThanOrEqual(box.y + box.height);
        expect(bb.y + bb.height).toBeLessThanOrEqual(height);
      }
      const total = status === 'completed' ? 7 : 4;
      await expect(page.getByText(`1 / ${total}`)).toBeVisible();
      await next.click();
      await expect(page.getByText(`2 / ${total}`)).toBeVisible({ timeout: 5000 });
      await prev.click();
      await expect(page.getByText(`1 / ${total}`)).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[role=alert]')).toHaveCount(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${status}-${width}x${height}-after.png` });
    });
  }
}

test('slideshow of the waiting screen has no page arrows', async ({ page }) => {
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (/images-staging\.magicalstory\.ch/.test(url)) return route.fulfill({ contentType: 'image/png', body: PNG });
    if (/\/api\/trial\/job-status\//.test(url)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobId: 'job_x', status: 'generating', progress: 5, totalPages: 6, unlocked: false, pages: [] }) });
    if (/\/api\//.test(url)) return route.fulfill({ contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await page.addInitScript(() => { localStorage.setItem('trial_gen_session_token', 'tok'); localStorage.setItem('trial_gen_job_id', 'job_x'); localStorage.setItem('trial_gen_character_name', 'Max'); });
  await page.goto('/trial-generation');
  await page.waitForTimeout(4500);
  await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous page' })).toHaveCount(0);
});

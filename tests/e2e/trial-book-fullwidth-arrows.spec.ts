import { test, expect, devices } from '@playwright/test';

// Owner iPhone trial (2026-10-10): "showing the story is like in a box, losing screen space, and there is no arrow for
// next page". The finished trial story fills the phone width and has the story viewer's page buttons (BookNavBar).
//   TEST_BASE_URL=http://localhost:5201 npx playwright test tests/e2e/trial-book-fullwidth-arrows.spec.ts --project=trial-viewer-webkit
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'webkit' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const IMG = (n: string) => `https://images-staging.magicalstory.ch/stories/job_x/${n}.jpg`;
const text = (n: number) => ({ pageNumber: n, locked: n > 2, ...(n > 2 ? { teaser: `Teaser ${n}` } : { text: `Page ${n} text.` }) });

for (const width of [375, 430]) {
  test(`book is full width with visible prev/next buttons at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (/images-staging\.magicalstory\.ch/.test(url)) return route.fulfill({ contentType: 'image/png', body: PNG });
      if (/\/api\/trial\/job-status\//.test(url)) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          jobId: 'job_x', status: 'generating', progress: 30, storyTitle: 'Der Test', totalPages: 6, unlocked: false,
          pages: [1, 2, 3, 4, 5, 6].map(n => ({ ...text(n), imageData: IMG(`p${n}`) })), titlePageImage: IMG('cover'), titlePageTitle: 'Der Test' }) });
      }
      if (/\/api\//.test(url)) return route.fulfill({ contentType: 'application/json', body: '{}' });
      return route.continue();
    });
    await page.addInitScript(() => {
      localStorage.setItem('trial_gen_session_token', 'tok'); localStorage.setItem('trial_gen_job_id', 'job_x'); localStorage.setItem('trial_gen_character_name', 'Max');
    });
    await page.goto('/trial-generation');
    const book = page.locator('.book-viewer');
    await expect(book).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1200);
    const box = await book.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(width - 2); // no boxed margins
    const next = page.getByRole('button', { name: 'Next page' });
    const prev = page.getByRole('button', { name: 'Previous page' });
    await expect(next).toBeVisible();
    await expect(prev).toBeVisible();
    await expect(page.getByText('1 / 7')).toBeVisible();
    await page.screenshot({ path: `${process.env.SHOT_DIR || test.info().outputDir}/book-${width}.png` });
    await next.click();
    await expect(page.getByText('2 / 7')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[role=alert]')).toHaveCount(0);
  });
}

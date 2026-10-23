import { test, expect } from '@playwright/test';

// Owner PC trial (2026-10-23): "for trial there is this thin middle column, that is fine for mobile but not for PC".
// The finished trial book must use the screen width on desktop windows, not the 32rem (max-w-lg) card column.
//   TEST_BASE_URL=http://localhost:5201 npx playwright test tests/e2e/trial-book-desktop-width.spec.ts --project=chromium
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const IMG = (n: string) => `https://images-staging.magicalstory.ch/stories/job_x/${n}.jpg`;
const text = (n: number) => ({ pageNumber: n, locked: n > 2, ...(n > 2 ? { teaser: `Teaser ${n}` } : { text: `Page ${n} text.` }) });
const SHOTS = process.env.SHOT_DIR;

// 1920/1440: plain desktop; 1280: laptop; 1100 / 900: laptop with 125% / 150% Windows scaling (CSS px).
for (const { width, height } of [{ width: 1920, height: 1000 }, { width: 1440, height: 800 }, { width: 1280, height: 720 }, { width: 1100, height: 650 }, { width: 900, height: 620 }]) {
  test(`completed trial book is wide at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (/images-staging\.magicalstory\.ch/.test(url)) return route.fulfill({ contentType: 'image/png', body: PNG });
      if (/\/api\/trial\/job-status\//.test(url)) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          jobId: 'job_x', status: 'completed', progress: 100, storyTitle: 'Der Test', totalPages: 6, unlocked: false,
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
    await page.waitForTimeout(2500);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-${width}x${height}.png` });
    const box = (await book.boundingBox())!;
    const card = (await book.locator('xpath=ancestor::div[contains(@class,"bg-white")][1]').boundingBox())!;
    // The card is not the thin 32rem (512 px) column any more: it widens with the window.
    expect(card.width).toBeGreaterThanOrEqual(Math.min(width >= 1024 ? 1024 : 768, width - 64) - 2);
    // The book sits inside the card (it no longer spills out of a narrow card) and inside the window.
    expect(box.x).toBeGreaterThanOrEqual(card.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 1);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    // and it uses the card: at least 60 % of its width (a single page on md is height-bound, a spread on lg).
    expect(box.width).toBeGreaterThanOrEqual(card.width * 0.6);
  });
}

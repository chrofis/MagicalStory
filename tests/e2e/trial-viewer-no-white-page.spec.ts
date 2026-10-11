import { test, expect, devices } from '@playwright/test';

// Replays the job-status payload sequence of a real trial (job_1791579344291_rk2bno6av shape:
// text first, then the title page + page images as R2 URLs) into the /trial-generation page on an
// iPhone WebKit with the API mocked. Owner, 2026-10-09: "story still crashes when the title should
// appear, white page, need to refresh". Run against a vite dev server:
//   TEST_BASE_URL=http://localhost:5200 npx playwright test tests/e2e/trial-viewer-no-white-page.spec.ts --project=trial-viewer-webkit
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const IMG = (n: string) => `https://images-staging.magicalstory.ch/stories/job_x/${n}.jpg`;
const text = (n: number) => ({ pageNumber: n, locked: n > 2, ...(n > 2 ? { teaser: `Teaser ${n}` } : { text: `Page ${n} text.` }) });

test.use({ ...devices['iPhone 13'], defaultBrowserType: 'webkit' });

test('title page and page images arriving never blank the page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  let poll = 0;
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (/images-staging\.magicalstory\.ch/.test(url)) return route.fulfill({ contentType: 'image/png', body: PNG });
    if (/\/api\/trial\/job-status\//.test(url)) {
      poll++;
      const base = { jobId: 'job_x', status: 'generating', progress: 30 };
      let body: any = base;
      if (poll >= 2) body = { ...base, storyTitle: 'Der Test', totalPages: 6, unlocked: false, pages: [1, 2, 3, 4, 5, 6].map(text) };
      if (poll >= 3) body = { ...body, pages: [1, 2, 3, 4, 5, 6].map(n => ({ ...text(n), imageData: IMG(`p${n}`) })), };
      if (poll >= 4) body = { ...body, titlePageImage: IMG('cover'), titlePageTitle: 'Der Test' };
      if (poll >= 5) body = { ...body, backCoverImage: IMG('back') };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (/\/api\//.test(url)) return route.fulfill({ contentType: 'application/json', body: '{}' });
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('trial_gen_session_token', 'tok');
    localStorage.setItem('trial_gen_job_id', 'job_x');
    localStorage.setItem('trial_gen_character_name', 'Max');
  });
  await page.goto('/trial-generation');
  await expect.poll(() => poll, { timeout: 30000 }).toBeGreaterThanOrEqual(5);
  await page.waitForTimeout(1500);
  expect(errors).toEqual([]);
  expect(await page.locator('body').innerText()).toContain('Der Test');
  // the book itself is still there: no error-boundary fallback, the title page is its cover
  await expect(page.locator('[role=alert]')).toHaveCount(0);
  await expect(page.locator('.book-viewer')).toBeVisible();
  // the back cover is the book's last page: the page counter reaches N / N and the arrow stops there
  const counter = page.locator('p', { hasText: /^\d+ \/ \d+$/ });
  const total = Number((await counter.innerText()).split('/')[1]);
  expect(total).toBe(9); // front cover + 6 pages + back cover + the sign-in page (mobile: picture with text under it)
  for (let i = 1; i < total; i++) { await page.getByRole('button', { name: /next page|nächste seite|page suivante/i }).first().click(); await page.waitForTimeout(700); }
  expect(await counter.innerText()).toBe(`${total} / ${total}`);
  await page.screenshot({ path: process.env.TRIAL_BACK_SHOT || 'trial-back-cover.png' });
});

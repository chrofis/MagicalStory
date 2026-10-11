import { test, expect, devices } from '@playwright/test';

// Owner iPhone trial (2026-10-11): "the back page now shows but there is no way to log on. Allow to go one page further
// and there have the log-on screen again." One more page after the back cover carries the sign-in block while the visitor is
// not linked, and is gone once the address is linked.
//   TEST_BASE_URL=http://localhost:5202 npx playwright test tests/e2e/trial-book-signin-page.spec.ts --project=trial-viewer-webkit
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'webkit' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const IMG = (n: string) => `https://images-staging.magicalstory.ch/stories/job_x/${n}.jpg`;
const SIZES = [{ width: 375, height: 667 }, { width: 390, height: 664 }, { width: 430, height: 739 }];
const SHOTS = process.env.SHOT_DIR;

for (const { width, height } of SIZES) {
  test(`sign-in page after the back cover, works, and goes once linked at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    let linked = false;
    let linkBody: any = null;
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (/images-staging\.magicalstory\.ch/.test(url)) return route.fulfill({ contentType: 'image/png', body: PNG });
      if (/\/api\/trial\/link-email/.test(url)) { linked = true; linkBody = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/json', body: '{"success":true}' }); }
      if (/\/api\/trial\/job-status\//.test(url)) {
        const pages = [1, 2, 3, 4, 5, 6].map(n => ({ pageNumber: n, imageData: IMG(`p${n}`), ...(linked || n <= 2 ? { locked: false, text: `Page ${n} text.` } : { locked: true, teaser: `Teaser ${n}` }) }));
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          jobId: 'job_x', status: 'completed', progress: 100, storyTitle: 'Der Test', totalPages: 6, unlocked: linked,
          pages, titlePageImage: IMG('cover'), titlePageTitle: 'Der Test', backCoverImage: IMG('back') }) });
      }
      if (/\/api\//.test(url)) return route.fulfill({ contentType: 'application/json', body: '{}' });
      return route.continue();
    });
    await page.addInitScript(() => {
      localStorage.setItem('trial_gen_session_token', 'tok'); localStorage.setItem('trial_gen_job_id', 'job_x'); localStorage.setItem('trial_gen_character_name', 'Max');
    });
    await page.goto('/trial-generation');
    const next = page.getByRole('button', { name: 'Next page' });
    await expect(page.getByText('1 / 9')).toBeVisible({ timeout: 20000 }); // cover + 6 pages + back cover + sign-in
    for (let i = 2; i <= 8; i++) { await next.click(); await expect(page.getByText(`${i} / 9`)).toBeVisible({ timeout: 5000 }); }
    await expect(next).toBeEnabled();
    await expect(page.getByText('8 / 9')).toBeVisible();
    await next.click();
    await expect(page.getByText('9 / 9')).toBeVisible({ timeout: 5000 });
    await expect(next).toBeDisabled();

    const email = page.locator('.book-viewer #trial-gen-email:visible');
    await expect(email).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/signin-page-${width}x${height}.png` });
    await email.fill('eltern@example.com');
    await email.press('Enter'); // the form submit
    await expect.poll(() => linkBody?.email).toBe('eltern@example.com');
    // linked: the extra page is gone (cover + 6 + back cover) and the visitor is not left on a missing page
    await expect(page.getByText(/\/ 8$/)).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#trial-gen-email')).toHaveCount(0);
    await expect(page.locator('[role=alert]')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/linked-${width}x${height}.png` });
  });
}

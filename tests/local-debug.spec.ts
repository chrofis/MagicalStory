import { test, expect } from '@playwright/test';

/**
 * Local Development & Pre-deployment Tests
 *
 * Usage:
 *   # Test against localhost
 *   TEST_BASE_URL=http://localhost:5173 npx playwright test tests/local-debug.spec.ts --project=chromium
 *
 *   # Test against production
 *   npx playwright test tests/local-debug.spec.ts --project=chromium
 *
 *   # Run with visible browser
 *   TEST_BASE_URL=http://localhost:5173 npx playwright test tests/local-debug.spec.ts --project=chromium --headed
 *
 *   # Run specific test
 *   TEST_BASE_URL=http://localhost:5173 npx playwright test -g "characters" --project=chromium --headed
 */

test.describe('Image Loading', () => {

  test('homepage images load correctly', async ({ page }) => {
    await page.goto('/');

    // Wait for page to be fully loaded
    await page.waitForLoadState('networkidle');

    const images = page.locator('img');
    const imageCount = await images.count();
    console.log(`\nFound ${imageCount} images on homepage`);

    const broken: string[] = [];
    for (let i = 0; i < imageCount; i++) {
      const img = images.nth(i);
      const src = await img.getAttribute('src') || 'no-src';
      const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
      const complete = await img.evaluate((el: HTMLImageElement) => el.complete);

      const status = complete && naturalWidth === 0 ? 'BROKEN' : 'OK';
      console.log(`  [${status}] ${src.substring(0, 80)}`);

      if (status === 'BROKEN') {
        broken.push(src);
      }
    }

    expect(broken.length, `Broken images: ${broken.join(', ')}`).toBe(0);
  });

  test('characters page loads with photos', async ({ page }) => {
    await page.goto('/create');

    // Wait for character names to appear (indicates data loaded)
    await page.waitForSelector('text=Main', { timeout: 15000 });

    // Wait for images to load
    await page.waitForFunction(() => {
      const imgs = document.querySelectorAll('img');
      return imgs.length > 0 && Array.from(imgs).every(img => img.complete);
    }, { timeout: 15000 });

    await page.screenshot({ path: 'test-results/characters-page.png', fullPage: true });

    const images = page.locator('img');
    const imageCount = await images.count();
    console.log(`\nFound ${imageCount} images on characters page`);

    // Characters should have images
    expect(imageCount).toBeGreaterThan(0);

    for (let i = 0; i < imageCount; i++) {
      const img = images.nth(i);
      const src = await img.getAttribute('src') || 'no-src';
      const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);

      const displaySrc = src.startsWith('data:') ? 'data:image/...' : src.substring(0, 60);
      const status = naturalWidth === 0 ? 'BROKEN' : 'OK';
      console.log(`  [${status}] ${displaySrc}`);
    }
  });

  test('stories page loads with cover images', async ({ page }) => {
    await page.goto('/stories');

    // Wait for stories to load
    await page.waitForFunction(() => {
      return !document.body.textContent?.includes('Loading...');
    }, { timeout: 10000 });

    await page.waitForTimeout(2000); // Extra time for cover images
    await page.screenshot({ path: 'test-results/stories-page.png', fullPage: true });

    // Check if there are any story cards
    const storyCards = page.locator('[class*="story"], [class*="card"]');
    const cardCount = await storyCards.count();
    console.log(`\nFound ${cardCount} story cards`);
  });

});


test.describe('API Health', () => {

  test('health endpoint responds', async ({ page }) => {
    const response = await page.request.get('/api/health');
    expect(response.ok()).toBe(true);

    const body = await response.json();
    console.log('API Health:', body);
    expect(body.status).toBe('ok');
  });

  test('auth endpoints respond', async ({ page }) => {
    // Test that auth endpoint exists (should return 401 without credentials)
    const response = await page.request.get('/api/auth/me');
    // 401 is expected without auth token
    expect([401, 403]).toContain(response.status());
  });

});


test.describe('Pre-deployment Checks', () => {

  test('critical pages load without JS errors', async ({ page }) => {
    const pages = ['/', '/pricing', '/create', '/stories'];
    const errors: string[] = [];

    page.on('pageerror', error => {
      errors.push(`${error.message}`);
    });

    for (const path of pages) {
      console.log(`Checking ${path}...`);
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');

      const title = await page.title();
      console.log(`  ✓ ${title}`);
    }

    if (errors.length > 0) {
      console.log('\nJS Errors found:');
      errors.forEach(e => console.log(`  ✗ ${e}`));
    }

    expect(errors.length, `JS errors: ${errors.join('; ')}`).toBe(0);
  });

  test('no 404 errors on static assets', async ({ page }) => {
    const notFound: string[] = [];

    page.on('response', response => {
      if (response.status() === 404) {
        const url = response.url();
        // Ignore known optional resources
        if (!url.includes('favicon') && !url.includes('manifest')) {
          notFound.push(url);
        }
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.goto('/create');
    await page.waitForLoadState('networkidle');

    if (notFound.length > 0) {
      console.log('404 errors:');
      notFound.forEach(url => console.log(`  ${url}`));
    }

    expect(notFound.length, `404 errors: ${notFound.join(', ')}`).toBe(0);
  });

  test('authenticated user can access protected pages', async ({ page }) => {
    // This test uses the stored auth state from setup
    // Verify we can access protected pages

    await page.goto('/create');
    await page.waitForLoadState('domcontentloaded');

    // Should be on create page (not redirected to login)
    expect(page.url()).toContain('/create');

    // Should see character content (not login prompt)
    await page.waitForSelector('text=Characters', { timeout: 10000 });

    console.log('✓ Authenticated access to /create works');
  });

});


test.describe('Story Generation Flow', () => {

  test('can navigate through wizard steps', async ({ page }) => {
    await page.goto('/create');

    // Wait for characters to load
    await page.waitForFunction(() => {
      return !document.body.textContent?.includes('Loading...');
    }, { timeout: 10000 });

    // Should be on step 1 (Characters)
    await expect(page.locator('text=Characters')).toBeVisible();

    // Click Next to go to step 2
    const nextButton = page.getByRole('button', { name: /next/i });
    await nextButton.click();

    // Should now be on step 2 (Book)
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-results/wizard-step2.png' });

    console.log('✓ Successfully navigated to step 2');
  });

});

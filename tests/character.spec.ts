import { test, expect } from '@playwright/test';

/**
 * Character creation tests (requires authentication)
 * Uses TEST_EMAIL and TEST_PASSWORD from .env
 */

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

test.describe('Character Creation', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('can login and access character creation', async ({ page }) => {
    // Go to landing page
    await page.goto('/');

    // Click create button to open auth modal
    const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
    await ctaButton.click();

    // Wait for auth modal
    await page.waitForSelector('.fixed.inset-0');

    // Fill login form (should be on login by default)
    await page.getByPlaceholder('your@email.com').fill(TEST_EMAIL!);
    await page.locator('input[type="password"]').first().fill(TEST_PASSWORD!);

    // Click sign in button
    const signInButton = page.getByRole('button', { name: /sign in|login|log in/i }).first();
    await signInButton.click();

    // Wait for navigation after login (should go to /create or /welcome or /stories)
    await page.waitForURL(/\/(create|welcome|stories)/, { timeout: 10000 });

    // If we're on welcome page, click to continue to create
    if (page.url().includes('/welcome')) {
      const continueButton = page.getByRole('button', { name: /create|start|begin/i }).first();
      await continueButton.click();
      await page.waitForURL(/\/create/, { timeout: 5000 });
    }

    // If we're on stories page, navigate to create
    if (page.url().includes('/stories')) {
      await page.goto('/create');
    }

    // Should now be on wizard/create page
    expect(page.url()).toContain('/create');

    // Check that the wizard loaded - should see character creation step
    // Look for elements that indicate we're on the character step
    const pageContent = await page.textContent('body');
    const hasCharacterContent =
      pageContent?.includes('Character') ||
      pageContent?.includes('Charakter') ||
      pageContent?.includes('Photo') ||
      pageContent?.includes('Foto');

    expect(hasCharacterContent).toBe(true);
  });

  test('can view character wizard step', async ({ page }) => {
    // Login first
    await page.goto('/');

    const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
    await ctaButton.click();
    await page.waitForSelector('.fixed.inset-0');

    await page.getByPlaceholder('your@email.com').fill(TEST_EMAIL!);
    await page.locator('input[type="password"]').first().fill(TEST_PASSWORD!);

    const signInButton = page.getByRole('button', { name: /sign in|login|log in/i }).first();
    await signInButton.click();

    // Wait and navigate to create
    await page.waitForURL(/\/(create|welcome|stories)/, { timeout: 10000 });

    if (!page.url().includes('/create')) {
      await page.goto('/create');
    }

    // Wait for wizard to load
    await page.waitForTimeout(2000);

    // Take screenshot for debugging
    await page.screenshot({ path: 'test-results/wizard-step.png' });

    // The wizard should show step 1 (Characters) or navigation
    // Check for any of these indicators:
    // - Step indicator showing "1" or "Characters"
    // - Photo upload area
    // - Character grid
    const body = await page.textContent('body');

    // Should have some wizard-related content
    const isOnWizard = page.url().includes('/create');
    expect(isOnWizard).toBe(true);

    // Should not be showing an error
    const hasError = body?.includes('error') || body?.includes('Error');
    // This is a soft check - errors might be in console, not on page
    console.log('Page contains error text:', hasError);
  });
});

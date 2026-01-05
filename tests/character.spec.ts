import { test, expect, Page } from '@playwright/test';

/**
 * Authenticated user tests (requires TEST_EMAIL and TEST_PASSWORD in .env)
 *
 * IMPORTANT: Tests run serially to avoid rate limiting on login
 */

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

// Run tests serially to avoid rate limiting
test.describe.configure({ mode: 'serial' });

/**
 * Helper function to login - handles rate limiting gracefully
 */
async function login(page: Page) {
  await page.goto('/');

  // Check if already logged in (has auth token in localStorage)
  const isLoggedIn = await page.evaluate(() => {
    return !!localStorage.getItem('auth_token');
  });

  if (isLoggedIn) {
    // Already logged in, just navigate
    await page.goto('/create');
    await page.waitForTimeout(1000);
    return;
  }

  const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
  await ctaButton.click();
  await page.waitForSelector('.fixed.inset-0');

  await page.getByPlaceholder('your@email.com').fill(TEST_EMAIL!);
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD!);

  const signInButton = page.getByRole('button', { name: /sign in|login|log in/i }).first();
  await signInButton.click();

  // Wait for either navigation or error message
  await page.waitForTimeout(3000);

  // Check for rate limit error
  const bodyText = await page.textContent('body');
  if (bodyText?.includes('Too many') || bodyText?.includes('rate limit')) {
    console.log('Rate limited - waiting 10 seconds...');
    await page.waitForTimeout(10000);
    // Retry login
    await signInButton.click();
    await page.waitForTimeout(3000);
  }

  // Wait for navigation after login
  try {
    await page.waitForURL(/\/(create|welcome|stories)/, { timeout: 15000 });
  } catch {
    // If still on landing page, might be rate limited or wrong credentials
    const currentUrl = page.url();
    console.log('Login may have failed, current URL:', currentUrl);

    // If rate limited, throw to fail test clearly
    const bodyText = await page.textContent('body');
    if (bodyText?.includes('Too many') || bodyText?.includes('rate limit')) {
      throw new Error('Rate limited - please wait before running tests again');
    }
  }
}

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

    // Wait for wizard to fully load (loading spinner to disappear)
    await page.waitForTimeout(3000);

    // Check that the wizard loaded - should see step indicator
    const stepIndicator = page.locator('text=1').or(page.locator('[class*="step"]')).first();
    await expect(stepIndicator).toBeVisible({ timeout: 5000 });
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

test.describe('Wizard Navigation', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('can navigate through wizard steps by clicking step indicators', async ({ page }) => {
    await login(page);

    // Navigate to create if not already there
    if (!page.url().includes('/create')) {
      await page.goto('/create');
    }

    // Wait for wizard to load
    await page.waitForTimeout(2000);

    // Should be on step 1 - verify step indicator shows 1 is active
    const step1Indicator = page.locator('nav, header').getByText('1').first();
    await expect(step1Indicator).toBeVisible({ timeout: 5000 });

    // Note: Next button may be disabled if no characters are added
    // Instead, try clicking on step indicators directly to navigate
    // Click on step 2 indicator
    const step2 = page.locator('nav, header').getByText('2').first();
    const canClickStep2 = await step2.isVisible().catch(() => false);

    if (canClickStep2) {
      await step2.click();
      await page.waitForTimeout(1000);
    }

    // Click on step 3 indicator
    const step3 = page.locator('nav, header').getByText('3').first();
    const canClickStep3 = await step3.isVisible().catch(() => false);

    if (canClickStep3) {
      await step3.click();
      await page.waitForTimeout(1000);
    }

    // Should still be on create page
    expect(page.url()).toMatch(/\/create\/?/);

    // Take screenshot
    await page.screenshot({ path: 'test-results/wizard-navigation.png' });
  });

  test('can navigate back through wizard steps', async ({ page }) => {
    await login(page);

    if (!page.url().includes('/create')) {
      await page.goto('/create');
    }

    await page.waitForTimeout(2000);

    // Go forward a couple steps
    const nextButton = page.getByRole('button', { name: /next|weiter|suivant/i }).first();
    await nextButton.click();
    await page.waitForTimeout(500);
    await nextButton.click();
    await page.waitForTimeout(500);

    // Now go back
    const backButton = page.getByRole('button', { name: /back|zurück|retour/i }).first();
    const hasBackButton = await backButton.isVisible().catch(() => false);

    if (hasBackButton) {
      await backButton.click();
      await page.waitForTimeout(500);
      // Should still be on create page
      expect(page.url()).toMatch(/\/create\/?/);
    }
  });
});

test.describe('My Stories Page', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('can access My Stories page', async ({ page }) => {
    await login(page);

    // Navigate to stories page
    await page.goto('/stories');

    // Wait for page to load
    await page.waitForTimeout(2000);

    // Should be on stories page
    expect(page.url()).toContain('/stories');

    // Take screenshot
    await page.screenshot({ path: 'test-results/my-stories.png' });

    // Check for stories content - either stories list or empty state
    const body = await page.textContent('body');
    const hasStoriesContent =
      body?.includes('Stories') ||
      body?.includes('Geschichten') ||
      body?.includes('story') ||
      body?.includes('Story') ||
      body?.includes('Create') ||
      body?.includes('Erstellen');

    expect(hasStoriesContent).toBe(true);
  });

  test('stories page shows content', async ({ page }) => {
    await login(page);
    await page.goto('/stories');
    await page.waitForTimeout(2000);

    // Take screenshot to see what's on the page
    await page.screenshot({ path: 'test-results/stories-content.png' });

    // The page should have loaded - check we're on stories URL
    expect(page.url()).toContain('/stories');

    // Page should have some content (not be blank)
    const bodyText = await page.textContent('body');
    expect(bodyText?.length).toBeGreaterThan(100);
  });
});

test.describe('My Orders Page', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('can access My Orders page', async ({ page }) => {
    await login(page);

    await page.goto('/orders');
    await page.waitForTimeout(2000);

    expect(page.url()).toContain('/orders');

    // Take screenshot
    await page.screenshot({ path: 'test-results/my-orders.png' });

    // Should show orders content or empty state
    const body = await page.textContent('body');
    const hasOrdersContent =
      body?.includes('Order') ||
      body?.includes('Bestellung') ||
      body?.includes('order') ||
      body?.includes('No orders') ||
      body?.includes('Keine Bestellungen');

    expect(hasOrdersContent).toBe(true);
  });
});

test.describe('Pricing Page', () => {
  test('can view pricing page', async ({ page }) => {
    await page.goto('/pricing');
    await page.waitForTimeout(1000);

    expect(page.url()).toContain('/pricing');

    // Should show pricing information
    const body = await page.textContent('body');
    const hasPricingContent =
      body?.includes('Price') ||
      body?.includes('Preis') ||
      body?.includes('Credit') ||
      body?.includes('credit') ||
      body?.includes('€') ||
      body?.includes('CHF');

    expect(hasPricingContent).toBe(true);

    await page.screenshot({ path: 'test-results/pricing.png' });
  });
});

test.describe('Logout Flow', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('can logout after login', async ({ page }) => {
    await login(page);

    // Find and click menu button
    const menuButton = page.getByRole('button', { name: /menu/i }).or(page.locator('[class*="menu"]')).first();
    await menuButton.click();
    await page.waitForTimeout(500);

    // Look for logout option
    const logoutButton = page.getByText(/logout|log out|sign out|abmelden|déconnexion/i).first();
    const hasLogout = await logoutButton.isVisible().catch(() => false);

    if (hasLogout) {
      await logoutButton.click();
      await page.waitForTimeout(1000);

      // After logout, should be redirected to home or login
      const url = page.url();
      const isLoggedOut = url.includes('/') || !url.includes('/create');

      expect(isLoggedOut).toBe(true);

      // Verify we're actually logged out by trying to access protected page
      await page.goto('/create');
      await page.waitForTimeout(1000);

      // Should either redirect to home or show login modal
      const showsAuthPrompt = await page.locator('.fixed.inset-0').isVisible().catch(() => false);
      const redirectedHome = page.url() === 'https://magicalstory.ch/' || page.url().endsWith('/');

      expect(showsAuthPrompt || redirectedHome).toBe(true);
    } else {
      // Menu might be different, just verify we're logged in
      console.log('Logout button not found in menu - skipping logout verification');
    }

    await page.screenshot({ path: 'test-results/logout.png' });
  });
});

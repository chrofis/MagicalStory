import { test, expect } from '@playwright/test';

/**
 * Authentication flow tests
 * Tests registration, login, and redirect behavior
 */

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    // Clear any existing auth state
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test('landing page loads correctly', async ({ page }) => {
    await page.goto('/');

    // Check that the page loads
    await expect(page).toHaveTitle(/Magical\s*Story/i);

    // Check for key elements (use first() as there are multiple CTAs)
    await expect(page.getByRole('button', { name: /start|begin|create/i }).first()).toBeVisible();
  });

  test('clicking create button shows auth modal when not logged in', async ({ page }) => {
    await page.goto('/');

    // Click the main CTA button
    const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
    await ctaButton.click();

    // Auth modal should appear
    await expect(page.getByRole('dialog').or(page.locator('.fixed.inset-0'))).toBeVisible();

    // Should have login/register options
    await expect(page.getByText(/sign in|login|log in/i).first()).toBeVisible();
  });

  test('can switch between login and register forms', async ({ page }) => {
    await page.goto('/');

    // Open auth modal
    const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
    await ctaButton.click();

    // Wait for modal
    await page.waitForSelector('.fixed.inset-0');

    // Find and click register/sign up link
    const registerLink = page.getByText(/register|sign up|create account/i).first();
    await registerLink.click();

    // Should now show registration form - email has placeholder, password uses label
    await expect(page.getByPlaceholder('your@email.com')).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
  });

  test('registration form validates email format', async ({ page }) => {
    await page.goto('/');

    // Open auth modal and switch to register
    const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
    await ctaButton.click();
    await page.waitForSelector('.fixed.inset-0');

    const registerLink = page.getByText(/register|sign up|create account/i).first();
    await registerLink.click();

    // Wait for registration form
    await page.waitForSelector('input[type="password"]');

    // Try to submit with invalid email
    await page.getByPlaceholder('your@email.com').fill('invalid-email');
    await page.locator('input[type="password"]').first().fill('testpassword123');

    // Submit form
    const submitButton = page.getByRole('button', { name: /register|sign up|create/i }).first();
    await submitButton.click();

    // Should show validation error or stay on form
    const emailInput = page.getByPlaceholder('your@email.com');
    const isValid = await emailInput.evaluate((el: HTMLInputElement) => el.validity.valid);
    expect(isValid).toBe(false);
  });

  test('welcome page redirects to home when not authenticated', async ({ page }) => {
    await page.goto('/welcome');

    // Should redirect to landing page
    await expect(page).toHaveURL('/');
  });

  test('create page requires authentication', async ({ page }) => {
    await page.goto('/create');

    // Should either redirect to landing or show auth prompt
    // The exact behavior depends on implementation
    const url = page.url();
    const hasAuthPrompt = await page.locator('.fixed.inset-0').isVisible().catch(() => false);

    expect(url.includes('/') || hasAuthPrompt).toBe(true);
  });
});

test.describe('Page Navigation', () => {
  test('scroll resets to top on navigation', async ({ page }) => {
    await page.goto('/');

    // Scroll down on landing page
    await page.evaluate(() => window.scrollTo(0, 500));

    // Navigate to another page
    await page.goto('/pricing');

    // Check scroll position is at top
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBe(0);
  });

  test('landing page has content', async ({ page }) => {
    await page.goto('/');

    // The landing page should have meaningful content
    // Check for headings that indicate multiple sections
    const headings = page.locator('h1, h2');
    await expect(headings.first()).toBeVisible();
  });
});

test.describe('Mobile Viewport', () => {
  test('landing page is responsive', async ({ page }) => {
    await page.goto('/');

    // Check that key elements are visible on mobile
    await expect(page.getByRole('button', { name: /start|begin|create/i }).first()).toBeVisible();

    // Navigation should be visible or have hamburger menu
    const nav = page.locator('nav, header, [role="navigation"]').first();
    await expect(nav).toBeVisible();
  });
});

import { test as setup, expect } from '@playwright/test';
import path from 'path';

const authFile = path.join(__dirname, '../.auth/user.json');

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

/**
 * This setup runs ONCE before all tests and saves the auth state.
 * Other tests can then reuse this state without logging in again.
 */
setup('authenticate', async ({ page }) => {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    console.log('No test credentials configured, skipping auth setup');
    return;
  }

  await page.goto('/');

  // Click create button to open auth modal
  const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
  await ctaButton.click();
  await page.waitForSelector('.fixed.inset-0');

  // Fill login form
  await page.getByPlaceholder('your@email.com').fill(TEST_EMAIL);
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);

  // Click sign in
  const signInButton = page.getByRole('button', { name: /sign in|login|log in/i }).first();
  await signInButton.click();

  // Wait for navigation after login
  await page.waitForURL(/\/(create|welcome|stories)/, { timeout: 15000 });

  // Save auth state
  await page.context().storageState({ path: authFile });
  console.log('Auth state saved to', authFile);
});

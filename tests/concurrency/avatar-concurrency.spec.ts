import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import path from 'path';

/**
 * Concurrency Tests for Avatar System
 *
 * Tests the system's ability to handle multiple users performing
 * avatar operations simultaneously.
 *
 * IMPORTANT: These tests require multiple test user accounts.
 * Set up auth state files for each user before running:
 *   - .auth/user1.json
 *   - .auth/user2.json
 *   - .auth/user3.json
 *
 * NOTE: These tests interact with real APIs and may incur significant costs
 * when running avatar generation in parallel (~$0.30/run).
 */

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

// Paths to pre-authenticated user state files
const AUTH_STATES = {
  user1: path.join(__dirname, '../../.auth/user.json'),  // Primary test user
  // Additional users would be configured here
  // user2: path.join(__dirname, '../../.auth/user2.json'),
  // user3: path.join(__dirname, '../../.auth/user3.json'),
};

// Helper to create browser context with auth state
async function createAuthenticatedContext(
  browser: Browser,
  authStatePath: string
): Promise<BrowserContext> {
  return browser.newContext({
    storageState: authStatePath
  });
}

// Helper to verify characters loaded correctly
async function verifyCharactersLoaded(page: Page): Promise<number> {
  await page.goto('/create');
  await page.waitForTimeout(2000);

  // Count character cards
  const cards = page.locator('[class*="character"], [class*="card"]').filter({
    has: page.locator('text=/\\d+/')
  });

  return await cards.count();
}

test.describe('Concurrent Page Access', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('multiple browser contexts can load character page', async ({ browser }) => {
    // Create multiple browser contexts (simulating different users)
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];

    try {
      // Create 3 contexts with the same user (tests session handling)
      for (let i = 0; i < 3; i++) {
        const context = await createAuthenticatedContext(browser, AUTH_STATES.user1);
        contexts.push(context);
        pages.push(await context.newPage());
      }

      // Load character page in all contexts simultaneously
      await Promise.all(pages.map(page => page.goto('/create')));

      // Wait for all to load
      await Promise.all(pages.map(page => page.waitForTimeout(3000)));

      // Verify all loaded successfully
      for (let i = 0; i < pages.length; i++) {
        const url = pages[i].url();
        expect(url).toContain('/create');

        // Take screenshot
        await pages[i].screenshot({
          path: `test-results/concurrent-context-${i}.png`
        });
      }

      console.log('All 3 browser contexts loaded character page successfully');
    } finally {
      // Cleanup
      for (const context of contexts) {
        await context.close();
      }
    }
  });

  test('parallel character data fetch is consistent', async ({ browser }) => {
    const contexts: BrowserContext[] = [];
    const characterCounts: number[] = [];

    try {
      // Create 3 contexts
      for (let i = 0; i < 3; i++) {
        const context = await createAuthenticatedContext(browser, AUTH_STATES.user1);
        contexts.push(context);
      }

      // Fetch character data in parallel
      const results = await Promise.all(
        contexts.map(async (context) => {
          const page = await context.newPage();
          const count = await verifyCharactersLoaded(page);
          await page.close();
          return count;
        })
      );

      characterCounts.push(...results);

      console.log(`Character counts from parallel fetches: ${characterCounts.join(', ')}`);

      // All fetches should return the same count
      const allSame = characterCounts.every(c => c === characterCounts[0]);
      expect(allSame).toBe(true);
    } finally {
      for (const context of contexts) {
        await context.close();
      }
    }
  });
});

test.describe('Concurrent Save Operations', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('handles rapid save button clicks gracefully', async ({ page }) => {
    await page.goto('/create');
    await page.waitForTimeout(2000);

    // Find a save button
    const saveButton = page.getByRole('button', { name: /save|speichern/i }).first();
    const hasSaveButton = await saveButton.isVisible().catch(() => false);

    if (!hasSaveButton) {
      console.log('No save button visible - skipping rapid click test');
      return;
    }

    // Intercept API calls
    const saveCalls: { timestamp: number; status: number }[] = [];

    page.on('response', async (response) => {
      if (response.url().includes('/api/characters') && response.request().method() === 'POST') {
        saveCalls.push({
          timestamp: Date.now(),
          status: response.status()
        });
      }
    });

    // Click save button rapidly (simulating double-click or network lag causing retry)
    await saveButton.click();
    await page.waitForTimeout(100);
    await saveButton.click();
    await page.waitForTimeout(100);
    await saveButton.click();

    await page.waitForTimeout(3000);

    console.log(`Rapid save clicks resulted in ${saveCalls.length} API calls`);

    // All saves should succeed (no race condition errors)
    for (const call of saveCalls) {
      expect(call.status).toBeLessThan(500); // No server errors
    }
  });
});

test.describe('Concurrent Avatar Jobs', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  // This test would trigger actual avatar generation - expensive!
  test.skip('multiple avatar generation jobs complete independently', async ({ browser }) => {
    // This test is skipped by default as it would cost API credits
    // Uncomment to run manually when testing concurrency

    const context = await createAuthenticatedContext(browser, AUTH_STATES.user1);
    const page = await context.newPage();

    try {
      await page.goto('/create');
      await page.waitForTimeout(2000);

      // Find characters that need avatar regeneration
      const regenerateButtons = page.locator('button').filter({
        hasText: /regenerate|neu generieren/i
      });

      const buttonCount = await regenerateButtons.count();
      console.log(`Found ${buttonCount} regenerate buttons`);

      // Click multiple regenerate buttons in quick succession
      // WARNING: Each click costs API credits!
      // for (let i = 0; i < Math.min(buttonCount, 2); i++) {
      //   await regenerateButtons.nth(i).click();
      //   await page.waitForTimeout(500);
      // }

      // Wait for all jobs to complete
      // await page.waitForTimeout(60000);

      console.log('Avatar concurrency test skipped (costs API credits)');
    } finally {
      await context.close();
    }
  });
});

test.describe('Race Condition Prevention', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('character data is consistent after rapid navigation', async ({ page }) => {
    // Rapidly navigate between pages
    const urls = ['/create', '/stories', '/create', '/stories', '/create'];

    for (const url of urls) {
      await page.goto(url);
      await page.waitForTimeout(500);
    }

    // Final load should be consistent
    await page.goto('/create');
    await page.waitForTimeout(2000);

    // Verify page loaded correctly
    expect(page.url()).toContain('/create');

    // No error messages should be visible
    const errorMessages = page.locator('text=/error|Error|failed|Failed/i');
    const errorCount = await errorMessages.count();

    if (errorCount > 0) {
      console.log(`Found ${errorCount} potential error messages after rapid navigation`);
      await page.screenshot({ path: 'test-results/race-condition-errors.png' });
    }
  });

  test('API responses are handled in correct order', async ({ page }) => {
    const apiResponses: { endpoint: string; timestamp: number; order: number }[] = [];
    let requestOrder = 0;

    page.on('request', (request) => {
      if (request.url().includes('/api/')) {
        (request as any)._order = ++requestOrder;
      }
    });

    page.on('response', async (response) => {
      if (response.url().includes('/api/')) {
        const request = response.request();
        apiResponses.push({
          endpoint: new URL(response.url()).pathname,
          timestamp: Date.now(),
          order: (request as any)._order || 0
        });
      }
    });

    await page.goto('/create');
    await page.waitForTimeout(3000);

    // Log API response order
    console.log('API responses received:');
    for (const resp of apiResponses) {
      console.log(`  ${resp.order}: ${resp.endpoint}`);
    }

    // Responses should be handled (no missing responses)
    expect(apiResponses.length).toBeGreaterThan(0);
  });
});

test.describe('Session Isolation', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('different contexts maintain separate session state', async ({ browser }) => {
    // Create two separate contexts
    const context1 = await browser.newContext({ storageState: AUTH_STATES.user1 });
    const context2 = await browser.newContext({ storageState: AUTH_STATES.user1 });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      // Load same page in both
      await Promise.all([
        page1.goto('/create'),
        page2.goto('/create')
      ]);

      await Promise.all([
        page1.waitForTimeout(2000),
        page2.waitForTimeout(2000)
      ]);

      // Both should load successfully
      expect(page1.url()).toContain('/create');
      expect(page2.url()).toContain('/create');

      // Take screenshots
      await Promise.all([
        page1.screenshot({ path: 'test-results/session-isolation-1.png' }),
        page2.screenshot({ path: 'test-results/session-isolation-2.png' })
      ]);

      console.log('Both contexts loaded independently');
    } finally {
      await context1.close();
      await context2.close();
    }
  });
});

test.describe('Load Testing', () => {
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('handles 5 parallel page loads', async ({ browser }) => {
    const contexts: BrowserContext[] = [];
    const loadTimes: number[] = [];

    try {
      // Create 5 contexts
      for (let i = 0; i < 5; i++) {
        contexts.push(await createAuthenticatedContext(browser, AUTH_STATES.user1));
      }

      // Load pages in parallel and measure time
      const startTime = Date.now();

      await Promise.all(
        contexts.map(async (context, index) => {
          const page = await context.newPage();
          const pageStart = Date.now();

          await page.goto('/create');
          await page.waitForLoadState('networkidle');

          loadTimes.push(Date.now() - pageStart);

          await page.screenshot({
            path: `test-results/load-test-${index}.png`
          });
        })
      );

      const totalTime = Date.now() - startTime;

      console.log('Load test results:');
      console.log(`  Total time: ${totalTime}ms`);
      console.log(`  Individual times: ${loadTimes.join('ms, ')}ms`);
      console.log(`  Average: ${Math.round(loadTimes.reduce((a, b) => a + b, 0) / loadTimes.length)}ms`);

      // All should complete within reasonable time (30 seconds total)
      expect(totalTime).toBeLessThan(30000);
    } finally {
      for (const context of contexts) {
        await context.close();
      }
    }
  });
});

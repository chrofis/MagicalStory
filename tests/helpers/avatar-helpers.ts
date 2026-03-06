import { Page, BrowserContext, Browser, expect } from '@playwright/test';
import path from 'path';

/**
 * Shared test utilities for avatar testing
 */

// Auth state file path
export const AUTH_FILE = path.join(__dirname, '../../.auth/user.json');

// Test fixtures directory
export const FIXTURES_DIR = path.join(__dirname, '../fixtures');

/**
 * Wait for avatar generation job to complete
 * Polls the page for avatar images or completion status
 */
export async function waitForAvatarGeneration(
  page: Page,
  options: {
    timeout?: number;
    expectedVariants?: number;
    pollInterval?: number;
  } = {}
): Promise<{ success: boolean; variantsFound: number }> {
  const {
    timeout = 120000,
    expectedVariants = 3,
    pollInterval = 3000
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Count avatar images
    const avatarImages = page.locator('img[src*="data:image/png"], img[src*="data:image/jpeg"]');
    const count = await avatarImages.count();

    if (count >= expectedVariants) {
      return { success: true, variantsFound: count };
    }

    // Check for status text
    const statusText = await page.textContent('body');
    if (statusText?.toLowerCase().includes('complete')) {
      return { success: true, variantsFound: count };
    }

    // Check for error
    if (statusText?.toLowerCase().includes('failed') || statusText?.toLowerCase().includes('error')) {
      return { success: false, variantsFound: count };
    }

    await page.waitForTimeout(pollInterval);
  }

  return { success: false, variantsFound: 0 };
}

/**
 * Navigate to character edit modal and wait for avatars to load
 */
export async function openCharacterEditModal(
  page: Page,
  characterName?: string
): Promise<boolean> {
  await page.goto('/create');
  await page.waitForTimeout(2000);

  // Find character to edit
  let targetElement;
  if (characterName) {
    targetElement = page.locator(`text=${characterName}`).first();
  } else {
    // Find first character with an edit option
    targetElement = page.locator('button').filter({ hasText: /edit|bearbeiten/i }).first();
  }

  const isVisible = await targetElement.isVisible().catch(() => false);
  if (!isVisible) {
    return false;
  }

  await targetElement.click();
  await page.waitForTimeout(1500);

  return true;
}

/**
 * Close any open modal
 */
export async function closeModal(page: Page): Promise<void> {
  // Try close button first
  const closeButton = page.locator('button').filter({ hasText: /close|schließen|×|✕/i }).first();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
    return;
  }

  // Try clicking overlay
  const overlay = page.locator('.fixed.inset-0').first();
  if (await overlay.isVisible().catch(() => false)) {
    await overlay.click({ position: { x: 10, y: 10 } });
    return;
  }

  // Try escape key
  await page.keyboard.press('Escape');
}

/**
 * Create multiple browser contexts for concurrency testing
 */
export async function createTestContexts(
  browser: Browser,
  count: number,
  authState?: string
): Promise<BrowserContext[]> {
  const contexts: BrowserContext[] = [];

  for (let i = 0; i < count; i++) {
    const options: { storageState?: string } = {};
    if (authState) {
      options.storageState = authState;
    }
    contexts.push(await browser.newContext(options));
  }

  return contexts;
}

/**
 * Clean up browser contexts
 */
export async function cleanupContexts(contexts: BrowserContext[]): Promise<void> {
  await Promise.all(contexts.map(ctx => ctx.close()));
}

/**
 * Intercept and log API calls for debugging
 */
export function setupApiLogging(page: Page): { calls: ApiCall[]; clear: () => void } {
  const calls: ApiCall[] = [];

  page.on('request', (request) => {
    if (request.url().includes('/api/')) {
      calls.push({
        method: request.method(),
        url: request.url(),
        timestamp: Date.now(),
        status: undefined
      });
    }
  });

  page.on('response', async (response) => {
    if (response.url().includes('/api/')) {
      const call = calls.find(
        c => c.url === response.url() && c.status === undefined
      );
      if (call) {
        call.status = response.status();
      }
    }
  });

  return {
    calls,
    clear: () => { calls.length = 0; }
  };
}

interface ApiCall {
  method: string;
  url: string;
  timestamp: number;
  status?: number;
}

/**
 * Get character data from the page via API interception
 */
export async function getCharacterDataFromApi(page: Page): Promise<CharacterData | null> {
  let characterData: CharacterData | null = null;

  page.on('response', async (response) => {
    if (response.url().includes('/api/characters') && response.request().method() === 'GET') {
      try {
        const data = await response.json();
        characterData = data;
      } catch {
        // Not JSON
      }
    }
  });

  await page.goto('/create');
  await page.waitForTimeout(3000);

  return characterData;
}

interface CharacterData {
  characters: Array<{
    id: number;
    name: string;
    avatars?: {
      status?: string;
      stale?: boolean;
    };
  }>;
}

/**
 * Verify avatar images are displayed correctly
 */
export async function verifyAvatarDisplay(page: Page): Promise<AvatarVerificationResult> {
  const result: AvatarVerificationResult = {
    thumbnailsVisible: 0,
    variantsVisible: 0,
    statusIndicatorsVisible: 0,
    hasLoadingIndicator: false,
    hasErrorIndicator: false
  };

  // Count thumbnails
  const thumbnails = page.locator('img[src*="data:image"]');
  result.thumbnailsVisible = await thumbnails.count();

  // Count variant tabs/buttons
  const variants = page.locator('text=/winter|standard|summer|formal/i');
  result.variantsVisible = await variants.count();

  // Check for status
  const bodyText = await page.textContent('body') || '';
  result.hasLoadingIndicator = /generating|loading/i.test(bodyText);
  result.hasErrorIndicator = /error|failed/i.test(bodyText);

  return result;
}

interface AvatarVerificationResult {
  thumbnailsVisible: number;
  variantsVisible: number;
  statusIndicatorsVisible: number;
  hasLoadingIndicator: boolean;
  hasErrorIndicator: boolean;
}

/**
 * Take timestamped screenshot for debugging
 */
export async function takeDebugScreenshot(
  page: Page,
  name: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `test-results/${name}-${timestamp}.png`;
  await page.screenshot({ path: filename });
  return filename;
}

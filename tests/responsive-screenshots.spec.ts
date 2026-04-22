/**
 * Responsive screenshot harness.
 *
 * Opens a configured page URL at a matrix of viewport sizes and saves full-page
 * screenshots to `test-output/responsive/`. No assertions — this is a visual-
 * review tool for the operator (human or Claude) to eyeball the layout across
 * phones, tablets, and desktops without clicking through the DevTools device
 * toolbar by hand.
 *
 * Usage:
 *   SHARE_URL=https://magicalstory.ch/shared/<token> npx playwright test \
 *     tests/responsive-screenshots.spec.ts --project=responsive
 *
 * Or to point at a local dev build:
 *   TEST_BASE_URL=http://localhost:5173 \
 *   SHARE_URL=http://localhost:5173/shared/<token> \
 *   npx playwright test tests/responsive-screenshots.spec.ts --project=responsive
 *
 * To add more scenarios (landing page, story wizard, etc.), push onto
 * SCENARIOS below. Viewports live in VIEWPORTS — add rows as needed.
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// ── Viewports to cover ────────────────────────────────────────────────────────
// Pulled from real device specs; keep the list deliberately small so the run
// finishes in a minute or two. Orientation matters — iPad portrait vs landscape
// trigger different book-viewer breakpoints.
const VIEWPORTS = [
  { name: 'iphone-se',            width: 375,  height: 667  }, // small phone
  { name: 'iphone-15-pro',        width: 393,  height: 852  }, // modern phone
  { name: 'iphone-15-pro-max',    width: 430,  height: 932  }, // large phone
  { name: 'pixel-7',              width: 412,  height: 915  }, // android
  { name: 'galaxy-s21',           width: 360,  height: 800  }, // narrow android
  { name: 'phone-landscape',      width: 932,  height: 430  }, // phone rotated
  { name: 'ipad-mini-portrait',   width: 744,  height: 1133 }, // small tablet portrait
  { name: 'ipad-mini-landscape',  width: 1133, height: 744  }, // small tablet landscape
  { name: 'ipad-air-portrait',    width: 820,  height: 1180 }, // tablet portrait
  { name: 'ipad-air-landscape',   width: 1180, height: 820  }, // tablet landscape
  { name: 'desktop-narrow',       width: 1280, height: 800  }, // small laptop
  { name: 'desktop-wide',         width: 1920, height: 1080 }, // full desktop
];

// ── Scenarios — pages to screenshot ──────────────────────────────────────────
// Each scenario names a URL + optional setup (waitForSelector, etc.). Add more
// as we extend the responsive audit to landing, wizard, account, etc.
interface Scenario {
  name: string;
  url: string | null;              // null = skip (env var not set)
  waitFor?: string;                // selector to wait on before screenshot
  waitForTimeout?: number;         // or a ms delay if no stable selector
  skipReason?: string;             // explanation shown in the log when skipped
}

const SCENARIOS: Scenario[] = [
  {
    name: 'share-view',
    url: process.env.SHARE_URL || null,
    // The book viewer renders asynchronously; wait for the flipbook container
    // to appear and the first image to load.
    waitFor: '.book-viewer',
    waitForTimeout: 4000,
    skipReason: 'set SHARE_URL=https://magicalstory.ch/shared/<token> to run',
  },
  // Future scenarios — uncomment and extend as we audit more pages:
  // { name: 'landing', url: `${process.env.TEST_BASE_URL || 'https://magicalstory.ch'}/`, waitFor: 'h1' },
  // { name: 'pricing', url: `${process.env.TEST_BASE_URL || 'https://magicalstory.ch'}/pricing`, waitFor: 'h1' },
];

// ── Output directory ──────────────────────────────────────────────────────────
const OUT_DIR = path.resolve(__dirname, '..', 'test-output', 'responsive');
test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

// ── Matrix ────────────────────────────────────────────────────────────────────
for (const scenario of SCENARIOS) {
  test.describe(`responsive: ${scenario.name}`, () => {
    for (const viewport of VIEWPORTS) {
      test(`${scenario.name} @ ${viewport.name} (${viewport.width}x${viewport.height})`, async ({ browser }) => {
        if (!scenario.url) {
          test.skip(true, scenario.skipReason || `no URL configured for ${scenario.name}`);
          return;
        }

        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          // Match a real mobile device for touch emulation on phone-sized viewports.
          // Tablets / desktops keep the default (mouse + no touch).
          hasTouch: viewport.width < 800,
          isMobile: viewport.width < 800,
          deviceScaleFactor: 2,
        });
        const page = await context.newPage();

        // Forward browser console errors so we notice JS blowups in the log.
        page.on('pageerror', (err) => console.error(`[${viewport.name}] pageerror:`, err.message));
        page.on('console', (msg) => {
          if (msg.type() === 'error') console.warn(`[${viewport.name}] console.error:`, msg.text());
        });

        await page.goto(scenario.url, { waitUntil: 'domcontentloaded' });

        if (scenario.waitFor) {
          try {
            await page.waitForSelector(scenario.waitFor, { timeout: 10000 });
          } catch {
            // Don't fail the test on selector miss — still take the screenshot
            // so the operator can see what actually rendered.
            console.warn(`[${viewport.name}] waitFor "${scenario.waitFor}" timed out, screenshotting anyway`);
          }
        }
        if (scenario.waitForTimeout) {
          await page.waitForTimeout(scenario.waitForTimeout);
        }

        const filename = `${scenario.name}__${viewport.name}.png`;
        const screenshotPath = path.join(OUT_DIR, filename);
        await page.screenshot({ path: screenshotPath, fullPage: false });

        // Also capture full-page in case content extends beyond the viewport
        // (long landing pages, scrollable lists, etc.).
        const fullPath = path.join(OUT_DIR, `${scenario.name}__${viewport.name}__fullpage.png`);
        await page.screenshot({ path: fullPath, fullPage: true });

        await context.close();

        // Soft assertion so the test reporter shows pass/fail; the real value
        // is the screenshot on disk, not the assertion.
        expect(fs.existsSync(screenshotPath)).toBe(true);
      });
    }
  });
}

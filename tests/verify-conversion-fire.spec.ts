/**
 * Verify that /try on prod fires the Google Ads conversion ping.
 *
 * Captures every outbound request, filters for the conversion endpoint,
 * and asserts the correct conversion label appears.
 *
 *   npx playwright test tests/verify-conversion-fire.spec.ts --project=chromium --workers=1
 */
import { test, expect, Page } from '@playwright/test';

const EXPECTED_HOST_FRAGMENTS = ['googlesyndication.com/pagead/conversion', 'googleads.g.doubleclick.net/pagead/viewthroughconversion'];
const EXPECTED_LABEL = 'cDfDCJTFs4McEI3w-4RD'; // Page view conversion send_to label

async function collectConversionPings(page: Page, durationMs: number): Promise<string[]> {
  const hits: string[] = [];
  page.on('request', req => {
    const url = req.url();
    if (EXPECTED_HOST_FRAGMENTS.some(f => url.includes(f))) hits.push(url);
  });
  await page.waitForTimeout(durationMs);
  return hits;
}

test('prod /try fires the Page view conversion', async ({ page }) => {
  const hits: string[] = [];
  page.on('request', req => {
    const url = req.url();
    if (EXPECTED_HOST_FRAGMENTS.some(f => url.includes(f))) hits.push(url);
  });

  await page.goto('https://magicalstory.ch/try', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Give gtag a moment to flush — fires after page mount
  await page.waitForTimeout(5000);

  console.log(`\n[Conversion pings captured: ${hits.length}]`);
  hits.forEach(h => console.log('  →', h.slice(0, 200)));

  // Did any of them carry our specific label?
  const ourLabel = hits.find(h => h.includes(EXPECTED_LABEL));
  if (ourLabel) {
    console.log(`\n✅ Found ping with label=${EXPECTED_LABEL}`);
    const url = new URL(ourLabel);
    console.log('  url param:', url.searchParams.get('url'));
    console.log('  value:    ', url.searchParams.get('value'));
    console.log('  currency: ', url.searchParams.get('currency_code'));
  } else {
    console.log(`\n❌ No ping carrying label=${EXPECTED_LABEL} captured`);
  }

  expect(hits.length, 'no conversion pings fired at all').toBeGreaterThan(0);
  expect(ourLabel, 'no ping carried our Page view label').toBeDefined();
});

test('prod /try has window.gtag defined', async ({ page }) => {
  await page.goto('https://magicalstory.ch/try', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const gtagType = await page.evaluate(() => typeof (window as unknown as { gtag?: unknown }).gtag);
  console.log(`window.gtag is: ${gtagType}`);
  expect(gtagType).toBe('function');
});

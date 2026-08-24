import { test, expect, Page } from '@playwright/test';

/**
 * A face repair for a character who is NOT in the picture must refuse, say who
 * WAS detected, and offer a page redo instead of a retry — without spending a
 * model call.
 *
 * The regression this locks down: step 3 of the bbox ladder asked the detector
 * for a lineup of ONE name, so it always produced a box. Sarah is not on p15 of
 * this story (her appearances are pages 2/4/7/12/-2); the old code pointed Grok
 * at a different character, and all three draws were rejected by the blend gate
 * at 43% mask IoU — silently, with no images and no reason in the UI.
 */

const STORY_ID = 'job_1787514666616_yw9qsv1vf';
const PAGE_NUMBER = 15;
const CHARACTER = 'Sarah';

const BASE = process.env.E2E_BASE || 'https://staging.magicalstory.ch';
const EMAIL = process.env.TESTLAB_USER || 'demo-b-hnecf@magicalstory.ch';
const PASSWORD = process.env.TESTLAB_PASSWORD || 'DemoStory2026!';

/** Log in through the API and plant the token, so the UI opens authenticated. */
async function authenticate(page: Page) {
  const res = await page.request.post(`${BASE}/api/auth/login`, {
    data: { username: EMAIL, password: PASSWORD },
  });
  expect(res.ok(), `login failed: ${res.status()}`).toBeTruthy();
  const body = await res.json();
  const token = body.token || body.accessToken;
  expect(token, 'no token in login response').toBeTruthy();
  await page.addInitScript((t) => {
    window.localStorage.setItem('token', t as string);
  }, token);
  return token as string;
}

test('face repair refuses when the character is not on the page', async ({ page }) => {
  test.setTimeout(240_000);
  const token = await authenticate(page);

  // The API is the contract under test; the panel renders what it returns.
  const res = await page.request.post(
    `${BASE}/api/stories/${STORY_ID}/repair-workflow/character-repair`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { repairs: [{ character: CHARACTER, pages: [PAGE_NUMBER] }] },
      timeout: 180_000,
    },
  );
  expect(res.ok(), `repair call failed: ${res.status()}`).toBeTruthy();
  const body = await res.json();

  const failed = body.results?.[0]?.pagesFailed || [];
  const entry = failed.find((f: { pageNumber: number }) => f.pageNumber === PAGE_NUMBER);
  expect(entry, `no pagesFailed entry for page ${PAGE_NUMBER}: ${JSON.stringify(body).slice(0, 600)}`).toBeTruthy();

  // Refused for the right reason, before any model call.
  expect(entry.notOnPage, `expected notOnPage; got reason: ${entry.reason}`).toBe(true);
  expect(entry.rejectedReason).toBe('not_on_page');

  // The message names who WAS found — that is what makes it actionable.
  expect(entry.reason).toContain(CHARACTER);
  expect(entry.reason).toMatch(/Detected instead:|No figures were detected/);
  expect(entry.reason).toContain('redo the page');

  // Nothing was repainted.
  expect(body.results?.[0]?.pagesRepaired || []).toHaveLength(0);

  // eslint-disable-next-line no-console
  console.log(`[not-on-page] ${entry.reason}`);
});

test('the story page still renders after a refused repair', async ({ page }) => {
  test.setTimeout(120_000);
  await authenticate(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${BASE}/create?storyId=${STORY_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});

  expect(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

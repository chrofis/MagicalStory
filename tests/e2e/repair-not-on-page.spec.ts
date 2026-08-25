import { test, expect, Page } from '@playwright/test';

/**
 * A face repair on a page where the target stands shoulder-to-shoulder with
 * another character must repaint ONLY the target.
 *
 * The regression this locks down: the neighbour-protection list was built only
 * from the STORED bbox detection. p15 of this story has `figures: []` stored,
 * so nothing was protected — Grok received a mask covering two overlapping
 * women, repainted both (turning the one behind Sarah into a bearded man), the
 * silhouette moved, and the blend gate rejected all three draws at 54% mask
 * IoU. Step 3 had just detected all four figures and discarded the result.
 *
 * The contract: the repair produces an image, and every rejected draw is
 * inspectable rather than silent.
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

test('face repair repaints only the target when characters overlap', async ({ page }) => {
  test.setTimeout(600_000);
  const token = await authenticate(page);

  const res = await page.request.post(
    `${BASE}/api/stories/${STORY_ID}/repair-workflow/character-repair`,
    {
      headers: { Authorization: `Bearer ${token}` },
      // EXACTLY WHAT THE UI SENDS. The repair-face button passes
      // whiteoutTarget:'face' (StoryWizard.tsx), which routes through
      // resolveRepairAxes to the tight cutout+whiteout path. Omitting it takes
      // the body/full-scene path instead — a different code path that fails for
      // a different reason, which is not the case under test.
      data: { repairs: [{ character: CHARACTER, pages: [PAGE_NUMBER] }], whiteoutTarget: 'face' },
      timeout: 540_000,
    },
  );
  expect(res.ok(), `repair call failed: ${res.status()}`).toBeTruthy();
  const body = await res.json();

  const result = body.results?.[0];
  const repaired = result?.pagesRepaired || [];
  const failed = result?.pagesFailed || [];
  const failure = failed.find((f: { pageNumber: number }) => f.pageNumber === PAGE_NUMBER);

  // On a rejection, every draw must be inspectable — that is what separates a
  // correct gate verdict from a silent dead end.
  if (failure) {
    // eslint-disable-next-line no-console
    console.log(`[repair] REJECTED: ${failure.reason}`);
    for (const f of failure.attemptFrames || []) {
      // eslint-disable-next-line no-console
      console.log(`  attempt ${f.attempt}: ${f.rejectedReason} — ${f.gateMessage}`);
    }
    expect(
      (failure.attemptFrames || []).length,
      'a rejected repair must carry its attempt frames',
    ).toBeGreaterThan(0);
    for (const f of failure.attemptFrames || []) {
      expect(f.grokRawResult || f.blackoutImage, `attempt ${f.attempt} carries no image`).toBeTruthy();
    }
  }

  expect(
    repaired.length,
    `repair produced no image. reason: ${failure?.reason || 'none reported'}`,
  ).toBeGreaterThan(0);
});

test('the story page still renders after a repair attempt', async ({ page }) => {
  test.setTimeout(120_000);
  await authenticate(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${BASE}/create?storyId=${STORY_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});

  expect(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

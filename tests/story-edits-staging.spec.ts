/**
 * Every edit a customer can make on a FINISHED story, exercised ONCE each, through the real UI of
 * https://staging.magicalstory.ch (owner request 2026-10-31: "make sure all editing options work").
 *
 * COSTS REAL MONEY. Opt-in only: ALLOW_PAID_STORY_EDITS=1, and the project is excluded from every
 * other Playwright project (playwright.config.ts). Run:
 *
 *   ALLOW_PAID_STORY_EDITS=1 npx playwright test --project=story-edits-staging
 *   (optional) EDIT_TEST_STORY_ID=<id>   a COMPLETED story owned by demo-b-hnecf@magicalstory.ch on staging
 *
 * The target story is owned by the admin smoke account (the token comes from
 * scripts/admin/get-admin-token.js). The edits CHANGE that story: new image versions are added and the
 * title/text are edited. afterAll restores title, text and the active image versions (free API calls);
 * the extra versions stay in the version history on purpose (nothing is deleted).
 *
 * Per-edit price (staging renders pages/covers on Imagine 2.0 = USD 0.04/img, edit tier USD 0.02/img;
 * Gemini quality eval ~USD 0.005/call). Customer credits per server/config/credits.js. USD figures are
 * ESTIMATES from the route code (server/routes/regeneration.js) - provider calls are not itemised per edit:
 *   1 edit page text        0 credits   USD 0
 *   2 version history       0 credits   USD 0   (PUT active-image only)
 *   3 change title          2 credits   ~USD 0.03 (free restamp + one edit-tier repaint + OCR check)
 *   4 page image edit       2 credits   ~USD 0.03-0.05 (POST edit/image: one edit-tier call + eval)
 *   5 cover edit (front)    2 credits   ~USD 0.05-0.10 (POST edit/cover: up to 2 calls + eval)
 *   6 retry page (iterate)  2 credits   ~USD 0.06-0.12 (analysis + one render + eval)
 *   7 reimagine page        2 credits   ~USD 0.08-0.25 (POST regenerate/image: render + eval, quality retries)
 *   8 character repair      2 credits   ~USD 0.04-0.10 (bbox detect + 1-3 edit-tier calls)
 * Whole run: ~USD 0.35-0.80. Burn-loop rule: a failing paid edit is NOT retried (retries: 0).
 *
 * Evidence (screenshots + evidence.json with API status, DB before/after) goes to
 * test-output/story-edits/<timestamp>/ .
 */
import { test, expect, Page, Response } from '@playwright/test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const BASE = process.env.TEST_BASE_URL || 'https://staging.magicalstory.ch';
const STORY_ID = process.env.EDIT_TEST_STORY_ID || 'job_1791551239260_a0dpn715x';
// The change-title repaint needs a textless front-cover art layer (story_images 'frontCoverArt'). STORY_ID
// (Oct-9, 4 pages) has none, so the repaint is refused there ("no textless art layer", charged 0). A second
// 4-page smoke-account story that HAS the layer is used for the title test only.
const TITLE_STORY_ID = process.env.EDIT_TEST_TITLE_STORY_ID || 'job_1787252581387_6sn8z0nh2';
const OUT = path.resolve(__dirname, '..', 'test-output', 'story-edits', new Date().toISOString().replace(/[:.]/g, '-'));
const EDIT_TIMEOUT = 6 * 60 * 1000;

// Button order on the page (verified against the live DOM): per image group Edit/Retry/Reimagine/Fix Character.
// Groups in DOM order: front cover, initial page, page 1..N, back cover.
const FRONT = 0;
const pageIdx = (p: number) => 1 + p; // page 1 -> 2
const label = (en: string, de: string) => new RegExp(`^(${en}|${de})\\s*\\(`, 'i');

// NOT serial: one failed edit must not hide the result of the others (each edit runs exactly once anyway).
// Paid edits take up to a few minutes (EDIT_TIMEOUT waits for the API response); the default 30 s test timeout
// killed tests 6-8 on the first run while their requests were still running server-side.
test.describe.configure({ timeout: EDIT_TIMEOUT + 90_000 });
test.use({ viewport: { width: 1280, height: 900 } });

let pool: Pool;
let token: string;
let original: { title: string; story: string; active: Record<string, number> };
const evidence: Record<string, any> = {};
const apiLog: { method: string; url: string; status: number }[] = [];

async function snapshot(id: string = STORY_ID) {
  const r = await pool.query(
    `select data->>'title' as title, data->>'story' as story, image_version_meta as ivm,
            (select coalesce(jsonb_object_agg(k, mx), '{}'::jsonb) from (
               select image_type || coalesce(':' || page_number::text, '') as k, max(version_index) as mx
               from story_images where story_id = $1 and image_type in ('scene','frontCover','backCover','initialPage')
               group by 1) t) as maxv
     from stories where id = $1`, [id]);
  const row = r.rows[0];
  return { title: row.title, storyLen: (row.story || '').length, story: row.story, ivm: row.ivm, maxVersions: row.maxv };
}

function slim(s: any) { const { story, ...rest } = s; return rest; }

async function shot(page: Page, name: string) {
  const f = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: f, fullPage: false });
  return f;
}

async function loadStoryMain() { await loadStory(page); }

async function loadStory(page: Page) {
  await page.goto(`${BASE}/create?storyId=${STORY_ID}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /^Edit Text|^Text bearbeiten/ }).first()).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1500);
}

/** Run `act`, wait for the API response matching `urlRe` (method optional), return it. */
async function actAndWait(page: Page, urlRe: RegExp, act: () => Promise<void>, method?: string): Promise<Response> {
  const wait = page.waitForResponse(
    r => urlRe.test(r.url()) && (!method || r.request().method() === method), { timeout: EDIT_TIMEOUT });
  await act();
  return wait;
}

async function respSummary(r: Response) {
  let body: any = null;
  try { body = await r.json(); } catch { /* not json */ }
  const keep: any = {};
  if (body && typeof body === 'object') {
    for (const k of ['success', 'error', 'message', 'activeVersion', 'versionIndex', 'versionCount', 'creditsUsed',
      'creditsRemaining', 'credits', 'qualityScore', 'method', 'repaired', 'refused', 'reason', 'charged', 'pagesRepaired']) {
      if (k in body) keep[k] = body[k];
    }
  }
  if (Array.isArray(body?.results)) {
    keep.creditsUsed = body.creditsUsed;
    keep.results = body.results.map((x: any) => ({ character: x.character, pagesRepaired: x.pagesRepaired, failed: x.failed ?? x.error ?? x.reason }));
  }
  return { method: r.request().method(), url: r.url().replace(BASE, ''), status: r.status(), body: keep };
}

test.beforeAll(async () => {
  test.skip(process.env.ALLOW_PAID_STORY_EDITS !== '1', 'PAID spec: set ALLOW_PAID_STORY_EDITS=1');
  if (!process.env.STAGING_DATABASE_URL) throw new Error('STAGING_DATABASE_URL missing from .env');
  fs.mkdirSync(OUT, { recursive: true });
  token = execSync('node scripts/admin/get-admin-token.js', { encoding: 'utf8', cwd: path.resolve(__dirname, '..') }).trim();
  pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const s = await snapshot();
  const active: Record<string, number> = {};
  for (const [k, v] of Object.entries<any>(s.ivm || {})) active[k] = v.activeVersion;
  original = { title: s.title, story: s.story, active };
  evidence._before = slim(s);
});

test.afterAll(async () => {
  if (!pool) return;
  // Free restore of title/text/active versions so the story reads as before (versions stay in history).
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const now = await snapshot();
    if (now.story !== original.story) {
      await fetch(`${BASE}/api/stories/${STORY_ID}/text`, { method: 'PUT', headers: H, body: JSON.stringify({ story: original.story }) });
    }
    if (now.title !== original.title) {
      await fetch(`${BASE}/api/stories/${STORY_ID}/title`, { method: 'PUT', headers: H, body: JSON.stringify({ title: original.title }) });
    }
    for (const [k, v] of Object.entries(original.active)) {
      if (now.ivm?.[k]?.activeVersion === v) continue;
      const url = /^\d+$/.test(k) ? `${BASE}/api/stories/${STORY_ID}/pages/${k}/active-image`
        : `${BASE}/api/stories/${STORY_ID}/covers/${k}/active-image`;
      await fetch(url, { method: 'PUT', headers: H, body: JSON.stringify({ versionIndex: v }) });
    }
    evidence._afterRestore = slim(await snapshot());
  } catch (e) { evidence._restoreError = String(e); }
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ storyId: STORY_ID, evidence, apiLog }, null, 2));
  console.log(`[story-edits] evidence: ${OUT}`);
  await pool.end();
});

let page: Page;
test.beforeAll(async ({ browser }) => {
  if (process.env.ALLOW_PAID_STORY_EDITS !== '1') return;
  const ctx = await browser.newContext({
    httpCredentials: process.env.STAGING_AUTH_PASSWORD
      ? { username: process.env.STAGING_AUTH_USER || 'staging', password: process.env.STAGING_AUTH_PASSWORD } : undefined,
    viewport: { width: 1280, height: 900 },
  });
  page = await ctx.newPage();
  page.on('response', r => {
    if (r.url().includes('/api/stories/') && r.request().method() !== 'GET') {
      apiLog.push({ method: r.request().method(), url: r.url().replace(BASE, ''), status: r.status() });
    }
  });
  page.on('dialog', d => { apiLog.push({ method: 'DIALOG', url: d.message(), status: 0 }); d.dismiss().catch(() => {}); });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(t => { localStorage.setItem('auth_token', t); localStorage.removeItem('current_user'); }, token);
  await loadStory(page);
});

test.afterEach(async () => {
  // a failed test may leave the UI on another story / with a modal open: reset for the next edit
  if (!page || page.url().includes(STORY_ID)) { await page?.keyboard.press('Escape').catch(() => {}); return; }
  await loadStoryMain();
});

async function record(name: string, extra: Record<string, any>) {
  evidence[name] = { ...extra, screenshot: path.relative(path.resolve(__dirname, '..'), path.join(OUT, `${name}.png`)) };
}

test('1 edit page text', async () => {
  const marker = ' [edit-test]';
  const before = await snapshot();
  await page.getByRole('button', { name: /^Edit Text|^Text bearbeiten/ }).first().click();
  const ta = page.locator('textarea').first();
  await ta.fill((await ta.inputValue()).trimEnd() + marker);
  const res = await actAndWait(page, /\/api\/stories\/[^/]+\/text$/, () =>
    page.getByRole('button', { name: /^(Save|Speichern)$/ }).click(), 'PUT');
  await shot(page, '1-edit-text');
  const after = await snapshot();
  await record('1-edit-text', { api: await respSummary(res), before: slim(before), after: slim(after) });
  expect(res.status()).toBe(200);
  expect(after.story).toContain(marker.trim());
});

test('2 version history: switch to older image version and back', async () => {
  // Page 3 has two versions (v0 active, v1 older/newer) in the target story.
  const before = await snapshot();
  const pageNum = 3;
  const startActive = before.ivm?.[String(pageNum)]?.activeVersion ?? 0;
  const openHistory = async () => {
    // Select Image buttons exist for pages with >1 versions: front, p3, p4, back (pre-edit state).
    await page.getByRole('button', { name: /^(Select Image|Bild wählen)/ }).nth(1).click();
    await expect(page.getByText(/Original/).first()).toBeVisible({ timeout: 10_000 });
  };
  await openHistory();
  const sel = page.getByRole('button', { name: /^(Select|Wählen)$/ }).first();
  const r1 = await actAndWait(page, new RegExp(`/pages/${pageNum}/active-image$`), () => sel.click(), 'PUT');
  await page.waitForTimeout(1200);
  const mid = await snapshot();
  await shot(page, '2-versions-switched');
  // switch back
  const closeBtn = page.locator('button:has(svg)').filter({ hasText: '' }).last();
  await page.keyboard.press('Escape');
  if (!(await page.getByRole('button', { name: /^(Select|Wählen)$/ }).first().isVisible().catch(() => false))) {
    // modal closed - reopen
    await openHistory();
  }
  const back = page.getByRole('button', { name: /^(Select|Wählen)$/ }).first();
  const r2 = await actAndWait(page, new RegExp(`/pages/${pageNum}/active-image$`), () => back.click(), 'PUT');
  await page.waitForTimeout(1200);
  const after = await snapshot();
  await shot(page, '2-versions-back');
  void closeBtn;
  await record('2-version-history', {
    api: [await respSummary(r1), await respSummary(r2)],
    activeVersionBefore: startActive, activeVersionAfterSwitch: mid.ivm?.[String(pageNum)]?.activeVersion,
    activeVersionAfterBack: after.ivm?.[String(pageNum)]?.activeVersion,
  });
  expect(r1.status()).toBe(200);
  expect(mid.ivm[String(pageNum)].activeVersion).not.toBe(startActive);
  expect(after.ivm[String(pageNum)].activeVersion).toBe(startActive);
  await page.keyboard.press('Escape');
});

test('3 change title (free restamp + paid repaint)', async () => {
  // Uses TITLE_STORY_ID (has a textless front-cover art layer); the main story has none, see header const.
  const before = await snapshot(TITLE_STORY_ID);
  await page.goto(`${BASE}/create?storyId=${TITLE_STORY_ID}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /^(Change title|Titel ändern)/ }).first()).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: /^(Change title|Titel ändern)/ }).first().click();
  const input = page.locator('input[type="text"]').first();
  await input.fill(`${before.title} II`);
  const res = await actAndWait(page, /\/api\/stories\/[^/]+\/title$/, async () => {
    await page.getByRole('button', { name: /^(Change title|Titel ändern)\s*\(/ }).click();
  }, 'PUT');
  const repaint = await page.waitForResponse(r => /\/repaint-title$/.test(r.url()), { timeout: EDIT_TIMEOUT });
  await page.waitForTimeout(1500);
  await shot(page, '3-change-title');
  const after = await snapshot(TITLE_STORY_ID);
  await record('3-change-title', { storyId: TITLE_STORY_ID, api: [await respSummary(res), await respSummary(repaint)], before: slim(before), after: slim(after) });
  // free restore of the flat title on that second story
  await fetch(`${BASE}/api/stories/${TITLE_STORY_ID}/title`, { method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: before.title }) });
  await loadStoryMain();
  expect(res.status()).toBe(200);
  expect(after.title).toBe(`${before.title} II`);
  expect(repaint.status(), 'repaint-title').toBe(200);
});

test('4 page image edit (edit with prompt)', async () => {
  const before = await snapshot();
  await page.getByRole('button', { name: label('Edit', 'Bearbeiten') }).nth(pageIdx(1)).click();
  await page.locator('textarea').last().fill('Make the sky a little bluer');
  const res = await actAndWait(page, /\/edit\/image\/1$/, () =>
    page.getByRole('button', { name: label('Edit', 'Bearbeiten') }).last().click(), 'POST');
  await page.waitForTimeout(2000);
  await shot(page, '4-page-edit');
  const after = await snapshot();
  await record('4-page-image-edit', { api: await respSummary(res), maxBefore: before.maxVersions['scene:1'], maxAfter: after.maxVersions['scene:1'] });
  expect(res.status()).toBe(200);
  expect(after.maxVersions['scene:1']).toBeGreaterThan(before.maxVersions['scene:1']);
});

test('5 cover edit (front cover)', async () => {
  const before = await snapshot();
  await page.getByRole('button', { name: label('Edit', 'Bearbeiten') }).nth(FRONT).click();
  await page.locator('textarea').last().fill('Make the colours slightly warmer');
  const res = await actAndWait(page, /\/edit\/cover\/front$/, () =>
    page.getByRole('button', { name: label('Edit', 'Bearbeiten') }).last().click(), 'POST');
  await page.waitForTimeout(2000);
  await shot(page, '5-cover-edit');
  const after = await snapshot();
  await record('5-cover-edit', { api: await respSummary(res), maxBefore: before.maxVersions['frontCover'], maxAfter: after.maxVersions['frontCover'] });
  expect(res.status()).toBe(200);
  expect(after.maxVersions['frontCover']).toBeGreaterThan(before.maxVersions['frontCover']);
});

test('6 retry page image (Nochmal / iterate)', async () => {
  const before = await snapshot();
  const res = await actAndWait(page, /\/iterate\/2$/, () =>
    page.getByRole('button', { name: label('Retry', 'Nochmal') }).nth(pageIdx(2)).click(), 'POST');
  await page.waitForTimeout(2000);
  await shot(page, '6-retry-page');
  const after = await snapshot();
  await record('6-retry-page', { api: await respSummary(res), maxBefore: before.maxVersions['scene:2'], maxAfter: after.maxVersions['scene:2'] });
  expect(res.status()).toBe(200);
  expect(after.maxVersions['scene:2']).toBeGreaterThan(before.maxVersions['scene:2']);
});

test('7 reimagine page (edit scene + regenerate)', async () => {
  const before = await snapshot();
  await page.getByRole('button', { name: label('Reimagine', 'Überarbeiten') }).nth(pageIdx(3)).click();
  await expect(page.getByRole('button', { name: /^(Regenerate|Neu generieren)/ })).toBeVisible();
  const res = await actAndWait(page, /\/regenerate\/image\/3$/, () =>
    page.getByRole('button', { name: /^(Regenerate|Neu generieren)/ }).click(), 'POST');
  await page.waitForTimeout(2000);
  await shot(page, '7-reimagine');
  const after = await snapshot();
  await record('7-reimagine', { api: await respSummary(res), maxBefore: before.maxVersions['scene:3'], maxAfter: after.maxVersions['scene:3'] });
  expect(res.status()).toBe(200);
  expect(after.maxVersions['scene:3']).toBeGreaterThan(before.maxVersions['scene:3']);
});

test('8 character repair (Fix Character, face)', async () => {
  const before = await snapshot();
  await page.getByRole('button', { name: /^(Fix Character|Figur reparieren)/ }).nth(pageIdx(4)).click();
  await expect(page.getByRole('heading', { name: /Fix Character|Figur reparieren/ })).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: /^(Face|Gesicht)$/ }).click();
  const res = await actAndWait(page, /\/repair-workflow\/character-repair$/, () =>
    page.getByRole('button', { name: /^(Repair|Reparieren)\s*\(/ }).click(), 'POST');
  await page.waitForTimeout(2500);
  await shot(page, '8-character-repair');
  const after = await snapshot();
  await record('8-character-repair', { api: await respSummary(res), maxBefore: before.maxVersions['scene:4'], maxAfter: after.maxVersions['scene:4'] });
  expect(res.status()).toBe(200);
  // 200 only proves the route ran. The quality gates may reject every attempt (no new version, no charge): flag it.
  const repaired = ((await res.json().catch(() => ({})))?.results || []).some((x: any) => x.pagesRepaired?.length);
  if (!repaired) test.info().annotations.push({ type: 'outcome', description: 'repair ran but every attempt was rejected by the gates: no new version, not charged' });
});

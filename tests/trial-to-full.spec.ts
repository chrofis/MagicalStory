import { test, expect, Page } from '@playwright/test';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

/**
 * End-to-end: trial wizard → generate one trial story → email claim →
 * DB-flip email_verified → auto-claim → verify full /create wizard loads.
 *
 * Runs against whatever TEST_BASE_URL points at (default: https://magicalstory.ch).
 * Real trial story generation costs ~$0.10-$0.30 per run.
 *
 * Skips the second full-story generation to stay inside the one-story budget —
 * we only verify the full wizard *renders* after conversion, which is enough
 * to prove the account is authenticated and fully-provisioned.
 */

// Rotate inputs so each run exercises a slightly different path. The single
// run-seed below makes outputs reproducible if a failure needs to be replayed
// (`E2E_SEED=<n>` env var pins it). Without a pinned seed, every run picks
// fresh photo + name + age + category.
const RUN_SEED = process.env.E2E_SEED ? Number(process.env.E2E_SEED) : Date.now();
function seededPick<T>(arr: readonly T[], offset: number): T {
  return arr[(RUN_SEED + offset) % arr.length];
}

const PHOTO_DIR = 'C:/Users/roger/OneDrive/Pictures/For automatic testing';
const PHOTOS = ['Roger.jpg', 'Franziska.jpg', 'Lukas.jpg', 'Manuel.jpg', 'Sophie.JPG'] as const;
const NAMES = ['Testkid', 'Mia', 'Felix', 'Lina', 'Jonas', 'Sara'] as const;
const AGES = ['4', '5', '6', '7', '8'] as const;
// 0 = first category card, 1 = second. Adventure (0) is usually safest; rotate
// occasionally to also exercise alternate flows when this test runs in CI.
const CATEGORY_INDEXES = [0, 0, 0, 1] as const;

const TEST_PHOTO = `${PHOTO_DIR}/${seededPick(PHOTOS, 0)}`;
const TEST_EMAIL_BASE = process.env.E2E_EMAIL_BASE || 'rogerfischer+e2e';
const CHAR_NAME = seededPick(NAMES, 1);
const CHAR_AGE = seededPick(AGES, 2);
const CATEGORY_INDEX = seededPick(CATEGORY_INDEXES, 3);

const TRIAL_GEN_TIMEOUT_MS = 25 * 60 * 1000; // 25 min safety ceiling
const WIZARD_STEP_TIMEOUT = 60 * 1000;

// Admin user from prod DB (rogerfischer@hotmail.com, role=admin). We inject this
// JWT into localStorage before /try loads so the wizard hits the admin-bypass
// path and skips Turnstile + fingerprint checks — Playwright can't solve
// Cloudflare challenges.
const ADMIN_USER = {
  id: '1764881868108',
  username: 'rogerfischer',
  email: 'rogerfischer@hotmail.com',
  role: 'admin',
  email_verified: true,
};

function generateAdminJwt(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET missing from env');
  return jwt.sign(
    {
      id: ADMIN_USER.id,
      userId: ADMIN_USER.id,
      username: ADMIN_USER.username,
      role: ADMIN_USER.role,
      email: ADMIN_USER.email,
      emailVerified: ADMIN_USER.email_verified,
    },
    secret,
    { expiresIn: '1h' }
  );
}

function makeTestEmail(): string {
  const ts = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
  return `${TEST_EMAIL_BASE}-${ts}@gmail.com`;
}

async function flipEmailVerified(email: string): Promise<{ userId: string; wasFlipped: boolean }> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    // Mirror what /api/auth/verify-email/:token does: set both email_verified
    // AND anonymous=false. Otherwise the test's final DB snapshot diverges
    // from what a real email-link click produces (is_trial stays true by
    // design until password-set; that part is correct).
    const r = await pool.query(
      `UPDATE users SET email_verified = true, anonymous = false
       WHERE email = $1
       RETURNING id, email_verified`,
      [email.toLowerCase()]
    );
    if (r.rows.length === 0) {
      throw new Error(`No user found with email ${email}`);
    }
    return { userId: r.rows[0].id, wasFlipped: r.rows[0].email_verified };
  } finally {
    await pool.end();
  }
}

// Poll the DB for the user row created by link-email. We can't assume a fixed
// wait time — the anonymous row is created when /api/trial/create-story fires
// on page mount, and the email column is updated when /api/trial/link-email
// succeeds. Poll until the row appears, up to `timeoutMs`.
async function waitForUserByEmail(email: string, timeoutMs = 60000): Promise<string> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const r = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (r.rows.length > 0) return r.rows[0].id;
      await new Promise(res => setTimeout(res, 2000));
    }
    throw new Error(`User with email ${email} never appeared in DB within ${timeoutMs}ms`);
  } finally {
    await pool.end();
  }
}

async function waitWithLog(page: Page, label: string, ms: number) {
  console.log(`⏳ [${new Date().toISOString()}] ${label} (${ms}ms)`);
  await page.waitForTimeout(ms);
}

test.describe('Trial → full-account end-to-end', () => {
  test.setTimeout(35 * 60 * 1000); // 35 min for whole flow

  test('creates trial, claims via email DB-flip, lands in full wizard', async ({ page, context }) => {
    const testEmail = makeTestEmail();
    console.log(`▶️  Run seed: ${RUN_SEED} (pin with E2E_SEED=${RUN_SEED} to replay)`);
    console.log(`▶️  Test email: ${testEmail}`);
    console.log(`▶️  Photo:      ${TEST_PHOTO}`);
    console.log(`▶️  Character:  ${CHAR_NAME}, age ${CHAR_AGE}`);
    console.log(`▶️  Category:   index ${CATEGORY_INDEX}`);
    console.log(`▶️  Base URL:   ${process.env.TEST_BASE_URL || 'https://magicalstory.ch'}`);

    // Surface console errors from the page so we see what breaks
    page.on('pageerror', (err) => console.error('❌ [PAGE ERROR]', err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('❌ [CONSOLE]', msg.text());
    });

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 0: Pre-inject admin JWT so Turnstile+fingerprint are bypassed
    // (Playwright can't solve Cloudflare challenges)
    // ═══════════════════════════════════════════════════════════════════════
    const adminJwt = generateAdminJwt();
    await context.addInitScript(([token]) => {
      window.localStorage.setItem('auth_token', token);
    }, [adminJwt]);
    console.log('✅ [P0] Admin JWT injected into localStorage');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1: Trial wizard — character step
    // ═══════════════════════════════════════════════════════════════════════
    await page.goto('/try', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/try/);
    console.log('✅ [P1] /try loaded');

    // ─── Intro screen ───────────────────────────────────────────────────
    // The trial flow now opens with a pre-wizard intro (TrialWizard.tsx:460,
    // showIntro state). Single CTA button "Los geht's" / "Let's start" /
    // "Allons-y" flips state to false and reveals the character step.
    const introCta = page.getByRole('button', {
      name: /los geht|let'?s start|allons|cominciamo|iniziamo/i,
    }).first();
    if (await introCta.isVisible({ timeout: 5000 }).catch(() => false)) {
      await introCta.click();
      console.log('✅ [P1] Intro screen dismissed');
    }

    // Accept the two consent checkboxes. Each row is a
    // `div.flex.items-start.gap-3.cursor-pointer.group` containing an SVG
    // checkbox as its first child. The 2nd row has nested <a> links (Terms,
    // Privacy) that suppress the toggle when clicked — so we click the SVG
    // directly instead of the row center.
    const consentRows = page.locator('div.flex.items-start.gap-3.cursor-pointer.group');
    await expect(consentRows.first()).toBeVisible({ timeout: WIZARD_STEP_TIMEOUT });
    const rowCount = await consentRows.count();
    console.log(`   Found ${rowCount} consent rows`);
    for (let i = 0; i < rowCount; i++) {
      const checkboxIcon = consentRows.nth(i).locator('svg').first();
      await checkboxIcon.click({ force: true });
    }
    console.log('✅ [P1] Consent checkboxes clicked');

    // Upload photo via the hidden file input
    const fileInput = page.locator('input[type=file]').first();
    await fileInput.setInputFiles(TEST_PHOTO);
    console.log('✅ [P1] Photo uploaded — waiting for face detection');

    // Wait for analysis to finish (Loader2 goes away, photo preview appears)
    await expect(page.locator('img[alt]').filter({ hasNot: page.locator('[alt=""]') }).first())
      .toBeVisible({ timeout: 60000 });
    // Buffer so face-detection UI settles
    await waitWithLog(page, 'post-upload settle', 2500);

    // If the face-picker shows (multiple faces), just pick the first one.
    // If only one face, it auto-selects. Defensive click on first face button if present.
    const faceButtons = page.locator('button').filter({
      has: page.locator('img[alt*="face" i], img[class*="rounded-full"]'),
    });
    if (await faceButtons.count() > 0) {
      try {
        await faceButtons.first().click({ timeout: 3000 });
        console.log('   Selected first detected face');
      } catch {
        // Face already selected — move on
      }
    }

    // Fill character name + age
    const nameInput = page.locator('input[type=text]').filter({ hasNot: page.locator('[type=file]') }).first();
    await nameInput.fill(CHAR_NAME);
    console.log(`✅ [P1] Character name: ${CHAR_NAME}`);

    // Age may be a number input OR a select. Try both.
    const ageInput = page.locator('input[type=number]').first();
    if (await ageInput.count() > 0) {
      await ageInput.fill(CHAR_AGE);
    } else {
      const ageSelect = page.locator('select').first();
      if (await ageSelect.count() > 0) {
        await ageSelect.selectOption(CHAR_AGE);
      }
    }

    // Gender is required (canProceed in TrialCharacterStep gates Next).
    // Button labels are locale-dependent: en "Boy", de "Junge", fr "Garçon",
    // and sometimes just "Male"/"Männlich". Include every variant.
    const maleBtn = page.getByRole('button', {
      name: /^(boy|junge|gar[çc]on|male|m[äa]nnlich)\s*$/i,
    }).first();
    await expect(maleBtn).toBeVisible({ timeout: 10000 });
    await maleBtn.click();
    console.log('✅ [P1] Gender selected: male');

    // After photo upload, the wizard silently kicks off an avatar preview
    // generation (30-90s). During that window the Next button is disabled
    // and labelled "{name} wird erstellt / is being created". We wait for
    // generation to finish (button text flips to Weiter/Next) before clicking.
    console.log('⏳ [P1] Waiting for avatar preview generation to complete (up to 2 min)...');
    const nextBtn = page.locator('button').filter({ hasText: /^(weiter|next|continue|suivant)\s*$/i }).first();
    await expect(nextBtn).toBeVisible({ timeout: 120000 });
    await expect(nextBtn).toBeEnabled({ timeout: 120000 });
    await nextBtn.click();
    console.log('✅ [P1] Character step complete → topic');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2: Topic step — card-based selection (category → theme/topic)
    // ═══════════════════════════════════════════════════════════════════════
    await waitWithLog(page, 'topic step render', 2000);

    // Step 2a: pick the first category card.
    // Categories are buttons with large emojis + a text label — the wizard
    // shows 3-4 in a grid. We pick the first to minimize downstream choices.
    const categoryCards = page.locator('button.p-6.rounded-xl.border-2').filter({
      has: page.locator('.text-5xl'),  // emoji inside
    });
    await expect(categoryCards.first()).toBeVisible({ timeout: 30000 });
    const categoryCount = await categoryCards.count();
    console.log(`   Found ${categoryCount} category cards`);
    const pickedIdx = Math.min(CATEGORY_INDEX, categoryCount - 1);
    await categoryCards.nth(pickedIdx).click();
    console.log(`✅ [P2a] Category picked (index ${pickedIdx})`);

    // Step 2b: pick a theme (second screen after adventure category).
    // Adventure theme buttons are `button.p-2.5.rounded-lg.border.border-gray-200`.
    // Other categories may have different class names, so fall back to the
    // grid structure too.
    await waitWithLog(page, 'theme screen render', 1500);
    const themeGrid = page.locator('div.grid').filter({ has: page.locator('button') }).last();
    const themeButtons = themeGrid.locator('button');
    const themeCount = await themeButtons.count();
    console.log(`   Found ${themeCount} buttons in theme grid`);
    if (themeCount > 0) {
      await themeButtons.first().click();
      console.log('✅ [P2b] Theme picked (first)');
    }

    // Some flows need one more pick (life-challenge has theme + topic).
    // If the Weiter button already shows, we're done; otherwise pick another.
    await waitWithLog(page, 'post-theme settle', 1500);
    const weiterVisible = await page.locator('button').filter({ hasText: /^(weiter|next|continue|suivant)\s*$/i }).first().isVisible().catch(() => false);
    if (!weiterVisible) {
      const subGrid = page.locator('div.grid').filter({ has: page.locator('button') }).last();
      const subButtons = subGrid.locator('button');
      const subCount = await subButtons.count();
      console.log(`   Need another pick: ${subCount} sub-topic buttons`);
      if (subCount > 0) {
        await subButtons.first().click();
        console.log('✅ [P2c] Sub-topic picked');
      }
    }

    // Topic step auto-advances to the ideas step when the theme is selected
    // (TrialTopicStep.tsx:240 — adventure themes call onNext() in onClick).
    // If we're already on the ideas step, skip ahead; otherwise wait/click Weiter.
    await waitWithLog(page, 'post-topic settle', 2000);
    const ideasHeading = page.getByRole('heading', { name: /ideen|ideas|id[ée]es/i }).first();
    const autoAdvanced = await ideasHeading.isVisible().catch(() => false);
    if (autoAdvanced) {
      console.log('✅ [P2] Topic auto-advanced → ideas step visible');
    } else {
      const nextBtn2 = page.locator('button').filter({
        hasText: /^(weiter|next|continue|suivant)\s*$/i,
      }).first();
      await expect(nextBtn2).toBeVisible({ timeout: 30000 });
      await expect(nextBtn2).toBeEnabled({ timeout: 30000 });
      await nextBtn2.click();
      console.log('✅ [P2] Topic Weiter clicked → ideas');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 3: Ideas step — wait for ideas, pick first, create
    // ═══════════════════════════════════════════════════════════════════════
    console.log('⏳ [P3] Waiting for Claude to generate 2 idea cards (30-90s)...');

    // Idea cards are clickable divs with class "relative text-left p-5 rounded-xl border-2 ..."
    // They START in an empty/loading state and fill with text once Claude responds.
    // Wait for at least one card to have a readable title text node.
    const ideaCards = page.locator('div.relative.text-left.p-5.rounded-xl.border-2');
    await expect(ideaCards.first()).toBeVisible({ timeout: 30000 });
    // Wait for text to arrive in the first card (means streaming is done enough
    // to select). We look for any textarea since each idea renders as a textarea
    // when editable.
    const firstIdeaTextarea = ideaCards.first().locator('textarea');
    await expect(firstIdeaTextarea).toBeVisible({ timeout: 3 * 60 * 1000 });
    // Give the textarea a beat to actually contain text — streaming can start
    // before the content has arrived.
    for (let i = 0; i < 60; i++) {
      const val = await firstIdeaTextarea.inputValue();
      if (val.length > 20) break;
      await page.waitForTimeout(1000);
    }
    console.log('✅ [P3] First idea textarea has content');

    // Each idea card has an explicit "Klicke zum Auswählen" / "Click to
    // select" / "Cliquer pour choisir" button. Click it — clicking the card
    // div itself can hit the textarea (stopPropagation) or get rejected
    // while ideas are still streaming (isEditable=false). The select-button
    // is only rendered once the idea is final.
    const selectBtn = ideaCards.first().locator('button').filter({
      hasText: /auswählen|select|choisir|wählen/i,
    }).first();
    // If the select button isn't present yet, wait a bit longer for streaming
    // to finalize before falling back to a direct card click.
    try {
      await expect(selectBtn).toBeVisible({ timeout: 60000 });
      await selectBtn.click();
      console.log('✅ [P3] First idea selected via select-button');
    } catch {
      // Fallback: click the card header area (not the textarea)
      await ideaCards.first().locator('div').first().click({ force: true });
      console.log('✅ [P3] First idea selected via card header fallback');
    }

    // Click the create-story button at the bottom
    const createBtn = page.locator('button').filter({
      hasText: /create (story|my story|this story)|meine geschichte erstellen|geschichte erstellen|cr[ée]er mon histoire/i,
    }).first();
    await expect(createBtn).toBeVisible({ timeout: 30000 });
    await expect(createBtn).toBeEnabled({ timeout: 60000 });
    await createBtn.click();
    console.log('✅ [P3] Create clicked → /trial-generation');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 4: Arrive on /trial-generation; the email form is shown from the
    // start (users can sign up WHILE the story generates). Wait for the email
    // input to be enabled — that's our signal that the page mounted + the
    // create-story API call kicked off (giving us a sessionToken).
    // ═══════════════════════════════════════════════════════════════════════
    await expect(page).toHaveURL(/\/trial-generation/, { timeout: 30000 });
    console.log('✅ [P4] On /trial-generation');
    const emailInput = page.locator('input[type=email]').first();
    await expect(emailInput).toBeVisible({ timeout: 60000 });
    await expect(emailInput).toBeEnabled({ timeout: 60000 });
    console.log('✅ [P4] Email input enabled — ready to link email');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 5: Submit email → wait for DB row → flip verified → wait for
    //         generation to complete → auto-claim → redirect
    // ═══════════════════════════════════════════════════════════════════════
    await emailInput.fill(testEmail);
    // The email-submit button is the SUBMIT button inside the <form> — NOT
    // the Google button above it (which also matches "Weiter mit Google").
    // Text is locale-dependent: de "Geschichte ansehen", en "View my story",
    // fr "Voir mon histoire".
    const submitEmailBtn = page.locator('form button[type=submit]').first();
    await expect(submitEmailBtn).toBeEnabled({ timeout: 15000 });
    await submitEmailBtn.click();
    console.log(`✅ [P5] Email submitted — ${testEmail}`);

    // Wait for the user row to exist in DB with this email (means link-email
    // succeeded). Backend creates the anonymous row on page mount, updates
    // email column on link-email.
    const userId = await waitForUserByEmail(testEmail, 60000);
    console.log(`✅ [P5] User row confirmed in DB — userId=${userId}`);

    // DB-flip email_verified
    await flipEmailVerified(testEmail);
    console.log(`✅ [P5] DB flipped email_verified=true`);

    // Wait for trial story to finish generating AND polling to flip isVerified.
    // The page auto-redirects to /stories once BOTH conditions are met.
    console.log('⏳ [P5] Waiting for story generation + auto-claim redirect (up to 25 min)...');
    await page.waitForURL(/\/stories|\/welcome/, { timeout: TRIAL_GEN_TIMEOUT_MS });
    console.log('✅ [P5] Redirected — trial generation complete and account claimed');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 6: Verify full wizard loads (no generation — save cost)
    // ═══════════════════════════════════════════════════════════════════════
    await page.goto('/create', { waitUntil: 'domcontentloaded' });
    // The full wizard renders step 1 (characters) with a list of existing chars
    // or an empty state + upload. Either way, the page shouldn't redirect back
    // to /try (that would mean we're not authenticated).
    await page.waitForTimeout(3000);
    expect(page.url()).toMatch(/\/create/);
    console.log('✅ [P6] /create loaded — full wizard accessible');

    // Final sanity: the user row should be non-trial, email_verified=true
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      const r = await pool.query(
        'SELECT email_verified, is_trial, anonymous, role FROM users WHERE id = $1',
        [userId]
      );
      console.log(`✅ [DONE] User state:`, r.rows[0]);
      expect(r.rows[0].email_verified).toBe(true);
    } finally {
      await pool.end();
    }
  });
});

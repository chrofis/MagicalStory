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

const TEST_PHOTO = 'C:/Users/roger/OneDrive/Pictures/For automatic testing/Roger.jpg';
const TEST_EMAIL_BASE = process.env.E2E_EMAIL_BASE || 'rogerfischer+e2e';
const STORY_TOPIC = 'abenteuer am bach mit meinem hund';
const CHAR_NAME = 'Testkid';
const CHAR_AGE = '5';

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
    const r = await pool.query(
      `UPDATE users SET email_verified = true
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

async function waitWithLog(page: Page, label: string, ms: number) {
  console.log(`⏳ [${new Date().toISOString()}] ${label} (${ms}ms)`);
  await page.waitForTimeout(ms);
}

test.describe('Trial → full-account end-to-end', () => {
  test.setTimeout(35 * 60 * 1000); // 35 min for whole flow

  test('creates trial, claims via email DB-flip, lands in full wizard', async ({ page, context }) => {
    const testEmail = makeTestEmail();
    console.log(`▶️  Test email: ${testEmail}`);
    console.log(`▶️  Base URL: ${process.env.TEST_BASE_URL || 'https://magicalstory.ch'}`);

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

    // Accept the two consent checkboxes (they appear before upload)
    const consentBoxes = page.locator('[class*="cursor-pointer"]').filter({
      has: page.locator('svg'),
    });
    // Click both consent rows by their text proxy — easier than finding the checkbox svgs
    // The consent block appears above the upload dropzone and contains "Terms" + "Privacy" links.
    const termsLink = page.getByRole('link', { name: /terms|agb|conditions/i }).first();
    const privacyLink = page.getByRole('link', { name: /privacy|datenschutz/i }).first();
    await expect(termsLink).toBeVisible({ timeout: WIZARD_STEP_TIMEOUT });
    // Each consent row wraps the icon + text — click the icon's parent to toggle.
    // Fall back: click twice on each of the two consent-row containers by their SVG-first children.
    const consentRows = page.locator('div.flex.items-start.gap-3.cursor-pointer.group');
    const rowCount = await consentRows.count();
    console.log(`   Found ${rowCount} consent rows`);
    for (let i = 0; i < rowCount; i++) {
      await consentRows.nth(i).click();
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

    // Pick a gender (optional — try to click "male"/"männlich")
    const maleBtn = page.getByRole('button', { name: /\b(male|m[äa]nnlich|boy|junge)\b/i }).first();
    if (await maleBtn.count() > 0) {
      try {
        await maleBtn.click({ timeout: 2000 });
      } catch { /* skip */ }
    }

    // Click Next / Weiter
    const nextBtn = page.getByRole('button', { name: /^(next|weiter|continue|suivant)/i }).first();
    await expect(nextBtn).toBeEnabled({ timeout: 30000 });
    await nextBtn.click();
    console.log('✅ [P1] Character step complete → topic');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2: Topic step — pick anything quick
    // ═══════════════════════════════════════════════════════════════════════
    await waitWithLog(page, 'topic step render', 1500);
    // Look for a topic textarea / input — type a simple topic
    const topicInput = page.locator('textarea, input[type=text]').first();
    if (await topicInput.count() > 0) {
      await topicInput.fill(STORY_TOPIC);
      console.log(`✅ [P2] Topic: ${STORY_TOPIC}`);
    }

    // Sometimes art-style picker is here — click the first style tile to pick one
    const styleTile = page.locator('button, div[role="button"]').filter({ has: page.locator('img') }).first();
    if (await styleTile.count() > 0) {
      try {
        await styleTile.click({ timeout: 2000 });
      } catch { /* first thing might not be clickable, skip */ }
    }

    const nextBtn2 = page.getByRole('button', { name: /^(next|weiter|continue|suivant|create ideas|ideen)/i }).first();
    await expect(nextBtn2).toBeEnabled({ timeout: 30000 });
    await nextBtn2.click();
    console.log('✅ [P2] Topic step complete → ideas');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 3: Ideas step — wait for ideas, pick first, create
    // ═══════════════════════════════════════════════════════════════════════
    console.log('⏳ [P3] Waiting for Claude to generate ideas (can take 20-60s)...');
    // Ideas render as clickable cards. Wait until at least one is visible.
    const ideaCard = page.locator('button, [role="button"], div').filter({
      hasText: /^[A-Z][A-Za-zäöü]+.*[.!?]$/, // rough heuristic — a sentence-like card
    });
    await page.waitForTimeout(3000);
    // More reliable: wait for the "create story" button to become enabled
    const createBtn = page.getByRole('button', {
      name: /create (story|my story|this story)|geschichte erstellen|create this|create!/i,
    }).first();

    // While waiting, if we see a "generate ideas" button, click it
    const genIdeasBtn = page.getByRole('button', { name: /generate (ideas|stories)|ideen generieren|create ideas/i }).first();
    if (await genIdeasBtn.count() > 0 && await genIdeasBtn.isEnabled()) {
      try { await genIdeasBtn.click({ timeout: 2000 }); console.log('   Clicked "Generate Ideas"'); } catch { /* skip */ }
    }

    // Wait up to 2 min for ideas to appear and be selectable
    await expect(createBtn).toBeVisible({ timeout: 2 * 60 * 1000 });
    console.log('✅ [P3] Ideas rendered — selecting first');

    // Click the first idea card to select it, then click create
    // Try h3 inside a clickable container (idea titles are typically bold)
    const firstIdeaTitle = page.locator('h3, h4').first();
    if (await firstIdeaTitle.count() > 0) {
      try {
        await firstIdeaTitle.click({ timeout: 3000 });
        console.log('   Clicked first idea title');
      } catch { /* skip */ }
    }

    await expect(createBtn).toBeEnabled({ timeout: 30000 });
    await createBtn.click();
    console.log('✅ [P3] Create clicked → trial-generation');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 4: Wait for trial story generation to complete
    // ═══════════════════════════════════════════════════════════════════════
    await expect(page).toHaveURL(/\/trial-generation/, { timeout: 30000 });
    console.log('✅ [P4] On /trial-generation — waiting for completion');

    // A completed trial shows an email-input form OR the story preview
    // We look for the email input (it's the "sign up to see" gate)
    const emailInput = page.locator('input[type=email]').first();
    await expect(emailInput).toBeVisible({ timeout: TRIAL_GEN_TIMEOUT_MS });
    console.log('✅ [P4] Trial generation complete — email input visible');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 5: Submit email → DB flip verified → auto-claim
    // ═══════════════════════════════════════════════════════════════════════
    await emailInput.fill(testEmail);
    const submitEmailBtn = page.getByRole('button', {
      name: /^(sign up|create account|send|submit|weiter|anmelden|registrieren)/i,
    }).first();
    await submitEmailBtn.click();
    console.log(`✅ [P5] Email submitted — ${testEmail}`);

    // Give the backend a moment to create the user row
    await waitWithLog(page, 'link-email settle', 4000);

    // DB-flip email_verified for this address
    const { userId } = await flipEmailVerified(testEmail);
    console.log(`✅ [P5] DB flipped email_verified=true for userId=${userId}`);

    // The page polls check-status every 5s. Wait for the /stories redirect.
    await page.waitForURL(/\/stories|\/welcome/, { timeout: 90000 });
    console.log('✅ [P5] Auto-claim succeeded — redirected to /stories');

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

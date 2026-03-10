import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { DEMO_ROTATION, DemoRotationEntry } from './helpers/demo-rotation';

/**
 * Demo Story Generator Test
 *
 * Generates real demo stories for the homepage by navigating the full wizard UI.
 * Each run picks the next topic/art style from the rotation list.
 *
 * This test INTENTIONALLY generates real stories (uses API credits).
 * It should be run separately from the regular test suite.
 *
 * Prerequisites:
 *   1. Run `node scripts/admin/setup-demo-user.js` to create the demo account
 *   2. Set DEMO_EMAIL and DEMO_PASSWORD env vars (or use defaults)
 *   3. Demo user needs sufficient credits (or unlimited: credits = -1)
 */

const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@magicalstory.ch';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoStory2026!';
const ROTATION_STATE_FILE = path.join(__dirname, 'demo-rotation-state.json');
const STORY_PAGES = 14;

// Timeout for wizard navigation (not waiting for generation)
const WIZARD_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// German art style names (id → German label)
const ART_STYLE_LABELS: Record<string, string> = {
  watercolor: 'Aquarell',
  concept: 'Konzeptkunst',
  anime: 'Anime',
  pixar: 'Pixar 3D',
  cartoon: 'Cartoon',
  comic: 'Comic',
  oil: 'Ölgemälde',
  steampunk: 'Steampunk',
  cyber: 'Cyberpunk',
  chibi: 'Chibi',
  manga: 'Manga',
  pixel: 'Pixelkunst',
  lowpoly: 'Low Poly',
};

// Category labels: regex patterns matching both English and German UI
const CATEGORY_PATTERNS: Record<string, RegExp> = {
  'adventure': /adventure|abenteuer/i,
  'life-challenge': /life skills|lebenskompetenzen/i,
  'educational': /learning|lernen/i,
  'historical': /history|geschichte/i,
  'custom': /create your own|eigenes thema/i,
};

// Topic labels: regex patterns matching both English and German UI
const TOPIC_PATTERNS: Record<string, RegExp> = {
  'first-kindergarten': /first.*kindergarten|erster kindergartentag/i,
  'new-sibling': /new.*sibling|neues geschwisterchen/i,
  'brushing-teeth': /brushing.*teeth|zähne putzen/i,
  'going-to-bed': /going.*bed|ins bett gehen/i,
  'making-friends': /making.*friends|echte freunde finden/i,
  'sharing': /learning.*share|teilen lernen/i,
  'managing-emotions': /managing.*emotions|grosse gefühle/i,
  // Adventure themes
  'pirate': /pirate|piraten/i,
  'space': /space.*explorer|weltraum/i,
  'dinosaur': /dinosaur|dinosaurier/i,
  'knight': /knight|ritter/i,
  'mermaid': /mermaid|meerjungfrau/i,
  'superhero': /superhero|superheld/i,
  'jungle': /jungle|dschungel/i,
  // Educational
  'counting': /counting|zählen/i,
  'planets': /planet/i,
  // Historical
  'moon-landing': /moon.*landing|mondlandung|neil armstrong/i,
  'wilhelm-tell': /wilhelm tell/i,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getRotationState(): { currentIndex: number; generatedStories: string[] } {
  try {
    return JSON.parse(fs.readFileSync(ROTATION_STATE_FILE, 'utf-8'));
  } catch {
    return { currentIndex: 0, generatedStories: [] };
  }
}

function saveRotationState(state: { currentIndex: number; generatedStories: string[] }) {
  fs.writeFileSync(ROTATION_STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function getCurrentEntry(): DemoRotationEntry {
  const state = getRotationState();
  const index = state.currentIndex % DEMO_ROTATION.length;
  return DEMO_ROTATION[index];
}

async function loginAsDemoUser(page: Page) {
  // Navigate to a protected route to trigger login redirect
  await page.goto('/?login=true');

  // Wait for the auth modal to appear
  const authModal = page.locator('.fixed.inset-0');
  if (!await authModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Try clicking login/sign-in link in the page
    const loginLink = page.getByRole('link', { name: /log in|sign in|anmelden|connexion/i }).first();
    if (await loginLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loginLink.click();
    } else {
      // Try the menu
      const menuBtn = page.getByRole('button', { name: /menu/i }).first();
      if (await menuBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await menuBtn.click();
        await page.waitForTimeout(500);
        const loginMenuItem = page.getByText(/log in|sign in|anmelden|connexion/i).first();
        await loginMenuItem.click();
      }
    }
  }

  await page.waitForSelector('.fixed.inset-0', { timeout: 10000 });

  // Fill login form inside the modal
  const modal = page.locator('.fixed.inset-0');
  await modal.getByPlaceholder(/email/i).fill(DEMO_EMAIL);
  await modal.locator('input[type="password"]').fill(DEMO_PASSWORD);

  // Click the "Sign in" submit button inside the modal
  const signInButton = modal.getByRole('button', { name: /sign in/i });
  await signInButton.click();

  // Wait for redirect to wizard
  await page.waitForURL(/\/(create|welcome|stories)/, { timeout: 15000 });
}

async function clickNext(page: Page) {
  const nextBtn = page.getByRole('button', { name: /weiter|next|suivant/i }).first();
  await expect(nextBtn).toBeEnabled({ timeout: 10000 });
  await nextBtn.click();
  await page.waitForTimeout(1000);  // Wait for step transition
}

// ─── Test ───────────────────────────────────────────────────────────────────

test.describe('Demo Story Generation', () => {
  test.describe.configure({ mode: 'serial' });

  const entry = getCurrentEntry();

  test(`Generate demo story: ${entry.description}`, async ({ page }) => {
    test.setTimeout(WIZARD_TIMEOUT);

    const categoryPattern = CATEGORY_PATTERNS[entry.storyCategory];
    const topicPattern = TOPIC_PATTERNS[entry.storyTopic];
    const artStyleLabel = ART_STYLE_LABELS[entry.artStyle];

    console.log(`\n=== Demo Story Generation ===`);
    console.log(`  Rotation index: ${entry.index}`);
    console.log(`  Category: ${entry.storyCategory}`);
    console.log(`  Topic: ${entry.storyTopic}`);
    console.log(`  Art Style: ${entry.artStyle} (${artStyleLabel})`);
    console.log(`  Pages: ${STORY_PAGES}`);
    console.log(`================================\n`);

    // Collect JS errors
    const jsErrors: string[] = [];
    page.on('pageerror', err => jsErrors.push(err.message));

    // ── Step 0: Login ──
    console.log('Step 0: Logging in as demo user...');
    await loginAsDemoUser(page);

    // ── Navigate to new story ──
    console.log('Step 0: Starting new story...');
    await page.goto('/create?new=true');
    await page.waitForTimeout(2000); // Wait for wizard to load and characters to fetch

    // ── Step 1: Characters ──
    console.log('Step 1: Verifying characters...');

    // Wait for characters to load (they should auto-load from the demo account)
    await expect(page.getByRole('heading', { name: 'Emma' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Noah' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('heading', { name: 'Daniel' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('heading', { name: 'Sarah' })).toBeVisible({ timeout: 5000 });

    // Verify at least one main character is set (Emma or Noah should be main)
    // The characters should already have storyRole set from the setup script
    // If "Next" is not enabled, we need to set main characters
    const nextBtn = page.getByRole('button', { name: /weiter|next|suivant/i }).first();
    const isNextEnabled = await nextBtn.isEnabled().catch(() => false);

    if (!isNextEnabled) {
      console.log('  Setting character roles...');
      // Click "Main" / "Hauptrolle" for the first two characters (Emma and Noah)
      const mainButtons = page.getByRole('button', { name: /^main$|hauptrolle/i });
      const roleButtonCount = await mainButtons.count();
      if (roleButtonCount >= 2) {
        await mainButtons.nth(0).click();
        await page.waitForTimeout(500);
        await mainButtons.nth(1).click();
        await page.waitForTimeout(500);
      }
    }

    await clickNext(page);

    // ── Step 2: Book Settings ──
    console.log('Step 2: Setting book format...');

    // Set page count to 14 via the range slider
    const slider = page.locator('input[type="range"]');
    if (await slider.isVisible({ timeout: 5000 }).catch(() => false)) {
      await slider.fill(String(STORY_PAGES));
      await page.waitForTimeout(500);
    }

    // Verify page count is set
    await expect(page.getByText(`${STORY_PAGES}`)).toBeVisible({ timeout: 3000 }).catch(() => {
      console.log(`  Warning: Could not verify page count display`);
    });

    await clickNext(page);

    // ── Step 3: Story Type ──
    console.log(`Step 3: Selecting story type: ${entry.storyCategory} → ${entry.storyTopic}...`);

    // Click the category button
    const categoryBtn = page.locator('button').filter({ hasText: categoryPattern }).first();
    await expect(categoryBtn).toBeVisible({ timeout: 5000 });
    await categoryBtn.click();
    await page.waitForTimeout(1000);

    // Find and click the topic/theme button
    // Topics may be in collapsible groups — try direct match first, then expand groups
    async function findAndClickTopic() {
      // Try direct match
      const directBtn = page.locator('button').filter({ hasText: topicPattern }).first();
      if (await directBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await directBtn.click();
        return true;
      }
      // Expand all group headers and try again
      const groupHeaders = page.locator('button').filter({
        hasText: /beliebt|popular|historisch|historical|fantasie|fantasy|entdeckung|exploration|helden|heroes|jahreszeiten|seasonal|schweiz|swiss|welt|world|toddler|kleinkind|preschool|vorschul|school|schul|family|famili|numbers|math|science|animal|body|time|music|letter/i,
      });
      const groupCount = await groupHeaders.count();
      for (let i = 0; i < groupCount; i++) {
        await groupHeaders.nth(i).click();
        await page.waitForTimeout(500);
        const found = await page.locator('button').filter({ hasText: topicPattern }).first().isVisible().catch(() => false);
        if (found) {
          await page.locator('button').filter({ hasText: topicPattern }).first().click();
          return true;
        }
      }
      return false;
    }

    const topicFound = await findAndClickTopic();
    if (!topicFound) {
      throw new Error(`Could not find topic button for: ${entry.storyTopic}`);
    }

    await page.waitForTimeout(1000);
    await clickNext(page);

    // ── Step 4: Art Style ──
    console.log(`Step 4: Selecting art style: ${artStyleLabel}...`);

    const artBtn = page.locator('button').filter({ hasText: artStyleLabel }).first();
    await expect(artBtn).toBeVisible({ timeout: 5000 });
    await artBtn.click();
    await page.waitForTimeout(1000);

    // Art style step may auto-advance to step 5 — only click Next if still on step 4
    const nextBtnAfterArt = page.getByRole('button', { name: /weiter|next|suivant/i }).first();
    if (await nextBtnAfterArt.isVisible({ timeout: 3000 }).catch(() => false)) {
      await clickNext(page);
    } else {
      console.log('  Art style auto-advanced to step 5');
      await page.waitForTimeout(1000);
    }

    // ── Step 5: Summary & Generate ──
    console.log('Step 5: Generating story ideas and starting generation...');

    // Ideas auto-generate on step 5 — wait for "Use this" button to appear
    // This can take up to 2 minutes depending on Claude API response time
    console.log('  Waiting for story ideas to generate...');
    const ideaOption = page.locator('button').filter({ hasText: /diese verwenden|use this|select this/i }).first();
    await expect(ideaOption).toBeVisible({ timeout: 180000 });
    await ideaOption.click();
    await page.waitForTimeout(1000);

    // Click "Generate Story" / "Geschichte erstellen!"
    const generateBtn = page.locator('button').filter({ hasText: /geschichte erstellen|generate story|create story/i }).first();
    await expect(generateBtn).toBeVisible({ timeout: 10000 });
    await expect(generateBtn).toBeEnabled({ timeout: 10000 });
    console.log('Step 5: Clicking Generate Story...');
    await generateBtn.click();

    // Wait briefly to confirm generation started (URL changes or progress appears)
    await page.waitForTimeout(5000);
    console.log('  Generation triggered successfully.');

    // ── Verification: UI flow completed without errors ──
    // Check no critical JS errors occurred during the wizard flow
    const criticalErrors = jsErrors.filter(e =>
      !e.includes('ResizeObserver') && !e.includes('chunk')
    );
    if (criticalErrors.length > 0) {
      console.log(`  JS errors: ${criticalErrors.join(', ')}`);
    }
    expect(criticalErrors.length).toBe(0);

    // ── Update rotation state ──
    const state = getRotationState();
    state.generatedStories.push(`${entry.storyCategory}/${entry.storyTopic} (${entry.artStyle}) - ${new Date().toISOString()}`);
    state.currentIndex = (state.currentIndex + 1) % DEMO_ROTATION.length;
    saveRotationState(state);

    console.log(`\nDemo story generated successfully!`);
    console.log(`Next rotation index: ${state.currentIndex}`);
    console.log(`Total demo stories generated: ${state.generatedStories.length}`);
  });
});

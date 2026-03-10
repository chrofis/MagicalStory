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

// Generation can take a long time
const GENERATION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

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

// German category labels
const CATEGORY_LABELS: Record<string, string> = {
  'adventure': 'Abenteuer',
  'life-challenge': 'Lebenskompetenzen',
  'educational': 'Lernen',
  'historical': 'Geschichte',
  'custom': 'Eigenes Thema',
};

// German topic labels for specific topics we use
const TOPIC_LABELS: Record<string, string> = {
  'first-kindergarten': 'Erster Kindergartentag',
  'new-sibling': 'Neues Geschwisterchen',
  'brushing-teeth': 'Zähne putzen',
  'going-to-bed': 'Ins Bett gehen',
  'making-friends': 'Echte Freunde finden',
  'sharing': 'Teilen lernen',
  'managing-emotions': 'Grosse Gefühle bewältigen',
  // Adventure themes
  'pirate': 'Piraten-Abenteuer',
  'space': 'Weltraum-Entdecker',
  'dinosaur': 'Dinosaurier-Welt',
  'knight': 'Ritter & Prinzessin',
  'mermaid': 'Meerjungfrauen-Abenteuer',
  'superhero': 'Superheld',
  'jungle': 'Dschungel-Safari',
  // Educational
  'counting': 'Zählen lernen',
  'planets': 'Planeten & Weltraum',
  // Historical
  'moon-landing': 'Mondlandung',
  'wilhelm-tell': 'Wilhelm Tell',
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
  await page.goto('/');

  // Click CTA to open auth modal
  const ctaButton = page.getByRole('button', { name: /start|begin|create|erstell|crée/i }).first();
  await ctaButton.click();
  await page.waitForSelector('.fixed.inset-0', { timeout: 5000 });

  // Fill login form
  await page.getByPlaceholder('your@email.com').fill(DEMO_EMAIL);
  await page.locator('input[type="password"]').first().fill(DEMO_PASSWORD);

  // Click sign in
  const signInButton = page.getByRole('button', { name: /sign in|login|log in|anmelden|connexion/i }).first();
  await signInButton.click();

  // Wait for redirect
  await page.waitForURL(/\/(create|welcome|stories)/, { timeout: 15000 });
}

async function clickNext(page: Page) {
  const nextBtn = page.getByRole('button', { name: /weiter|next|suivant/i }).first();
  await expect(nextBtn).toBeEnabled({ timeout: 10000 });
  await nextBtn.click();
  await page.waitForTimeout(1000);  // Wait for step transition
}

async function waitForGenerationComplete(page: Page) {
  // Wait for the story display to appear (step 6)
  // The generation status is shown with progress indicators
  // When complete, story pages with images should be visible

  // First, wait for generation to start (progress bar or status text)
  console.log('  Waiting for story generation to complete...');

  // Poll for completion by checking if story content is visible
  const startTime = Date.now();
  const pollInterval = 15000; // Check every 15 seconds

  while (Date.now() - startTime < GENERATION_TIMEOUT) {
    // Check for story completion indicators:
    // - Story pages with images
    // - "Download" or "PDF" buttons appearing
    // - Absence of progress/spinner elements
    const hasStoryContent = await page.locator('img[src*="storage"], img[src*="blob"], img[src*="data:image"]').count() > 2;
    const hasDownloadBtn = await page.getByRole('button', { name: /download|pdf|herunterladen/i }).count() > 0;
    const hasErrorState = await page.getByText(/error|fehler|failed|fehlgeschlagen/i).count() > 0;

    if (hasErrorState) {
      throw new Error('Story generation failed with an error');
    }

    if (hasStoryContent && hasDownloadBtn) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  Generation completed in ${elapsed}s`);
      return;
    }

    // Log progress
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const progressText = await page.locator('[class*="progress"], [role="progressbar"]').textContent().catch(() => '');
    console.log(`  Still generating... (${elapsed}s elapsed) ${progressText}`);

    await page.waitForTimeout(pollInterval);
  }

  throw new Error(`Story generation timed out after ${GENERATION_TIMEOUT / 1000}s`);
}

// ─── Test ───────────────────────────────────────────────────────────────────

test.describe('Demo Story Generation', () => {
  test.describe.configure({ mode: 'serial' });

  const entry = getCurrentEntry();

  test(`Generate demo story: ${entry.description}`, async ({ page }) => {
    test.setTimeout(GENERATION_TIMEOUT + 60000); // Extra minute for UI navigation

    const categoryLabel = CATEGORY_LABELS[entry.storyCategory];
    const topicLabel = TOPIC_LABELS[entry.storyTopic];
    const artStyleLabel = ART_STYLE_LABELS[entry.artStyle];

    console.log(`\n=== Demo Story Generation ===`);
    console.log(`  Rotation index: ${entry.index}`);
    console.log(`  Category: ${entry.storyCategory} (${categoryLabel})`);
    console.log(`  Topic: ${entry.storyTopic} (${topicLabel})`);
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
    await expect(page.getByText('Emma')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Noah')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Daniel')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Sarah')).toBeVisible({ timeout: 5000 });

    // Verify at least one main character is set (Emma or Noah should be main)
    // The characters should already have storyRole set from the setup script
    // If "Next" is not enabled, we need to set main characters
    const nextBtn = page.getByRole('button', { name: /weiter|next|suivant/i }).first();
    const isNextEnabled = await nextBtn.isEnabled().catch(() => false);

    if (!isNextEnabled) {
      console.log('  Setting character roles...');
      // Click "Hauptrolle" for Emma and Noah
      const hauptrolleButtons = page.getByRole('button', { name: /hauptrolle|main/i });
      const roleButtonCount = await hauptrolleButtons.count();
      if (roleButtonCount >= 2) {
        await hauptrolleButtons.nth(0).click();
        await page.waitForTimeout(500);
        await hauptrolleButtons.nth(1).click();
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
    console.log(`Step 3: Selecting story type: ${categoryLabel} → ${topicLabel}...`);

    // Click the category button
    const categoryBtn = page.locator('button').filter({ hasText: categoryLabel }).first();
    await expect(categoryBtn).toBeVisible({ timeout: 5000 });
    await categoryBtn.click();
    await page.waitForTimeout(1000);

    // For some categories, topics are in collapsible groups
    // Try to find and click the topic directly first
    if (entry.storyCategory === 'adventure') {
      // Adventure: select the theme (pirate, space, etc.)
      // Themes may be in groups - the "popular" group is usually expanded
      const themeBtn = page.locator('button').filter({ hasText: topicLabel }).first();
      if (await themeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await themeBtn.click();
      } else {
        // Try expanding groups to find the theme
        const groupHeaders = page.locator('button').filter({ hasText: /beliebt|popular|historisch|fantasie|entdeckung/i });
        for (let i = 0; i < await groupHeaders.count(); i++) {
          await groupHeaders.nth(i).click();
          await page.waitForTimeout(500);
          const found = await page.locator('button').filter({ hasText: topicLabel }).first().isVisible().catch(() => false);
          if (found) {
            await page.locator('button').filter({ hasText: topicLabel }).first().click();
            break;
          }
        }
      }
    } else if (entry.storyCategory === 'historical') {
      // Historical: events may be grouped, search by short name
      const eventBtn = page.locator('button').filter({ hasText: topicLabel }).first();
      if (await eventBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await eventBtn.click();
      } else {
        // Try expanding groups
        const groupHeaders = page.locator('button').filter({ hasText: /schweiz|swiss|welt|world|entdeck|explor/i });
        for (let i = 0; i < await groupHeaders.count(); i++) {
          await groupHeaders.nth(i).click();
          await page.waitForTimeout(500);
          const found = await page.locator('button').filter({ hasText: topicLabel }).first().isVisible().catch(() => false);
          if (found) {
            await page.locator('button').filter({ hasText: topicLabel }).first().click();
            break;
          }
        }
      }
    } else {
      // Life challenge / Educational: find and click the topic
      const topicBtn = page.locator('button').filter({ hasText: topicLabel }).first();
      if (await topicBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await topicBtn.click();
      } else {
        // Try expanding all group headers
        const groupHeaders = page.locator('button[class*="bg-gray-50"], button[class*="justify-between"]');
        for (let i = 0; i < await groupHeaders.count(); i++) {
          await groupHeaders.nth(i).click();
          await page.waitForTimeout(500);
          const found = await page.locator('button').filter({ hasText: topicLabel }).first().isVisible().catch(() => false);
          if (found) {
            await page.locator('button').filter({ hasText: topicLabel }).first().click();
            break;
          }
        }
      }
    }

    await page.waitForTimeout(1000);
    await clickNext(page);

    // ── Step 4: Art Style ──
    console.log(`Step 4: Selecting art style: ${artStyleLabel}...`);

    const artBtn = page.locator('button').filter({ hasText: artStyleLabel }).first();
    await expect(artBtn).toBeVisible({ timeout: 5000 });
    await artBtn.click();
    await page.waitForTimeout(500);

    await clickNext(page);

    // ── Step 5: Summary & Generate ──
    console.log('Step 5: Generating story ideas and starting generation...');

    // Click "Vorschlag generieren" to get AI-generated story ideas
    const generateIdeasBtn = page.locator('button').filter({ hasText: /vorschlag generieren|generate suggest/i }).first();
    if (await generateIdeasBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await generateIdeasBtn.click();

      // Wait for ideas to generate (up to 60 seconds)
      await page.waitForTimeout(3000);
      const ideaOption = page.locator('button').filter({ hasText: /diese verwenden|use this/i }).first();
      await expect(ideaOption).toBeVisible({ timeout: 60000 });
      await ideaOption.click();
      await page.waitForTimeout(500);
    } else {
      // Fallback: fill story details manually
      console.log('  Generate ideas button not found, filling manually...');
      const textarea = page.locator('textarea').first();
      await textarea.fill(`Eine Geschichte über die Familie Berger: Emma (5) und Noah (7) erleben ein spannendes Abenteuer.`);
    }

    // Click "Geschichte erstellen!" to start generation
    const generateBtn = page.locator('button').filter({ hasText: /geschichte erstellen|generate story|create story/i }).first();
    await expect(generateBtn).toBeVisible({ timeout: 5000 });
    await expect(generateBtn).toBeEnabled({ timeout: 5000 });
    await generateBtn.click();

    // ── Step 6: Wait for generation & verify ──
    console.log('Step 6: Waiting for story generation...');
    await waitForGenerationComplete(page);

    // ── Verification ──
    console.log('Verifying generated story...');

    // Check story has images (at least 5 page images for a 14-page story)
    const storyImages = page.locator('img[src*="storage"], img[src*="blob"], img[src*="data:image"]');
    const imageCount = await storyImages.count();
    console.log(`  Found ${imageCount} images`);
    expect(imageCount).toBeGreaterThanOrEqual(5);

    // Verify images actually load (check first few)
    for (let i = 0; i < Math.min(3, imageCount); i++) {
      const img = storyImages.nth(i);
      const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
      expect(naturalWidth).toBeGreaterThan(0);
    }

    // Check text is in German (look for common German words)
    const pageContent = await page.textContent('body') || '';
    const germanIndicators = ['und', 'die', 'der', 'ein', 'mit', 'auf', 'für', 'sie', 'ist', 'war'];
    const foundGermanWords = germanIndicators.filter(w => {
      const regex = new RegExp(`\\b${w}\\b`, 'i');
      return regex.test(pageContent);
    });
    console.log(`  German words found: ${foundGermanWords.length}/${germanIndicators.length}`);
    expect(foundGermanWords.length).toBeGreaterThanOrEqual(3);

    // Check no critical JS errors
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

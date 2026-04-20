import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { DEMO_ROTATION, DemoRotationEntry } from './helpers/demo-rotation';
import { getFamily, DemoLanguage, DemoFamily } from './helpers/demo-characters';

const PHOTOS_DIR = path.resolve(__dirname, 'fixtures', 'demo-photos');

/**
 * Demo Story Generator Test
 *
 * Generates real demo stories for the homepage by navigating the full wizard UI.
 * Each run picks the next entry from DEMO_ROTATION (rotates family × language ×
 * topic × art style). Override with DEMO_ENTRY_INDEX env var.
 *
 * This test INTENTIONALLY generates real stories (uses API credits).
 *
 * Prerequisites:
 *   1. Run `node scripts/admin/setup-demo-user.js` to create demo accounts
 *   2. Run `node scripts/admin/generate-demo-photos.js` to seed character photos
 *   3. Demo users need credits (or unlimited: credits = -1)
 */

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoStory2026!';
const ROTATION_STATE_FILE = path.join(__dirname, 'demo-rotation-state.json');
const STORY_PAGES = 14;
const WIZARD_TIMEOUT = 5 * 60 * 1000;

// ─── Multilingual UI labels ────────────────────────────────────────────────

const ART_STYLE_LABELS: Record<DemoLanguage, Record<string, string>> = {
  de: {
    watercolor: 'Aquarell', concept: 'Konzeptkunst', anime: 'Anime', pixar: 'Pixar 3D',
    cartoon: 'Cartoon', comic: 'Comic', oil: 'Ölgemälde', steampunk: 'Steampunk',
    cyber: 'Cyberpunk', chibi: 'Chibi', manga: 'Manga', pixel: 'Pixelkunst', lowpoly: 'Low Poly',
  },
  en: {
    watercolor: 'Watercolor', concept: 'Concept Art', anime: 'Anime', pixar: 'Pixar 3D',
    cartoon: 'Cartoon', comic: 'Comic', oil: 'Oil Painting', steampunk: 'Steampunk',
    cyber: 'Cyberpunk', chibi: 'Chibi', manga: 'Manga', pixel: 'Pixel Art', lowpoly: 'Low Poly',
  },
  fr: {
    watercolor: 'Aquarelle', concept: 'Art Conceptuel', anime: 'Anime', pixar: 'Pixar 3D',
    cartoon: 'Dessin animé', comic: 'Bande dessinée', oil: 'Peinture à l\'huile', steampunk: 'Steampunk',
    cyber: 'Cyberpunk', chibi: 'Chibi', manga: 'Manga', pixel: 'Pixel Art', lowpoly: 'Low Poly',
  },
};

// Category & topic patterns — multilingual regex per id (matches whichever UI is shown).
const CATEGORY_PATTERNS: Record<string, RegExp> = {
  'adventure': /adventure|abenteuer|aventure/i,
  'life-challenge': /life skills|lebenskompetenzen|compétences de vie/i,
  'educational': /learning|lernen|apprendre|éducation|apprentissage/i,
  'historical': /history|geschichte|histoire/i,
  'custom': /create your own|eigenes thema|créer/i,
};

const TOPIC_PATTERNS: Record<string, RegExp> = {
  'first-kindergarten': /first.*kindergarten|erster kindergartentag|premier.*maternelle/i,
  'new-sibling': /new.*sibling|neues geschwisterchen|nouveau.*frère|nouvelle.*sœur/i,
  'brushing-teeth': /brushing.*teeth|zähne putzen|brosser.*dents/i,
  'going-to-bed': /going.*bed|ins bett gehen|aller.*lit|coucher/i,
  'making-friends': /making.*friends|echte freunde finden|se faire.*amis/i,
  'sharing': /learning.*share|teilen lernen|apprendre.*partager/i,
  'managing-emotions': /managing.*emotions|grosse gefühle|gérer.*émotions/i,
  'pirate': /pirate|piraten/i,
  'space': /space.*explorer|weltraum|espace/i,
  'dinosaur': /dinosaur|dinosaurier|dinosaure/i,
  'knight': /knight|ritter|chevalier/i,
  'mermaid': /mermaid|meerjungfrau|sirène/i,
  'superhero': /superhero|superheld|super-?héros/i,
  'jungle': /jungle|dschungel/i,
  'counting': /counting|zählen|compter/i,
  'planets': /planet|planète/i,
  'moon-landing': /moon.*landing|mondlandung|neil armstrong|alunissage/i,
  'wilhelm-tell': /wilhelm tell/i,
};

const NEXT_BTN_RE = /weiter|next|suivant/i;
const SIGN_IN_RE = /log in|sign in|anmelden|connexion|se connecter/i;
const MAIN_BTN_RE = /^main$|hauptrolle|principal/i;
const USE_THIS_RE = /diese verwenden|use this|utiliser|select this|choisir/i;
const GENERATE_RE = /geschichte erstellen|generate story|create story|générer|créer.*histoire/i;

// ─── Helpers ────────────────────────────────────────────────────────────────

interface RotationState { currentIndex: number; generatedStories: string[]; }

function getRotationState(): RotationState {
  try {
    return JSON.parse(fs.readFileSync(ROTATION_STATE_FILE, 'utf-8'));
  } catch {
    return { currentIndex: 0, generatedStories: [] };
  }
}

function saveRotationState(state: RotationState) {
  fs.writeFileSync(ROTATION_STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function getCurrentEntry(): DemoRotationEntry {
  const overrideRaw = process.env.DEMO_ENTRY_INDEX;
  if (overrideRaw !== undefined && overrideRaw !== '') {
    const override = parseInt(overrideRaw, 10);
    if (!Number.isNaN(override)) return DEMO_ROTATION[override % DEMO_ROTATION.length];
  }
  const state = getRotationState();
  return DEMO_ROTATION[state.currentIndex % DEMO_ROTATION.length];
}

async function loginAs(page: Page, email: string, password: string) {
  await page.goto('/?login=true');

  const authModal = page.locator('.fixed.inset-0');
  if (!await authModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    const loginLink = page.getByRole('link', { name: SIGN_IN_RE }).first();
    if (await loginLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loginLink.click();
    } else {
      const menuBtn = page.getByRole('button', { name: /menu/i }).first();
      if (await menuBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await menuBtn.click();
        await page.waitForTimeout(500);
        await page.getByText(SIGN_IN_RE).first().click();
      }
    }
  }

  await page.waitForSelector('.fixed.inset-0', { timeout: 10000 });
  const modal = page.locator('.fixed.inset-0');
  await modal.getByPlaceholder(/email/i).fill(email);
  await modal.locator('input[type="password"]').fill(password);
  await modal.getByRole('button', { name: /sign in|anmelden|connexion|se connecter/i }).click();

  await page.waitForURL(/\/(create|welcome|stories)/, { timeout: 15000 });
}

async function clickNext(page: Page) {
  const nextBtn = page.getByRole('button', { name: NEXT_BTN_RE }).first();
  await expect(nextBtn).toBeEnabled({ timeout: 10000 });
  await nextBtn.click();
  await page.waitForTimeout(1000);
}

async function preSeedLanguage(page: Page, language: DemoLanguage, baseUrl: string) {
  // Set the language preference in localStorage BEFORE the app boots so the wizard renders
  // in the target language from the first paint. The LanguageProvider also accepts ?lang= as
  // an override on the URL, but we set both to be safe.
  await page.goto(`${baseUrl}/?lang=${language}`);
  await page.evaluate((lang) => {
    try { localStorage.setItem('magicalstory_language', lang); } catch { /* ignore */ }
  }, language);
}

// ─── Photo seeding (Playwright-driven) ──────────────────────────────────────
// Characters are pre-created with full metadata (traits, relationships, roles)
// via the API in showcase.js before Playwright runs. But photo upload via the
// API is awkward (nested shape vs server's flat photo_url column), so we drive
// the real UI instead — it's more robust to schema drift and mirrors what a
// real user would do.

const PHOTO_LABEL_RE = /foto hochladen|upload photo|neues foto|new photo|foto wechseln|change photo|foto ersetzen/i;
const SAVE_CHAR_RE = /speichern|save|enregistrer|finish|fertig|done/i;

async function isOnCharacterList(page: Page): Promise<boolean> {
  // Character list view shows a "Create Another" card OR any character heading
  const markers = await page.locator('text=/create another|weiteren charakter|personnage suivant/i').count();
  return markers > 0;
}

async function findCharacterCard(page: Page, name: string) {
  // Matches the `div.border.rounded` (or .rounded-lg) card variants observed in CharacterList
  return page.locator('div.border.rounded-lg, div.border.rounded').filter({ hasText: name }).first();
}

async function waitForPhotoAnalysis(page: Page) {
  // Photo analyzer (Python service via server) extracts face/body/bodyNoBg ~5-15s.
  // We don't have a reliable spinner selector across wizard states, so just sleep.
  await page.waitForTimeout(15000);
}

async function uploadPhotoForCharacter(page: Page, charName: string, photoPath: string) {
  console.log(`  [${charName}] opening edit...`);
  const card = await findCharacterCard(page, charName);
  await expect(card).toBeVisible({ timeout: 10000 });

  // Primary selector matches the original character-management.spec.ts pattern
  const editBtn = card.locator('button.bg-indigo-600').first();
  if (await editBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await editBtn.click();
  } else {
    // Fallback: click the thumbnail
    await card.locator('img, svg').first().click();
  }
  await page.waitForTimeout(2000);

  console.log(`  [${charName}] uploading photo from ${path.relative(process.cwd(), photoPath)}`);
  const newPhotoLabel = page.locator('label').filter({ hasText: PHOTO_LABEL_RE }).first();
  let fileInput = newPhotoLabel.locator('input[type="file"]');
  if (await fileInput.count() === 0) {
    // Fallback: any file input on the edit screen
    fileInput = page.locator('input[type="file"]').first();
  }
  await fileInput.setInputFiles(photoPath);
  await waitForPhotoAnalysis(page);

  // Walk any remaining save-path clicks until we land back on the character list.
  // Cap iterations to avoid runaway loops.
  console.log(`  [${charName}] walking to save...`);
  for (let i = 0; i < 8; i++) {
    if (await isOnCharacterList(page)) break;

    const saveBtn = page.getByRole('button', { name: SAVE_CHAR_RE }).first();
    if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false) && await saveBtn.isEnabled().catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(2500);
      continue;
    }

    const nextBtn = page.getByRole('button', { name: NEXT_BTN_RE }).first();
    if (await nextBtn.isVisible({ timeout: 1500 }).catch(() => false) && await nextBtn.isEnabled().catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(2000);
      continue;
    }

    // Nothing to click — stuck. Bail out; the character may have been saved earlier.
    console.log(`  [${charName}] no next/save button visible after ${i + 1} steps — assuming saved`);
    break;
  }

  await page.waitForTimeout(1500);
  console.log(`  [${charName}] done`);
}

async function waitForAllAvatars(page: Page, family: DemoFamily, timeoutMs = 180000) {
  // Poll /api/characters (via the page's authenticated session) until every
  // family character shows a standard avatar (or we hit the timeout).
  const deadline = Date.now() + timeoutMs;
  const needed = new Set(family.characters.map(c => c.name));

  while (Date.now() < deadline) {
    const status = await page.evaluate(async () => {
      const token = localStorage.getItem('auth_token');
      const res = await fetch('/api/characters?includeAllAvatars=true', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.characters || []).map((c: any) => ({
        name: c.name,
        hasAvatar: !!(c.avatars && (c.avatars.standard || c.avatars.winter || c.avatars.summer)),
        status: c.avatars?.status,
      }));
    });

    if (status) {
      const ready = status.filter((c: any) => needed.has(c.name) && c.hasAvatar).map((c: any) => c.name);
      const pending = [...needed].filter(n => !ready.includes(n));
      if (pending.length === 0) {
        console.log(`  All ${family.characters.length} avatars ready.`);
        return;
      }
      console.log(`  Avatars pending: ${pending.join(', ')} (ready: ${ready.length}/${family.characters.length})`);
    }

    await page.waitForTimeout(10000);
  }

  console.log(`  Avatar poll timed out after ${timeoutMs / 1000}s — continuing anyway.`);
}

async function seedPhotosForFamily(page: Page, family: DemoFamily) {
  console.log(`\n=== Seeding photos for ${family.label} family ===`);

  // Start on the wizard step 1 (character list) — showcase.js already saved the
  // character rows via API, so they should all be visible as cards.
  await page.goto('/create');
  await page.waitForTimeout(3000);

  // Record photo consent once for the whole user — otherwise the PhotoUpload
  // component's `canUpload` gate stays false and setInputFiles will trigger
  // handleFileChange but bail before calling onPhotoSelect, silently dropping
  // the first upload. Idempotent: server stores photo_consent_at timestamp.
  console.log('  Recording photo consent (one-shot)...');
  const consentStatus = await page.evaluate(async () => {
    const token = localStorage.getItem('auth_token');
    const res = await fetch('/api/auth/photo-consent', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.status;
  });
  console.log(`  Consent endpoint → ${consentStatus}`);
  // Reload so AuthContext picks up the new photoConsentAt from /api/auth/me
  await page.reload();
  await page.waitForTimeout(2000);

  for (const char of family.characters) {
    const photoPath = path.join(PHOTOS_DIR, family.id, `${char.name}.jpg`);
    if (!fs.existsSync(photoPath)) {
      throw new Error(`Missing photo on disk: ${photoPath}`);
    }
    await uploadPhotoForCharacter(page, char.name, photoPath);
    // Navigate back to character list before next character (in case the save
    // path deposited us somewhere else)
    if (!await isOnCharacterList(page)) {
      await page.goto('/create');
      await page.waitForTimeout(2000);
    }
  }

  console.log(`\n=== Waiting for avatar generation (up to 3 min) ===`);
  await waitForAllAvatars(page, family);
}

// ─── Test ───────────────────────────────────────────────────────────────────

test.describe('Demo Story Generation', () => {
  test.describe.configure({ mode: 'serial' });

  const entry = getCurrentEntry();
  const family = getFamily(entry.familyId);

  test(`Generate demo story: ${entry.description}`, async ({ page, baseURL }) => {
    test.setTimeout(WIZARD_TIMEOUT);

    const categoryPattern = CATEGORY_PATTERNS[entry.storyCategory];
    const topicPattern = TOPIC_PATTERNS[entry.storyTopic];
    const artStyleLabel = ART_STYLE_LABELS[entry.language][entry.artStyle];

    console.log('\n=== Demo Story Generation ===');
    console.log(`  Rotation index: ${entry.index}`);
    console.log(`  Family:         ${family.label} (${family.email})`);
    console.log(`  Language:       ${entry.language}`);
    console.log(`  Category:       ${entry.storyCategory}`);
    console.log(`  Topic:          ${entry.storyTopic}`);
    console.log(`  Art Style:      ${entry.artStyle} (${artStyleLabel})`);
    console.log(`  Pages:          ${STORY_PAGES}`);
    console.log('================================\n');

    const jsErrors: string[] = [];
    page.on('pageerror', err => jsErrors.push(err.message));

    // ── Step 0: Pre-seed language, then login ──
    // DEMO_EMAIL env var overrides the family's default account — used by the
    // showcase orchestrator to log in as the freshly-provisioned per-run account.
    const loginEmail = process.env.DEMO_EMAIL || family.email;
    console.log(`Step 0: Setting language + logging in as ${loginEmail}...`);
    await preSeedLanguage(page, entry.language, baseURL || 'https://magicalstory.ch');
    await loginAs(page, loginEmail, DEMO_PASSWORD);

    // ── Step 0b: Seed photos + trigger avatar generation (idempotent — skipped if family already has avatars) ──
    await seedPhotosForFamily(page, family);

    // ── Step 0c: Navigate to a fresh story (lang param keeps language sticky) ──
    console.log('Step 0c: Starting new story...');
    await page.goto(`/create?new=true&lang=${entry.language}`);
    await page.waitForTimeout(2000);

    // ── Step 1: Characters ──
    console.log('Step 1: Verifying characters...');
    const expectedNames = family.characters.map(c => c.name);
    for (const name of expectedNames) {
      await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 10000 });
    }

    const nextBtn = page.getByRole('button', { name: NEXT_BTN_RE }).first();
    const isNextEnabled = await nextBtn.isEnabled().catch(() => false);
    if (!isNextEnabled) {
      console.log('  Setting main character roles...');
      const mainButtons = page.getByRole('button', { name: MAIN_BTN_RE });
      const count = await mainButtons.count();
      if (count >= 2) {
        await mainButtons.nth(0).click();
        await page.waitForTimeout(500);
        await mainButtons.nth(1).click();
        await page.waitForTimeout(500);
      }
    }
    await clickNext(page);

    // ── Step 2: Book Settings ──
    console.log('Step 2: Setting book format...');
    const slider = page.locator('input[type="range"]');
    if (await slider.isVisible({ timeout: 5000 }).catch(() => false)) {
      await slider.fill(String(STORY_PAGES));
      await page.waitForTimeout(500);
    }
    await clickNext(page);

    // ── Step 3: Story Type ──
    console.log(`Step 3: Selecting ${entry.storyCategory} → ${entry.storyTopic}...`);
    const categoryBtn = page.locator('button').filter({ hasText: categoryPattern }).first();
    await expect(categoryBtn).toBeVisible({ timeout: 5000 });
    await categoryBtn.click();
    await page.waitForTimeout(1000);

    async function findAndClickTopic() {
      const directBtn = page.locator('button').filter({ hasText: topicPattern }).first();
      if (await directBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await directBtn.click();
        return true;
      }
      const groupHeaders = page.locator('button').filter({
        hasText: /beliebt|popular|populaire|historisch|historical|fantasie|fantasy|fantastique|entdeckung|exploration|helden|heroes|héros|jahreszeiten|seasonal|saisons|schweiz|swiss|suisse|welt|world|monde|toddler|kleinkind|tout-petit|preschool|vorschul|maternelle|school|schul|école|family|famili|famille|numbers|math|science|animal|body|time|music|musique|letter|lettres/i,
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

    if (!await findAndClickTopic()) {
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
    const nextBtnAfterArt = page.getByRole('button', { name: NEXT_BTN_RE }).first();
    if (await nextBtnAfterArt.isVisible({ timeout: 3000 }).catch(() => false)) {
      await clickNext(page);
    } else {
      console.log('  Art style auto-advanced.');
      await page.waitForTimeout(1000);
    }

    // ── Step 5: Summary & Generate ──
    console.log('Step 5: Waiting for ideas...');
    const ideaOption = page.locator('button').filter({ hasText: USE_THIS_RE }).first();
    await expect(ideaOption).toBeVisible({ timeout: 180000 });
    await ideaOption.click();
    await page.waitForTimeout(1000);

    const generateBtn = page.locator('button').filter({ hasText: GENERATE_RE }).first();
    await expect(generateBtn).toBeVisible({ timeout: 10000 });
    await expect(generateBtn).toBeEnabled({ timeout: 10000 });
    console.log('Step 5: Triggering generation...');
    await generateBtn.click();
    await page.waitForTimeout(5000);
    console.log('  Generation triggered.');

    // ── Verification ──
    const criticalErrors = jsErrors.filter(e =>
      !e.includes('ResizeObserver') && !e.includes('chunk')
    );
    if (criticalErrors.length > 0) {
      console.log(`  JS errors: ${criticalErrors.join(', ')}`);
    }
    expect(criticalErrors.length).toBe(0);

    // ── Update rotation state (only if not overridden) ──
    if (process.env.DEMO_ENTRY_INDEX === undefined || process.env.DEMO_ENTRY_INDEX === '') {
      const state = getRotationState();
      state.generatedStories.push(
        `${entry.familyId}/${entry.language}/${entry.storyCategory}/${entry.storyTopic} (${entry.artStyle}) - ${new Date().toISOString()}`
      );
      state.currentIndex = (state.currentIndex + 1) % DEMO_ROTATION.length;
      saveRotationState(state);
      console.log(`\nNext rotation index: ${state.currentIndex}`);
      console.log(`Total demo stories generated: ${state.generatedStories.length}`);
    } else {
      console.log(`\n(DEMO_ENTRY_INDEX override — rotation state not advanced)`);
    }

    console.log('\nDemo story triggered successfully.');
  });
});

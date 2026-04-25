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
const WIZARD_TIMEOUT = 90 * 60 * 1000;  // 90 min — full UI create (5 chars × 6 sub-steps) + avatar wait + story wizard

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

// Anchored: must match the EXACT button label, not "Weiteren Charakter erstellen".
const NEXT_BTN_RE = /^(weiter|next|suivant)$/i;
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
  // ?login=true used to auto-open the modal but no longer does. The
  // homepage shows a visible "Bereits ein Konto? Anmelden" button — click
  // it to open the modal.
  await page.goto('/?login=true');
  // Try modal-already-open first (auto-open may return at any time).
  if (!await page.locator('.fixed.inset-0').isVisible({ timeout: 1500 }).catch(() => false)) {
    const trigger = page.getByRole('button', { name: /bereits ein konto|already have an account|déjà un compte|anmelden|sign in|connexion/i }).first();
    await trigger.click({ timeout: 5000 });
  }
  await page.waitForSelector('.fixed.inset-0', { timeout: 15000 });

  const modal = page.locator('.fixed.inset-0');
  await modal.getByPlaceholder(/email/i).fill(email, { timeout: 5000 });
  await modal.locator('input[type="password"]').fill(password, { timeout: 5000 });
  await modal.getByRole('button', { name: /sign in|anmelden|connexion|se connecter/i })
    .click({ timeout: 5000 });

  // Login is successful when the modal closes — the post-login redirect
  // can land on /, /create, /welcome, or /stories depending on existing
  // user state. Wait for modal close, then navigate to /create explicitly.
  await page.waitForSelector('.fixed.inset-0', { state: 'detached', timeout: 15000 })
    .catch(async () => {
      // Fallback: maybe the URL already changed but the modal selector lingers.
      // Give a short window for URL change before failing hard.
      await page.waitForURL(/\/(create|welcome|stories|\?|#|$)/, { timeout: 5000 });
    });
  if (!/\/create(\?|#|$)/.test(page.url())) {
    await page.goto('/create');
  }
  await page.waitForLoadState('domcontentloaded');
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

// ─── Family creation via real wizard UI ─────────────────────────────────────
// showcase.js only registers + logs in the account — it performs no API-side
// character save. Everything from character creation onward is driven through
// the actual wizard UI, exactly like a normal user would do it. Slower, but
// exercises the real client-side flow (photo analysis, trait auto-fill,
// avatar generation trigger, relationship UX) end-to-end.

const CREATE_FIRST_RE = /ersten charakter|create first|premier personnage/i;
const CREATE_ANOTHER_RE = /weiteren charakter|weiterer charakter|create another|autre personnage|personnage suivant|noch einen/i;
const SAVE_CHAR_RE = /charakter speichern|save character|enregistrer le personnage|speichern|save|enregistrer|finish|fertig|done/i;
const CONTINUE_TO_TRAITS_RE = /weiter zu.*eigenschaften|continue.*traits|eigenschaften/i;

interface CreatedCharInfo { id: number; name: string; }

function photoPathFor(family: DemoFamily, charName: string): string {
  return path.join(PHOTOS_DIR, family.id, `${charName}.jpg`);
}

async function acceptPhotoConsentIfShown(page: Page) {
  // Consent is tracked per user (users.photo_consent_at). Shown on first photo
  // upload only — subsequent uploads skip the checkboxes. Click both if visible.
  const consent1 = page.locator('text=/Ich bestätige|I confirm I have|Je confirme/').first();
  if (await consent1.isVisible({ timeout: 1500 }).catch(() => false)) {
    console.log('    accepting consent checkboxes...');
    await consent1.locator('..').click();
    await page.waitForTimeout(300);
    const consent2 = page.locator('text=/Ich stimme|I agree to|J\'accepte/').first();
    if (await consent2.isVisible({ timeout: 1000 }).catch(() => false)) {
      await consent2.locator('..').click();
      await page.waitForTimeout(300);
    }
  }
}

async function waitForPhotoStep(page: Page, timeoutMs: number): Promise<boolean> {
  // Photo step is unique: PhotoUpload renders an always-present <input type="file">
  // AND an <h2> with the charactersStepTitle. We wait for the file input since
  // that's what the next step (setInputFiles) actually needs.
  return page.locator('input[type="file"]').first()
    .waitFor({ state: 'attached', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

async function clickCreateCharacterButton(page: Page, isFirst: boolean) {
  // Already in the photo-upload sub-step? On a brand-new empty account the
  // wizard sometimes skips the empty-state card and auto-opens photo upload
  // for the first character.
  if (await waitForPhotoStep(page, 1500)) {
    console.log(`    already on photo upload step — skipping entry button`);
    return;
  }

  console.log(`    clicking "${isFirst ? 'Create First' : 'Create Another'}" character...`);

  const candidates: Array<{ label: string; loc: () => any }> = [];
  if (isFirst) {
    // Empty-state button (WizardStep2Characters.tsx:250)
    candidates.push({
      label: 'role-first',
      loc: () => page.getByRole('button', { name: CREATE_FIRST_RE }).first(),
    });
  }
  // Dashed "Create Another" card in CharacterList.tsx:210 — a <button> element
  // with both border-dashed classes AND the create-another text. Target the
  // button specifically (not any dashed element) to avoid hitting skeleton
  // placeholders or out-of-story character cards which are also dashed.
  candidates.push({
    label: 'button-create-another-text',
    loc: () => page.locator('button').filter({ hasText: CREATE_ANOTHER_RE }).first(),
  });
  candidates.push({
    label: 'role-create-another',
    loc: () => page.getByRole('button', { name: CREATE_ANOTHER_RE }).first(),
  });
  candidates.push({
    label: 'button-dashed-indigo',
    loc: () => page.locator('button[class*="border-dashed"][class*="indigo"]').first(),
  });

  for (const c of candidates) {
    const el = c.loc();
    if (!await el.isVisible({ timeout: 2000 }).catch(() => false)) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click().catch(() => {});
    if (await waitForPhotoStep(page, 10000)) {
      console.log(`    landed on photo step via ${c.label}`);
      return;
    }
    console.log(`    clicked ${c.label} but photo step did not appear — trying next candidate`);
  }
  throw new Error('Could not navigate to photo-upload step (no candidate worked)');
}

async function uploadPhotoInCreateFlow(page: Page, photoPath: string) {
  console.log(`    uploading ${path.basename(photoPath)}...`);
  await acceptPhotoConsentIfShown(page);
  // PhotoUpload renders <input type="file" className="hidden"> at all times
  // (attached even while disabled). setInputFiles targets it directly.
  const fileInput = page.locator('input[type="file"]').first();
  // Short wait — clickCreateCharacterButton already waited for this element.
  // If it's still missing here, fail fast instead of burning the 90-min test
  // timeout on a silent locator wait.
  await fileInput.waitFor({ state: 'attached', timeout: 15000 });
  await fileInput.setInputFiles(photoPath);
  console.log(`    waiting for photo analysis to complete...`);
  // The wizard auto-advances to the NAME step when photo analysis returns
  // (MediaPipe face detection + rembg + Gemini traits). Critically, this is
  // also when avatars.status='pending' is set on the character, which is
  // what makes the eventual 'Continue to traits' click trigger
  // onSaveAndGenerateAvatar (StoryWizard.tsx:3220 path). If we proceed
  // BEFORE analysis completes, status stays undefined → no avatar trigger
  // → 'Kein Bild' dead state at the avatar sub-step. Wait up to 90s.
  const nameInput = page.locator('input[placeholder*="Name" i], input[placeholder*="Nom" i]').first();
  await nameInput.waitFor({ state: 'visible', timeout: 90000 });
  // Small settle so the avatars.status='pending' state-update commits.
  await page.waitForTimeout(500);
}

async function fillCharacterBasics(page: Page, char: DemoCharacter) {
  // Required fields on the name sub-step (Geschlecht + Alter); Next is disabled
  // until both are filled. Photo analyzer SOMETIMES auto-fills these from the
  // photo, but we can't rely on it (network issues, ambiguous photos).
  console.log(`    entering name: ${char.name}`);
  const nameSelectors = [
    'input[placeholder*="Name" i]',
    'input[placeholder*="name" i]',
    'input[placeholder*="Nom" i]',
    'input[type="text"]:not([inputmode])',
    'input:not([type]):not([inputmode])',
  ];
  let nameSet = false;
  for (const selector of nameSelectors) {
    const field = page.locator(selector).first();
    if (await field.isVisible({ timeout: 1500 }).catch(() => false)) {
      await field.click();
      await field.fill('');
      await field.fill(char.name);
      nameSet = true;
      break;
    }
  }
  if (!nameSet) throw new Error(`Could not locate name input for ${char.name}`);

  // Gender select — option values are "male" / "female" / "other" per
  // CharacterForm.tsx:783-784. Set even if photo analyzer already filled it
  // (selectOption is idempotent).
  console.log(`    setting gender: ${char.gender}`);
  const genderSelect = page.locator('select').filter({ hasText: /wählen|select|choisir|männlich|weiblich|male|female/i }).first();
  if (await genderSelect.isVisible({ timeout: 1500 }).catch(() => false)) {
    await genderSelect.selectOption(char.gender).catch(async () => {
      // Fallback: try by visible label
      const opt = char.gender === 'male' ? /männlich|male|garçon/i :
                  char.gender === 'female' ? /weiblich|female|fille/i :
                  /other|andere|autre/i;
      await genderSelect.selectOption({ label: opt as any });
    });
  } else {
    console.log(`    WARN: gender select not found`);
  }

  // Age — number input. May already be set by photo analysis; overwrite anyway.
  console.log(`    setting age: ${char.age}`);
  const ageInput = page.locator('input[type="number"], input[inputmode="numeric"]').first();
  if (await ageInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    await ageInput.click();
    await ageInput.fill('');
    await ageInput.fill(String(char.age));
  } else {
    console.log(`    WARN: age input not found`);
  }

  await page.waitForTimeout(500);
}

async function clickAnyNext(page: Page, timeoutMs = 5000): Promise<boolean> {
  // Try to advance. Returns true if we clicked something, false if no enabled
  // Next button appears within timeoutMs. The Next button is often VISIBLE but
  // DISABLED while validation settles (photo analysis, trait minimums), so we
  // poll for ~timeoutMs until it becomes enabled rather than returning false
  // on first check.
  const patterns = [CONTINUE_TO_TRAITS_RE, NEXT_BTN_RE];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      const btn = page.getByRole('button', { name: pattern }).first();
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)
          && await btn.isEnabled().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(2000);
        return true;
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function selectTraitButtons(page: Page, labels: string[], max: number, sectionLabelRe: RegExp) {
  let clicked = 0;
  const overallDeadline = Date.now() + 15000;
  // Scope chips to ONE TraitSelector section. Locator: the immediate parent
  // <div> of the section's header <button>. `page.locator('div', { has: ... }).first()`
  // is too loose — it matches the outermost wrapper that contains all three
  // sections, defeating the scoping. xpath=.. gives us the direct parent only.
  const headerBtn = page.getByRole('button', { name: sectionLabelRe }).first();
  const section = headerBtn.locator('xpath=..');

  // Exact matches from JSON data first.
  for (const label of labels) {
    if (clicked >= max || Date.now() > overallDeadline) break;
    const chip = section.getByRole('button', { name: label, exact: true });
    if (await chip.isVisible({ timeout: 500 }).catch(() => false)) {
      await chip.click({ timeout: 2000 }).catch(() => {});
      clicked++;
      await page.waitForTimeout(150);
    }
  }
  // Fallback: click any unselected chip in this section (10s budget).
  if (clicked < max) {
    const deadline = Math.min(Date.now() + 10000, overallDeadline);
    const chips = section.locator('button.rounded-full');
    const count = await chips.count().catch(() => 0);
    for (let i = 0; i < count && clicked < max; i++) {
      if (Date.now() > deadline) break;
      const btn = chips.nth(i);
      if (!await btn.isVisible({ timeout: 200 }).catch(() => false)) continue;
      const classNames = (await btn.getAttribute('class')) || '';
      if (classNames.includes('bg-indigo')) continue;  // already selected
      await btn.click({ timeout: 2000 }).catch(() => {});
      clicked++;
      await page.waitForTimeout(100);
    }
  }
  return clicked;
}

async function selectTraits(page: Page, char: DemoCharacter) {
  console.log(`    selecting traits (${char.traits.strengths.length}S / ${char.traits.flaws.length}F / ${char.traits.challenges.length}C)...`);
  const STRENGTHS_RE = /^Stärken|^Strengths|^Forces/i;
  const FLAWS_RE = /^Schwächen|^Flaws|^Défauts/i;
  const CHALLENGES_RE = /^Konflikte|^Challenges|^Conflits/i;
  const t0 = Date.now();
  const s = await selectTraitButtons(page, char.traits.strengths, Math.max(3, char.traits.strengths.length), STRENGTHS_RE);
  const t1 = Date.now();
  console.log(`      strengths: ${s} clicked in ${t1 - t0}ms`);
  const f = await selectTraitButtons(page, char.traits.flaws, Math.max(2, char.traits.flaws.length), FLAWS_RE);
  const t2 = Date.now();
  console.log(`      flaws: ${f} clicked in ${t2 - t1}ms`);
  const c = await selectTraitButtons(page, char.traits.challenges, Math.max(2, char.traits.challenges.length), CHALLENGES_RE);
  const t3 = Date.now();
  console.log(`      challenges: ${c} clicked in ${t3 - t2}ms`);
  await page.waitForTimeout(500);
}

function relationshipLabelFor(char: DemoCharacter, other: DemoCharacter, rawType: string): string | null {
  // Translate the compact JSON relationship tokens into the exact UI labels
  // from client/src/constants/relationships.ts. Direction matters: char → other.
  const charAge = parseInt(char.age, 10) || 0;
  const otherAge = parseInt(other.age, 10) || 0;
  switch (rawType) {
    case 'parent-child':
      return charAge > otherAge ? 'Parent of' : 'Child of';
    case 'sibling':
      return charAge >= otherAge ? 'Older Sibling of' : 'Younger Sibling of';
    case 'partner':
      return 'Married to';
    case 'grandparent-grandchild':
      // No built-in grandparent label; fall back to Parent/Child chain which the
      // UI supports. Story generator reads the actual relationships table so
      // this approximation is only for display.
      return charAge > otherAge ? 'Parent of' : 'Child of';
    default:
      return null;
  }
}

function lookupRelationshipType(family: DemoFamily, a: number, b: number): string | null {
  // relationships keys are stored as "id1-id2"; try both orientations.
  const rels = family.relationships || {};
  return rels[`${a}-${b}`] || rels[`${b}-${a}`] || null;
}

async function setRelationshipsForCharacter(page: Page, char: DemoCharacter, family: DemoFamily, alreadyCreated: DemoCharacter[]) {
  if (alreadyCreated.length === 0) {
    console.log('    no prior characters — nothing to set');
    return;
  }
  console.log(`    setting relationships vs ${alreadyCreated.length} prior character(s)...`);

  // Hard budget: relationships are nice-to-have for the demo but the accurate
  // story generator reads them from the DB. If the DOM dance gets stuck
  // (selectOption on a card that was re-rendered mid-loop), bail after 15s
  // total rather than burning the 90-min test timeout.
  const budgetMs = 15000;
  const deadline = Date.now() + budgetMs;

  const cards = page.locator('div.rounded-lg').filter({ has: page.locator('select') });
  const cardCount = await cards.count().catch(() => 0);
  for (let i = 0; i < cardCount; i++) {
    if (Date.now() > deadline) {
      console.log(`    relationship-setting budget exceeded — leaving defaults for remaining cards`);
      break;
    }
    const card = cards.nth(i);
    if (!await card.isVisible({ timeout: 500 }).catch(() => false)) continue;
    const cardText = (await card.textContent().catch(() => '')) || '';

    const other = alreadyCreated.find(c => cardText.includes(c.name));
    if (!other) continue;

    const rawType = lookupRelationshipType(family, char.id, other.id);
    if (!rawType) continue;

    const enLabel = relationshipLabelFor(char, other, rawType);
    if (!enLabel) continue;

    const select = card.locator('select').first();
    const variants: Record<string, string[]> = {
      'Parent of': ['Parent of', 'Elternteil von', 'Parent de'],
      'Child of': ['Child of', 'Kind von', 'Enfant de'],
      'Older Sibling of': ['Older Sibling of', 'Älteres Geschwister von', 'Frère/Sœur aîné(e) de'],
      'Younger Sibling of': ['Younger Sibling of', 'Jüngeres Geschwister von', 'Frère/Sœur cadet(te) de'],
      'Married to': ['Married to', 'Verheiratet mit', 'Marié(e) à'],
    };
    const labels = variants[enLabel] || [enLabel];
    let set = false;
    for (const label of labels) {
      if (Date.now() > deadline) break;
      try {
        // Explicit short timeout — default 30s × 3 variants could by itself
        // eat the entire per-char budget.
        await select.selectOption({ label }, { timeout: 3000 });
        console.log(`      ${char.name} → ${other.name}: "${label}"`);
        set = true;
        break;
      } catch { /* try next variant */ }
    }
    if (!set) {
      console.log(`      ${char.name} → ${other.name}: could not set "${enLabel}" — leaving default`);
    }
  }
}

async function walkToCharacterList(page: Page, charName: string) {
  // After relationships, the wizard may have one or more terminal buttons (Save
  // Character, Finish, Continue). Click whatever advances us until we land back
  // on the character list view.
  console.log(`    walking to character list...`);
  for (let i = 0; i < 12; i++) {
    // Are we back on the list? Look for the "Create Another" card or the
    // header "Charaktere & Rollen"/"Characters & Roles".
    const backOnList = await page.locator('text=/charaktere & rollen|characters & roles|personnages & rôles/i').isVisible({ timeout: 500 }).catch(() => false);
    const hasCreateAnother = await page.locator('[class*="border-dashed"]').isVisible({ timeout: 500 }).catch(() => false);
    if (backOnList && hasCreateAnother) {
      console.log(`      ${charName} saved — back on character list`);
      return;
    }

    const saveBtn = page.getByRole('button', { name: SAVE_CHAR_RE }).first();
    if (await saveBtn.isVisible({ timeout: 1000 }).catch(() => false)
        && await saveBtn.isEnabled().catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(3000);
      continue;
    }

    if (await clickAnyNext(page, 2000)) continue;

    console.log(`      ${charName}: no button to advance after step ${i + 1} — assuming done`);
    break;
  }
  await page.waitForTimeout(2000);
}

async function isOnCharacterListNow(page: Page): Promise<boolean> {
  // Character list = wizard Step 1 "Charaktere & Rollen" WITH the Create
  // Another button (has create-another text). The avatar-waiting screen ALSO
  // uses the "Charaktere & Rollen" header and a dashed placeholder, so we
  // must key off the text of the add-another button specifically — not just
  // "any dashed element".
  const listHeader = await page.locator('text=/Charaktere & Rollen|Characters & Roles|Personnages & Rôles/i').first()
    .isVisible({ timeout: 500 }).catch(() => false);
  if (!listHeader) return false;
  const createAnother = await page.locator('button').filter({ hasText: CREATE_ANOTHER_RE }).first()
    .isVisible({ timeout: 500 }).catch(() => false);
  return createAnother;
}

async function dismissAvatarWaitIfShown(page: Page): Promise<boolean> {
  // After the final Save, the wizard shows an avatar-generation waiting screen
  // with a single "Weiter ohne zu warten" / "Continue without waiting" button.
  // Click it to skip to the character list. Returns true if the button was
  // found and clicked.
  const skipBtn = page.getByRole('button', { name: /weiter ohne zu warten|continue without waiting|continuer sans attendre/i }).first();
  if (await skipBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    console.log(`      → skipping avatar wait`);
    await skipBtn.click();
    await page.waitForTimeout(2000);
    return true;
  }
  return false;
}

async function advanceSubStep(page: Page, label: string): Promise<boolean> {
  // Avatar-wait screen comes right after the final Save. Dismiss it first so
  // the next checks see the true character list, not the transient wait UI.
  if (await dismissAvatarWaitIfShown(page)) {
    // After dismiss we should be on the list. Re-check.
  }
  // After every sub-step click we check: are we already back on the character
  // list? If yes, the wizard auto-saved and we must NOT click again (would
  // advance past Step 1 into Buch/Story/etc.). Returns true if still in
  // character-edit flow, false if we've landed on the list.
  if (await isOnCharacterListNow(page)) {
    console.log(`      already on list after ${label} — skipping remaining sub-step advances`);
    return false;
  }
  // Prefer Save button over Next — terminal step shows "Charakter speichern"/
  // "Save Character", not generic Next. Clicking a still-visible Next when
  // Save was waiting would be a no-op or a wrong-step-advance.
  const saveBtn = page.getByRole('button', { name: SAVE_CHAR_RE }).first();
  if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false)
      && await saveBtn.isEnabled().catch(() => false)) {
    console.log(`      → save after ${label}`);
    await saveBtn.click();
    await page.waitForTimeout(3000);
    return true;
  }
  // Allow up to 90s for disabled Next to enable. Photo analysis can run
  // long on prod (Gemini + face detection + rembg) — Next on the name step
  // stays disabled until it completes.
  if (await clickAnyNext(page, 90000)) {
    console.log(`      → next after ${label}`);
    return true;
  }
  // No Save/Next visible. Dump a screenshot and FAIL HARD — earlier we used
  // a /create reload here, but that bypasses StoryWizard's onSaveCharacter
  // which fires the client-side avatar trigger (StoryWizard.tsx:3220).
  // Skipping the save means the character has no avatar pipeline started,
  // and the showcase is dead in the water. Better to fail loudly so we
  // can diagnose the wizard state.
  const shotPath = `test-results/debug-no-button-${label}-${Date.now()}.png`;
  await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
  throw new Error(`No Save/Next button after ${label} — wizard stuck. Screenshot: ${shotPath}`);
}

async function createOneCharacterViaWizard(page: Page, char: DemoCharacter, family: DemoFamily, alreadyCreated: DemoCharacter[]) {
  console.log(`\n  === Creating ${char.name} (id ${char.id}) ===`);
  await clickCreateCharacterButton(page, alreadyCreated.length === 0);
  await uploadPhotoInCreateFlow(page, photoPathFor(family, char.name));

  // Photo analyzer auto-advances to 'name' step — no click needed.
  await fillCharacterBasics(page, char);

  // From here on, each click might auto-fulfil several sub-steps. Re-check
  // list state after every action. Stop the moment we're back on the list.
  if (!await advanceSubStep(page, 'name')) return;
  await selectTraits(page, char);
  if (!await advanceSubStep(page, 'traits')) return;
  // Characteristics (hobbies) — no selection, just advance.
  if (!await advanceSubStep(page, 'characteristics')) return;
  await setRelationshipsForCharacter(page, char, family, alreadyCreated);
  if (!await advanceSubStep(page, 'relationships')) return;
  // Final auto-step: from relationships, the wizard typically shows the
  // avatar step (avatar ready → "Weiter" calls onSave) or the avatar-wait
  // screen ("Weiter ohne zu warten"). Click whichever is present. Re-check
  // isOnCharacterListNow each iteration so we never click a wizard-level
  // Weiter (Step 2/3 advance) by mistake.
  for (let i = 0; i < 3; i++) {
    if (await isOnCharacterListNow(page)) break;
    // Save button (label: "Speichern", "Charakter trotzdem speichern").
    const saveBtn = page.getByRole('button', { name: SAVE_CHAR_RE }).first();
    if (await saveBtn.isVisible({ timeout: 800 }).catch(() => false)
        && await saveBtn.isEnabled().catch(() => false)) {
      console.log(`      → save (final-${i + 1})`);
      await saveBtn.click();
      await page.waitForTimeout(2500);
      continue;
    }
    // Avatar-step "Weiter" (calls onSave) — only fire when we're confidently
    // INSIDE character edit (not on the list — already checked above).
    const weiterBtn = page.getByRole('button', { name: /^(weiter|next|suivant)$/i }).first();
    if (await weiterBtn.isVisible({ timeout: 800 }).catch(() => false)
        && await weiterBtn.isEnabled().catch(() => false)) {
      console.log(`      → weiter/save on avatar step (final-${i + 1})`);
      await weiterBtn.click();
      await page.waitForTimeout(2500);
      continue;
    }
    // Avatar-wait screen.
    if (await dismissAvatarWaitIfShown(page)) continue;
    break;
  }
  await page.waitForTimeout(1000);
  if (!await isOnCharacterListNow(page)) {
    const shotPath = `test-results/debug-not-on-list-${char.name}-${Date.now()}.png`;
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    throw new Error(`Did not land on character list after ${char.name}. Screenshot: ${shotPath}`);
  }
}

async function setMainRoles(page: Page, family: DemoFamily) {
  const mains = family.characters.filter(c => c.storyRole === 'main').map(c => c.name);
  if (mains.length === 0) return;
  console.log(`\n  Setting main roles: ${mains.join(', ')}`);
  for (const name of mains) {
    const card = page.locator('div.border.rounded-lg, div.border.rounded').filter({ hasText: name }).first();
    // Hauptrolle button — has a star icon and label, indigo when selected.
    const roleBtn = card.getByRole('button', { name: /hauptrolle|main|principal/i }).first();
    if (await roleBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      const classes = (await roleBtn.getAttribute('class')) || '';
      if (!classes.includes('bg-indigo')) {
        await roleBtn.click();
        console.log(`    → ${name} set as main`);
        await page.waitForTimeout(500);
      } else {
        console.log(`    → ${name} already main`);
      }
    }
  }
  await page.waitForTimeout(1000);
}

async function waitForAllAvatars(page: Page, family: DemoFamily, timeoutMs = 600000) {
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

async function createFamilyViaWizard(page: Page, family: DemoFamily) {
  console.log(`\n=== Creating ${family.label} family via wizard UI ===`);

  // Verify all photos are on disk up-front so we fail fast, not mid-run.
  for (const char of family.characters) {
    const photoPath = photoPathFor(family, char.name);
    if (!fs.existsSync(photoPath)) throw new Error(`Missing photo on disk: ${photoPath}`);
  }

  await page.goto('/create');
  await page.waitForTimeout(3000);

  const alreadyCreated: DemoCharacter[] = [];
  for (const char of family.characters) {
    await createOneCharacterViaWizard(page, char, family, alreadyCreated);
    alreadyCreated.push(char);
  }

  await setMainRoles(page, family);

  console.log(`\n=== Waiting for avatar generation (up to 10 min) ===`);
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

    // ── Step 0b: Create the full family via the wizard UI — photo upload, name,
    //            traits, characteristics, relationships, save — exactly like a real user.
    //            showcase.js only registered + logged in the account; everything
    //            beyond that is pure UI clicking.
    await createFamilyViaWizard(page, family);

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
    // If a default style is preselected (localStorage from a prior run, or
    // server default), Step 4 can auto-advance to Step 5 before we get a
    // chance to click. Treat the art-style button as optional.
    console.log(`Step 4: Selecting art style: ${artStyleLabel}...`);
    const artBtn = page.locator('button').filter({ hasText: artStyleLabel }).first();
    if (await artBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await artBtn.click();
      await page.waitForTimeout(1000);
      const nextBtnAfterArt = page.getByRole('button', { name: NEXT_BTN_RE }).first();
      if (await nextBtnAfterArt.isVisible({ timeout: 3000 }).catch(() => false)) {
        await clickNext(page);
      } else {
        console.log('  Art style auto-advanced.');
        await page.waitForTimeout(1000);
      }
    } else {
      console.log(`  Art style picker not visible — already on Step 5 (preselected).`);
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

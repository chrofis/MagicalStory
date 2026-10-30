import { test, expect, Page } from '@playwright/test';
import { installWizardMock, WizardMock, IDEAS, IDEA_WORLDS, IDEA_SHAPES, MockCharacter } from './helpers/wizard-mock';

/**
 * Wizard settings round trip (FREE). Every wizard setting is set through the real UI and then read back from
 * the body of POST /api/jobs/create-story. The backend is not running: every /api call is answered by
 * tests/helpers/wizard-mock.ts, the create-story request is captured and answered with a fake job id, so no
 * story, no Jev call and no model call happens.
 *
 *   npm run dev:client      (Vite on :5173, nothing else is needed)
 *   TEST_BASE_URL=http://localhost:5173 npx playwright test tests/wizard-settings.spec.ts --project=wizard-settings
 *
 * Not driven here: the relationship editor and the character editor (they sit behind the photo/avatar flow);
 * relationships are served by the mock and checked to reach the payload unchanged.
 */

const NEXT = /^next$/i;

async function openWizard(page: Page, cast?: MockCharacter[]): Promise<WizardMock> {
  const mock = await installWizardMock(page, cast);
  page.on('pageerror', e => { throw new Error(`page error: ${e.message}`); });
  await page.goto('/create?new=true');
  await page.getByRole('button', { name: NEXT }).waitFor();
  return mock;
}

const next = (page: Page) => page.getByRole('button', { name: NEXT }).click();

/** The role buttons (Out / In / Main) sit in the card that holds the character's name. */
function roleButton(page: Page, name: string, role: 'Out' | 'In' | 'Main') {
  return page.getByText(name, { exact: true }).first()
    .locator('xpath=ancestor::div[.//button[normalize-space()="Main"]][1]')
    .getByRole('button', { name: role, exact: true });
}

/** The reading-level card holding this label; selected cards carry the indigo ring. */
const levelCard = (page: Page, label: string) => page.getByRole('button', { name: new RegExp(`^${label}`) });
const isSelectedCard = async (page: Page, label: string) =>
  ((await levelCard(page, label).getAttribute('class')) || '').includes('ring-indigo-200');

async function chooseStoryType(page: Page, category: RegExp, topic: RegExp) {
  await page.getByRole('button', { name: category }).click();
  await page.getByRole('button', { name: topic }).first().click(); // picking a topic advances to the art style
}

async function chooseArtStyle(page: Page, name: RegExp) {
  await page.getByRole('button', { name }).first().click(); // picking a style advances to the summary
}

/** Characters -> Book -> Story type -> Art style -> Summary, with defaults unless the test did something before. */
async function toSummary(page: Page) {
  await next(page);                                   // characters -> book
  await next(page);                                   // book -> story type
  await chooseStoryType(page, /Adventure/, /Pirate/);
  await chooseArtStyle(page, /^Watercolor/);
  await expect(page.getByText('Own story')).toBeVisible();
}

async function generateIdeas(page: Page) {
  await page.getByRole('button', { name: /Generate Suggestion/ }).first().click();
  await expect(page.locator('textarea').filter({ hasText: IDEAS[0] })).toBeVisible();
}

/** Press "Generate Story!" and return the captured create-story body. */
async function submit(page: Page, mock: WizardMock) {
  await page.getByRole('button', { name: /Generate Story!/ }).click();
  await expect.poll(() => mock.createStoryRequests.length, { timeout: 10_000 }).toBe(1);
  return mock.createStoryRequests[0];
}

test.describe('wizard settings reach the create-story payload', () => {
  test('characters: roles, relationships and the oldest-main explanation', async ({ page }) => {
    const mock = await openWizard(page);
    // 4 languages of the explanation are covered by the unit/i18n texts; here the English one is on screen
    await expect(page.getByText(/Main characters are the stars of the story, all equally important/)).toBeVisible();
    await expect(page.getByText(/The age of the oldest main character picks the kind of story/)).toBeVisible();
    await roleButton(page, 'Mama', 'Out').click();
    await toSummary(page);
    await generateIdeas(page);
    await page.getByRole('button', { name: 'Use this' }).first().click();
    const body = await submit(page, mock);
    expect(body.mainCharacters).toEqual([1001]);
    expect(body.characters.map((c: any) => c.name)).toEqual(['Lio', 'Noam']); // Mama is out
    expect(body.relationships['1001-1002']).toBe('siblings');
    expect(body.relationshipTexts['1001-1002']).toBe('Lio carries Noam when he is tired');
  });

  test('two mains: both reach the payload and the youngest picks the reading level', async ({ page }) => {
    const mock = await openWizard(page);
    await roleButton(page, 'Noam', 'Main').click();
    await next(page);
    await expect(page.getByTestId('reading-level-why')).toHaveText('Chosen because Noam is 3 – you can change it.');
    expect(await isSelectedCard(page, 'Picture Book')).toBe(true);
    await next(page);
    await chooseStoryType(page, /Adventure/, /Pirate/);
    await chooseArtStyle(page, /^Watercolor/);
    await generateIdeas(page);
    await page.getByRole('button', { name: 'Use this' }).first().click();
    const body = await submit(page, mock);
    expect([...body.mainCharacters].sort()).toEqual([1001, 1002]);
    expect(body.languageLevel).toBe('1st-grade');
  });

  test('reading level: auto from the youngest main, manual choice sticks, changed mains re-apply', async ({ page }) => {
    const mock = await openWizard(page);
    await next(page);
    // single main Lio (8) -> Chapter Book, with the visible reason
    await expect(page.getByTestId('reading-level-why')).toHaveText('Chosen because Lio is 8 – you can change it.');
    expect(await isSelectedCard(page, 'Chapter Book')).toBe(true);
    // manual choice
    await levelCard(page, 'Young Reader').click();
    expect(await isSelectedCard(page, 'Young Reader')).toBe(true);
    await expect(page.getByTestId('reading-level-why')).toContainText('Your choice is kept');
    // leave the step and come back: the manual choice must still be there
    await page.getByRole('button', { name: /^back$/i }).click();
    await next(page);
    expect(await isSelectedCard(page, 'Young Reader')).toBe(true);
    // mains change (Noam becomes main too): the youngest is now 3 -> Picture Book replaces the manual choice
    await page.getByRole('button', { name: /^back$/i }).click();
    await roleButton(page, 'Noam', 'Main').click();
    await next(page);
    expect(await isSelectedCard(page, 'Picture Book')).toBe(true);
    await expect(page.getByTestId('reading-level-why')).toHaveText('Chosen because Noam is 3 – you can change it.');
    await next(page);
    await chooseStoryType(page, /Adventure/, /Pirate/);
    await chooseArtStyle(page, /^Watercolor/);
    await generateIdeas(page);
    await page.getByRole('button', { name: 'Use this' }).first().click();
    const body = await submit(page, mock);
    expect(body.languageLevel).toBe('1st-grade');
  });

  test('book settings: language, season, pages, location', async ({ page }) => {
    const mock = await openWizard(page);
    await next(page);
    await page.getByRole('button', { name: /Deutsch \(Schweiz\)/ }).click();
    await page.getByRole('button', { name: 'Français', exact: true }).click();
    await page.getByRole('button', { name: 'France', exact: true }).click();
    await page.locator('select').first().selectOption('winter');
    const slider = page.locator('input[type="range"]');
    await slider.evaluate((el: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(el, '20');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.getByRole('button', { name: /Add location/ }).click();
    await page.getByPlaceholder('City').fill('Baden');
    await expect(page.getByLabel('Location found')).toBeVisible();
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    await next(page);
    await chooseStoryType(page, /Adventure/, /Pirate/);
    await chooseArtStyle(page, /^Watercolor/);
    await generateIdeas(page);
    await page.getByRole('button', { name: 'Use this' }).first().click();
    const body = await submit(page, mock);
    expect(body.language).toBe('fr-fr');
    expect(body.season).toBe('winter');
    expect(body.pages).toBe(20);
    expect(body.userLocation.city).toBe('Baden');
  });

  test('story type, topic and art style', async ({ page }) => {
    const mock = await openWizard(page);
    await next(page);
    await next(page);
    await chooseStoryType(page, /Adventure/, /Dragon Quest/);
    await chooseArtStyle(page, /^Anime/);
    await generateIdeas(page);
    await page.getByRole('button', { name: 'Use this' }).first().click();
    const body = await submit(page, mock);
    expect(body.storyCategory).toBe('adventure');
    expect(body.storyTheme).toBeTruthy();
    expect(body.artStyle).toBe('anime');
  });

  test('life-skills topics show the age window against the oldest main', async ({ page }) => {
    await openWizard(page);
    await next(page);
    await next(page);
    await page.getByRole('button', { name: /Life Skills/ }).click();
    // The age hint compares the topic's window with the oldest main's age (8): at least one topic carries it.
    await expect(page.getByRole('button', { name: /Brushing Teeth\s*2-6/ })).toBeVisible();
  });

  test('idea cards: select a card, the card keeps its index and world; editing keeps the selected card', async ({ page }) => {
    const mock = await openWizard(page);
    await toSummary(page);
    await generateIdeas(page);
    await page.getByRole('button', { name: 'Use this' }).nth(1).click(); // second generated idea
    const textareas = page.locator('textarea');
    const card2 = textareas.filter({ hasText: IDEAS[1] });
    await expect(card2).toBeVisible();
    await card2.fill(`${IDEAS[1]} They also take a picnic.`); // EDIT the selected card
    const body = await submit(page, mock);
    expect(body.storyDetails).toBe(`${IDEAS[1]} They also take a picnic.`);
    expect(body.ideaPick.index).toBe(1);
    expect(body.ideaWorld).toEqual(IDEA_WORLDS[1]);
    expect(body.ideaPick.shape).toEqual(IDEA_SHAPES[1]);
  });

  test('idea cards: first card payload', async ({ page }) => {
    const mock = await openWizard(page);
    await toSummary(page);
    await generateIdeas(page);
    await page.getByRole('button', { name: 'Use this' }).first().click();
    const body = await submit(page, mock);
    expect(body.storyDetails).toBe(IDEAS[0]);
    expect(body.ideaPick.index).toBe(0);
    expect(body.ideaWorld).toEqual(IDEA_WORLDS[0]);
    expect(body.ownStory).toBeUndefined();     // a generated idea keeps the loose commission
  });

  test('own story: Jev checklist after the pause, selecting sends the text as a custom text', async ({ page }) => {
    test.setTimeout(60_000);
    const mock = await openWizard(page);
    await toSummary(page);
    await generateIdeas(page);
    const own = page.getByTestId('own-story-text');
    await expect(own).toHaveValue('');
    await own.fill('Too short');
    await page.waitForTimeout(5500);
    expect(mock.ownStoryRequests).toHaveLength(0); // under 40 characters: never asked
    const text = 'A girl and her grandfather row out to find a lost balloon on the lake.';
    await own.fill(text);
    await page.waitForTimeout(2000);
    expect(mock.ownStoryRequests).toHaveLength(0); // the 5 s pause has not passed
    await expect(page.getByTestId('own-story-checklist')).toBeVisible({ timeout: 8000 });
    expect(mock.ownStoryRequests).toHaveLength(1);
    expect(mock.ownStoryRequests[0]).toMatchObject({ text, age: 8 });
    await expect(page.getByTestId('own-story-checklist').locator('[data-part="WHO"]')).toHaveAttribute('data-present', 'true');
    await expect(page.getByTestId('own-story-checklist').locator('[data-part="WHERE"]')).toHaveAttribute('data-present', 'false');
    await expect(page.getByTestId('own-story-tip')).toHaveText('Say where the story happens.');
    await page.getByTestId('own-story-select').click();
    const body = await submit(page, mock);
    expect(body.storyDetails).toBe(text);
    expect(body.ideaPick.index).toBeNull();   // a custom text: no idea index, no idea world
    expect(body.ownStory).toBe(true);         // the Own story card: the writer follows its events and ending
    expect(body.ideaWorld).toBeNull();
  });

  test('dedication', async ({ page }) => {
    const mock = await openWizard(page);
    await toSummary(page);
    await generateIdeas(page);
    await page.getByRole('button', { name: 'Use this' }).first().click();
    await page.locator('textarea[maxlength="500"]').fill('For Lio, who found the lantern.');
    const body = await submit(page, mock);
    expect(body.dedication).toBe('For Lio, who found the lantern.');
  });
});

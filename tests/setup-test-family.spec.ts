import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * ONE-TIME SETUP: Creates test family characters with avatars
 *
 * RUN WITH: npx playwright test tests/setup-test-family.spec.ts --project=chromium --headed
 *
 * Family:
 * - Roger (Hero, adult)
 * - Franziska (Wife of Roger, adult)
 * - Manuel (Son, oldest child)
 * - Sophie (Daughter, 2nd child)
 * - Lukas (Son, youngest child)
 *
 * WARNING: This costs API credits for avatar generation!
 * Only run once to set up test data.
 */

const PHOTOS_DIR = 'C:\\Users\\roger\\OneDrive\\Pictures\\For automatic testing';

interface FamilyMember {
  name: string;
  photo: string;
  relationship?: string;
}

const family: FamilyMember[] = [
  { name: 'Roger', photo: 'Roger.jpg' },
  { name: 'Franziska', photo: 'Franziska.jpg', relationship: 'Wife' },
  { name: 'Manuel', photo: 'Manuel.jpg', relationship: 'Son' },
  { name: 'Sophie', photo: 'Sophie.JPG', relationship: 'Daughter' },
  { name: 'Lukas', photo: 'Lukas.jpg', relationship: 'Son' },
];

test('Setup test family with avatars', async ({ page }) => {
  test.setTimeout(600000); // 10 minutes for full setup

  // Go to create page (auth state should be loaded)
  await page.goto('/create');

  // Wait for page to fully load
  console.log('Waiting for page to load...');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  // Take initial screenshot to see page state
  await page.screenshot({ path: 'test-results/setup-initial-state.png' });
  console.log('Screenshot saved: setup-initial-state.png');

  console.log('Starting family setup...');
  console.log('This will create 5 characters and generate avatars (costs credits!)');

  // First, check if any characters already exist
  await page.screenshot({ path: 'test-results/setup-check-existing.png' });
  const existingCharacters = page.locator('[class*="character-card"], [data-testid="character-card"]');
  const existingCount = await existingCharacters.count().catch(() => 0);
  console.log(`Found ${existingCount} existing character cards`);

  // Add each family member
  for (let i = 0; i < family.length; i++) {
    const member = family[i];
    console.log(`\n=== Adding ${member.name} (${i + 1}/${family.length}) ===`);

    // Check if this character already exists by looking for their name
    const existingChar = page.locator(`text="${member.name}"`).first();
    if (await existingChar.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log(`${member.name} already exists - skipping`);
      continue;
    }

    // Navigate to add new character
    // First ensure we're on the character list view (not editing another character)
    const saveCharBtn = page.getByRole('button', { name: /save character|charakter speichern/i });
    if (await saveCharBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await saveCharBtn.click();
      console.log('Saved current character first');
      await page.waitForTimeout(2000);
    }

    // Now click to add a new character
    const addCardBtn = page.locator('[class*="border-dashed"]').first();
    const createFirstBtn = page.getByRole('button', { name: /create first|ersten charakter|create.*character/i });

    if (await addCardBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addCardBtn.click();
      console.log('Clicked add character card');
      await page.waitForTimeout(1000);
    } else if (await createFirstBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await createFirstBtn.click();
      console.log('Clicked "Create First Character"');
      await page.waitForTimeout(1000);
    } else {
      // Check if we're already in photo upload mode
      const fileInput = page.locator('input[type="file"]');
      if (await fileInput.count() === 0) {
        console.log('Cannot find way to add character - taking screenshot');
        await page.screenshot({ path: `test-results/setup-${member.name}-cant-add.png` });
        continue;
      }
    }

    // Take screenshot before photo upload
    await page.screenshot({ path: `test-results/setup-${member.name}-before-upload.png` });
    console.log(`Screenshot saved: setup-${member.name}-before-upload.png`);

    // Step 1: Upload photo
    console.log(`Uploading photo: ${member.photo}`);
    const photoPath = path.join(PHOTOS_DIR, member.photo);

    // Check if consent checkboxes exist (only for first-time users who haven't consented)
    const consentCheckbox1 = page.locator('text=/I confirm I have the right|Ich bestätige/').first();
    const consentCheckbox2 = page.locator('text=/I agree to the|Ich stimme den/').first();

    if (await consentCheckbox1.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('Found consent checkboxes, clicking them...');
      // Click the parent clickable div for each checkbox
      await consentCheckbox1.locator('..').click();
      await page.waitForTimeout(300);
      await consentCheckbox2.locator('..').click();
      await page.waitForTimeout(300);
      console.log('Consent checkboxes clicked');
    }

    // Find the file input and set files (it's hidden but Playwright can still interact)
    const fileInput = page.locator('input[type="file"]');
    const inputCount = await fileInput.count();
    console.log(`Found ${inputCount} file input(s)`);

    if (inputCount === 0) {
      console.error('ERROR: No file input found on page!');
      await page.screenshot({ path: `test-results/setup-${member.name}-no-input-error.png` });
      throw new Error('No file input found');
    }

    await fileInput.setInputFiles(photoPath);
    console.log('Photo file set');

    // Wait for photo analysis (AI detects traits from photo)
    console.log('Waiting for photo analysis...');
    await page.waitForTimeout(8000); // Give more time for analysis

    // Take screenshot after upload
    await page.screenshot({ path: `test-results/setup-${member.name}-after-upload.png` });

    // Check if we're now on the name step - look for name input
    const nameInput = page.locator('input[placeholder*="name" i], input[type="text"]').first();
    if (await nameInput.isVisible({ timeout: 10000 })) {
      // Clear and fill name
      await nameInput.clear();
      await nameInput.fill(member.name);
      console.log(`Set name: ${member.name}`);
    }

    // Click Continue/Next to proceed to traits/characteristics
    const continueBtn = page.getByRole('button', { name: /continue|weiter|continuer|next/i });
    if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await continueBtn.click();
      console.log('Proceeding to traits/characteristics...');
      // Wait longer for page transition
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(3000);
    }

    // Take a screenshot to see current state
    await page.screenshot({ path: `test-results/setup-${member.name}-after-continue.png` });

    // After name step, we should be on characteristics step (Strengths/Flaws/Conflicts)
    // This step requires selecting: 3+ strengths, 2+ flaws before Continue is enabled
    // The trait chips are button elements inside TraitSelector components

    // First, check if we can find any trait chip button (like "Kind")
    const kindButton = page.getByRole('button', { name: 'Kind' });
    if (await kindButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('Found trait buttons - selecting strengths and flaws...');

      // Select 3 strengths
      const strengths = ['Kind', 'Caring', 'Funny'];
      for (const strength of strengths) {
        const chip = page.getByRole('button', { name: strength });
        if (await chip.isVisible({ timeout: 1000 }).catch(() => false)) {
          await chip.click();
          console.log(`Selected strength: ${strength}`);
          await page.waitForTimeout(300);
        }
      }

      // Select 2 flaws
      const flaws = ['Impatient', 'Distracted'];
      for (const flaw of flaws) {
        const chip = page.getByRole('button', { name: flaw });
        if (await chip.isVisible({ timeout: 1000 }).catch(() => false)) {
          await chip.click();
          console.log(`Selected flaw: ${flaw}`);
          await page.waitForTimeout(300);
        }
      }

      await page.waitForTimeout(1000);
      await page.screenshot({ path: `test-results/setup-${member.name}-characteristics.png` });
    } else {
      console.log('Trait buttons not found - checking page state');
      await page.screenshot({ path: `test-results/setup-${member.name}-no-traits.png` });

      // List all visible buttons for debugging
      const buttons = page.getByRole('button');
      const count = await buttons.count();
      console.log(`Found ${count} buttons on page`);
    }

    // Now look for Continue/Save/Next button - should be enabled after selecting characteristics
    const saveGenerateBtn = page.getByRole('button', { name: /save.*generate|generate.*avatar|avatar.*generieren|speichern.*generieren/i });
    if (await saveGenerateBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await saveGenerateBtn.click();
      console.log('Clicked Save & Generate Avatar');
      await page.waitForTimeout(5000);
    } else {
      // Try Continue or Next button
      const nextBtn = page.getByRole('button', { name: /continue|weiter|next|save|speichern/i });
      try {
        await nextBtn.waitFor({ state: 'visible', timeout: 5000 });
        const isDisabled = await nextBtn.isDisabled();
        if (!isDisabled) {
          await nextBtn.click();
          console.log('Clicked Continue/Next after characteristics');
          await page.waitForTimeout(2000);
        } else {
          console.log('Continue button is still disabled');
          await page.screenshot({ path: `test-results/setup-${member.name}-button-disabled.png` });
        }
      } catch (e) {
        console.log('Could not find Continue button');
      }
    }

    // Check for "Hobbies, Interests" step (optional details) - just click Next
    const hobbiesSection = page.locator('text=/Hobbies|Interests|Details/i');
    if (await hobbiesSection.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('On hobbies/interests step - clicking Next');
      const nextBtn = page.getByRole('button', { name: /next|weiter|continue/i });
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(2000);
      }
    }

    // Check for relationships step (only appears if there are multiple characters)
    if (i > 0) {
      const relationshipsSection = page.locator('text=/relationship|beziehung|relation/i');
      if (await relationshipsSection.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('On relationships step - clicking Save/Done');
        const saveRelBtn = page.getByRole('button', { name: /save|done|fertig|speichern|continue|weiter|next/i });
        if (await saveRelBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await saveRelBtn.click();
          console.log('Saved relationships');
          await page.waitForTimeout(2000);
        }
      }
    }

    // Keep clicking Next/Continue until we hit Save Character or are back at character list
    for (let step = 0; step < 5; step++) {
      // Check if we're on the final save screen
      const saveCharBtn = page.getByRole('button', { name: /save character|charakter speichern/i });
      if (await saveCharBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await saveCharBtn.click();
        console.log('Clicked Save Character - completing character creation');
        await page.waitForTimeout(3000);
        break;
      }

      // Check for add character card (means we're back on the list)
      const addCard = page.locator('[class*="border-dashed"]').first();
      if (await addCard.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('Back on character list');
        break;
      }

      // Try clicking Next/Continue buttons
      const anyNextBtn = page.getByRole('button', { name: /^next$|^weiter$|^continue$/i });
      if (await anyNextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        const isDisabled = await anyNextBtn.isDisabled().catch(() => true);
        if (!isDisabled) {
          await anyNextBtn.click();
          console.log(`Clicked Next/Continue (step ${step + 1})`);
          await page.waitForTimeout(2000);
        } else {
          break;
        }
      } else {
        break;
      }
    }

    // Wait a bit for any background processing
    await page.waitForTimeout(3000);

    // Take screenshot after completing character
    await page.screenshot({ path: `test-results/setup-${member.name}-complete.png` });
    console.log(`Completed ${member.name}`);
  }

  console.log('\n=== All characters created ===');
  await page.screenshot({ path: 'test-results/setup-all-characters.png' });

  // Now proceed through the wizard to summary but DON'T generate story
  console.log('\nProceeding through wizard steps to summary...');

  // Click Next to go to next steps
  const nextBtn = page.getByRole('button', { name: /^next$|^weiter$|^suivant$/i });

  // Step through remaining wizard steps
  for (let step = 2; step <= 5; step++) {
    if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await nextBtn.click();
      console.log(`Advanced to step ${step}`);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `test-results/setup-step-${step}.png` });
    }
  }

  // Final state
  console.log('\n=== Reached Summary Step ===');
  console.log('Setup complete! DO NOT click Generate Story.');
  console.log('You can now manually generate a story from the browser.');

  await page.screenshot({ path: 'test-results/setup-final.png' });

  // Keep browser open for 60 seconds so user can see and take over if needed
  console.log('\nBrowser will stay open for 60 seconds...');
  await page.waitForTimeout(60000);
});

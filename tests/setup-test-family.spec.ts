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

  // Add each family member
  for (let i = 0; i < family.length; i++) {
    const member = family[i];
    console.log(`\n=== Adding ${member.name} (${i + 1}/${family.length}) ===`);

    // For first character, may need to click "Create First Character" or it may auto-start
    if (i === 0) {
      // Check if we're already in photo upload mode (wizard auto-starts for new users)
      const uploadBtn = page.locator('label:has-text("Upload")');
      const fileInput = page.locator('input[type="file"]');

      if (await fileInput.count() === 0) {
        // Not in photo upload mode yet, look for "Create First Character" button
        const createFirstBtn = page.getByRole('button', { name: /create first|ersten charakter|premier personnage|create.*character/i });
        if (await createFirstBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await createFirstBtn.click();
          console.log('Clicked "Create First Character"');
          await page.waitForTimeout(1000);
        } else {
          // Maybe there are existing characters - try the add card
          const addBtn = page.locator('[class*="border-dashed"]').first();
          if (await addBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await addBtn.click();
            console.log('Clicked add character card');
            await page.waitForTimeout(1000);
          }
        }
      } else {
        console.log('Already in photo upload mode (auto-started)');
      }
    } else {
      // Additional characters - look for the add character card or button
      // After saving a character, we should be back on the character list
      const addCardBtn = page.locator('[class*="border-dashed"], button:has-text("Create Another"), button:has-text("Add")').first();
      if (await addCardBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await addCardBtn.click();
        console.log('Clicked "Add Character"');
        await page.waitForTimeout(1000);
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

    // Click Continue/Next to proceed to traits
    const continueBtn = page.getByRole('button', { name: /continue|weiter|continuer|next/i });
    if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await continueBtn.click();
      console.log('Proceeding to traits...');
      await page.waitForTimeout(2000);
    }

    // On traits step - look for "Save & Generate Avatar" button
    // This saves the traits and triggers avatar generation in the background
    const saveGenerateBtn = page.getByRole('button', { name: /save.*generate|generate.*avatar|avatar.*generieren|speichern.*generieren/i });
    if (await saveGenerateBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await saveGenerateBtn.click();
      console.log('Clicked Save & Generate Avatar');
      // Wait for avatar generation to start
      await page.waitForTimeout(5000);
    } else {
      // Try just a "Continue" or "Next" button on traits step
      const traitsNextBtn = page.getByRole('button', { name: /continue|weiter|next|save|speichern/i });
      if (await traitsNextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await traitsNextBtn.click();
        console.log('Clicked Continue/Save on traits');
        await page.waitForTimeout(3000);
      }
    }

    // Check for characteristics step and handle it
    const characteristicsSection = page.locator('text=/characteristics|eigenschaften|caracteristiques/i');
    if (await characteristicsSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('On characteristics step');
      // Look for skip or continue button
      const skipBtn = page.getByRole('button', { name: /skip|überspringen|passer|continue|weiter/i });
      if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await skipBtn.click();
        console.log('Skipped/continued past characteristics');
        await page.waitForTimeout(1000);
      }
    }

    // Check for relationships step (only appears if there are multiple characters)
    if (i > 0) {
      const relationshipsSection = page.locator('text=/relationship|beziehung|relation/i');
      if (await relationshipsSection.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('On relationships step');
        // Just click save/done to accept defaults
        const saveRelBtn = page.getByRole('button', { name: /save|done|fertig|speichern|continue|weiter/i });
        if (await saveRelBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await saveRelBtn.click();
          console.log('Saved relationships');
          await page.waitForTimeout(1000);
        }
      }
    }

    // Look for a "Done" or "Finish" button to complete character creation
    const doneBtn = page.getByRole('button', { name: /^done$|^fertig$|^finish$|^terminé$|^complete$/i });
    if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await doneBtn.click();
      console.log('Completed character');
      await page.waitForTimeout(2000);
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

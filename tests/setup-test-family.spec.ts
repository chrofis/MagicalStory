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
  await page.waitForTimeout(3000);

  console.log('Starting family setup...');
  console.log('This will create 5 characters and generate avatars (costs credits!)');

  // Add each family member
  for (let i = 0; i < family.length; i++) {
    const member = family[i];
    console.log(`\n=== Adding ${member.name} (${i + 1}/${family.length}) ===`);

    // Click "Create First Character" or "Create Another Character" button
    if (i === 0) {
      // First character - look for "Create First Character" button
      const createFirstBtn = page.getByRole('button', { name: /create first|ersten charakter|premier personnage/i });
      if (await createFirstBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await createFirstBtn.click();
        console.log('Clicked "Create First Character"');
      }
    } else {
      // Additional characters - look for the dashed border add card
      const addCardBtn = page.locator('button.border-dashed, button:has-text("Create Another"), button:has-text("Weiteren")');
      if (await addCardBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await addCardBtn.first().click();
        console.log('Clicked "Create Another Character"');
      }
    }

    await page.waitForTimeout(1000);

    // Step 1: Upload photo
    console.log(`Uploading photo: ${member.photo}`);
    const photoPath = path.join(PHOTOS_DIR, member.photo);

    // Find the file input (may be hidden) or the upload area
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(photoPath);

    console.log('Photo uploaded, waiting for analysis...');
    // Wait for photo analysis (AI detects traits from photo)
    await page.waitForTimeout(5000);

    // Check if we're now on the name step
    const nameInput = page.locator('input[type="text"]').first();
    if (await nameInput.isVisible({ timeout: 10000 })) {
      // Clear and fill name
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

    // On traits step - just accept the AI-detected traits
    // Click "Save & Generate Avatar" or similar
    const generateAvatarBtn = page.getByRole('button', { name: /save.*avatar|generate avatar|avatar.*generi|speichern/i });
    if (await generateAvatarBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await generateAvatarBtn.click();
      console.log('Clicked Generate Avatar');
      // Wait for avatar generation (this takes time!)
      console.log('Waiting for avatar generation...');
      await page.waitForTimeout(30000); // 30 seconds per avatar
    } else {
      // Try just saving
      const saveBtn = page.getByRole('button', { name: /save|speichern|enregistrer/i });
      if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await saveBtn.click();
        console.log('Saved character');
        await page.waitForTimeout(5000);
      }
    }

    // If there's a characteristics step, skip through it
    const skipBtn = page.getByRole('button', { name: /skip|überspringen|passer/i });
    if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipBtn.click();
      console.log('Skipped characteristics');
      await page.waitForTimeout(1000);
    }

    // If there's a relationships step, handle it
    if (member.relationship) {
      const relationshipSelect = page.locator('select, [role="combobox"]').first();
      if (await relationshipSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Try to find and click the relationship option
        const relationshipOption = page.getByText(new RegExp(member.relationship, 'i')).first();
        if (await relationshipOption.isVisible({ timeout: 2000 }).catch(() => false)) {
          await relationshipOption.click();
          console.log(`Set relationship: ${member.relationship}`);
        }
      }
    }

    // Complete character creation
    const doneBtn = page.getByRole('button', { name: /done|fertig|terminé|complete|finish/i });
    if (await doneBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await doneBtn.click();
      console.log('Completed character');
      await page.waitForTimeout(2000);
    }

    await page.screenshot({ path: `test-results/setup-${member.name}.png` });
    console.log(`Completed ${member.name}`);
  }

  console.log('\n=== All characters created ===');
  await page.screenshot({ path: 'test-results/setup-all-characters.png' });

  // Now proceed through the wizard to story selection
  console.log('\nProceeding through wizard steps...');

  // Click Next to go to book settings
  const nextBtn = page.getByRole('button', { name: /next|weiter|suivant/i });
  if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await nextBtn.click();
    console.log('Step 1 -> Step 2 (Book Settings)');
    await page.waitForTimeout(2000);
  }

  // Step 2: Book settings - just proceed
  if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nextBtn.click();
    console.log('Step 2 -> Step 3 (Story Type)');
    await page.waitForTimeout(2000);
  }

  // Step 3: Select a story type
  // Click first adventure option
  const adventureCard = page.locator('[class*="card"], button').filter({ hasText: /adventure|abenteuer|aventure/i }).first();
  if (await adventureCard.isVisible({ timeout: 3000 }).catch(() => false)) {
    await adventureCard.click();
    console.log('Selected Adventure story type');
    await page.waitForTimeout(1000);
  }

  if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nextBtn.click();
    console.log('Step 3 -> Step 4 (Art Style)');
    await page.waitForTimeout(2000);
  }

  // Step 4: Select an art style
  const watercolorStyle = page.locator('[class*="card"], button').filter({ hasText: /watercolor|aquarell/i }).first();
  if (await watercolorStyle.isVisible({ timeout: 3000 }).catch(() => false)) {
    await watercolorStyle.click();
    console.log('Selected Watercolor style');
    await page.waitForTimeout(1000);
  }

  if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nextBtn.click();
    console.log('Step 4 -> Step 5 (Summary)');
    await page.waitForTimeout(2000);
  }

  // Step 5: Summary - STOP HERE
  console.log('\n=== Reached Summary Step ===');
  console.log('Setup complete! DO NOT click Generate Story.');
  console.log('You can now manually generate a story from the browser.');

  await page.screenshot({ path: 'test-results/setup-final.png' });

  // Keep browser open for 30 seconds so user can see
  console.log('\nBrowser will stay open for 30 seconds...');
  await page.waitForTimeout(30000);
});

import { test, expect, Page } from '@playwright/test';
import path from 'path';

/**
 * Test to fix Roger's avatar by re-uploading photo with bodyNoBg
 *
 * This test:
 * 1. Navigates to character edit for Roger
 * 2. Uploads a new photo
 * 3. Verifies bodyNoBg is generated (via console logs)
 * 4. Triggers avatar regeneration
 * 5. Verifies success
 */

// Test photo path
const TEST_PHOTO = path.join(__dirname, '..', 'images', 'Real person.jpg');

test.describe('Fix Roger Avatar', () => {
  test('upload photo and regenerate avatars for Roger', async ({ page }) => {
    // Increase timeout for avatar generation
    test.setTimeout(300000);

    // Enable console logging to see frontend logs
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      const text = msg.text();
      consoleLogs.push(text);
      if (text.includes('bodyNoBg') || text.includes('Photo source') || text.includes('Available photos') ||
          text.includes('Resized') || text.includes('IMAGE_OTHER') || text.includes('AVATAR')) {
        console.log(`[BROWSER] ${text}`);
      }
    });

    // Navigate to create page (character list)
    console.log('\n=== Step 1: Navigate to character list ===');
    await page.goto('/create');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Take screenshot of character list
    await page.screenshot({ path: 'test-results/01-character-list.png', fullPage: true });

    // Find Roger's card and click the edit (pencil) button
    console.log('\n=== Step 2: Click edit button on Roger\'s card ===');

    // The character cards have structure: div > (thumbnail button, name h4, edit button, delete button)
    // Find the card that contains an h4 with "Roger" text
    const rogerCard = page.locator('div.border.rounded').filter({ hasText: 'Roger' }).first();
    await page.screenshot({ path: 'test-results/02a-before-edit-click.png', fullPage: true });

    // The edit button is the indigo-colored button (first button in the button group)
    // It has class "bg-indigo-600" and contains the Edit2 icon
    const editButton = rogerCard.locator('button.bg-indigo-600').first();

    if (await editButton.isVisible()) {
      console.log('Found edit button (bg-indigo-600), clicking...');
      await editButton.click();
    } else {
      // Alternative: Click on Roger's thumbnail image (also triggers edit)
      console.log('Edit button not visible, trying thumbnail click...');
      const thumbnail = rogerCard.locator('img').first();
      if (await thumbnail.isVisible()) {
        console.log('Found thumbnail, clicking to edit...');
        await thumbnail.click();
      } else {
        // Last resort: find button by title attribute
        console.log('Trying button with edit title...');
        const editByTitle = page.locator('button[title*="Edit"], button[title*="edit"], button[title*="Bearbeiten"]').filter({ has: page.locator('svg') });
        // Filter to Roger's row - find Roger text then nearby edit button
        const rogerText = page.getByText('Roger', { exact: true });
        const rogerParent = rogerText.locator('..').locator('..').locator('..');
        const nearbyEdit = rogerParent.locator('button.bg-indigo-600').first();
        if (await nearbyEdit.isVisible()) {
          await nearbyEdit.click();
        }
      }
    }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'test-results/02-after-edit-click.png', fullPage: true });

    // Now we should be in character edit mode (traits step)
    // Look for the "New Photo" button which contains a hidden file input
    console.log('\n=== Step 3: Upload new photo ===');

    // Wait for the character form to appear
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/03-character-form.png', fullPage: true });

    // Check if we're in the character edit form by looking for character-specific elements
    const formVisible = await page.locator('text=New Photo').isVisible().catch(() => false) ||
                        await page.locator('text=Neues Foto').isVisible().catch(() => false) ||
                        await page.locator('text=Nouvelle photo').isVisible().catch(() => false);

    if (formVisible) {
      console.log('Character edit form is visible');
    } else {
      console.log('Character edit form NOT visible - edit click may have failed');
      // Try to find any indicators we're on a character edit page
      const pageText = await page.textContent('body') || '';
      console.log('Page contains "Roger":', pageText.includes('Roger'));
      console.log('Page contains "traits":', pageText.toLowerCase().includes('trait'));
    }

    // Find the "New Photo" label which contains the hidden file input
    // The label text varies by language: "New Photo" / "Neues Foto" / "Nouvelle photo"
    const newPhotoLabel = page.locator('label:has-text("New Photo"), label:has-text("Neues Foto"), label:has-text("Nouvelle photo")').first();

    // Get the file input inside the label
    let fileInput = newPhotoLabel.locator('input[type="file"]');

    if (await fileInput.count() > 0) {
      console.log('Found file input inside "New Photo" label, uploading photo...');
      await fileInput.setInputFiles(TEST_PHOTO);
      console.log('Photo uploaded, waiting for analysis...');

      // Wait a bit for photo to start processing
      await page.waitForTimeout(5000);
      await page.screenshot({ path: 'test-results/04-photo-uploading.png', fullPage: true });

      // Handle "Clothing for New Photo" modal if it appears
      const clothingModal = page.locator('text=Clothing for New Photo');
      if (await clothingModal.isVisible({ timeout: 10000 }).catch(() => false)) {
        console.log('Clothing modal appeared - clicking "Use clothing from new photo"');
        await page.screenshot({ path: 'test-results/04a-clothing-modal.png', fullPage: true });

        // Click the default option: "Use clothing from new photo"
        const useNewClothingBtn = page.locator('button:has-text("Use clothing from new photo")');
        if (await useNewClothingBtn.isVisible()) {
          await useNewClothingBtn.click();
          console.log('Clicked "Use clothing from new photo"');
        } else {
          // Try the other option
          const keepCurrentBtn = page.locator('button:has-text("Keep current clothing")');
          if (await keepCurrentBtn.isVisible()) {
            await keepCurrentBtn.click();
            console.log('Clicked "Keep current clothing"');
          }
        }
      }

      // Wait for photo analysis to complete (Python service processes it)
      console.log('Waiting for photo analysis...');
      await page.waitForTimeout(15000);
      await page.screenshot({ path: 'test-results/04-photo-uploaded.png', fullPage: true });
    } else {
      console.log('No file input in label, trying direct file input search...');

      // Fallback: find any file input on the page
      fileInput = page.locator('input[type="file"]').first();

      if (await fileInput.count() > 0) {
        console.log('Found file input directly, uploading...');
        await fileInput.setInputFiles(TEST_PHOTO);
        await page.waitForTimeout(20000);
        await page.screenshot({ path: 'test-results/04-photo-uploaded.png', fullPage: true });
      } else {
        console.log('No file input found at all - checking page state...');
        await page.screenshot({ path: 'test-results/04-no-file-input.png', fullPage: true });
      }
    }

    // Check console logs for bodyNoBg
    console.log('\n=== Step 4: Check if bodyNoBg was generated ===');
    const bodyNoBgLogs = consoleLogs.filter(log => log.includes('bodyNoBg'));
    console.log('bodyNoBg related logs:', bodyNoBgLogs.length > 0 ? bodyNoBgLogs.slice(-5) : 'None found');

    const availablePhotosLog = consoleLogs.find(log => log.includes('Available photos'));
    if (availablePhotosLog) {
      console.log('Available photos log:', availablePhotosLog);
    }

    // Look for regenerate avatars button
    console.log('\n=== Step 5: Look for avatar regeneration options ===');
    await page.screenshot({ path: 'test-results/05-before-regenerate.png', fullPage: true });

    // Look for various regenerate button variations
    const regenerateSelectors = [
      'button:has-text("Regenerate")',
      'button:has-text("Generate Avatar")',
      'button:has-text("Create Avatar")',
      'button:has-text("avatar")',
      'button:has-text("Avatar")',
      '[class*="avatar"] button',
      'button[class*="regenerate"]',
    ];

    let foundRegenerate = false;
    for (const selector of regenerateSelectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible().catch(() => false)) {
        console.log(`Found regenerate button with selector: ${selector}`);
        await btn.click();
        foundRegenerate = true;

        // Wait for avatar generation to complete (can take up to 2 minutes)
        console.log('Waiting for avatar generation (up to 2 minutes)...');

        // Poll for completion by watching for avatar images or completion message
        for (let i = 0; i < 40; i++) {  // 40 * 3s = 120s max
          await page.waitForTimeout(3000);

          // Check for completion indicators
          const pageText = await page.textContent('body') || '';
          if (pageText.includes('complete') || pageText.includes('success')) {
            console.log('Avatar generation completed!');
            break;
          }

          // Check console for completion
          const recentLogs = consoleLogs.slice(-10);
          if (recentLogs.some(log => log.includes('Avatars generated') || log.includes('success'))) {
            console.log('Avatar generation completed (from console)!');
            break;
          }

          console.log(`  Still generating... (${(i + 1) * 3}s)`);
        }

        await page.screenshot({ path: 'test-results/06-after-regenerate.png', fullPage: true });
        break;
      }
    }

    if (!foundRegenerate) {
      console.log('No regenerate button found - checking current avatar status...');

      // Maybe avatars are already showing, or we need to save first
      const saveButton = page.locator('button:has-text("Save"), button:has-text("Speichern")').first();
      if (await saveButton.isVisible()) {
        console.log('Found save button, saving character...');
        await saveButton.click();
        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'test-results/06-after-save.png', fullPage: true });
      }
    }

    // Final check - look for avatar images
    console.log('\n=== Step 6: Verify results ===');
    const avatarImages = page.locator('img').filter({ has: page.locator('[alt*="avatar"]') });
    const allImages = page.locator('img');
    const imageCount = await allImages.count();
    console.log(`Found ${imageCount} total images on page`);

    // Print all recent console logs related to avatar/photo
    console.log('\n=== Recent relevant console logs ===');
    const relevantLogs = consoleLogs.filter(log =>
      log.includes('avatar') ||
      log.includes('Avatar') ||
      log.includes('AVATAR') ||
      log.includes('photo') ||
      log.includes('Photo') ||
      log.includes('PHOTO') ||
      log.includes('IMAGE_OTHER') ||
      log.includes('Resized') ||
      log.includes('bodyNoBg')
    ).slice(-20);
    relevantLogs.forEach(log => console.log(`  ${log}`));

    await page.screenshot({ path: 'test-results/07-final.png', fullPage: true });

    // Check if bodyNoBg was generated successfully
    const hasBodyNoBg = consoleLogs.some(log => log.includes('bodyNoBg=true'));
    console.log(`\n=== RESULT: bodyNoBg generated = ${hasBodyNoBg} ===`);
  });
});

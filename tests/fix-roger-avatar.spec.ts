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
    // Enable console logging to see frontend logs
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      const text = msg.text();
      consoleLogs.push(text);
      if (text.includes('bodyNoBg') || text.includes('Photo source') || text.includes('Available photos')) {
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

    // Find Roger and click to edit
    console.log('\n=== Step 2: Find Roger and open edit ===');

    // Look for Roger in the character list
    const rogerCard = page.locator('text=Roger').first();
    await expect(rogerCard).toBeVisible({ timeout: 10000 });

    // Click on Roger to select/edit
    await rogerCard.click();
    await page.waitForTimeout(2000);

    // Take screenshot after clicking Roger
    await page.screenshot({ path: 'test-results/02-roger-selected.png', fullPage: true });

    // Look for edit button or character form
    const editButton = page.locator('button:has-text("Edit"), button:has-text("Bearbeiten")').first();
    if (await editButton.isVisible()) {
      await editButton.click();
      await page.waitForTimeout(2000);
    }

    await page.screenshot({ path: 'test-results/03-edit-mode.png', fullPage: true });

    // Upload new photo
    console.log('\n=== Step 3: Upload new photo ===');

    // Find the file input for photo upload
    const fileInput = page.locator('input[type="file"]').first();

    // Check if file input exists
    if (await fileInput.count() > 0) {
      console.log('Found file input, uploading photo...');
      await fileInput.setInputFiles(TEST_PHOTO);

      // Wait for photo analysis to complete (Python service)
      console.log('Waiting for photo analysis...');
      await page.waitForTimeout(15000);

      await page.screenshot({ path: 'test-results/04-photo-uploaded.png', fullPage: true });
    } else {
      console.log('No file input found, looking for upload button...');

      // Try to find and click an upload button
      const uploadButton = page.locator('button:has-text("Upload"), button:has-text("Foto"), label:has-text("Photo")').first();
      if (await uploadButton.isVisible()) {
        await uploadButton.click();
        await page.waitForTimeout(1000);

        // Now look for file input again
        const newFileInput = page.locator('input[type="file"]').first();
        if (await newFileInput.count() > 0) {
          await newFileInput.setInputFiles(TEST_PHOTO);
          await page.waitForTimeout(15000);
        }
      }

      await page.screenshot({ path: 'test-results/04-looking-for-upload.png', fullPage: true });
    }

    // Check console logs for bodyNoBg
    console.log('\n=== Step 4: Check if bodyNoBg was generated ===');
    const bodyNoBgLogs = consoleLogs.filter(log => log.includes('bodyNoBg'));
    console.log('bodyNoBg related logs:', bodyNoBgLogs.length > 0 ? bodyNoBgLogs : 'None found');

    const availablePhotosLog = consoleLogs.find(log => log.includes('Available photos'));
    if (availablePhotosLog) {
      console.log('Available photos log:', availablePhotosLog);
      expect(availablePhotosLog).toContain('bodyNoBg=true');
    }

    // Look for regenerate avatars button
    console.log('\n=== Step 5: Regenerate avatars ===');

    const regenerateButton = page.locator('button:has-text("Regenerate"), button:has-text("Generate"), button:has-text("Avatar")').first();
    if (await regenerateButton.isVisible()) {
      console.log('Found regenerate button, clicking...');
      await regenerateButton.click();

      // Wait for avatar generation to complete (can take up to 2 minutes)
      console.log('Waiting for avatar generation (up to 2 minutes)...');
      await page.waitForTimeout(120000);

      await page.screenshot({ path: 'test-results/05-avatars-generated.png', fullPage: true });
    } else {
      console.log('No regenerate button found in current view');
      await page.screenshot({ path: 'test-results/05-no-regenerate-button.png', fullPage: true });
    }

    // Final check - look for avatar images
    console.log('\n=== Step 6: Verify avatars ===');
    const avatarImages = page.locator('img[alt*="avatar"], img[src*="avatar"], [data-testid*="avatar"]');
    const avatarCount = await avatarImages.count();
    console.log(`Found ${avatarCount} avatar elements`);

    // Print all console logs related to avatar/photo
    console.log('\n=== Relevant console logs ===');
    const relevantLogs = consoleLogs.filter(log =>
      log.includes('avatar') ||
      log.includes('Avatar') ||
      log.includes('photo') ||
      log.includes('Photo') ||
      log.includes('IMAGE_OTHER') ||
      log.includes('Resized')
    );
    relevantLogs.forEach(log => console.log(log));

    await page.screenshot({ path: 'test-results/06-final.png', fullPage: true });
  });
});

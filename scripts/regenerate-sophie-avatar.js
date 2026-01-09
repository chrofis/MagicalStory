// Regenerate Sophie's avatar via Playwright
const { chromium } = require('playwright');
const path = require('path');

async function main() {
  const authFile = path.join(__dirname, '../.auth/user.json');

  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({
    storageState: authFile,
    viewport: { width: 1400, height: 900 }
  });

  const page = await context.newPage();

  // Navigate to create page
  console.log('Navigating to /create...');
  await page.goto('http://localhost:3000/create');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'test-results/regen-1-initial.png' });

  // Find Sophie's edit button (indigo button with no text, first one in Sophie's card)
  console.log('Finding Sophie edit button...');

  // The edit button is bg-indigo-600 class, and Sophie is the first card
  // Each card has: [edit button (indigo), delete button (red), Out, In, Main]
  // Sophie is the first character, so her edit button is the first bg-indigo-600 button

  const editButton = await page.evaluate(() => {
    // Find the Sophie text element
    const sophieElements = Array.from(document.querySelectorAll('*')).filter(el =>
      el.textContent.trim() === 'Sophie' && el.children.length === 0
    );

    if (sophieElements.length > 0) {
      // Get the closest parent that contains the edit button
      let container = sophieElements[0].parentElement;
      while (container && !container.querySelector('.bg-indigo-600')) {
        container = container.parentElement;
      }

      if (container) {
        const btn = container.querySelector('.bg-indigo-600');
        if (btn) {
          // Return a way to identify this button
          const rect = btn.getBoundingClientRect();
          return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
        }
      }
    }
    return null;
  });

  if (editButton) {
    console.log(`Clicking at (${editButton.x}, ${editButton.y})`);
    await page.mouse.click(editButton.x, editButton.y);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'test-results/regen-2-after-edit.png' });

    const url = page.url();
    console.log(`Current URL: ${url}`);

    // Now we should be on the character edit page
    // Look for the Regenerate Avatar button

    // Scroll down to find the button
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(1000);

    // Look for Modify Avatar button (it's called "Modify Avatar" not "Regenerate")
    console.log('Looking for Modify Avatar button...');
    const modifyBtn = page.locator('button:has-text("Modify Avatar")');
    const regenerateCount = await modifyBtn.count();
    console.log(`Found ${regenerateCount} Modify Avatar buttons`);

    if (regenerateCount > 0) {
      await modifyBtn.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'test-results/regen-3-found-button.png' });

      console.log('Clicking Modify Avatar...');
      await modifyBtn.first().click();

      // Wait for the modal to open
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'test-results/regen-4-modal.png' });

      // Now click "Save & Regenerate" button
      console.log('Looking for Save & Regenerate button...');
      const saveRegenBtn = page.locator('button:has-text("Save & Regenerate")');
      if (await saveRegenBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('Clicking Save & Regenerate...');
        await saveRegenBtn.click();

        console.log('Waiting for avatar generation (this takes 30-90 seconds)...');
        await page.waitForTimeout(10000);
        await page.screenshot({ path: 'test-results/regen-5-generating.png' });

        // Wait up to 2 minutes for generation
        for (let i = 0; i < 12; i++) {
          await page.waitForTimeout(10000);
          console.log(`  ${(i+1)*10} seconds elapsed...`);

          // Check if modal is still open or if there's a loading indicator
          const modalOpen = await page.locator('text="Modify Avatar"').isVisible().catch(() => false);
          const isLoading = await page.evaluate(() => {
            return !!document.querySelector('[class*="animate-spin"], [class*="loading"], [class*="generating"]');
          });

          if (!modalOpen && !isLoading) {
            console.log('Generation complete!');
            break;
          }
        }

        await page.screenshot({ path: 'test-results/regen-6-complete.png' });
      } else {
        console.log('Save & Regenerate button not found');
        await page.screenshot({ path: 'test-results/regen-5-no-save-btn.png' });
      }
    } else {
      console.log('Regenerate button not found');

      // List all visible buttons
      const allBtns = await page.locator('button:visible').all();
      console.log(`Found ${allBtns.length} visible buttons:`);
      for (let i = 0; i < Math.min(allBtns.length, 20); i++) {
        const text = await allBtns[i].textContent().catch(() => '');
        if (text.trim()) {
          console.log(`  "${text.trim().substring(0, 50)}"`);
        }
      }

      await page.screenshot({ path: 'test-results/regen-3-no-button.png' });
    }
  } else {
    console.log('Could not find Sophie edit button');
    await page.screenshot({ path: 'test-results/regen-error.png' });
  }

  console.log('\nBrowser staying open for 5 minutes for observation...');
  await page.waitForTimeout(300000);

  await browser.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

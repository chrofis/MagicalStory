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

  await page.screenshot({ path: 'test-results/regenerate-1-initial.png' });

  // Enable dev mode from menu
  console.log('Enabling Dev Mode...');
  await page.click('button:has-text("Menu")');
  await page.waitForTimeout(500);

  // Look for Dev Mode checkbox/toggle in the menu
  const devToggle = page.locator('label:has-text("Dev"), button:has-text("Dev"), [class*="toggle"]:near(:text("Dev"))').first();
  if (await devToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
    await devToggle.click();
    console.log('Clicked dev mode toggle');
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);

  await page.screenshot({ path: 'test-results/regenerate-2-after-dev.png' });

  // Find all character cards - they should have edit buttons (pencil icons)
  console.log('Looking for Sophie card...');

  // Character cards have a specific structure - find the one with Sophie
  // Each card has the character name, and edit/delete buttons
  // Let's find the edit button that's associated with Sophie

  // Get all card containers that have edit buttons
  const cards = await page.locator('[class*="card"], [class*="character"]').all();
  console.log(`Found ${cards.length} card-like elements`);

  // Find Sophie by looking for text containing "Sophie" and "Female"
  const sophieText = page.locator('text="Sophie"');
  const sophieCount = await sophieText.count();
  console.log(`Found ${sophieCount} elements with "Sophie" text`);

  if (sophieCount > 0) {
    // Get the parent card element that contains Sophie
    // Then find the edit button (pencil) within it

    // The card structure from the screenshot shows:
    // - Avatar image
    // - Name "Sophie"
    // - Details "Female, 12 y"
    // - Edit (pencil) and Delete (trash) buttons

    // Try to find the edit button by looking for SVG pencil icon near Sophie
    console.log('Trying to click edit button for Sophie...');

    // Use XPath to find button near Sophie text
    const editButton = page.locator('//text()[contains(.,"Sophie")]/ancestor::div[contains(@class,"card") or contains(@class,"character") or position()=1]//button[1] | //*[text()="Sophie"]/parent::*/parent::*//button[1]').first();

    if (await editButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editButton.click();
      console.log('Clicked edit button via XPath');
    } else {
      // Alternative: find all buttons and click the one closest to Sophie text
      console.log('XPath did not work, trying alternative...');

      // Look for the card that has Sophie and click its first button (edit)
      const sophieParent = page.locator('div:has(> div:has-text("Sophie"))').first();
      const parentButtons = sophieParent.locator('button');
      const btnCount = await parentButtons.count();
      console.log(`Found ${btnCount} buttons in Sophie's parent container`);

      if (btnCount > 0) {
        // First button should be edit (pencil)
        await parentButtons.first().click();
        console.log('Clicked first button in Sophie container');
      }
    }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'test-results/regenerate-3-after-edit-click.png' });

    // Check if we're now on the character edit page
    const currentUrl = page.url();
    console.log(`Current URL: ${currentUrl}`);

    // Look for regenerate button
    console.log('Looking for Regenerate button...');

    // The regenerate button might have different text
    const regenerateSelectors = [
      'button:has-text("Regenerate")',
      'button:has-text("Generate Avatar")',
      'button:has-text("Re-generate")',
      '[class*="regenerate"]',
      'button:has-text("Avatar")'
    ];

    let found = false;
    for (const selector of regenerateSelectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log(`Found button with selector: ${selector}`);
        const btnText = await btn.textContent();
        console.log(`Button text: "${btnText}"`);

        if (btnText.toLowerCase().includes('regenerate') || btnText.toLowerCase().includes('generate')) {
          console.log('Clicking regenerate button...');
          await btn.click();
          found = true;
          break;
        }
      }
    }

    if (!found) {
      console.log('Regenerate button not found. Listing all buttons...');
      const allBtns = await page.getByRole('button').all();
      for (let i = 0; i < Math.min(allBtns.length, 15); i++) {
        const text = await allBtns[i].textContent().catch(() => '');
        const visible = await allBtns[i].isVisible().catch(() => false);
        if (visible && text.trim()) {
          console.log(`  Button: "${text.trim().substring(0, 60)}"`);
        }
      }
    }

    if (found) {
      console.log('Waiting for avatar generation (30-90 seconds)...');

      // Wait for generation - look for loading indicator to appear and disappear
      await page.waitForTimeout(5000);
      await page.screenshot({ path: 'test-results/regenerate-4-generating.png' });

      // Wait for completion
      try {
        await page.waitForFunction(() => {
          // Check if any loading spinner is gone
          const loading = document.querySelector('[class*="loading"], [class*="spinner"], [class*="generating"]');
          return !loading;
        }, { timeout: 120000 });
        console.log('Generation appears complete!');
      } catch (e) {
        console.log('Timeout or error waiting for generation');
      }

      await page.screenshot({ path: 'test-results/regenerate-5-complete.png' });
    }
  }

  console.log('\nKeeping browser open for 30 seconds...');
  await page.waitForTimeout(30000);

  await browser.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

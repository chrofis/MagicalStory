const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const password = 'M1.NtFsmdS';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    console.log('1. Opening app...');
    await page.goto('http://localhost:5173/create');
    await page.waitForTimeout(3000);

    // Login if modal visible
    const emailInput = page.locator('input[type="email"]');
    if (await emailInput.isVisible()) {
      console.log('2. Logging in with password:', password);
      await emailInput.fill('ch_roger_fischer@yahoo.com');
      await page.locator('input[type="password"]').fill(password);
      await page.locator('button:has-text("Sign In")').click();
      await page.waitForTimeout(5000);
      // Close modal if still open
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
    }

    console.log('3. Looking for character to click...');
    const names = ['Sophie', 'Lukas', 'Tim', 'Sue', 'Anna'];
    for (const name of names) {
      const el = page.locator(`text="${name}"`).first();
      if (await el.isVisible()) {
        console.log(`   Clicking ${name}...`);
        await el.click();
        await page.waitForTimeout(2000);
        break;
      }
    }

    console.log('4. Scrolling to find Generate button...');
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 300));
      await page.waitForTimeout(300);
      const btn = page.locator('button:has-text("Generate Clothing Avatars")');
      if (await btn.isVisible()) {
        console.log('5. Found button! Clicking...');
        await btn.click();
        console.log('   Avatar generation started - wait for it to complete...');
        break;
      }
    }
  } catch (err) {
    console.log('Error:', err.message);
  }

  // NEVER close - wait forever
  console.log('\n=== BROWSER STAYS OPEN - Close it manually when done ===\n');
  await new Promise(() => {}); // Wait forever
})();

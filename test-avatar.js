const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const password = fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
  .match(/TEST_PASSWORD=(.+)/)?.[1]?.trim();

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // 1. Go to create page (triggers login)
  console.log('1. Opening app...');
  await page.goto('http://localhost:5173/create');
  await page.waitForTimeout(2000);

  // 2. Login if modal appears
  if (await page.locator('input[type="email"]').isVisible()) {
    console.log('2. Logging in...');
    await page.fill('input[type="email"]', 'ch_roger_fischer@yahoo.com');
    await page.fill('input[type="password"]', password);
    await page.click('button:has-text("Sign In")');
    await page.waitForTimeout(3000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // 3. Click on a character name to edit
  console.log('3. Opening character...');
  const names = ['Sophie', 'Lukas', 'Tim', 'Sue', 'Anna'];
  for (const name of names) {
    const el = page.locator(`text="${name}"`).first();
    if (await el.isVisible()) {
      await el.click();
      console.log(`   Clicked ${name}`);
      await page.waitForTimeout(2000);
      break;
    }
  }

  // 4. Scroll to find Generate button
  console.log('4. Looking for Generate Clothing Avatars...');
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(300);
    const btn = page.locator('button:has-text("Generate Clothing Avatars")');
    if (await btn.isVisible()) {
      console.log('   Found! Clicking...');
      await btn.click();
      break;
    }
  }

  // 5. Wait for generation
  console.log('5. Waiting for avatar generation (90 seconds)...');
  await page.waitForTimeout(90000);

  // 6. Take screenshot of results
  console.log('6. Taking screenshot...');
  await page.screenshot({ path: 'test-results/avatar-scores.png', fullPage: true });

  // Keep open for inspection
  console.log('7. Browser stays open - check the scores!');
  await page.waitForTimeout(60000);

  await browser.close();
})();

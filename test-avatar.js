const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  console.log('1. Opening /create...');
  await page.goto('http://localhost:5173/create');
  await page.waitForLoadState('networkidle');

  // Login if needed
  const emailInput = page.locator('input[type="email"]');
  if (await emailInput.isVisible().catch(() => false)) {
    console.log('2. Logging in...');
    await emailInput.fill('ch_roger_fischer@yahoo.com');
    await page.locator('input[type="password"]').fill('M1.NtFsmdS');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(5000);
  }

  console.log('3. Clicking character...');
  await page.waitForTimeout(2000);
  for (const name of ['Sophie', 'Lukas', 'Tim']) {
    const char = page.locator(`text="${name}"`).first();
    if (await char.isVisible().catch(() => false)) {
      await char.click();
      console.log(`   Clicked ${name}`);
      await page.waitForTimeout(2000);
      break;
    }
  }

  console.log('4. Finding Generate button...');
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => window.scrollBy(0, 250));
    await page.waitForTimeout(200);
  }

  const btn = page.locator('button:has-text("Generate Clothing Avatars")');
  if (await btn.isVisible().catch(() => false)) {
    console.log('5. Generating avatars - please wait...');
    await btn.click();

    // Wait for generation (watch for loading to finish)
    await page.waitForTimeout(90000);
    console.log('6. Done! Check the scores in the browser.');
  } else {
    console.log('   Button not found - scroll manually');
  }

  console.log('\n=== BROWSER OPEN - Close manually when done ===');
  await new Promise(() => {});
})();

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  // Go to production - wait longer for deployment
  await page.goto('https://magicalstory.ch');
  await page.waitForTimeout(2000);
  
  // Click Start Your Adventure
  await page.click('text=Start Your Adventure');
  await page.waitForTimeout(2000);
  
  // Check if login modal appeared, try Google login or look for character section
  const loginModal = page.locator('text=Welcome Back');
  if (await loginModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('Login required - taking screenshot of login modal');
    await page.screenshot({ path: 'test-output/needs-login.png' });
  }
  
  // Try going directly to a public page that might show character styling
  await page.goto('https://magicalstory.ch');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'test-output/home-check.png', fullPage: true });
  
  console.log('Done - check test-output/home-check.png');
  await browser.close();
})();

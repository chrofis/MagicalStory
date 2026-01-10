const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Capture console messages
  page.on('console', msg => console.log('BROWSER:', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  page.on('response', response => {
    if (response.url().includes('/api/auth')) {
      console.log('AUTH RESPONSE:', response.status(), response.url());
    }
  });

  try {
    console.log('1. Opening app...');
    await page.goto('http://localhost:5173/create');
    await page.waitForLoadState('networkidle');

    console.log('2. Filling login form...');
    const emailInput = page.locator('input[type="email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });

    await emailInput.fill('ch_roger_fischer@yahoo.com');
    await page.locator('input[type="password"]').fill('M1.NtFsmdS');

    console.log('3. Submitting...');
    await page.locator('button[type="submit"]').click();

    // Wait and watch for responses
    console.log('4. Waiting for response...');
    await page.waitForTimeout(8000);

    // Check current URL and state
    console.log('5. Current URL:', page.url());
    const hasLoginForm = await page.locator('input[type="email"]').isVisible().catch(() => false);
    console.log('   Login form visible:', hasLoginForm);

    if (hasLoginForm) {
      // Check for any error messages on the page
      const errorText = await page.locator('.text-red-500, .text-red-600, .error').textContent().catch(() => 'none');
      console.log('   Error text:', errorText);
    }

    console.log('\n=== Browser stays open ===');
  } catch (err) {
    console.log('Error:', err.message);
  }

  await new Promise(() => {});
})();

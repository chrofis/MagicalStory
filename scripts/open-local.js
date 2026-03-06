// Launch browser logged in to localhost for manual testing
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function main() {
  const authFile = path.join(__dirname, '../.auth/user.json');

  // Check if auth state exists
  if (!fs.existsSync(authFile)) {
    console.log('No auth state found. Please run: npx playwright test -g "authenticate" first');
    process.exit(1);
  }

  console.log('Launching browser with saved auth state...');

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({
    storageState: authFile,
    viewport: null // Use full window size
  });

  const page = await context.newPage();

  // Navigate to localhost
  await page.goto('http://localhost:3000/create');
  await page.waitForLoadState('networkidle');

  console.log('Browser opened at http://localhost:3000/create');
  console.log('You are logged in as admin - enable Dev Mode from the Menu');
  console.log('Press Ctrl+C to close when done');

  // Keep the script running
  await new Promise(() => {});
}

main().catch(console.error);

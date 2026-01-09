// Upload a new photo for Sophie via Playwright
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

  await page.screenshot({ path: 'test-results/upload-1-initial.png' });

  // Find Sophie's edit button
  console.log('Finding Sophie edit button...');

  const editButton = await page.evaluate(() => {
    const sophieElements = Array.from(document.querySelectorAll('*')).filter(el =>
      el.textContent.trim() === 'Sophie' && el.children.length === 0
    );

    if (sophieElements.length > 0) {
      let container = sophieElements[0].parentElement;
      while (container && !container.querySelector('.bg-indigo-600')) {
        container = container.parentElement;
      }

      if (container) {
        const btn = container.querySelector('.bg-indigo-600');
        if (btn) {
          const rect = btn.getBoundingClientRect();
          return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
        }
      }
    }
    return null;
  });

  if (editButton) {
    console.log(`Clicking edit at (${editButton.x}, ${editButton.y})`);
    await page.mouse.click(editButton.x, editButton.y);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'test-results/upload-2-edit-page.png' });

    const url = page.url();
    console.log(`Current URL: ${url}`);

    // Look for "Upload Photo" or file input for photo upload
    console.log('Looking for photo upload area...');

    // The photo upload is usually in the character edit form
    // Look for file input or upload button
    const fileInput = page.locator('input[type="file"]').first();
    const fileInputCount = await fileInput.count();
    console.log(`Found ${fileInputCount} file inputs`);

    if (fileInputCount > 0) {
      // Use a test image - let's use one of the screenshots as a test
      const testImagePath = path.join(__dirname, '../test-results/regen-1-initial.png');
      console.log(`Uploading test image: ${testImagePath}`);

      await fileInput.setInputFiles(testImagePath);
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'test-results/upload-3-after-upload.png' });

      // Wait for photo analysis
      console.log('Waiting for photo analysis...');
      await page.waitForTimeout(5000);
      await page.screenshot({ path: 'test-results/upload-4-analyzed.png' });

      // Look for Generate Avatar button or Save button
      console.log('Looking for Generate/Save button...');

      // List all visible buttons to find the right one
      const allBtns = await page.locator('button:visible').all();
      console.log(`Found ${allBtns.length} visible buttons:`);
      for (let i = 0; i < Math.min(allBtns.length, 20); i++) {
        const text = await allBtns[i].textContent().catch(() => '');
        if (text.trim()) {
          console.log(`  "${text.trim().substring(0, 50)}"`);
        }
      }

      // Try clicking "Generate Avatar" or similar
      const generateBtn = page.locator('button:has-text("Generate")');
      if (await generateBtn.count() > 0) {
        console.log('Clicking Generate button...');
        await generateBtn.first().click();

        console.log('Waiting for avatar generation...');
        for (let i = 0; i < 12; i++) {
          await page.waitForTimeout(10000);
          console.log(`  ${(i+1)*10} seconds elapsed...`);
          await page.screenshot({ path: `test-results/upload-5-gen-${i}.png` });
        }
      }
    } else {
      console.log('No file input found. Looking for upload button...');

      // List all buttons
      const allBtns = await page.locator('button:visible').all();
      console.log(`Found ${allBtns.length} visible buttons:`);
      for (let i = 0; i < Math.min(allBtns.length, 20); i++) {
        const text = await allBtns[i].textContent().catch(() => '');
        if (text.trim()) {
          console.log(`  "${text.trim().substring(0, 50)}"`);
        }
      }
    }

    await page.screenshot({ path: 'test-results/upload-6-final.png' });
  } else {
    console.log('Could not find Sophie edit button');
    await page.screenshot({ path: 'test-results/upload-error.png' });
  }

  console.log('\nBrowser staying open for 5 minutes for observation...');
  await page.waitForTimeout(300000);

  await browser.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

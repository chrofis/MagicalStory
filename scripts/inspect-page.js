// Inspect the character cards structure
const { chromium } = require('playwright');
const path = require('path');

async function main() {
  const authFile = path.join(__dirname, '../.auth/user.json');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: authFile,
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();

  await page.goto('http://localhost:3000/create');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Get the HTML around Sophie
  const sophieHtml = await page.evaluate(() => {
    const sophieEl = Array.from(document.querySelectorAll('*')).find(el =>
      el.textContent.includes('Sophie') &&
      el.textContent.includes('Female') &&
      el.children.length < 20
    );
    if (sophieEl) {
      // Get parent structure
      let parent = sophieEl;
      for (let i = 0; i < 3 && parent.parentElement; i++) {
        parent = parent.parentElement;
      }
      return {
        outerHTML: parent.outerHTML.substring(0, 2000),
        tagName: parent.tagName,
        className: parent.className
      };
    }
    return null;
  });

  console.log('Sophie card structure:');
  console.log(JSON.stringify(sophieHtml, null, 2));

  // Find all clickable elements near Sophie
  const buttons = await page.evaluate(() => {
    const results = [];
    const sophieText = Array.from(document.querySelectorAll('*')).find(el =>
      el.textContent === 'Sophie' || el.textContent.trim() === 'Sophie'
    );

    if (sophieText) {
      // Find parent card (walk up until we find something with multiple children)
      let card = sophieText.parentElement;
      while (card && card.children.length < 3) {
        card = card.parentElement;
      }

      if (card) {
        // Find all buttons/clickable elements in this card
        const btns = card.querySelectorAll('button, [role="button"], a, [onclick]');
        btns.forEach((btn, i) => {
          results.push({
            index: i,
            tagName: btn.tagName,
            className: btn.className.substring(0, 100),
            text: btn.textContent.substring(0, 50),
            ariaLabel: btn.getAttribute('aria-label')
          });
        });
      }
    }
    return results;
  });

  console.log('\nButtons in Sophie card:');
  buttons.forEach(b => console.log(b));

  await page.waitForTimeout(5000);
  await browser.close();
}

main().catch(console.error);

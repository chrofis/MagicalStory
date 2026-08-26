// Connect to the running resume-demo browser via CDP and run a single
// inline JS snippet against the active page. The browser stays open
// across drive.js invocations.
//
// Usage:
//   node tests/manual/drive.js "<javascript-using-page>"
//
// Examples:
//   node tests/manual/drive.js "await page.getByRole('button', { name: /^weiter$/i }).first().click()"
//   node tests/manual/drive.js "console.log(await page.url())"
//   node tests/manual/drive.js "await page.screenshot({ path: 'shot.png', fullPage: true })"

const { chromium } = require('playwright');

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const snippet = process.argv.slice(2).join(' ');
if (!snippet) {
  console.error('Usage: node tests/manual/drive.js "<javascript-using-page>"');
  process.exit(1);
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  if (contexts.length === 0) { console.error('No contexts found.'); process.exit(1); }
  const pages = contexts[0].pages();
  if (pages.length === 0) { console.error('No pages found.'); process.exit(1); }
  const page = pages[0];

  const fn = new Function('page', `return (async () => { ${snippet} })();`);
  try {
    const result = await fn(page);
    if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    // disconnect, NOT close — leave the browser open for the next call
    await browser.close().catch(() => {});
  }
})();

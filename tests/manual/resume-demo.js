// Open the demo account in a headed browser, log in, navigate to /create,
// then idle indefinitely. User drives the browser manually OR tells the
// assistant which Playwright actions to add next.
//
// Usage: node tests/manual/resume-demo.js
//   env DEMO_EMAIL / DEMO_PASSWORD optional (defaults to the most recent
//   showcase account so we don't burn another one).

const { chromium } = require('playwright');

const EMAIL = process.env.DEMO_EMAIL || 'demo-b-hmtwe@magicalstory.ch';
const PASSWORD = process.env.DEMO_PASSWORD || 'DemoStory2026!';

// CDP port — any subsequent driver script (tests/manual/drive.js) can
// connectOverCDP('http://localhost:9222') and act on the same browser
// without forcing a re-login.
const CDP_PORT = 9222;

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: [`--remote-debugging-port=${CDP_PORT}`],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  console.log(`CDP open on http://localhost:${CDP_PORT}`);

  console.log(`Logging in as ${EMAIL}...`);
  await page.goto('https://magicalstory.ch/?login=true');

  // Trigger modal if it didn't auto-open.
  if (!await page.locator('.fixed.inset-0').isVisible({ timeout: 2000 }).catch(() => false)) {
    const trigger = page.getByRole('button', { name: /bereits ein konto|already have an account|d[eé]j[aà] un compte|anmelden|sign in|connexion/i }).first();
    await trigger.click({ timeout: 5000 });
  }

  await page.waitForSelector('.fixed.inset-0', { timeout: 15000 });
  const modal = page.locator('.fixed.inset-0');
  await modal.getByPlaceholder(/email/i).fill(EMAIL, { timeout: 5000 });
  await modal.locator('input[type="password"]').fill(PASSWORD, { timeout: 5000 });
  await modal.getByRole('button', { name: /sign in|anmelden|connexion|se connecter/i })
    .click({ timeout: 5000 });
  await page.waitForSelector('.fixed.inset-0', { state: 'detached', timeout: 15000 });
  console.log('Logged in.');

  await page.goto('https://magicalstory.ch/create');
  await page.waitForLoadState('domcontentloaded');
  console.log('On /create. Browser stays open — drive it manually or tell the assistant what to do.');

  // Keep the process alive so the browser stays open.
  // Ctrl+C in this terminal closes it.
  await new Promise(() => {});
})().catch(err => {
  console.error('Resume failed:', err);
  process.exit(1);
});

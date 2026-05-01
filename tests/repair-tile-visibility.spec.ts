import { test, expect } from '@playwright/test';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const STORY_ID = 'job_1777498941771_7w7ax5wpv';
const PAGE_NUMBER = 10;
const CHAR_NAME = 'Werner';
const BASE = process.env.TEST_BASE_URL || 'https://www.magicalstory.ch';
// Body (default) → auto routes to fullScene = grok_inpaint.
// Face → auto routes to grok_blended (the new shape-aware face blur).
// Override at the CLI: REPAIR_TARGET=face npx playwright test ...
const REPAIR_TARGET: 'body' | 'face' = (process.env.REPAIR_TARGET === 'face') ? 'face' : 'body';
const EXPECTED_METHOD = REPAIR_TARGET === 'face' ? /grok_blended/ : /grok_inpaint/;

const ADMIN_USER = {
  id: '1764881868108',
  username: 'rogerfischer',
  email: 'rogerfischer@hotmail.com',
  role: 'admin',
};

function adminJwt(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET missing from .env');
  return jwt.sign(
    {
      id: ADMIN_USER.id,
      userId: ADMIN_USER.id,
      username: ADMIN_USER.username,
      role: ADMIN_USER.role,
      email: ADMIN_USER.email,
      emailVerified: true,
    },
    secret,
    { expiresIn: '2h' }
  );
}

const log = (msg: string) => console.log(`[repair-tile] ${new Date().toISOString().slice(11, 19)} ${msg}`);

test('char-repair Reparatur-Ergebnis shows Whiteout tile (grok_inpaint mode)', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);

  // Surface page console + network errors so we can see why the request didn't fire
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') log(`[browser ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', e => log(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => log(`[requestfailed] ${r.url()} — ${r.failure()?.errorText}`));
  page.on('response', async r => {
    if (r.url().includes('/repair-character') || r.url().includes('/refresh-bbox') || r.url().includes('/api/stories/' + STORY_ID + '/repair')) {
      log(`[response ${r.status()}] ${r.url()}`);
    }
  });

  const token = adminJwt();

  log('Step 1: prime localStorage with admin JWT + dev mode (no user blob — let /api/auth/me hydrate credits)');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => {
    localStorage.setItem('auth_token', tok);
    localStorage.setItem('developer_mode', 'true');
    localStorage.removeItem('current_user');
  }, token);

  log(`Step 1b: pin page ${PAGE_NUMBER} to versionIndex=0 (Original) so reruns are deterministic`);
  const pinRes = await page.request.put(`${BASE}/api/stories/${STORY_ID}/pages/${PAGE_NUMBER}/active-image`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { versionIndex: 0 },
  });
  log(`  pin status = ${pinRes.status()} ${pinRes.statusText()}`);
  if (pinRes.status() >= 400) {
    const body = await pinRes.text().catch(() => '<no body>');
    log(`  pin failed body: ${body.slice(0, 300)}`);
  }

  log('Step 2: open story');
  await page.goto(`${BASE}/create?storyId=${STORY_ID}`, { waitUntil: 'domcontentloaded' });

  log(`Step 3: wait for "Seite ${PAGE_NUMBER}" header`);
  const pageHeader = page.locator('h4', { hasText: `Seite ${PAGE_NUMBER}` }).first();
  await pageHeader.waitFor({ state: 'visible', timeout: 90_000 });
  await pageHeader.scrollIntoViewIfNeeded();
  log('  ✓ page 10 header visible');

  // page wrapper is the nearest ancestor div with className starting "p-4"
  const pageContainer = pageHeader.locator('xpath=ancestor::div[contains(@class,"p-4")][1]');
  await expect(pageContainer).toBeVisible();

  log('Step 4: click "Figur reparieren" button on page 10');
  const fixCharBtn = pageContainer.getByRole('button', { name: /Figur reparieren|Fix Character|Réparer personnage/i }).first();
  await fixCharBtn.scrollIntoViewIfNeeded();
  await expect(fixCharBtn).toBeVisible();
  // Credits load async via /api/auth/me — give it 30s to hydrate before the
  // !hasEnoughCredits guard releases the button.
  await expect(fixCharBtn).toBeEnabled({ timeout: 30_000 });
  await fixCharBtn.click();
  log('  ✓ trigger button clicked');

  log('Step 5: wait for popover');
  const popoverRoot = page.locator('div.fixed.inset-0.z-50').last();
  await popoverRoot.waitFor({ state: 'visible', timeout: 60_000 });
  const popoverCard = popoverRoot.locator('> div').first();
  await popoverCard.waitFor({ state: 'visible' });
  log('  ✓ popover open');

  // List options for diagnostics
  const opts = await popoverCard.locator('select option').allTextContents();
  log(`  popover dropdown options: [${opts.join(', ')}]`);

  if (!opts.some(o => o.trim() === CHAR_NAME)) {
    log(`  ✗ ${CHAR_NAME} not in dropdown — failing fast`);
    await page.screenshot({ path: 'test-results/repair-tile-no-werner.png', fullPage: true });
    throw new Error(`Character "${CHAR_NAME}" not in dropdown options: [${opts.join(', ')}]`);
  }

  log(`Step 6: select character "${CHAR_NAME}"`);
  const charSelect = popoverCard.locator('select').first();
  await charSelect.selectOption({ label: CHAR_NAME });
  const selectedVal = await charSelect.inputValue();
  log(`  ✓ select value = "${selectedVal}"`);

  log(`Step 6b: select target = ${REPAIR_TARGET}`);
  if (REPAIR_TARGET === 'body') {
    const bodyBtn = popoverCard.getByRole('button', { name: /^(Körper|Body|Corps)$/ }).first();
    await bodyBtn.click();
  } else {
    // Face is the popover default but click it explicitly so the test is reproducible.
    const faceBtn = popoverCard.getByRole('button', { name: /^(Gesicht|Face|Visage)$/ }).first();
    await faceBtn.click();
  }
  log(`  ✓ ${REPAIR_TARGET} target selected`);

  log('Step 7: click "Reparieren" inside popover');
  const repairBtn = popoverCard.getByRole('button', { name: /^(Reparieren|Repair|Réparer)/ }).first();
  await expect(repairBtn).toBeEnabled();
  await page.screenshot({ path: 'test-results/repair-tile-before-click.png', fullPage: false });
  await repairBtn.click();
  log('  ✓ Reparieren clicked');

  log('Step 8: confirm popover closes + repairing-state engages');
  // Popover should close within ~1s (state update is synchronous on click)
  await popoverRoot.waitFor({ state: 'hidden', timeout: 10_000 }).catch(async () => {
    await page.screenshot({ path: 'test-results/repair-tile-popover-stuck.png', fullPage: true });
    throw new Error('Popover did not close after Reparieren click');
  });
  // The page-10 button should now show the "Repariere..." spinner
  const repairingSpinner = pageContainer.getByText(/Repariere\.\.\.|Repairing\.\.\./).first();
  await repairingSpinner.waitFor({ state: 'visible', timeout: 5_000 }).catch(async () => {
    await page.screenshot({ path: 'test-results/repair-tile-no-spinner.png', fullPage: true });
    log('  ⚠ no Repariere... spinner detected — request may not have fired');
  });
  log('  ✓ popover closed, spinner up');

  log('Step 9: wait for Reparatur-Ergebnis panel (up to 12 min)');
  const resultPanel = page.locator('details', { hasText: /Reparatur-Ergebnis|Repair Result/i }).first();
  await resultPanel.waitFor({ state: 'visible', timeout: 12 * 60 * 1000 });
  log('  ✓ panel visible');

  const methodTxt = await resultPanel.locator('text=/grok_/').first().textContent().catch(() => null);
  log(`  method = ${methodTxt}`);
  expect(methodTxt, `expected ${EXPECTED_METHOD} method (${REPAIR_TARGET} target)`).toMatch(EXPECTED_METHOD);

  log('Step 10: assert masked-input tile is rendered');
  const whiteoutTile = resultPanel.locator('img[alt="Whiteout"]');
  const cutoutTile = resultPanel.locator('img[alt="Cutout sent"]');
  const wCount = await whiteoutTile.count();
  const cCount = await cutoutTile.count();
  log(`  Whiteout count=${wCount}, Cutout-sent count=${cCount}`);
  const maskedTile = wCount > 0 ? whiteoutTile : cutoutTile;
  await expect(maskedTile, 'masked-input tile (Whiteout or Cutout sent) must be visible').toHaveCount(1);
  const src = await maskedTile.getAttribute('src');
  expect(src, 'masked-input tile must have non-empty src').toBeTruthy();
  expect(src!.length, 'masked-input src must not be a placeholder').toBeGreaterThan(40);

  await expect(resultPanel.locator('img[alt="Grok raw"]')).toHaveCount(1);
  await expect(resultPanel.locator('img[alt="Avatar sent"]')).toHaveCount(1);

  log(`PASS — masked-input tile rendered, src length ${src!.length}`);

  await page.pause();
});

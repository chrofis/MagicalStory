import { test, expect } from '@playwright/test';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ADMIN = {
  id: '1764881868108',
  username: 'rogerfischer',
  email: 'rogerfischer@hotmail.com',
  role: 'admin',
};

function adminJwt(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET missing');
  return jwt.sign(
    { id: ADMIN.id, userId: ADMIN.id, username: ADMIN.username, role: ADMIN.role, email: ADMIN.email, emailVerified: true },
    secret,
    { expiresIn: '1h' }
  );
}

test.describe('Test Models flag dropdowns are visible (dev panel)', () => {
  test.setTimeout(120_000);

  test('renders Reference Mode + Empty-Scene Plate selectors after clicking Test Models', async ({ page, context }) => {
    page.on('pageerror', err => console.error('❌ [PAGE ERROR]', err.message));
    page.on('console', msg => { if (msg.type() === 'error') console.error('❌ [CONSOLE]', msg.text()); });

    // Inject admin JWT before any navigation so the wizard recognizes admin role
    const token = adminJwt();
    await context.addInitScript(([t]) => {
      window.localStorage.setItem('auth_token', t);
      window.localStorage.setItem('developer_mode', 'true');
    }, [token]);

    // Open a known existing story directly. job_1777498941771_7w7ax5wpv is the
    // Wilhelm-Tell story we've been diagnosing; any completed story id works.
    const STORY_ID = process.env.TEST_STORY_ID || 'job_1777498941771_7w7ax5wpv';
    await page.goto(`/create?storyId=${STORY_ID}`, { waitUntil: 'domcontentloaded' });
    console.log(`✅ on /create?storyId=${STORY_ID}`);
    await page.waitForLoadState('networkidle', { timeout: 30_000 });

    // Wait for first page card to render
    await page.waitForSelector('text=Test Models', { timeout: 30_000 });
    console.log('✅ Test Models button visible');

    // Click the FIRST "Test Models" button on the page
    const testModelsBtn = page.locator('button', { hasText: 'Test Models' }).first();
    await testModelsBtn.click();

    // Verify the panel opened — heading "Test Models — Page N"
    await page.waitForSelector('text=/Test Models — Page/', { timeout: 5_000 });
    console.log('✅ Test Models panel opened');

    // Verify Reference Mode label + select
    const refModeLabel = page.locator('text=Reference Mode').first();
    await expect(refModeLabel).toBeVisible({ timeout: 5_000 });
    console.log('✅ Reference Mode label found');

    // Verify Empty-Scene Plate label + select
    const plateLabel = page.locator('text=Empty-Scene Plate').first();
    await expect(plateLabel).toBeVisible({ timeout: 5_000 });
    console.log('✅ Empty-Scene Plate label found');

    // Verify the selects have the expected options
    const refModeSelect = page.locator('select').filter({ hasText: 'inherit (server default)' }).first();
    await expect(refModeSelect).toBeVisible();
    const refModeText = await refModeSelect.evaluate((el: HTMLSelectElement) =>
      Array.from(el.options).map(o => o.value).join(',')
    );
    console.log(`▶️  Reference Mode options: ${refModeText}`);
    expect(refModeText).toContain('strict');
    expect(refModeText).toContain('loose');
    expect(refModeText).toContain('styled-only');
    expect(refModeText).toContain('off');

    // Screenshot for the user
    await page.screenshot({ path: 'tests/_screenshots/test-models-flags.png', fullPage: false });
    console.log('📸 Screenshot saved to tests/_screenshots/test-models-flags.png');
  });
});

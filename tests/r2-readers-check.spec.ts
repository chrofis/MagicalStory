import { test, expect } from '@playwright/test';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Story migrated to URL-only VB refs. Owner = same admin id below, so the
// admin JWT bypass works.
const STORY_ID = 'job_1777492526266_wwky4z64a';
const BASE = process.env.TEST_BASE_URL || 'https://www.magicalstory.ch';

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

test('Phase 2 reader: editor loads migrated story, all images render', async ({ page }) => {
  test.setTimeout(120_000);

  const consoleErrors: string[] = [];
  const failedReqs: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on('requestfailed', req => {
    const u = req.url();
    if (/googlesyndication|googletagmanager|doubleclick|fonts\.googleapis|gtm\.js|analytics/.test(u)) return;
    failedReqs.push(`${req.method()} ${u} (${req.failure()?.errorText})`);
  });

  // Prime auth before navigating to the protected route
  const token = adminJwt();
  await page.goto(BASE + '/');
  await page.evaluate((tok) => {
    localStorage.setItem('auth_token', tok);
    localStorage.setItem('developer_mode', 'true');
  }, token);

  await page.goto(`${BASE}/create?storyId=${STORY_ID}`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(3500);

  await page.screenshot({ path: 'test-output/r2-readers-editor.png', fullPage: false });

  const title = await page.title();
  console.log('TITLE:', title);
  console.log('CURRENT URL:', page.url());

  const imgCount = await page.locator('img').count();
  const brokenImages = await page.locator('img').evaluateAll(imgs =>
    imgs.filter((img: any) => img.complete && img.naturalWidth === 0)
        .map((img: any) => ({ src: img.src, alt: img.alt }))
  );

  const r2Imgs = await page.locator('img').evaluateAll(imgs =>
    imgs.filter((img: any) => img.src && img.src.includes('images.magicalstory.ch'))
        .map((img: any) => ({ src: img.src.slice(0, 120), ok: img.naturalWidth > 0, w: img.naturalWidth, h: img.naturalHeight }))
  );

  console.log('IMG COUNT:', imgCount);
  console.log('BROKEN IMAGES:', brokenImages.length);
  if (brokenImages.length) console.log(JSON.stringify(brokenImages, null, 2));
  console.log('R2 IMAGES IN DOM:', r2Imgs.length);
  console.log('R2 SAMPLE (first 5):', JSON.stringify(r2Imgs.slice(0, 5), null, 2));
  console.log('CONSOLE ERRORS:', consoleErrors.length);
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 5));
  console.log('FAILED REQS (excluding third-party):', failedReqs.length);
  if (failedReqs.length) console.log(failedReqs.slice(0, 5));

  expect(brokenImages.length, `Broken images: ${JSON.stringify(brokenImages)}`).toBe(0);
  expect(r2Imgs.length, 'No R2-hosted images found in DOM').toBeGreaterThan(0);
  expect(r2Imgs.every(i => i.ok), 'Some R2 images failed to load').toBe(true);
});

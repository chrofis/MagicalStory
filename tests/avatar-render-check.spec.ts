import { test, expect } from '@playwright/test';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const BASE = process.env.TEST_BASE_URL || 'https://www.magicalstory.ch';
const ADMIN = {
  id: '1764881868108',
  username: 'rogerfischer',
  email: 'rogerfischer@hotmail.com',
  role: 'admin',
};

function adminJwt(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET missing');
  return jwt.sign({
    id: ADMIN.id, userId: ADMIN.id, username: ADMIN.username,
    role: ADMIN.role, email: ADMIN.email, emailVerified: true,
  }, secret, { expiresIn: '15m' });
}

test('character avatars render after Phase 5 cleanup', async ({ page }) => {
  test.setTimeout(90_000);

  const failed: string[] = [];
  page.on('requestfailed', req => {
    const u = req.url();
    if (/googlesyndication|googletagmanager|doubleclick|fonts\.googleapis|gtm\.js|analytics/.test(u)) return;
    failed.push(`${req.method()} ${u} (${req.failure()?.errorText})`);
  });

  const tok = adminJwt();
  await page.goto(BASE + '/');
  await page.evaluate(t => {
    localStorage.setItem('auth_token', t);
    localStorage.setItem('developer_mode', 'true');
  }, tok);

  // Hit the characters list page (the avatar wizard / characters screen)
  await page.goto(`${BASE}/create`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: 'test-output/avatars-after-p5.png', fullPage: true });

  // Probe the API directly via the page's fetch (uses authed session)
  const apiResult = await page.evaluate(async () => {
    const r = await fetch('/api/characters', { headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') }});
    const j = await r.json();
    return j.characters?.map((c: any) => ({
      id: c.id,
      name: c.name,
      faceThumb: c.avatars?.faceThumbnails?.standard ? (c.avatars.faceThumbnails.standard.startsWith('http') ? 'URL' : 'data:') : 'MISSING',
      hasFull: !!c.avatars?.hasFullAvatars,
    }));
  });

  console.log('API characters:', JSON.stringify(apiResult, null, 2));

  // Check rendered <img> tags on the page that point to face thumbs
  const imgs = await page.locator('img').evaluateAll(arr => arr
    .filter((i: any) => i.src && (i.src.includes('images.magicalstory.ch') || i.src.startsWith('data:image')))
    .map((i: any) => ({ src: i.src.slice(0, 100), ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth, h: i.naturalHeight }))
  );
  const broken = imgs.filter(i => !i.ok);

  console.log('AVATAR-LIKE IMGS in DOM:', imgs.length);
  console.log('BROKEN IMGS:', broken.length);
  if (broken.length) console.log(JSON.stringify(broken.slice(0, 10), null, 2));
  console.log('FAILED REQS:', failed.length);
  if (failed.length) console.log(failed.slice(0, 5));

  // Hard assertion: every character must have a face thumb
  const noThumb = (apiResult || []).filter((c: any) => c.faceThumb === 'MISSING');
  expect(noThumb.length, `Characters missing faceThumb: ${JSON.stringify(noThumb)}`).toBe(0);
  expect(broken.length, `Broken avatar imgs: ${JSON.stringify(broken)}`).toBe(0);
});

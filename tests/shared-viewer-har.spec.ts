import { test } from '@playwright/test';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const SHARE_TOKEN = '45f84241023c9d4df61a6cdf8ccb85233ec9b19276789c1622efeb2bd55a2900';
const BASE = process.env.TEST_BASE_URL || 'https://www.magicalstory.ch';
const HAR_PATH = path.resolve('test-results', 'shared-viewer.har');

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
    { id: ADMIN_USER.id, userId: ADMIN_USER.id, username: ADMIN_USER.username, role: ADMIN_USER.role, email: ADMIN_USER.email, emailVerified: true },
    secret,
    { expiresIn: '1h' }
  );
}

test('capture HAR for shared viewer first paint', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    recordHar: { path: HAR_PATH, mode: 'minimal', content: 'omit' },
  });
  // For a public story we don't need auth at all — measure the cleanest
  // first-paint case (anonymous user from email link → not yet logged in).
  // Pre-loading auth_token via addInitScript adds a layer of script
  // execution before navigation that can interfere with preload timing.
  const page = await context.newPage();
  // If REPAIR_LINK_SIGNED=1, use the email-style signed URL so the server
  // injects the cover preload even for a private story. Mimics the email
  // click path.
  let path = `/shared/${SHARE_TOKEN}`;
  if (process.env.SIGNED === '1') {
    const { sign } = require('../server/lib/shareLinkSig');
    const key = sign(SHARE_TOKEN);
    if (key) path += `?key=${encodeURIComponent(key)}`;
  }

  // Surface key timings
  const tNav = Date.now();
  page.on('response', r => {
    const u = r.url();
    if (u.includes('/api/shared/' + SHARE_TOKEN + '/header')) {
      console.log(`[har] ${Date.now() - tNav}ms HEADER ${r.status()}`);
    } else if (u.endsWith('/api/shared/' + SHARE_TOKEN)) {
      console.log(`[har] ${Date.now() - tNav}ms FULL ${r.status()}`);
    } else if (u.includes('/text-overlay/')) {
      console.log(`[har] ${Date.now() - tNav}ms OVERLAY ${r.status()} ${u.split('/').pop()}`);
    } else if (u.includes('/cover-image/frontCover')) {
      console.log(`[har] ${Date.now() - tNav}ms COVER ${r.status()}`);
    }
  });

  await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
  // Stay on the page until network goes quiet so the HAR captures every
  // background request (overlays, full /shared/*, image redirects).
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});

  // Browser-side perf timings: when did the cover image actually arrive in
  // the renderer? The HAR's `start` field is when the request was queued
  // by the browser, which can lag the actual fetch start under HTTP/2 +
  // preload prioritisation. PerformanceResourceTiming gives us truth.
  const perf = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const cover = entries.find(e => e.name.includes('images.magicalstory.ch') && e.name.includes('frontCover'));
    const lcp = (performance as any).getEntriesByType('largest-contentful-paint')?.[0];
    return {
      navigationStart: performance.timeOrigin,
      coverFetchStart: cover ? cover.startTime : null,
      coverResponseEnd: cover ? cover.responseEnd : null,
      coverInitiator: cover ? cover.initiatorType : null,
      lcpStart: lcp ? lcp.startTime : null,
      domContentLoaded: performance.timing
        ? performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart
        : null,
    };
  });
  console.log(`[har] perf entries:`);
  console.log(`  cover fetch start: ${perf.coverFetchStart?.toFixed(0)}ms (initiator: ${perf.coverInitiator})`);
  console.log(`  cover response end: ${perf.coverResponseEnd?.toFixed(0)}ms (= title paintable)`);
  console.log(`  domContentLoaded: ${perf.domContentLoaded}ms`);
  console.log(`  LCP: ${perf.lcpStart?.toFixed(0)}ms`);

  await context.close();
  console.log(`[har] Saved to ${HAR_PATH}`);
});

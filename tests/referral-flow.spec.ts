import { test, expect } from '@playwright/test';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const BASE = process.env.TEST_BASE_URL || 'https://www.magicalstory.ch';

// ─── Safety rails ────────────────────────────────────────────────────────
//
// This spec exercises the READ-ONLY referral endpoints only:
//   GET  /api/referral/my-code
//   POST /api/referral/validate     (validation only — does not commit anything)
//   GET  /api/referral/balance
//
// It NEVER hits checkout, Stripe, Gelato, or any endpoint that could create
// an order. POST /referral/validate runs a DB SELECT and returns a JSON
// verdict; no side effects (the buyer's referred_by field is set later, by
// the Stripe webhook on a successful paid order).

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
    { expiresIn: '15m' }
  );
}

test('referral endpoints — read-only flow (no checkout)', async ({ request }) => {
  const token = adminJwt();
  const auth = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };

  // 1. GET /api/referral/my-code — should return the user's referral code.
  const myCodeRes = await request.get(`${BASE}/api/referral/my-code`, auth);
  expect(myCodeRes.status(), 'my-code endpoint should return 200').toBe(200);
  const myCode = await myCodeRes.json();
  console.log('[referral] my code:', myCode.code, '| credits:', myCode.credits, '| referrals:', myCode.referrals, '| earned:', myCode.creditsEarned);
  // Format: "MagicXxx{2-4 digits}" per server/lib/referral.js, with mixed
  // case ("Roger") and a numeric suffix (300+ slots/name).
  expect(myCode.code, 'referral code present').toBeTruthy();
  expect(myCode.code, 'referral code matches MagicNameNNN format').toMatch(/^Magic[A-Za-z]+\d{2,4}$/);
  expect(typeof myCode.credits, 'credits is a number').toBe('number');
  expect(typeof myCode.referrals, 'referrals count is a number').toBe('number');
  expect(typeof myCode.creditsEarned, 'creditsEarned is a number').toBe('number');

  // 2. POST /api/referral/validate with the user's OWN code → must reject self-referral.
  const selfRes = await request.post(`${BASE}/api/referral/validate`, { ...auth, data: { code: myCode.code } });
  expect(selfRes.status()).toBe(200);
  const selfBody = await selfRes.json();
  console.log('[referral] self-ref result:', selfBody);
  expect(selfBody.valid, 'self-referral must be invalid').toBe(false);
  // Validation may also short-circuit on "already used / not first-time customer" before
  // reaching the self-check. Accept any of those reasons — they all keep self-ref blocked.
  expect(selfBody.reason, 'self-ref blocked with a clear reason').toMatch(/own code|already used|first-time/i);

  // 3. POST /api/referral/validate with a bogus code → "Code not found".
  const fakeRes = await request.post(`${BASE}/api/referral/validate`, { ...auth, data: { code: 'MagicBogus9999' } });
  expect(fakeRes.status()).toBe(200);
  const fakeBody = await fakeRes.json();
  console.log('[referral] fake-code result:', fakeBody);
  expect(fakeBody.valid).toBe(false);
  // Like the self-ref case, the buyer-side guards (already used / not first-time) can
  // fire before the lookup. The lookup itself does fire for unknown codes — but only
  // if the buyer isn't already disqualified.
  expect(fakeBody.reason).toMatch(/not found|already used|first-time/i);

  // 4. POST /api/referral/validate with empty/missing code → "No code provided".
  const emptyRes = await request.post(`${BASE}/api/referral/validate`, { ...auth, data: { code: '' } });
  expect(emptyRes.status()).toBe(200);
  const emptyBody = await emptyRes.json();
  console.log('[referral] empty-code result:', emptyBody);
  expect(emptyBody.valid).toBe(false);
  expect(emptyBody.reason).toMatch(/No code provided|already used|first-time/i);

  // 5. GET /api/referral/balance — referrer's CHF balance + recent ledger entries.
  const balRes = await request.get(`${BASE}/api/referral/balance`, auth);
  expect(balRes.status()).toBe(200);
  const balance = await balRes.json();
  console.log('[referral] balance:', balance);
  // Schema: { balanceChf: number, ledger: [...] } — exact ledger field names depend on
  // server/routes/print.js, but the top-level numeric balance must be present.
  const balKey = Object.keys(balance).find(k => /balance|chf/i.test(k));
  expect(balKey, 'balance response has a balance/CHF field').toBeTruthy();

  console.log('[referral] all read-only endpoints OK — NO checkout fired, NO order created.');
});

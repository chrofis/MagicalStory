#!/usr/bin/env node
/**
 * Print an admin Bearer token for the MagicalStory API — THE canonical auth
 * entry point for scripts and agents (Test Lab runs, smoke stories, admin
 * endpoints). Documented in CLAUDE.md → "Admin API auth".
 *
 * Usage:
 *   node scripts/admin/get-admin-token.js                       # staging
 *   node scripts/admin/get-admin-token.js --base=https://magicalstory.ch
 *   TOKEN=$(node scripts/admin/get-admin-token.js)
 *   curl -H "Authorization: Bearer $TOKEN" .../api/admin/...
 *
 * Notes:
 *  - Account: the admin smoke-test account (demo-b-hnecf@magicalstory.ch) —
 *    unlimited quota, 4-page stories + skipCovers allowed.
 *  - The staging Basic-auth gate (STAGING_AUTH_USER/PASSWORD in .env) protects
 *    HTML/static only, NOT /api/* — the bearer token is all API calls need.
 *  - Output: the raw token on stdout (nothing else), so $(...) capture is clean.
 *  - Tokens are CACHED in the OS temp dir until shortly before they expire.
 *    Without it every call is a fresh login, and a polling loop that re-runs this
 *    per tick trips the login rate limiter (429, "try again in 15 minutes") and
 *    locks the account out mid-experiment — which is exactly how 2026-08-23 lost
 *    its Lab slot. `--no-cache` forces a fresh login.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

/** Seconds left on a JWT, or null when it cannot be read. */
function secondsLeft(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf8'));
    if (!payload || !payload.exp) return null;
    return payload.exp - Math.floor(Date.now() / 1000);
  } catch { return null; }
}

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const BASE = arg('base', 'https://staging.magicalstory.ch').replace(/\/$/, '');
const EMAIL = arg('email', process.env.TESTLAB_USER || 'demo-b-hnecf@magicalstory.ch');
const PASSWORD = arg('password', process.env.TESTLAB_PASSWORD || 'DemoStory2026!');

// Cache key covers host + account, so staging and prod never share a token.
const CACHE_FILE = path.join(
  os.tmpdir(),
  `magicalstory-admin-token-${crypto.createHash('sha1').update(`${BASE}|${EMAIL}`).digest('hex').slice(0, 12)}.json`
);
// Re-login this long before expiry so a cached token never dies mid-request.
const REFRESH_MARGIN_S = 120;

(async () => {
  if (!process.argv.includes('--no-cache')) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const left = secondsLeft(cached.token);
      if (cached.token && left !== null && left > REFRESH_MARGIN_S) {
        process.stdout.write(cached.token + '\n');
        return;
      }
    } catch { /* no cache, unreadable, or expired — fall through to login */ }
  }

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    console.error(`login failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const { token, user } = await res.json();
  if (!token) { console.error('login ok but no token in response'); process.exit(1); }
  if (user?.role !== 'admin') console.error(`warning: ${EMAIL} role=${user?.role} (not admin)`);
  // Best-effort cache; a failed write must never break the caller's $(...).
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ token, base: BASE, email: EMAIL }), { mode: 0o600 });
  } catch { /* ignore */ }
  process.stdout.write(token + '\n');
})().catch(e => { console.error(e.message); process.exit(1); });

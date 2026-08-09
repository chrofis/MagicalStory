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
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const BASE = arg('base', 'https://staging.magicalstory.ch').replace(/\/$/, '');
const EMAIL = arg('email', process.env.TESTLAB_USER || 'demo-b-hnecf@magicalstory.ch');
const PASSWORD = arg('password', process.env.TESTLAB_PASSWORD || 'DemoStory2026!');

(async () => {
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
  process.stdout.write(token + '\n');
})().catch(e => { console.error(e.message); process.exit(1); });

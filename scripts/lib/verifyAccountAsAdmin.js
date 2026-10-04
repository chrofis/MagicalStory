'use strict';
/**
 * Mark a freshly registered demo/showcase account's email as verified, through the admin
 * API. Registration no longer auto-verifies @magicalstory.ch addresses (code review V1:
 * the domain regex let anyone skip the email gate), so scripts that create inbox-less demo
 * accounts verify them here instead.
 *
 * Admin: SHOWCASE_ADMIN_EMAIL / SHOWCASE_ADMIN_PASSWORD (default: the smoke-test admin).
 */
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoStory2026!';

async function verifyAccountAsAdmin(apiBase, userId) {
  const adminEmail = process.env.SHOWCASE_ADMIN_EMAIL || 'demo-b-hnecf@magicalstory.ch';
  const adminPassword = process.env.SHOWCASE_ADMIN_PASSWORD || DEMO_PASSWORD;
  const loginRes = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminEmail, password: adminPassword }),
  });
  if (!loginRes.ok) throw new Error(`Admin login failed for ${adminEmail} (${loginRes.status}); cannot verify the new account`);
  const admin = await loginRes.json();
  if (admin.user?.role !== 'admin') throw new Error(`${adminEmail} is not an admin on ${apiBase}; cannot verify the new account`);
  const res = await fetch(`${apiBase}/api/admin/users/${encodeURIComponent(userId)}/email-verified`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ emailVerified: true }),
  });
  if (!res.ok) throw new Error(`Verifying account ${userId} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

module.exports = { verifyAccountAsAdmin };

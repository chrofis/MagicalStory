/**
 * Regression: the admin bypass token must skip the per-IP trial limiters.
 *
 * trialAvatarLimiter (2/IP/day) fronts /generate-preview-avatar AND
 * /create-anonymous-account as middleware, so it answered 429 before the
 * handler's isAdminRequest() check ran — capping admin trial testing at two
 * runs per day (hit on 2026-08-15 during a trial showcase). Asserts both
 * halves: admins pass, and a forged or expired token is still capped.
 *
 *   node tests/manual/trial-admin-bypass-limiter.test.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-limiter-check';
const crypto = require('crypto');
const express = require('express');
const { trialAvatarLimiter } = require('../../server/middleware/rateLimit');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.post('/t', trialAvatarLimiter, (req, res) => res.json({ ok: true }));

function mintToken(offsetMs = 0) {
  const ts = String(Date.now() - offsetMs);
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`trial-bypass:${ts}`).digest('hex');
  return `${ts}:${sig}`;
}

(async () => {
  const server = app.listen(0);
  const port = server.address().port;
  const hit = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/t`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return r.status;
  };

  const anon = [];
  for (let i = 0; i < 4; i++) anon.push(await hit({}));
  console.log('no token (max=2)      :', anon.join(' '), anon.slice(2).every(s => s === 429) ? '✅ capped' : '❌');

  const admin = [];
  for (let i = 0; i < 6; i++) admin.push(await hit({ adminToken: mintToken() }));
  console.log('valid admin token     :', admin.join(' '), admin.every(s => s === 200) ? '✅ bypassed' : '❌');

  const expired = await hit({ adminToken: mintToken(6 * 60 * 1000) }); // 6 min old, TTL 5
  console.log('expired token         :', expired, expired === 429 ? '✅ still capped' : '❌ LEAK');

  const forged = await hit({ adminToken: `${Date.now()}:${'a'.repeat(64)}` });
  console.log('forged signature      :', forged, forged === 429 ? '✅ still capped' : '❌ LEAK');

  server.close();
})();

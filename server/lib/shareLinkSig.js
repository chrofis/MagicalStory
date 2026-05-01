'use strict';

const crypto = require('crypto');

// HMAC signature for email-link share URLs. Used by the /shared/<token>
// HTML handler to recognise an owner's email-link click at HTML-request
// time (before any JS runs / before auth headers are available) and inject
// the R2 cover preload hint for private stories.
//
// Format: `?key=<expiryMs>.<hmacHex>` where hmac = HMAC-SHA256(secret,
// `${shareToken}:${expiryMs}`).
//
// Threat model: a leaked key gives the bearer ONE benefit only — the HTML
// response includes a preload <link> for the front cover image. The
// underlying R2 URL the link points to is publicly fetchable anyway once
// known (R2 URLs aren't signed in this project). So the marginal leak
// here is "the bearer can see the front cover bytes if they capture the
// URL within the TTL." Account access, story content, page text — none of
// that is unlocked by this signature.
//
// The actual /api/shared/<token> endpoint still requires the share token
// (and either is_shared=true or an Authorization Bearer JWT for the
// owner). This signature is not a bypass.

function getSecret() {
  const sec = process.env.SHARE_LINK_SECRET || process.env.JWT_SECRET;
  if (!sec) throw new Error('SHARE_LINK_SECRET (or JWT_SECRET fallback) is required to sign share links');
  return sec;
}

const DEFAULT_TTL_MS = 60 * 86400 * 1000; // 60 days — emails get re-clicked weeks later

function sign(shareToken, ttlMs = DEFAULT_TTL_MS) {
  if (!shareToken || typeof shareToken !== 'string') return null;
  const expiry = Date.now() + ttlMs;
  const hmac = crypto.createHmac('sha256', getSecret())
    .update(`${shareToken}:${expiry}`)
    .digest('hex');
  return `${expiry}.${hmac}`;
}

function verify(shareToken, key) {
  if (!shareToken || !key || typeof key !== 'string') return false;
  const dot = key.indexOf('.');
  if (dot <= 0) return false;
  const expiryStr = key.slice(0, dot);
  const sigHex = key.slice(dot + 1);
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return false;
  const expected = crypto.createHmac('sha256', getSecret())
    .update(`${shareToken}:${expiry}`)
    .digest('hex');
  // Constant-time compare to avoid timing leaks.
  try {
    const a = Buffer.from(sigHex, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { sign, verify };

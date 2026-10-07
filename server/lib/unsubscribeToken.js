'use strict';

const crypto = require('crypto');

// Signed one-click unsubscribe token for promotional mail (the trial reminders).
//
// Format: `<base64url(userId)>.<hmacHex>` where
//   hmac = HMAC-SHA256(secret, `unsubscribe:${userId}`).
//
// No expiry on purpose: an opt-out link in a mail from three months ago must
// still work (Swiss UWG Art. 3 lit. o — the recipient may refuse at any time),
// and the only thing the bearer can do with it is stop promotional mail to that
// one account. There is nothing to replay for gain, so a leaked token is
// harmless beyond "someone else unsubscribed me", which the account page can
// undo once such a toggle exists.
//
// Secret: UNSUBSCRIBE_SECRET, or JWT_SECRET like server/lib/shareLinkSig.js —
// one secret per environment, so a token minted on staging does not verify on
// production and vice versa. That is why the URL is built from the same base
// the claim link uses (FRONTEND_URL / BASE_URL), not from a hardcoded host.

function getSecret() {
  const sec = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!sec) throw new Error('UNSUBSCRIBE_SECRET (or JWT_SECRET fallback) is required to sign unsubscribe links');
  return sec;
}

function hmacFor(userId) {
  return crypto.createHmac('sha256', getSecret())
    .update(`unsubscribe:${userId}`)
    .digest('hex');
}

function sign(userId) {
  if (!userId || typeof userId !== 'string') throw new Error('unsubscribe sign: userId is required');
  return `${Buffer.from(userId, 'utf8').toString('base64url')}.${hmacFor(userId)}`;
}

/** Returns the user id the token was minted for, or null when it does not verify. */
function verify(token) {
  if (!token || typeof token !== 'string' || token.length > 600) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const sigHex = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return null;
  let userId;
  try {
    userId = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!userId) return null;
  const a = Buffer.from(sigHex, 'hex');
  const b = Buffer.from(hmacFor(userId), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return userId;
}

// The same base as the claim link in the same mail (server/lib/trialReminders.js),
// so the link lands on the environment whose secret signed it.
function publicBaseUrl() {
  return process.env.FRONTEND_URL || process.env.BASE_URL || 'https://magicalstory.ch';
}

function buildUnsubscribeUrl(userId) {
  return `${publicBaseUrl()}/api/email/unsubscribe/${sign(userId)}`;
}

module.exports = { sign, verify, buildUnsubscribeUrl };

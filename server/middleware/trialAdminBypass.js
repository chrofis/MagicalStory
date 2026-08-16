/**
 * Trial admin bypass — shared verifier for the short-lived HMAC token.
 *
 * Admins testing the trial flow (the /try wizard, tests/trial-to-full.spec.ts,
 * scripts/admin/trial-showcase.js) get a purpose-scoped 5-minute HMAC from
 * GET /api/trial/admin-bypass-token and pass it as `adminToken` in the body.
 * It is NOT the admin JWT — it only says "this request may skip the trial
 * abuse guards" (Turnstile, fingerprint, per-IP rate limits).
 *
 * WHY THIS IS ITS OWN MODULE: the handlers in routes/trial.js checked the
 * token, but the per-IP limiters run as MIDDLEWARE — they rejected the request
 * with 429 before any handler code ran, so an admin re-running the trial hit
 * "Too many attempts. Please try again tomorrow." on the 3rd run of the day.
 * Both routes/trial.js and middleware/rateLimit.js need the verifier, and this
 * module is a leaf (crypto + env only), so neither require direction cycles.
 */

const crypto = require('crypto');

const BYPASS_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * True when the request carries a valid, unexpired admin bypass token.
 * Never throws — a malformed token is simply "not admin".
 * Usable directly as express-rate-limit's `skip` option.
 */
function isAdminRequest(req) {
  const token = req.body?.adminToken;
  if (!token) return false;
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return false;
    // Token format: "timestamp:hmac"
    const [ts, sig] = token.split(':');
    if (!ts || !sig) return false;
    const timestamp = Number(ts);
    if (!Number.isFinite(timestamp) || Date.now() - timestamp > BYPASS_TTL_MS) return false;
    const expected = crypto.createHmac('sha256', secret).update(`trial-bypass:${ts}`).digest('hex');
    // Constant-time comparison. A plain `sig === expected` short-circuits on
    // the first mismatched byte, leaking timing information that lets a
    // network-positioned attacker brute-force the HMAC one byte at a time.
    // Both buffers must be the same length for timingSafeEqual; if not,
    // bail out fast (the length itself is not secret).
    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch { return false; }
}

module.exports = { isAdminRequest, BYPASS_TTL_MS };

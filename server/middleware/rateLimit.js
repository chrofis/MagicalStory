// Rate Limiting Middleware
const rateLimit = require('express-rate-limit');
const { MemoryStore } = rateLimit;
const { isAdminRequest } = require('./trialAdminBypass');

// Rate limiting for authentication endpoints (prevent brute force attacks)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Max 10 attempts per window
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for registration
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Max 5 registrations per hour per IP
  message: { error: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin peek for the general apiLimiter's skip(): admins (and admins acting as another user via
// an impersonation token) bypass the 100/min cap. It goes through verifySession, the same check
// authenticateToken makes, so a revoked session (token_version bump) or a demoted admin no longer
// skips the cap. A token that fails verification, or a DB error, is simply "not admin".
async function _peekAdminFromToken(req) {
  try {
    const h = req.headers['authorization'] || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!t) return false;
    const { verifySession, isAdminActing } = require('./auth');
    return isAdminActing(await verifySession(t));
  } catch {
    return false;
  }
}

// General API rate limiter (more permissive)
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Admins bypass — impersonating a user fires many GETs (stories list,
  // jobs, character data, per-story image lazy-loads) and routinely
  // trips the 100/min cap. Real users coming through unauthenticated
  // routes still get the cap.
  skip: _peekAdminFromToken,
});

// Story generation rate limiter
const storyGenerationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Max 10 story generations per hour
  message: { error: 'Too many story generation requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// AI proxy endpoints rate limiter (prevents abuse of direct AI API calls)
// Generous limit: 60 requests/minute per user to allow legitimate use
// while preventing runaway costs from abuse
const aiProxyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute per IP
  message: { error: 'Too many AI API requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Password reset rate limiter (prevent enumeration and abuse)
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // Max 3 password reset requests per hour per IP
  message: { error: 'Too many password reset attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Error logging rate limiter (prevent DoS via log flooding)
const errorLoggingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // Max 100 error logs per hour per IP
  message: { error: 'Too many error logs. Rate limited.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Job status polling rate limiter (very permissive - lightweight read operation)
const jobStatusLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute (5/second)
  message: { error: 'Too many status requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Image regeneration rate limiter (prevent credit drain abuse)
const imageRegenerationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Max 10 regenerations per minute
  message: { error: 'Too many image regeneration requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Trial avatar rate limiter (prevent abuse of free avatar generation)
// Fronts /create-anonymous-account AND /prepare-standard-avatar (one trial = those two hits). Admin bypass
// tokens skip it: the handlers already skip Turnstile/fingerprint for admins,
// but this middleware answered 429 first, capping admin trial testing at 2 runs
// per day per IP. The global daily caps (DAILY_TRIAL_*_CAP in routes/trial.js)
// still apply to admins — those bound real spend, this one only bounds abuse.
const trialAvatarStore = new MemoryStore();
const trialAvatarLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 2, // 2 avatar generations per IP per day
  store: trialAvatarStore,
  message: { error: 'Too many attempts. Please try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isAdminRequest,
});

// Story-ideas limiter (BILL-3): these endpoints call Claude but cost no credits,
// so without a dedicated cap the only guard is the 100/min global apiLimiter —
// enough for a single abuser to burn hundreds of dollars. 30 per 15 min per IP
// is generous for real browsing while bounding runaway spend.
const storyIdeasLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: { error: 'Too many story-idea requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Avatar generation (code review 2026-10 V4): each request is several paid image calls plus evals and
// retries, charged to no credit balance. 30 per user per day; admins and admins acting as a user are
// exempt (they run Lab/QA batches). Keyed by user id, so it must run AFTER authenticateToken.
const avatarGenerationLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `user:${req.user.id}`,
  skip: (req) => require('./auth').isAdminActing(req.user),
  message: { error: 'Daily avatar generation limit reached. Please try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Trial funnel event limiter. One real trial run emits ~16 events, and a
// visitor who reloads or navigates back mints them again, so the cap has to
// leave honest usage untouched while bounding a script that tries to forge a
// funnel. Writes are ON CONFLICT DO NOTHING on (visit_id, step), so the damage
// a flood can do is bounded anyway — this mostly protects the DB from the
// write volume.
const trialEventLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  message: { error: 'Too many events.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// The idea-landmark prepare calls (wizard + trial, 2026-09-27): fired each
// time a story kind is picked, so a visitor clicking through themes sends a
// handful. Its OWN store — sharing an idea limiter would spend the idea
// requests' quota on prepares. Each call is at most one ~USD 0.0001 Jev call.
const ideaLandmarksPrepareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/landmarks/discover (security review 2026-10-07): unauthenticated by
// design (the trial wizard fires it before any session exists), and one call for
// a city not yet in landmark_index runs geocode + Wikipedia + up to 30 photo
// fetches + one gemini-2.5-flash vision call PER landmark, in the background.
// The global 100/min/IP apiLimiter allowed ~3000 paid vision calls a minute from
// one address by cycling real city names. A visitor legitimately sends one or two
// (wizard mount, location change), so 10/h/IP is generous. Its OWN store.
const landmarkDiscoverLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Reset trial-related stores from this module */
function resetTrialMiddlewareStores() {
  trialAvatarStore.resetAll();
}

module.exports = {
  authLimiter,
  registerLimiter,
  apiLimiter,
  storyGenerationLimiter,
  aiProxyLimiter,
  passwordResetLimiter,
  errorLoggingLimiter,
  imageRegenerationLimiter,
  jobStatusLimiter,
  trialAvatarLimiter,
  trialEventLimiter,
  storyIdeasLimiter,
  avatarGenerationLimiter,
  ideaLandmarksPrepareLimiter,
  landmarkDiscoverLimiter,
  resetTrialMiddlewareStores,
  _peekAdminFromToken,
};

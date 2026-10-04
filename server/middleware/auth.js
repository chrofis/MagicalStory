// Authentication Middleware
const jwt = require('jsonwebtoken');

// JWT_SECRET must be set in environment - no fallback for security
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Server cannot start securely.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

// ---------------------------------------------------------------------------
// Session validity (decisions.md: "Session JWTs carry users.token_version").
// A JWT alone cannot be revoked, so every authenticated request compares the
// token's version and the user's role with the DB row. One indexed read per
// request, cached in-process for AUTH_STATE_TTL_MS; every code path that bumps
// the version or changes the role calls invalidateAuthState().
// ---------------------------------------------------------------------------
const AUTH_STATE_TTL_MS = 10 * 1000;
const authStateCache = new Map(); // String(userId) -> { state, at }

class SessionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function loadAuthState(userId) {
  const key = String(userId);
  const hit = authStateCache.get(key);
  if (hit && Date.now() - hit.at < AUTH_STATE_TTL_MS) return hit.state;
  const { getPool } = require('../services/database'); // lazy: database.js loads heavy libs
  const result = await getPool().query('SELECT token_version, role FROM users WHERE id = $1', [userId]);
  const state = result.rows[0] ? { tokenVersion: result.rows[0].token_version, role: result.rows[0].role } : null;
  if (state) authStateCache.set(key, { state, at: Date.now() });
  return state;
}

function invalidateAuthState(userId) {
  authStateCache.delete(String(userId));
}

/**
 * Verify a bearer token AND that the session is still valid: the user exists, the token's
 * version matches users.token_version, and the role is read fresh from the DB. Returns the
 * req.user payload. Throws SessionError(401/403/503).
 *
 * Impersonation tokens are the admin acting as the target: they are valid while the target
 * exists and the ORIGINAL admin is still an admin in the DB, and their role is the target's
 * (an admin target is downgraded to 'user', so an impersonation token never grants admin
 * rights by itself; admin-acting checks use isAdminActing()).
 */
async function verifySession(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    throw new SessionError(403, 'Invalid or expired token');
  }
  let state;
  let adminState = null;
  try {
    state = await loadAuthState(decoded.id);
    if (decoded.impersonating && decoded.originalAdminId) adminState = await loadAuthState(decoded.originalAdminId);
  } catch (err) {
    console.error(`[AUTH] session lookup failed: ${err.message}`);
    throw new SessionError(503, 'Authentication temporarily unavailable');
  }
  if (!state) throw new SessionError(403, 'Invalid or expired token');
  if (decoded.impersonating) {
    if (!decoded.originalAdminId || !adminState || adminState.role !== 'admin') {
      throw new SessionError(403, 'Invalid or expired token');
    }
    return { ...decoded, role: state.role === 'admin' ? 'user' : state.role };
  }
  if ((decoded.tv || 0) !== state.tokenVersion) throw new SessionError(403, 'Invalid or expired token');
  return { ...decoded, role: state.role };
}

// Middleware to verify JWT token
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    req.user = await verifySession(token);
  } catch (err) {
    if (!(err instanceof SessionError)) throw err;
    console.log(`🔐 Auth failed for ${req.path}: ${err.message}`);
    return res.status(err.status).json({ error: err.message });
  }
  next();
}

/** True for a real admin, or an admin acting as another user (impersonation token). */
function isAdminActing(user) {
  return !!user && (user.role === 'admin' || (user.impersonating === true && user.originalAdminRole === 'admin'));
}

// Middleware to check if user is admin
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Admin, or an admin acting as another user (impersonation). For developer/eval endpoints
// that an ordinary story owner must not reach.
function requireAdminActing(req, res, next) {
  if (!isAdminActing(req.user)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Generate JWT token for a user. `user.token_version` is required: a token minted without
// it would be rejected on its first request after any later version bump.
function generateToken(user, expiresIn = '7d') {
  if (!Number.isInteger(user.token_version)) {
    throw new Error('generateToken: user.token_version missing - select users.token_version with the user row');
  }
  return jwt.sign(
    {
      id: user.id,           // Use 'id' so req.user.id works in routes
      userId: user.id,       // Keep for backwards compatibility
      username: user.username,
      role: user.role,
      email: user.email,
      emailVerified: user.email_verified,
      tv: user.token_version
    },
    JWT_SECRET,
    { expiresIn }
  );
}

// Signature-only verification (no session check). For trial-session tokens and other
// non-user tokens; user sessions go through verifySession().
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Sign arbitrary payload (for impersonation tokens etc.)
function signToken(payload, expiresIn = '7d') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

module.exports = {
  authenticateToken,
  requireAdmin,
  isAdminActing,
  requireAdminActing,
  verifySession,
  SessionError,
  invalidateAuthState,
  generateToken,
  verifyToken,
  signToken
};

// Middleware exports
const { authenticateToken, requireAdmin, generateToken, verifyToken, signToken } = require('./auth');
const { authLimiter, registerLimiter, apiLimiter, storyGenerationLimiter } = require('./rateLimit');

module.exports = {
  // Auth middleware
  authenticateToken,
  requireAdmin,
  generateToken,
  verifyToken,
  signToken,

  // Rate limiters
  authLimiter,
  registerLimiter,
  apiLimiter,
  storyGenerationLimiter
};

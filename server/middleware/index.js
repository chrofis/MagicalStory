// Middleware exports
const { authenticateToken, requireAdmin, generateToken, JWT_SECRET } = require('./auth');
const { authLimiter, registerLimiter, apiLimiter, storyGenerationLimiter } = require('./rateLimit');

module.exports = {
  // Auth middleware
  authenticateToken,
  requireAdmin,
  generateToken,
  JWT_SECRET,

  // Rate limiters
  authLimiter,
  registerLimiter,
  apiLimiter,
  storyGenerationLimiter
};

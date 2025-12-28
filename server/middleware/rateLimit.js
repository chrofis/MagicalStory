// Rate Limiting Middleware
const rateLimit = require('express-rate-limit');

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

// General API rate limiter (more permissive)
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
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

// Image regeneration rate limiter (prevent credit drain abuse)
const imageRegenerationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Max 10 regenerations per minute
  message: { error: 'Too many image regeneration requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  authLimiter,
  registerLimiter,
  apiLimiter,
  storyGenerationLimiter,
  aiProxyLimiter,
  passwordResetLimiter,
  errorLoggingLimiter,
  imageRegenerationLimiter
};

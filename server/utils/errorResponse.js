// Standardized Error Response Utility
// Ensures consistent error format across all API endpoints

// Standard error codes
const ERROR_CODES = {
  // Authentication (401)
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',

  // Authorization (403)
  FORBIDDEN: 'FORBIDDEN',
  ADMIN_REQUIRED: 'ADMIN_REQUIRED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',

  // Not Found (404)
  NOT_FOUND: 'NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  STORY_NOT_FOUND: 'STORY_NOT_FOUND',
  CHARACTER_NOT_FOUND: 'CHARACTER_NOT_FOUND',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',

  // Validation (400)
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',

  // Payment (402)
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',

  // Conflict (409)
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  JOB_IN_PROGRESS: 'JOB_IN_PROGRESS',

  // Rate Limit (429)
  RATE_LIMITED: 'RATE_LIMITED',

  // Server Error (500)
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  EXTERNAL_API_ERROR: 'EXTERNAL_API_ERROR',

  // Service Unavailable (503)
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE'
};

// Create standardized error response
function createError(code, message, details = null, statusCode = null) {
  const response = {
    error: message,
    code: code
  };

  if (details) {
    response.details = details;
  }

  // Determine status code from error code if not provided
  if (!statusCode) {
    if (code.startsWith('UNAUTHORIZED') || code === 'TOKEN_EXPIRED' || code === 'TOKEN_INVALID') {
      statusCode = 401;
    } else if (code === 'FORBIDDEN' || code === 'ADMIN_REQUIRED' || code === 'EMAIL_NOT_VERIFIED') {
      statusCode = 403;
    } else if (code.includes('NOT_FOUND')) {
      statusCode = 404;
    } else if (code === 'VALIDATION_ERROR' || code === 'INVALID_INPUT' || code === 'MISSING_REQUIRED_FIELD') {
      statusCode = 400;
    } else if (code === 'INSUFFICIENT_CREDITS' || code === 'PAYMENT_REQUIRED') {
      statusCode = 402;
    } else if (code === 'ALREADY_EXISTS' || code === 'JOB_IN_PROGRESS') {
      statusCode = 409;
    } else if (code === 'RATE_LIMITED') {
      statusCode = 429;
    } else if (code === 'SERVICE_UNAVAILABLE') {
      statusCode = 503;
    } else {
      statusCode = 500;
    }
  }

  return { response, statusCode };
}

// Send error response helper
function sendError(res, code, message, details = null, statusCode = null) {
  const { response, statusCode: derivedStatus } = createError(code, message, details, statusCode);
  return res.status(statusCode || derivedStatus).json(response);
}

// Common error shortcuts
const errors = {
  unauthorized: (res, message = 'Authentication required') =>
    sendError(res, ERROR_CODES.UNAUTHORIZED, message),

  forbidden: (res, message = 'Access denied') =>
    sendError(res, ERROR_CODES.FORBIDDEN, message),

  adminRequired: (res) =>
    sendError(res, ERROR_CODES.ADMIN_REQUIRED, 'Admin access required'),

  notFound: (res, resource = 'Resource') =>
    sendError(res, ERROR_CODES.NOT_FOUND, `${resource} not found`),

  validationError: (res, details) =>
    sendError(res, ERROR_CODES.VALIDATION_ERROR, 'Validation failed', details),

  insufficientCredits: (res, required, available) =>
    sendError(res, ERROR_CODES.INSUFFICIENT_CREDITS, 'Insufficient credits', { required, available }),

  alreadyExists: (res, resource = 'Resource') =>
    sendError(res, ERROR_CODES.ALREADY_EXISTS, `${resource} already exists`),

  rateLimited: (res, message = 'Too many requests. Please try again later.') =>
    sendError(res, ERROR_CODES.RATE_LIMITED, message),

  internalError: (res, message = 'An unexpected error occurred') =>
    sendError(res, ERROR_CODES.INTERNAL_ERROR, message),

  serviceUnavailable: (res, message = 'Service temporarily unavailable') =>
    sendError(res, ERROR_CODES.SERVICE_UNAVAILABLE, message)
};

module.exports = {
  ERROR_CODES,
  createError,
  sendError,
  errors
};

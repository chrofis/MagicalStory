// Input Validation Middleware and Utilities

// Common validation functions
const validators = {
  // String validation
  isString: (val) => typeof val === 'string',
  isNonEmptyString: (val) => typeof val === 'string' && val.trim().length > 0,
  maxLength: (val, max) => typeof val === 'string' && val.length <= max,
  minLength: (val, min) => typeof val === 'string' && val.length >= min,

  // Number validation
  isNumber: (val) => typeof val === 'number' && !isNaN(val),
  isInteger: (val) => Number.isInteger(val),
  isPositiveInteger: (val) => Number.isInteger(val) && val > 0,
  inRange: (val, min, max) => typeof val === 'number' && val >= min && val <= max,

  // Email validation
  isEmail: (val) => {
    if (typeof val !== 'string') return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(val) && val.length <= 254;
  },

  // Array validation
  isArray: (val) => Array.isArray(val),
  maxArrayLength: (val, max) => Array.isArray(val) && val.length <= max,

  // Object validation
  isObject: (val) => val !== null && typeof val === 'object' && !Array.isArray(val),

  // ID validation (alphanumeric with underscores/dashes)
  isValidId: (val) => typeof val === 'string' && /^[a-zA-Z0-9_-]+$/.test(val) && val.length <= 100,

  // Username validation
  isValidUsername: (val) => {
    if (typeof val !== 'string') return false;
    return /^[a-zA-Z0-9_-]{3,30}$/.test(val);
  },

  // Password validation (minimum requirements)
  isValidPassword: (val) => {
    if (typeof val !== 'string') return false;
    return val.length >= 8 && val.length <= 128;
  }
};

// Sanitize string input (trim and limit length)
function sanitizeString(val, maxLength = 1000) {
  if (typeof val !== 'string') return '';
  return val.trim().substring(0, maxLength);
}

// Sanitize integer input
function sanitizeInteger(val, defaultVal = 0, min = null, max = null) {
  const num = parseInt(val, 10);
  if (isNaN(num)) return defaultVal;
  if (min !== null && num < min) return min;
  if (max !== null && num > max) return max;
  return num;
}

// Validation middleware factory
function validateBody(schema) {
  return (req, res, next) => {
    const errors = [];

    for (const [field, rules] of Object.entries(schema)) {
      const value = req.body[field];

      // Check required
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`);
        continue;
      }

      // Skip validation if not required and not provided
      if (value === undefined || value === null) continue;

      // Type validation
      if (rules.type === 'string' && !validators.isString(value)) {
        errors.push(`${field} must be a string`);
      } else if (rules.type === 'number' && !validators.isNumber(value)) {
        errors.push(`${field} must be a number`);
      } else if (rules.type === 'integer' && !validators.isInteger(value)) {
        errors.push(`${field} must be an integer`);
      } else if (rules.type === 'array' && !validators.isArray(value)) {
        errors.push(`${field} must be an array`);
      } else if (rules.type === 'email' && !validators.isEmail(value)) {
        errors.push(`${field} must be a valid email address`);
      }

      // Length validation for strings
      if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
        errors.push(`${field} must be at most ${rules.maxLength} characters`);
      }
      if (rules.minLength && typeof value === 'string' && value.length < rules.minLength) {
        errors.push(`${field} must be at least ${rules.minLength} characters`);
      }

      // Range validation for numbers
      if (rules.min !== undefined && typeof value === 'number' && value < rules.min) {
        errors.push(`${field} must be at least ${rules.min}`);
      }
      if (rules.max !== undefined && typeof value === 'number' && value > rules.max) {
        errors.push(`${field} must be at most ${rules.max}`);
      }

      // Array length validation
      if (rules.maxItems && Array.isArray(value) && value.length > rules.maxItems) {
        errors.push(`${field} must have at most ${rules.maxItems} items`);
      }

      // Custom validation
      if (rules.custom && typeof rules.custom === 'function') {
        const customError = rules.custom(value);
        if (customError) errors.push(customError);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors
      });
    }

    next();
  };
}

// Common validation schemas
const schemas = {
  register: {
    username: { required: true, type: 'string', minLength: 3, maxLength: 30 },
    email: { required: true, type: 'email' },
    password: { required: true, type: 'string', minLength: 8, maxLength: 128 }
  },
  login: {
    email: { required: true, type: 'email' },
    password: { required: true, type: 'string', minLength: 1, maxLength: 128 }
  },
  createStory: {
    pages: { required: true, type: 'integer', min: 10, max: 100 },
    language: { type: 'string', maxLength: 50 },
    languageLevel: { type: 'string', maxLength: 50 },
    storyType: { type: 'string', maxLength: 100 },
    storyCategory: { type: 'string', maxLength: 50 },
    storyTopic: { type: 'string', maxLength: 200 },
    storyTheme: { type: 'string', maxLength: 100 },
    artStyle: { type: 'string', maxLength: 50 },
    characters: { type: 'array', maxItems: 10 }
  }
};

module.exports = {
  validators,
  sanitizeString,
  sanitizeInteger,
  validateBody,
  schemas
};

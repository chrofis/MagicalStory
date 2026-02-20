/**
 * Credit costs and pricing configuration (centralized for easy maintenance)
 *
 * Extracted from server.js to share across route modules.
 */

const CREDIT_CONFIG = {
  // Credit costs per operation
  COSTS: {
    IMAGE_REGENERATION: 5,    // Cost to regenerate a single scene image
    COVER_REGENERATION: 5,    // Cost to regenerate a cover image
    PER_PAGE: 10,             // Credits per story page (e.g., 20-page story = 200 credits)
  },

  // Credit purchase pricing
  PRICING: {
    CENTS_PER_CREDIT: 5,      // 5 cents per credit (CHF 0.05)
    // So CHF 5 = 500 cents = 100 credits
  },

  // Credit limits
  LIMITS: {
    MIN_PURCHASE: 100,        // Minimum credits to purchase
    MAX_PURCHASE: 10000,      // Maximum credits to purchase
    INITIAL_USER: 500,        // Credits for new users
    INITIAL_ADMIN: -1,        // Unlimited credits for admins (-1)
  },

  // Story page limits
  STORY_PAGES: {
    MIN: 4,      // Minimum 4 pages (2 scenes for standard, 4 for picture book) - dev mode uses this
    MIN_PUBLIC: 10,  // Minimum for non-dev users
    MAX: 100,
    DEFAULT: 20,
  },
};

// Legacy export for backward compatibility
const CREDIT_COSTS = CREDIT_CONFIG.COSTS;

module.exports = { CREDIT_CONFIG, CREDIT_COSTS };

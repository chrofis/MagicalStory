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

  // Credit purchase pricing — fixed packages only
  // 10 credits per page. Volume discount from 33¢/page (starter) to 25¢/page (pro).
  PRICING: {
    PACKAGES: [
      { credits: 150,  amountCHF: 5,  amountCents: 500  }, // 33.3¢/page — 15 pages (1 default story)
      { credits: 350,  amountCHF: 10, amountCents: 1000 }, // 28.6¢/page — 35 pages
      { credits: 750,  amountCHF: 20, amountCents: 2000 }, // 26.7¢/page — 75 pages
      { credits: 2000, amountCHF: 50, amountCents: 5000 }, // 25.0¢/page — 200 pages
    ],
  },

  // Credit limits
  LIMITS: {
    MAX_PURCHASE: 2000,       // Maximum credits to purchase (largest package)
    INITIAL_USER: 200,        // Credits for new users (all paths: direct signup, trial conversion, Google)
    INITIAL_ADMIN: -1,        // Unlimited credits for admins (-1)
  },

  // Referral / promo code rewards
  REFERRAL: {
    BUYER_DISCOUNT_CHF: 10,     // CHF 10 off the book price at checkout
    REFERRER_CREDITS: 350,      // credits added to referrer's balance (= CHF 10 package value)
    CODE_LENGTH: 8,             // 8-char uppercase alphanumeric, no ambiguous chars
  },

  // Story page limits
  // 1 page = 1 scene = 1 illustration (picture-book layout for all reading levels)
  STORY_PAGES: {
    MIN: 4,         // Dev mode minimum
    MIN_PUBLIC: 10, // Public minimum
    MAX: 25,        // Max 25 pages keeps a typical story under ~$3 / 250 credits
    DEFAULT: 15,
  },
};

// Legacy export for backward compatibility
const CREDIT_COSTS = CREDIT_CONFIG.COSTS;

module.exports = { CREDIT_CONFIG, CREDIT_COSTS };

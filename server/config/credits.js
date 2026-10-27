/**
 * Credit costs and pricing configuration (centralized for easy maintenance)
 *
 * Extracted from server.js to share across route modules.
 */

const CREDIT_CONFIG = {
  // Credit costs per operation
  COSTS: {
    // 2 credits = CHF 0.050–0.067 of package value, depending on which pack the
    // user bought (Pro is the floor at 2.50 Rp/credit).
    //
    // Provider cost per image is PER ENVIRONMENT — check /api/health/config, don't
    // assume. Production renders everything on Imagine 1.x ($0.02); staging renders
    // pages, covers, repair inpaint and style repair on Imagine 2.0 ($0.04). Char
    // repair and the edit tier are $0.02 in both. So the same operation is ~3–4×
    // margin in production and ~1.6–2.1× if the 2.0 rollout is promoted to master.
    IMAGE_REGENERATION: 2,    // Regenerate/iterate/prompt-edit one scene image ($0.02 prod / $0.04 staging)
    COVER_REGENERATION: 2,    // Regenerate or prompt-edit a cover (composite path is 2 calls)
    TITLE_PAINT: 2,           // Repaint the cover title in the artwork's medium (one edit-tier call, $0.02)
    CHARACTER_REPAIR: 2,      // Cutout/blended character fix on one page (1–3 edit-tier calls, $0.02 each — pinned 1.x)
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
  // Buyer side: CHF discount on this checkout (only for users with no past paid order).
  // Referrer side: earns CHF cashback to their referral balance, spendable as
  //   - discount on future books
  //   - converted to credits at CREDITS_PER_CHF rate
  //   - cashed out via Stripe refund (capped at lifetime spend on Stripe)
  REFERRAL: {
    BUYER_DISCOUNT_CHF: 10,         // CHF 10 off buyer's order
    REFERRER_CASHBACK_CENTS: 1000,  // CHF 10 cashback to referrer's balance
    CREDITS_PER_CHF: 35,            // conversion rate (mirrors 350-credits-for-CHF-10 package)
    CASHOUT_MIN_CENTS: 500,         // CHF 5 minimum cashout (avoids spam/dust refunds)
    CONVERT_MIN_CENTS: 100,         // CHF 1 minimum convert-to-credits
    CODE_LENGTH: 8,                 // 8-char uppercase alphanumeric, no ambiguous chars
  },

  // Gift vouchers. A voucher = 500 credits (a story is capped at 25 pages, so two stories in one
  // book) + one book credit. Book rule (owner, 2026-10-25): up to maxPages content pages,
  // softcover costs CHF 0, hardcover costs hardcoverSurchargeCents; CH shipping included in both.
  // bookCents = CHF 41 softcover up to 50 pages (pricing_tiers tier 3) + CHF 10 shipping = CHF 51:
  // the list value of the free softcover, used for display and as the voucher's stated value.
  VOUCHER: {
    GIFT: { priceCents: 5900, credits: 500, bookCents: 5100 },
    MAX_BOOK_PAGES: 50,
    HARDCOVER_SURCHARGE_CENTS: 1000,
    CAMPAIGN_DEFAULT_EXPIRY_MONTHS: 12,
    CODE_CHARS: 20,
  },

  // Printed-book layout (owner 2026-10-27, decisions.md "The customer picks the book layout"): facing pages
  // (picture left, text right) cost this fixed surcharge on top of the one-page price tier WHEN the customer
  // chose them over an available text-in-picture layout (gelato.facingSurchargeApplies). One constant: the
  // quote, both Stripe checkouts and the client price line read it. Gelato's own extra cost for facing pages is
  // CHF 0.65-0.98 on a 15-page story and CHF 3.84-5.88 on a 25-page story (quoted 2026-10-27).
  BOOK_LAYOUT_SURCHARGE_CHF: 5,

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

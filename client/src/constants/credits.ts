/**
 * Credits configuration — single source of truth for the frontend.
 *
 * ⚠️ MUST be kept in sync with server/config/credits.js.
 * If you change a value here, also change it there (and vice versa).
 *
 * DO NOT hardcode credit counts in page text, marketing copy, or UI — import
 * from this file and interpolate. That way changing the pricing is a one-file
 * edit on each side instead of a grep-and-replace across the codebase.
 */

/** Credits granted to every new user (free signup, trial conversion, Google). */
export const INITIAL_USER_CREDITS = 200;

/** Credits charged per story page (1 page = 1 scene = 1 illustration). */
export const CREDITS_PER_PAGE = 10;

/** Credits charged to regenerate a single page image. Mirrors CREDIT_COSTS.IMAGE_REGENERATION on the server. */
export const IMAGE_REGENERATION_COST = 2;

/**
 * Example story length used in marketing copy like
 * "a 20-page story uses 200 credits". Keep in sync with EXAMPLE_STORY_CREDITS.
 */
export const EXAMPLE_STORY_PAGES = 20;
export const EXAMPLE_STORY_CREDITS = EXAMPLE_STORY_PAGES * CREDITS_PER_PAGE;

/**
 * Credit purchase packages.
 * Must mirror server/config/credits.js PRICING.PACKAGES.
 * Volume discount: 33¢/page → 25¢/page as pack size grows.
 */
export const CREDIT_PACKAGES = [
  { credits: 150,  priceCHF: 5,  label: 'Starter' },
  { credits: 350,  priceCHF: 10, label: 'Popular' },
  { credits: 750,  priceCHF: 20, label: 'Best Value' },
  { credits: 2000, priceCHF: 50, label: 'Pro' },
] as const;

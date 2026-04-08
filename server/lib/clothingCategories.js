/**
 * Clothing Categories — canonical normalizer.
 *
 * Single source of truth for mapping AI-produced clothing category strings
 * to one of 4 canonical buckets. Used on BOTH write and read sides of the
 * styled avatar cache so lookups are guaranteed to match regardless of
 * AI variability (case, language, costume subtype).
 *
 * Four buckets:
 *   - "standard"  — default everyday clothing
 *   - "winter"    — cold-weather variant
 *   - "summer"    — warm-weather variant
 *   - "costumed"  — story-specific outfit (costume subtype lives elsewhere)
 *
 * Tolerates:
 *   - Case variations: "Summer", "SUMMER" → "summer"
 *   - Language variants: "Sommer" (DE), "été" (FR), "verano" (ES) → "summer"
 *   - Costume subtypes: "costumed:pirate", "costumed:wizard" → "costumed"
 *   - Visual Bible bracket IDs: "[CLO001] costumed" → "costumed"
 *   - Leading/trailing whitespace
 *
 * Unknown strings fall through to "standard" — deterministic degradation
 * rather than a cache miss + face photo fallback.
 */

// Canonical buckets — the ONLY valid cache key values
const CANONICAL = Object.freeze(['standard', 'winter', 'summer', 'costumed']);

/**
 * Normalize any clothing category string to one of 4 canonical buckets.
 *
 * @param {string|null|undefined} category - Raw category from AI output
 * @returns {'standard'|'winter'|'summer'|'costumed'}
 */
function normalizeClothingCategory(category) {
  if (!category) return 'standard';

  // Strip Visual Bible bracket notation (e.g., "[CLO001] costumed" → "costumed")
  // then trim and lowercase for matching.
  const raw = String(category)
    .replace(/\s*\[[A-Za-z]+\d+\]\s*/g, '')
    .trim()
    .toLowerCase();

  if (!raw) return 'standard';

  // Costumed — any costume subtype (costumed:pirate, costumed:wizard)
  // plus language variants in German, French, Spanish.
  if (raw.startsWith('costumed') ||
      raw.startsWith('costume') ||
      raw.startsWith('kostüm') ||
      raw.startsWith('kostum') ||
      raw.startsWith('déguis') ||
      raw.startsWith('deguis') ||
      raw.startsWith('disfraz')) {
    return 'costumed';
  }

  // Winter — multi-language
  if (raw === 'winter' || raw === 'wintertime' ||
      raw === 'hiver' || raw === 'inverno' || raw === 'invierno') {
    return 'winter';
  }

  // Summer — multi-language
  if (raw === 'summer' || raw === 'summertime' ||
      raw === 'sommer' || raw === 'été' || raw === 'ete' ||
      raw === 'estate' || raw === 'verano') {
    return 'summer';
  }

  // Everything else (including unknown/typo) → standard
  return 'standard';
}

module.exports = {
  CANONICAL,
  normalizeClothingCategory,
};

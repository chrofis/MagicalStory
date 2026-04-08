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

/**
 * Get the list of clothing categories a character has marked `used: true` in
 * their clothingRequirements entry. Includes the costume name when present
 * (e.g. "costumed:pirate"). Case-insensitive character name lookup.
 *
 * @param {Object|null} clothingRequirements - The full clothingRequirements object from outline
 * @param {string} characterName - Character to look up
 * @returns {string[]} List of used categories (raw, not canonicalized — first one wins for substitution)
 */
function getUsedClothingCategories(clothingRequirements, characterName) {
  if (!clothingRequirements || !characterName) return [];
  // Case-insensitive lookup — Claude is inconsistent about character name casing
  const charNameLower = String(characterName).trim().toLowerCase();
  const charReqs = Object.entries(clothingRequirements).find(
    ([name]) => name.trim().toLowerCase() === charNameLower
  )?.[1];
  if (!charReqs || typeof charReqs !== 'object') return [];

  const used = [];
  for (const [category, config] of Object.entries(charReqs)) {
    if (!config || !config.used) continue;
    if (category === 'costumed' && config.costume) {
      used.push(`costumed:${String(config.costume).toLowerCase()}`);
    } else {
      used.push(category);
    }
  }
  return used;
}

/**
 * Reconcile cover hint character clothing against the story's clothingRequirements.
 *
 * Claude generates `clothingRequirements` (per-character used categories) and
 * `coverHints` (per-cover character clothing) independently, and the two can
 * disagree — e.g. Claude marks Sophie's clothingRequirements as
 * `{ costumed: { used: true, costume: 'zauberlehrling' } }` but writes the
 * back cover hint as `{ Sophie: 'standard' }`. That contradiction would force
 * us to either generate a never-otherwise-needed `standard` styled avatar for
 * Sophie (wasted work) or fall back to a raw face photo at render time
 * (ugly result).
 *
 * Resolution: when a cover hint requests a clothing category that the
 * character did NOT mark used, override it with the FIRST category they DID
 * mark used. This guarantees every cover-time avatar lookup hits a category
 * that was already pre-generated.
 *
 * Mutates `coverHints` in place.
 *
 * @param {Object|null} coverHints - { titlePage: { characterClothing }, initialPage: ..., backCover: ... }
 * @param {Object|null} clothingRequirements - From extractClothingRequirements()
 * @param {Object} [logger] - Optional logger for warning messages
 * @returns {{ overrides: Array<{cover, character, requested, replacedWith}> }}
 */
function reconcileCoverClothingWithRequirements(coverHints, clothingRequirements, logger = null) {
  const overrides = [];
  if (!coverHints || !clothingRequirements) return { overrides };

  for (const [coverType, hint] of Object.entries(coverHints)) {
    if (!hint || !hint.characterClothing || typeof hint.characterClothing !== 'object') continue;

    for (const [charName, requestedClothing] of Object.entries(hint.characterClothing)) {
      const usedCategories = getUsedClothingCategories(clothingRequirements, charName);
      if (usedCategories.length === 0) continue; // No requirements for this character — leave as-is

      // Compare requested vs used using canonical buckets so 'costumed:pirate'
      // and 'costumed' both count as a match.
      const requestedCanonical = normalizeClothingCategory(requestedClothing);
      const isUsed = usedCategories.some(
        (cat) => normalizeClothingCategory(cat) === requestedCanonical
      );

      if (!isUsed) {
        // Override with the first used category. We pick the first because
        // when a character has multiple used variants we have no further
        // signal — the cover hint clothing wasn't valid anyway.
        const replacement = usedCategories[0];
        hint.characterClothing[charName] = replacement;
        overrides.push({
          cover: coverType,
          character: charName,
          requested: requestedClothing,
          replacedWith: replacement,
        });
        if (logger?.warn) {
          logger.warn(
            `⚠️ [COVER RECONCILE] ${coverType}: ${charName} requested "${requestedClothing}" ` +
            `but only [${usedCategories.join(', ')}] are marked used — overriding to "${replacement}"`
          );
        }
      }
    }
  }

  return { overrides };
}

module.exports = {
  CANONICAL,
  normalizeClothingCategory,
  getUsedClothingCategories,
  reconcileCoverClothingWithRequirements,
};

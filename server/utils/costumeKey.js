/**
 * Shared costume cache-key slugify. The slug IS a cache key — its output must
 * stay byte-identical across the reader (compositeCastBuilder) and writer
 * (styledAvatars) or costumed sheets desync (regenerate / wrong clothing).
 */

/**
 * Slugify a costume string into a stable cache key.
 * @param {string} s
 * @returns {string}
 */
function slugifyCostume(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The ONE key a costume lives under in every `costumed: { <key>: … }` map —
 * styled avatars, clothing descriptions, cache slots. Derived from the
 * `costumed:<x>` label's colon part, else from the story's costume name, else
 * 'default'; always slugified. Writers and readers must both go through here:
 * measured 2026-09-13, `clothingCategories.js` lower-cased the label,
 * `clothingResolve.js` preserved case, and `entityConsistency.js` looked the
 * colon part up case-sensitively, so a costume written as "Zauberlehrling"
 * was missed by a lookup for "zauberlehrling" and the prompt fell back to
 * "costume as shown in reference" while a different styled sheet was attached.
 * @param {string|null|undefined} clothingCategory - 'costumed' | 'costumed:<x>' | anything else
 * @param {string|null|undefined} fallbackCostume - the story's costume name when the label is bare
 * @returns {string}
 */
function costumeSubKey(clothingCategory, fallbackCostume = null) {
  const cat = String(clothingCategory || '');
  const colon = cat.startsWith('costumed:') ? cat.slice('costumed:'.length) : '';
  return slugifyCostume(colon || fallbackCostume) || 'default';
}

/**
 * Read a costume out of a `costumed` map without knowing how the key was
 * written. Order: the canonical slug, then the raw colon part exactly as
 * labelled (stored data written before the slug was enforced), then — one
 * costume per character (Phase 5) — the first entry. Returns undefined for
 * a missing or non-object map so callers keep their own fallbacks.
 * @param {Object|null|undefined} map
 * @param {string|null|undefined} clothingCategory
 * @param {string|null|undefined} fallbackCostume
 */
function pickCostumed(map, clothingCategory, fallbackCostume = null) {
  if (!map || typeof map !== 'object') return undefined;
  const cat = String(clothingCategory || '');
  const raw = cat.startsWith('costumed:') ? cat.slice('costumed:'.length) : '';
  const slug = costumeSubKey(clothingCategory, fallbackCostume);
  if (map[slug] !== undefined) return map[slug];
  if (raw && map[raw] !== undefined) return map[raw];
  const first = Object.values(map).find(v => v !== undefined && v !== null);
  return first;
}

module.exports = { slugifyCostume, costumeSubKey, pickCostumed };

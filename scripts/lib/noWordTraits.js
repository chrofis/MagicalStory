'use strict';
/**
 * Stored trait values that are a typed "no" instead of the canonical sentinel 'none'
 * (bug glasses-nein-read-as-glasses, docs/decisions.md 2026-11-12).
 *
 * The NO_VALUES list is the ONLY place such a list is allowed: production code never reads
 * free text, and the character form now stores 'none' through a ja/nein switch. This module
 * exists for the data repairs of values written before that switch:
 *   scripts/admin/fix-glasses-no-words-2026-11-12.js   (characters table)
 *   scripts/admin/append-staging-versions-to-prod.js   (a story's own snapshot in stories.data)
 * The values are the distinct stored values found in production (2026-11-12) that mean "no":
 * only 'nein'. 'Brille', 'schwarze Brille', 'wears glasses' etc. mean YES and are left alone.
 */

const NO_VALUES = ['nein'];          // exact stored values meaning "no"
const FIELDS = ['glasses', 'other'];
const SENTINEL = 'none';

/**
 * Every `glasses` / `other` key anywhere under `root` whose value is a stored "no" word.
 * A story snapshot holds the trait in several places (characters[].physical,
 * avatars.extractedTraits, each page's sceneCharacters), so the walk is by key, not by path.
 *
 * @param {*} root
 * @returns {Array<{path:string, holder:object, key:string, from:string}>}
 */
function findNoWordFields(root) {
  const hits = [];
  const walk = (node, pth) => {
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      const p = Array.isArray(node) ? `${pth}[${k}]` : `${pth}.${k}`;
      if (typeof v === 'string') {
        if (FIELDS.includes(k) && NO_VALUES.includes(v)) hits.push({ path: p, holder: node, key: k, from: v });
      } else {
        walk(v, p);
      }
    }
  };
  walk(root, '');
  return hits;
}

/**
 * Set every hit of findNoWordFields to the sentinel, in place.
 * @returns {string[]} the paths changed
 */
function replaceNoWordFields(root) {
  const hits = findNoWordFields(root);
  for (const h of hits) h.holder[h.key] = SENTINEL;
  return hits.map((h) => h.path);
}

module.exports = { NO_VALUES, FIELDS, SENTINEL, findNoWordFields, replaceNoWordFields };

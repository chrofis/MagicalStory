/**
 * Story-scoped character avatars.
 *
 * The target architecture (see plans/story-scoped-avatars) is that every
 * reference image used during a story's generation is sourced from a
 * story-level 2×4 sheet stored at `story.data.characterAvatars[name].<key>`.
 * `<key>` is one of: `'costumed'`, `'styled-standard'`, `'styled-winter'`,
 * `'styled-summer'`. There is ONE `costumed` slot per character per story —
 * no `costumed:pirate` / `costumed:knight` subtype keying.
 *
 * Phase 1 of the migration adds a SHADOW WRITE: project the existing per-
 * character sheets/avatars at `character.avatars.styledAvatars[artStyle].*`
 * into a story-scoped object on the storyData blob, without touching any
 * read paths yet. Subsequent phases flip the readers over and then drop the
 * character-row source.
 */
'use strict';

/**
 * Pull a URL out of whatever shape the legacy code stored.
 *   - string: a data: URI or http(s) URL
 *   - object: { imageData, imageUrl, data, url } — pick the first that's a string
 *   - anything else: null
 */
function extractUrl(slot) {
  if (!slot) return null;
  if (typeof slot === 'string') return slot;
  if (typeof slot === 'object') {
    return slot.imageUrl || slot.imageData || slot.url || slot.data || null;
  }
  return null;
}

/**
 * Project per-character `avatars.styledAvatars[<artStyle>].*` into a story-
 * scoped object:
 *
 *   {
 *     Emma: {
 *       costumed:        '<url>',     // first costumed.<anyKey>
 *       'styled-standard': '<url>',   // .standard
 *       'styled-winter':   '<url>',   // .winter
 *       'styled-summer':   '<url>',   // .summer
 *     },
 *     Noah: { costumed: '<url>' },
 *   }
 *
 * Only keys with a resolvable URL are present in the output. Characters
 * with no styled avatars at all are omitted entirely (caller can fall
 * back to legacy character-row reads while Phase 1-2 ship additive).
 *
 * No mutation of the input characters.
 */
function projectStoryCharacterAvatars(characters, artStyle) {
  const out = {};
  if (!Array.isArray(characters) || !artStyle) return out;

  for (const char of characters) {
    if (!char || !char.name) continue;
    const styled = char.avatars?.styledAvatars?.[artStyle];
    if (!styled || typeof styled !== 'object') continue;

    const entry = {};

    // Costumed — collapse subtype keying to a single flat URL. Stories only
    // have one costume per character; if there are multiple costumed entries
    // we pick the first (alphabetical by key for determinism).
    if (styled.costumed && typeof styled.costumed === 'object') {
      const keys = Object.keys(styled.costumed).sort();
      for (const k of keys) {
        const url = extractUrl(styled.costumed[k]);
        if (url) {
          entry.costumed = url;
          break;
        }
      }
    } else {
      // Future shape (Phase 6+): styled.costumed is a flat string/object.
      const url = extractUrl(styled.costumed);
      if (url) entry.costumed = url;
    }

    // Non-costumed styled sheets (optional add-ons, "the character out of
    // costume in art style"). Each is keyed as `styled-<clothing>`.
    for (const clothing of ['standard', 'winter', 'summer']) {
      const url = extractUrl(styled[clothing]);
      if (url) entry[`styled-${clothing}`] = url;
    }

    if (Object.keys(entry).length > 0) {
      out[char.name] = entry;
    }
  }

  return out;
}

/**
 * Project per-character costume descriptions out of `clothingRequirements`
 * (the structure Sonnet emits during outline parsing — see
 * `prompts/story-unified.txt` for the `"costumed": { used, costume, description }`
 * spec) into a story-scoped map:
 *
 *   { Emma: 'burgundy frock coat with brass buttons, tricorn hat, red sash',
 *     Noah: '...', }
 *
 * Stored on `story.data.visualBible.costumes`. Stories have ONE costume per
 * character so we don't preserve the costume-type subkey (`pirate`, `knight`).
 * Characters with `costumed.used !== true` are omitted.
 */
function projectStoryCostumeDescriptions(clothingRequirements) {
  const out = {};
  if (!clothingRequirements || typeof clothingRequirements !== 'object') return out;
  for (const [charName, requirements] of Object.entries(clothingRequirements)) {
    const cc = requirements?.costumed;
    if (!cc || cc.used !== true) continue;
    const desc = (typeof cc.description === 'string' && cc.description.trim()) || null;
    if (!desc) continue;
    out[charName] = desc;
  }
  return out;
}

module.exports = {
  projectStoryCharacterAvatars,
  projectStoryCostumeDescriptions,
  extractUrl,
};

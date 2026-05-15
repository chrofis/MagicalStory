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

/**
 * Replace each character's full-image reference with a single body cell
 * cropped out of the story-scoped 2×4 sheet at
 * `story.data.characterAvatars[name][slotKey]`. Pose + flip come from the
 * scene-expansion metadata so the cell matches the figure's intended
 * facing direction on this page.
 *
 * Falls through silently when the story has no sheet for the character
 * (legacy stories pre-Phase-1, or characters with no costumed sheet).
 * Mutates the array elements in place AND returns the same array.
 *
 * @param {Array<Object>} referencePhotos - per-character refs with
 *   `name`, `photoUrl`, `clothingCategory` (mutated)
 * @param {Object} storyCharacterAvatars - story.data.characterAvatars blob
 * @param {Array<Object>} sceneCharacters - scene-expansion characters with
 *   `name`, `pose`, `flip`
 * @returns {Promise<Array<Object>>} the same array, with photoUrl swapped
 *   to data-URI cell crops where applicable.
 */
async function applyStoryCellRefs(referencePhotos, storyCharacterAvatars, sceneCharacters) {
  if (!Array.isArray(referencePhotos) || referencePhotos.length === 0) return referencePhotos;
  if (!storyCharacterAvatars || typeof storyCharacterAvatars !== 'object') return referencePhotos;
  const { cropAvatarCell } = require('./sceneComposite');

  const poseByName = new Map();
  for (const sc of (Array.isArray(sceneCharacters) ? sceneCharacters : [])) {
    const nm = (typeof sc === 'string' ? sc : sc?.name) || '';
    if (!nm) continue;
    const pose = (sc?.pose && ['front', 'threeQuarter', 'profile', 'back'].includes(sc.pose))
      ? sc.pose : 'threeQuarter';
    const flip = sc?.flip === true;
    poseByName.set(nm.toLowerCase(), { pose, flip });
  }

  for (const ref of referencePhotos) {
    const charName = ref?.name;
    if (!charName) continue;
    const story = storyCharacterAvatars[charName];
    if (!story) continue;
    const clothingRaw = String(ref.clothingCategory || '').toLowerCase();
    let slotKey;
    if (clothingRaw === 'costumed' || clothingRaw.startsWith('costumed:')) slotKey = 'costumed';
    else if (['standard', 'winter', 'summer'].includes(clothingRaw)) slotKey = `styled-${clothingRaw}`;
    else slotKey = 'costumed';
    const sheetUri = story[slotKey] || story.costumed;
    if (!sheetUri) continue;
    const pf = poseByName.get(charName.toLowerCase()) || { pose: 'threeQuarter', flip: false };
    try {
      const { body } = await cropAvatarCell(sheetUri, { pose: pf.pose, flip: pf.flip, includeFace: false });
      ref.photoUrl = `data:image/png;base64,${body.toString('base64')}`;
      ref.photoType = `cell-${pf.pose}${pf.flip ? '-flip' : ''}`;
      ref.cellPose = pf.pose;
      ref.cellFlip = pf.flip;
    } catch (err) {
      // Fall through to the existing full-image ref. Logged at debug level
      // by the caller if it tracks errors.
    }
  }
  return referencePhotos;
}

/**
 * Append one history entry per character to `character.avatars.storyHistory[]`.
 * Dev-only inspection log — never read by generation paths. Each entry is:
 *   { storyId, generatedAt, sheetKey, sheetUrl, costumeDescription, artStyle, language, title }
 *
 * Idempotent per (storyId, sheetKey) — if the entry already exists it's
 * skipped. Safe to call multiple times for the same story.
 *
 * @param {string} userId - story owner's user id (for the DB update query)
 * @param {Array<Object>} characters - inputData.characters[]
 * @param {Object} ctx - { storyId, artStyle, language, title }
 * @param {Object} storyCharacterAvatars - story.data.characterAvatars
 * @param {Object} costumeDescriptions - story.data.visualBible.costumes
 * @returns {Promise<number>} count of history entries actually appended
 */
async function appendStoryHistory(userId, characters, ctx, storyCharacterAvatars, costumeDescriptions) {
  if (!userId || !Array.isArray(characters) || !ctx?.storyId) return 0;
  if (!storyCharacterAvatars || typeof storyCharacterAvatars !== 'object') return 0;
  const { getDbPool } = require('../services/database');
  const pool = getDbPool();
  let appended = 0;
  const now = new Date().toISOString();
  for (const char of characters) {
    if (!char?.id || !char?.name) continue;
    const sheets = storyCharacterAvatars[char.name];
    if (!sheets || typeof sheets !== 'object') continue;
    const costumeDesc = (costumeDescriptions && costumeDescriptions[char.name]) || null;
    for (const [sheetKey, sheetUrl] of Object.entries(sheets)) {
      if (!sheetUrl) continue;
      const entry = {
        storyId: ctx.storyId,
        generatedAt: now,
        sheetKey,
        sheetUrl,
        costumeDescription: sheetKey === 'costumed' ? costumeDesc : null,
        artStyle: ctx.artStyle || null,
        language: ctx.language || null,
        title: ctx.title || null,
      };
      try {
        // Append idempotently — only push when no entry with the same
        // (storyId, sheetKey) already exists.
        const res = await pool.query(
          `UPDATE characters
           SET data = jsonb_set(
             data,
             '{avatars,storyHistory}',
             COALESCE(data -> 'avatars' -> 'storyHistory', '[]'::jsonb) || $2::jsonb,
             true
           )
           WHERE id = $1
             AND user_id = $3
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(data -> 'avatars' -> 'storyHistory', '[]'::jsonb)) e
               WHERE e->>'storyId' = $4 AND e->>'sheetKey' = $5
             )
           RETURNING id`,
          [char.id, JSON.stringify([entry]), userId, ctx.storyId, sheetKey]
        );
        if (res.rowCount > 0) appended++;
      } catch (err) {
        // Don't fail story completion if history write fails.
        // eslint-disable-next-line no-console
        console.warn(`[STORY-AVATAR-HISTORY] append failed for ${char.name}/${sheetKey}: ${err.message}`);
      }
    }
  }
  return appended;
}

module.exports = {
  projectStoryCharacterAvatars,
  projectStoryCostumeDescriptions,
  applyStoryCellRefs,
  appendStoryHistory,
  extractUrl,
};

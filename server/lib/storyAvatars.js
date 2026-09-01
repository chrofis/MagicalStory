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

const { log } = require('../utils/logger');

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
      if (!url) continue;
      entry[`styled-${clothing}`] = url;
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
/**
 * SINGLE resolver for which 2×4 sheet cell a scene character should get.
 * Beats metadata never carries `pose` — it declares `perspective` in natural
 * language ("back view", "profile"). Every cell-picker that read only `pose`
 * served the threeQuarter cell to ALL beats characters, including declared
 * back-view figures (job_1786571353564 p10: three back-view adults, all sent
 * threeQuarter refs). Used by applyStoryCellRefs, the iterate path
 * (images.js) and the regeneration route — never inline a copy.
 *
 * @param {Object|string} sc - scene-metadata character ({name, pose?, perspective?, depth?, flip?})
 * @returns {{pose: string, depth: string, flip: boolean}}
 */
function resolveCellPose(sc) {
  let pose = (sc?.pose && ['front', 'threeQuarter', 'profile', 'back'].includes(sc.pose))
    ? sc.pose : null;
  if (!pose && sc?.perspective) {
    const persp = String(sc.perspective).toLowerCase();
    if (/\bback\b|behind/.test(persp)) pose = 'back';
    else if (/profile|side/.test(persp)) pose = 'profile';
    else if (/front|camera/.test(persp)) pose = 'front';
  }
  if (!pose) pose = 'threeQuarter';
  const depth = (sc?.depth && ['foreground', 'midground', 'background'].includes(sc.depth))
    ? sc.depth : 'foreground';
  return { pose, depth, flip: sc?.flip === true };
}

/**
 * SINGLE resolver for "which stored image does this reference get, is it a
 * 2×4 sheet, and what is it actually wearing?"
 *
 * Three call sites crop cells (applyStoryCellRefs here, the iterate path in
 * images.js, the regeneration route) and each had its own inline copy of the
 * slot-key mapping. They drifted: only this one warned about the costumed
 * fallback and corrected the ref's label, so the other two could silently
 * render a `standard` page in costume — the bug this resolver exists to make
 * impossible. Never inline a fourth copy.
 *
 * Mutates `ref.clothingCategory` when it falls back, so the reference always
 * reports the clothing it actually carries.
 *
 * @param {Object} story - one character's entry from story.data.characterAvatars
 * @param {Object} ref - reference photo ({ name, clothingCategory, ... })
 * @returns {{uri: string, slotKey: string}|null} null when
 *   the character has nothing usable stored.
 */
function resolveSheetForRef(story, ref) {
  if (!story || !ref) return null;
  const clothingRaw = String(ref.clothingCategory || '').toLowerCase();
  let slotKey;
  if (clothingRaw.startsWith('costumed')) slotKey = 'costumed';
  else if (['standard', 'winter', 'summer'].includes(clothingRaw)) slotKey = `styled-${clothingRaw}`;
  else slotKey = 'costumed';

  let uri = story[slotKey];
  // NEVER swap clothing silently. Falling back to the costumed sheet while
  // keeping the ref's `standard` label is how a page the outline marked
  // standard was rendered in costume, invisibly, for three runs
  // (job_1786826686448 p1). The fallback stays — a reference beats none —
  // but it says so, and the ref carries the category actually sent.
  if (!uri && story.costumed) {
    log.warn(`👕 [STORY-CELLS] ${ref.name || '?'}: no "${slotKey}" entry — falling back to the costumed sheet (ref asked for "${clothingRaw || 'none'}")`);
    uri = story.costumed;
    ref.clothingCategory = 'costumed';
    slotKey = 'costumed';
  }
  if (!uri) return null;

  return { uri, slotKey };
}

async function applyStoryCellRefs(referencePhotos, storyCharacterAvatars, sceneCharacters, opts = {}) {
  if (!Array.isArray(referencePhotos) || referencePhotos.length === 0) return referencePhotos;
  if (!storyCharacterAvatars || typeof storyCharacterAvatars !== 'object') return referencePhotos;
  // opts.closeUp: the page's shot is a close-up — send face cell + head of the
  // costumed body cell (headwear survives) instead of the full-body stack. A
  // full-body ref pulls the render toward full-figure poses on close-up pages.
  const closeUp = opts.closeUp === true;
  const { cropAvatarCell } = require('./sceneComposite');

  const poseByName = new Map();
  for (const sc of (Array.isArray(sceneCharacters) ? sceneCharacters : [])) {
    const nm = (typeof sc === 'string' ? sc : sc?.name) || '';
    if (!nm) continue;
    poseByName.set(nm.toLowerCase(), resolveCellPose(sc));
  }

  for (const ref of referencePhotos) {
    const charName = ref?.name;
    if (!charName) continue;
    const story = storyCharacterAvatars[charName];
    // Both of these used to `continue` in silence, which is how a page could
    // ship the WHOLE 2×4 sheet as its reference and leave no trace of why.
    // Same reason the crop-failure catch below is loud: a fallback nobody can
    // see is a fallback nobody fixes.
    if (!story) {
      log.warn(`[CELL REFS] ${charName}: no story sheet available yet (have: ${Object.keys(storyCharacterAvatars).join(', ') || 'none'}) — sending the FULL reference image instead of a pose cell`);
      continue;
    }
    const resolved = resolveSheetForRef(story, ref);
    if (!resolved) {
      log.warn(`[CELL REFS] ${charName}: no usable sheet for clothing "${ref.clothingCategory || 'none'}" (slots: ${Object.keys(story).join(', ')}) — sending the FULL reference image instead of a pose cell`);
      continue;
    }
    const { uri: sheetUri, slotKey } = resolved;
    const pf = poseByName.get(charName.toLowerCase()) || { pose: 'threeQuarter', depth: 'foreground' };
    // Foreground → stack head + body into one ref (canvas-large faces need
    // a tight head anchor). Midground / background → body cell only.
    const includeFace = pf.depth === 'foreground';
    try {
      const headOnly = closeUp && includeFace;
      const { body, stacked } = await cropAvatarCell(sheetUri, { pose: pf.pose, includeFace, stack: includeFace, headOnly });
      const buf = stacked || body;
      ref.photoUrl = `data:image/png;base64,${buf.toString('base64')}`;
      ref.photoType = `cell-${pf.pose}${headOnly ? '-costumedHead' : (includeFace ? '-headbody' : '')}`;
      ref.cellPose = pf.pose;
      ref.cellDepth = pf.depth;
      ref.cellIncludesFace = includeFace;
    } catch (err) {
      // Fall through to the existing full-image ref — but never silently:
      // this catch swallowed the R2-URL base64-garbage bug for every
      // DB-reloaded story until it was made loud.
      log.warn(`[CELL REFS] crop failed for ${charName} (${slotKey}): ${err.message} — falling back to full-image ref`);
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
/**
 * Put an avatar sheet in R2 and return its URL.
 *
 * A value that is already a URL passes straight through — this runs on every
 * append and must be idempotent. Bytes are uploaded; there is no third option,
 * because storing them in characters.data is the defect this exists to close.
 * A failed upload returns null and the history entry is SKIPPED rather than
 * written with base64 in a field named sheetUrl.
 */
async function sheetToR2(sheet, userId, charId, storyId, sheetKey) {
  if (typeof sheet !== 'string' || !sheet) return null;
  if (/^https?:\/\//.test(sheet)) return sheet;                    // already offloaded
  const looksLikeBytes = sheet.startsWith('data:image/') || sheet.startsWith('/9j/')
    || sheet.startsWith('iVBORw0') || sheet.startsWith('R0lGOD') || sheet.startsWith('UklGR');
  if (!looksLikeBytes) return sheet;
  const r2 = require('./r2');
  if (!r2.isConfigured()) {
    log.error('[STORY-AVATAR-HISTORY] R2 not configured — refusing to store sheet bytes in JSONB');
    return null;
  }
  const safe = (v) => String(v).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  const key = `characters/${safe(userId)}/${safe(charId)}/story-sheets/${safe(storyId)}-${safe(sheetKey)}.jpg`;
  try {
    return await r2.uploadImage(sheet, key);
  } catch (err) {
    log.error(`[STORY-AVATAR-HISTORY] R2 upload failed for ${key}: ${err.message}`);
    return null;
  }
}

async function appendStoryHistory(userId, characters, ctx, storyCharacterAvatars, costumeDescriptions) {
  if (!userId || !Array.isArray(characters) || !ctx?.storyId) {
    console.warn(`[STORY-AVATAR-HISTORY] precondition fail userId=${!!userId} chars=${characters?.length} storyId=${ctx?.storyId}`);
    return 0;
  }
  if (!storyCharacterAvatars || typeof storyCharacterAvatars !== 'object') {
    console.warn(`[STORY-AVATAR-HISTORY] no storyCharacterAvatars`);
    return 0;
  }
  const { getPool, dbQuery } = require('../services/database');
  const pool = getPool();
  if (!pool) {
    console.warn(`[STORY-AVATAR-HISTORY] getPool() returned null`);
    return 0;
  }

  // The characters table layout: ONE row per user, id = `characters_<userId>`,
  // and `data.characters[]` is the array of character objects. Each character
  // has its own numeric id WITHIN that array. To target a character we need
  // the array index — fetch the row, find the index, then jsonb_set both
  // columns at path {characters, <idx>, avatars, storyHistory}.
  const rowId = `characters_${userId}`;
  let rowChars = [];
  try {
    const rowRes = await dbQuery(`SELECT data FROM characters WHERE id = $1`, [rowId]);
    if (rowRes.length === 0) {
      console.warn(`[STORY-AVATAR-HISTORY] no row for ${rowId}`);
      return 0;
    }
    rowChars = rowRes[0].data?.characters || [];
  } catch (err) {
    console.warn(`[STORY-AVATAR-HISTORY] row fetch failed: ${err.message}`);
    return 0;
  }

  let appended = 0;
  let triedQueries = 0;
  const now = new Date().toISOString();
  for (const char of characters) {
    if (!char?.id || !char?.name) continue;
    const sheets = storyCharacterAvatars[char.name];
    if (!sheets || typeof sheets !== 'object') continue;
    const charIndex = rowChars.findIndex(c => String(c.id) === String(char.id));
    if (charIndex < 0) {
      console.warn(`[STORY-AVATAR-HISTORY] char ${char.name}(id=${char.id}) not in row ${rowId}`);
      continue;
    }
    const costumeDesc = (costumeDescriptions && costumeDescriptions[char.name]) || null;
    for (const [sheetKey, rawSheet] of Object.entries(sheets)) {
      if (!rawSheet) continue;
      // `storyCharacterAvatars` hands us the sheet as BYTES, and this field is
      // named sheetUrl — so the base64 went straight into characters.data and
      // stayed there. Measured 2026-09-01: storyHistory[].sheetUrl was the
      // single largest inline payload on prod (10.3 MB across 4 sampled rows).
      // R2 is the only store for image bytes; a URL is what this field means.
      const sheetUrl = await sheetToR2(rawSheet, userId, char.id, ctx.storyId, sheetKey);
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
        triedQueries++;
        // Path = data.characters[idx].avatars.storyHistory. We update both
        // columns (data has everything; metadata is the light copy served
        // by GET /api/characters and read by the dev panel).
        const idxStr = String(charIndex);
        const AVATARS_PATH = ['characters', idxStr, 'avatars'];
        const HISTORY_PATH = [...AVATARS_PATH, 'storyHistory'];
        // Ensure parent {characters, idx, avatars} exists so jsonb_set's
        // create_missing for the leaf works. Idempotent.
        for (const col of ['data', 'metadata']) {
          await pool.query(
            `UPDATE characters SET ${col} = jsonb_set(${col}, $2::text[], COALESCE(${col} #> $2::text[], '{}'::jsonb), true) WHERE id = $1`,
            [rowId, AVATARS_PATH]
          );
        }
        // Append idempotently — if an entry with this (storyId, sheetKey)
        // already exists, skip. Otherwise jsonb_set replaces the array
        // with the existing array || new entry.
        const idempotentSql = (col) => `
          UPDATE characters
          SET ${col} = jsonb_set(
            ${col},
            $2::text[],
            COALESCE(${col} #> $2::text[], '[]'::jsonb) || $3::jsonb,
            true
          )
          WHERE id = $1
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(${col} #> $2::text[], '[]'::jsonb)) e
              WHERE e->>'storyId' = $4 AND e->>'sheetKey' = $5
            )
          RETURNING id`;
        const params = [rowId, HISTORY_PATH, JSON.stringify([entry]), ctx.storyId, sheetKey];
        const resData = await pool.query(idempotentSql('data'), params);
        const resMeta = await pool.query(idempotentSql('metadata'), params);
        if (resData.rowCount > 0 || resMeta.rowCount > 0) appended++;
        if (resData.rowCount === 0 && resMeta.rowCount === 0) {
          console.warn(`[STORY-AVATAR-HISTORY] 0 rows for ${char.name}@${idxStr}/${sheetKey} (already exists?)`);
        }
      } catch (err) {
        console.warn(`[STORY-AVATAR-HISTORY] append failed for ${char.name}/${sheetKey}: ${err.message}`);
      }
    }
  }
  console.log(`[STORY-AVATAR-HISTORY] story=${ctx.storyId} chars=${characters.length} tried=${triedQueries} appended=${appended}`);
  return appended;
}

module.exports = {
  projectStoryCharacterAvatars,
  projectStoryCostumeDescriptions,
  applyStoryCellRefs,
  resolveCellPose,
  resolveSheetForRef,
  appendStoryHistory,
  extractUrl,
};

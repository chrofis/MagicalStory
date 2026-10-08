/**
 * Hair follows the approved avatar (owner decision 2026-10-08, docs/decisions.md
 * "Hair text follows the approved avatar").
 *
 * `physical.detailedHairAnalysis` is the ONE field every prompt, sheet judge,
 * cover and consistency judge reads (buildHairDescription / hairRequest). It used
 * to be the photo's reading, so a photo that hid or posed the hair (Fiona: a
 * headband photo read "neck-length, brushed back", her avatars show long hair
 * worn down) put text and picture in disagreement on every page. Now:
 *
 *   - routes/avatars.js (a new avatar): once the retries have settled which avatar
 *     is kept, ONE read of it (readAvatarHair) replaces the photo's reading.
 *   - ensureAvatarDerivedHair() (a character whose hair is still the photo's
 *     reading: every character made before this decision, and a trial character):
 *     the same ONE read of the stored avatar, persisted, so a character is read
 *     once for every later story.
 *
 * ORDER (circularity): the text is derived from the permanent avatar (or, for a
 * trial character, the preview avatar the visitor approved), BEFORE any story
 * sheet exists. The sheet judges then compare a sheet against text that came from
 * a different image, never against a reading of that same sheet. The photo
 * reading stays stored as `physical.photoHairAnalysis` (audit only, no prompt reads it).
 */
const { log } = require('../utils/logger');

const HAIR_SOURCE_AVATAR = 'avatar';
const AVATAR_CATEGORY_ORDER = ['standard', 'summer', 'winter'];

/**
 * The avatar job's extraction result, once the retries have settled which avatar is kept: ONE read of
 * that avatar (standard first, else summer, winter) replaces the photo's reading in extractedTraits, and
 * `hairFromAvatar` says so (the DB write stamps the source map from it). No readable avatar or a failed
 * read: the photo's reading stays, unstamped, and the failure is logged (ensureAvatarDerivedHair retries
 * from the stored avatar at the next story).
 */
async function applyAvatarHairToExtraction(results, { usageTracker = null, reader = readHairFromAvatar } = {}) {
  if (!results?.extractedTraits) return;
  const image = AVATAR_CATEGORY_ORDER.map(c => results[c]).find(v => typeof v === 'string' && v.startsWith('data:image'));
  let hair = null;
  if (image) {
    try { hair = await reader(image, usageTracker); } catch (e) { log.error(`[AVATAR HAIR] avatar hair read failed: ${e.message}`); }
  }
  if (hair) {
    results.extractedTraits.detailedHairAnalysis = hair;
    results.hairFromAvatar = true;
    return;
  }
  log.error('[AVATAR HAIR] no avatar hair reading — the photo reading is kept unstamped');
  results.hairFromAvatar = false;
  if (results.photoHairAnalysis) results.extractedTraits.detailedHairAnalysis = results.photoHairAnalysis;
}

/** True when this character's hair text is still the photo's reading and may be re-derived. */
function needsAvatarHair(character) {
  const src = character?.physicalTraitsSource || {};
  if (src.detailedHairAnalysis === HAIR_SOURCE_AVATAR) return false;
  // A value the user typed in the character form wins over any reading (routes/avatars.js has always said so).
  if (src.detailedHairAnalysis === 'user' || src.hairType === 'user') return false;
  return true;
}

/**
 * Put an avatar reading on a character: the photo reading moves to photoHairAnalysis (kept once,
 * never overwritten by a later reading), the avatar reading becomes detailedHairAnalysis, the source
 * map says so. Returns the patch ({ physical, physicalTraitsSource }) for a database merge.
 */
function applyAvatarHair(character, avatarHair) {
  if (!avatarHair || typeof avatarHair !== 'object') throw new Error('applyAvatarHair: no avatar hair reading');
  const physical = character.physical || (character.physical = {});
  const sources = character.physicalTraitsSource || (character.physicalTraitsSource = {});
  const patch = { physical: {}, physicalTraitsSource: { detailedHairAnalysis: HAIR_SOURCE_AVATAR } };
  if (sources.detailedHairAnalysis !== HAIR_SOURCE_AVATAR && physical.detailedHairAnalysis && !physical.photoHairAnalysis) {
    physical.photoHairAnalysis = physical.detailedHairAnalysis;
    patch.physical.photoHairAnalysis = physical.photoHairAnalysis;
  }
  physical.detailedHairAnalysis = avatarHair;
  patch.physical.detailedHairAnalysis = avatarHair;
  sources.detailedHairAnalysis = HAIR_SOURCE_AVATAR;
  return patch;
}

/** The avatar image to read: the permanent standard avatar, else a trial character's approved preview. */
async function resolveAvatarImage(character) {
  const { resolveAvatarBytes } = require('./styledAvatars');
  const standard = await resolveAvatarBytes(character.avatars || character.clothingAvatars, 'standard');
  if (standard) return standard;
  const preview = character.previewAvatar;
  return typeof preview === 'string' && preview.startsWith('data:image') ? preview : null;
}

/** ONE vision read of the hair on an avatar image (character2x4Sheet.readAvatarHair, prompts/avatar-hair-read.txt). */
async function readHairFromAvatar(imageDataUri, usageTracker = null) {
  const { readAvatarHair } = require('./character2x4Sheet');
  const { hair, seen } = await readAvatarHair(imageDataUri, { usageTracker });
  if (seen) log.debug(`[AVATAR HAIR] read: ${seen}`);
  return hair && typeof hair === 'object' && hair.lengthTop ? hair : null;
}

const inFlight = new Map(); // character id/name -> Promise, so two stages starting together read once

/**
 * Re-derive the hair text of every character whose hair is still the photo's reading, from its
 * approved avatar. Mutates the character objects; persists to the characters row when `userId` is given.
 * A character with no avatar, or whose read fails, keeps what it has and is logged loudly: the
 * next story retries it (the source map is only stamped on success).
 */
async function ensureAvatarDerivedHair(characters, { userId = null, usageTracker = null, reader = readHairFromAvatar } = {}) {
  const results = [];
  await Promise.all((characters || []).filter(c => c && needsAvatarHair(c)).map(async (character) => {
    const key = `${userId || ''}:${character.id || character.name}`;
    if (!inFlight.has(key)) {
      inFlight.set(key, (async () => {
        try {
          const image = await resolveAvatarImage(character);
          if (!image) { log.warn(`[AVATAR HAIR] ${character.name}: no avatar to read hair from — keeping the stored hair text`); return null; }
          const hair = await reader(image, usageTracker);
          if (!hair) { log.error(`[AVATAR HAIR] ${character.name}: the avatar hair read returned nothing — keeping the stored hair text`); return null; }
          const before = character.physical?.detailedHairAnalysis || null;
          const patch = applyAvatarHair(character, hair);
          if (userId && character.id != null) await persistAvatarHair(userId, character, patch);
          log.info(`[AVATAR HAIR] ${character.name}: hair text now read from the avatar (was ${before ? `${before.lengthTop}, ${before.styling}` : 'none'}; now ${hair.lengthTop}, ${hair.styling})`);
          return { name: character.name, before, after: hair };
        } catch (e) {
          log.error(`[AVATAR HAIR] ${character.name}: ${e.message} — keeping the stored hair text`);
          return null;
        } finally {
          inFlight.delete(key);
        }
      })());
    }
    const r = await inFlight.get(key);
    if (r) results.push(r);
  }));
  return results;
}

// The characters table: ONE row per user (`characters_<userId>`), data.characters[] holds the characters
// (the same layout storyAvatars.appendStoryHistory writes to). Merge only the hair fields, in both columns.
async function persistAvatarHair(userId, character, patch) {
  const { getPool } = require('../services/database');
  const pool = getPool();
  if (!pool) throw new Error('no database pool');
  const rowId = `characters_${userId}`;
  const row = await pool.query('SELECT data FROM characters WHERE id = $1', [rowId]);
  const chars = row.rows[0]?.data?.characters || [];
  const idx = chars.findIndex(c => String(c.id) === String(character.id));
  if (idx < 0) { log.warn(`[AVATAR HAIR] ${character.name} (id ${character.id}) not in ${rowId} — hair text not persisted`); return; }
  for (const col of ['data', 'metadata']) {
    await pool.query(
      `UPDATE characters SET ${col} = jsonb_set(jsonb_set(${col}, $2::text[], COALESCE(${col} #> $2::text[], '{}'::jsonb) || $3::jsonb, true), $4::text[], COALESCE(${col} #> $4::text[], '{}'::jsonb) || $5::jsonb, true) WHERE id = $1`,
      [rowId, ['characters', String(idx), 'physical'], JSON.stringify(patch.physical), ['characters', String(idx), 'physicalTraitsSource'], JSON.stringify(patch.physicalTraitsSource)]
    );
  }
}

module.exports = { HAIR_SOURCE_AVATAR, applyAvatarHairToExtraction, needsAvatarHair, applyAvatarHair, readHairFromAvatar, ensureAvatarDerivedHair, resolveAvatarImage };

/**
 * The face + body cut-outs the Grok 2 avatar sheet call needs as input
 * (MODEL_DEFAULTS.avatarSheetReferences 'face+body', docs/decisions.md 2026-10-10).
 *
 * A character stored with only its original photo (7 of 220 prod characters on 2026-10-11) used to
 * fail the story 68 minutes in, after the writer and every page, when the costume sheet threw
 * "has no body photo". This produces the missing input ONCE at job start with the SAME analyzer
 * call the upload route makes (POST /analyze), persists it (R2 URLs, never JSONB bytes), and
 * fails the job AT ONCE when it cannot be produced. No fallback to a face-only sheet.
 */
const { log } = require('../utils/logger');
const r2 = require('./r2');
const { analyzerJson, reportAnalyzerFailure } = require('./photoAnalyzerClient');

class CharacterInputError extends Error {
  constructor(characterName, reason) {
    super(`The photo of ${characterName} cannot be used to create the story: ${reason}`);
    this.name = 'CharacterInputError';
    this.characterName = characterName;
  }
}

const hasCutout = (c) => !!(c?.photos?.bodyNoBg || c?.photos?.body);

async function persist(userId, character) {
  const { modifyCharactersRow } = require('../services/database');
  await modifyCharactersRow(`characters_${userId}`, userId, (data) => {
    const stored = (data.characters || []).find(c => String(c.id) === String(character.id));
    if (!stored) return false;
    stored.photos = { ...(stored.photos || {}), ...character.photos };
    return true;
  });
}

/** Derive and attach photos.face/body/bodyNoBg for every character that has only an original photo. Throws CharacterInputError. */
async function ensureCharacterCutouts(characters, { userId = null, analyze = analyzerJson, genLog = null } = {}) {
  for (const character of (characters || [])) {
    if (!character || hasCutout(character)) continue;
    const name = character.name || 'a character';
    const original = character.photos?.original;
    const bytes = original ? await r2.bytesFromAnyImage(original).catch(() => null) : null;
    if (!bytes) throw new CharacterInputError(name, 'no photo is stored for this character');
    let a;
    try {
      a = await analyze('/analyze', { image: `data:image/jpeg;base64,${bytes.toString('base64')}`, selected_face_id: null, cached_faces: null }, { timeoutMs: 90_000 });
    } catch (e) {
      reportAnalyzerFailure('[CUTOUT]', e, { severity: 'customer', userId });
      throw new CharacterInputError(name, e.message);
    }
    if (a.multiple_faces_detected) throw new CharacterInputError(name, `${a.face_count} faces found, the photo must be uploaded again with one face chosen`);
    const face = a.face_thumbnail || a.faceThumbnail;
    const body = a.body_crop || a.bodyCrop;
    const bodyNoBg = a.body_no_bg || a.bodyNoBg;
    if (!bodyNoBg && !body) throw new CharacterInputError(name, 'no body was found in the photo');
    const photos = { ...character.photos, face: face || character.photos.face || null, body: body || null, bodyNoBg: bodyNoBg || null };
    if (userId && character.id != null) {
      const { uploadCharacterPhotosToR2 } = require('../services/database');
      await uploadCharacterPhotosToR2(userId, character.id, photos);
      character.photos = photos;
      await persist(userId, character);
    } else {
      character.photos = photos;
    }
    const msg = `${name}: derived face/body cut-outs from the original photo${userId ? ' and stored them' : ''}`;
    log.info(`[CUTOUT] ${msg}`);
    // The story's own log, so a reviewer of the stored story sees the derivation (prod showcase 2026-10-12 had it only in Railway).
    genLog?.info('character_cutout_derived', msg, name);
  }
}

module.exports = { ensureCharacterCutouts, CharacterInputError, hasCutout };

/**
 * The trial's prepared avatar sheets: how they are styled, persisted, merged and reused.
 *
 * A trial has two styled 2x4 sheets, a STANDARD one (everyday clothes) and a COSTUMED one (the story's
 * costume). Both are made before the story job needs them, by two background endpoints in
 * routes/trial.js, and persisted on the character row (`preGeneratedStyledAvatars`):
 *
 *   - POST /api/trial/prepare-standard-avatar starts the moment the form is filled (photo, age and
 *     gender are all it needs) and styles the STANDARD sheet.
 *   - POST /api/trial/prepare-title starts when the story ideas are shown (the topic picks the costume)
 *     and styles the COSTUMED sheet.
 *
 * The story job reuses both (storyJobPipeline.runTrialEarlyStyling) and awaits whichever is still in flight, so
 * no sheet is ever styled twice. docs/decisions.md 2026-10-09 "Trial: the standard avatar sheet starts at the
 * form, the preview avatar is gone".
 *
 * Both endpoints write the same row concurrently, so the persisted shape is MERGED per sheet under the row
 * lock, and the waiting-page slides are rebuilt from whatever the row holds, written only if the row still
 * holds exactly those sheets (see persistPreparedSheets).
 */
const { log: defaultLog } = require('../utils/logger');
const { writeCutSlides } = require('./clientAvatarImages');

/** The one art style of a trial (routes/trial.js re-exports it as TRIAL_ART_STYLE). */
const TRIAL_ART_STYLE = 'watercolor';

/**
 * What the standard sheet (and the body row drawn ahead of it) was drawn FOR: the gender, and nothing else. The body row is
 * drawn at the photo from the photo's own estimates before the visitor has typed anything; the owner's rule (2026-10-09:
 * "don't throw the images for trials, just keep them") is that a trial keeps what was drawn when the declared age lands in
 * another band or phantom tier, so the age is NOT part of the stamp. A gender change redraws: the figure, hair and clothes
 * are cut differently. A sheet whose stamp differs from the declared gender is stale and is not reused
 * (docs/decisions.md 2026-10-09 "Trial keeps the drawn body row"; it replaces the band/tier clause of the body-row entry).
 */
function standardSheetStamp(character) {
  return `gender:${character?.gender || ''}`;
}

/** Declared ages up to this keep the drawn body row whatever the gender (owner 2026-10-09: "gender redraws if age is more than 2"). */
const GENDER_KEEP_MAX_AGE = 2;

/**
 * THE rule for reusing something drawn under `drawnStamp` (the body row, the standard sheet): it is kept when the stamp equals
 * the declared one, or when the declared age is 2 or under (a baby's gender barely shows in the figure). Otherwise a gender
 * change redraws. Used by prepare-standard-avatar, the PATCH measurement log and usablePreparedAvatars.
 */
function keepsDrawnBody(drawnStamp, character) {
  if (drawnStamp === standardSheetStamp(character)) return true;
  const age = parseInt(character?.age, 10);
  return Number.isFinite(age) && age <= GENDER_KEEP_MAX_AGE;
}

/**
 * The persisted sheets a story job may seed, from one character-row object. The standard sheet is dropped
 * (loudly) when it was drawn for another age/gender than the row holds now; the job then styles it itself.
 */
function usablePreparedAvatars(character, log = defaultLog) {
  const prepared = character?.preGeneratedStyledAvatars;
  if (!prepared || typeof prepared !== 'object') return null;
  const current = standardSheetStamp(character);
  const out = {};
  for (const [name, avatars] of Object.entries(prepared)) {
    const { standard, ...rest } = avatars || {};
    out[name] = rest;
    if (!standard) continue;
    if (keepsDrawnBody(character.preGeneratedStandardFor, character)) {
      out[name].standard = standard;
    } else {
      log.error(`❌ [TRIAL] The prepared standard sheet of ${name} was drawn for "${character.preGeneratedStandardFor}" but the row now says "${current}" — it is not reused`);
    }
  }
  return out;
}

/** Merge two persisted sheet maps ({ name: { standard, costumed: { key: sheet } } }); the second wins per sheet. */
function mergePreparedAvatars(existing, incoming) {
  const out = { ...(existing || {}) };
  for (const [name, avatars] of Object.entries(incoming || {})) {
    const before = out[name] || {};
    const merged = { ...before, ...avatars };
    if (before.costumed || avatars.costumed) merged.costumed = { ...(before.costumed || {}), ...(avatars.costumed || {}) };
    out[name] = merged;
  }
  return out;
}

/** Keep, per character, only the sheets a request asked for (the scope cache may hold more). */
function onlyRequestedSheets(exported, requirements) {
  const wantsCostumed = requirements.some(r => String(r.clothingCategory).startsWith('costumed'));
  const wanted = new Set(requirements.map(r => String(r.clothingCategory)).filter(c => !c.startsWith('costumed')));
  const out = {};
  for (const [name, avatars] of Object.entries(exported || {})) {
    const kept = {};
    for (const [key, value] of Object.entries(avatars || {})) {
      if (key === 'costumed' ? wantsCostumed : wanted.has(key)) kept[key] = value;
    }
    if (Object.keys(kept).length > 0) out[name] = kept;
  }
  return out;
}

/** Which sheets one character holds, as a comparable string. */
function sheetSignature(avatars) {
  const parts = [];
  for (const [key, value] of Object.entries(avatars || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (key === 'costumed' && value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) parts.push(`costumed.${k}=${String(v).slice(-48)}`);
    } else {
      parts.push(`${key}=${String(value).slice(-48)}`);
    }
  }
  return parts.join('|');
}

function defaultDeps() {
  const database = require('../services/database');
  return {
    offload: database.offloadCharacterImages,
    modifyRow: database.modifyCharactersRow,
    readCharacter: async (characterId) => {
      const res = await database.getPool().query('SELECT data FROM characters WHERE id = $1', [characterId]);
      if (res.rows.length === 0) return null;
      const data = typeof res.rows[0].data === 'string' ? JSON.parse(res.rows[0].data) : res.rows[0].data;
      return data.characters?.[0] || null;
    },
    storeSlides: (...a) => require('./avatarSlides').storeSlides(...a),
    buildSlides: (sheets) => require('./avatarSlides').buildAvatarSlides(sheets),
  };
}

const MAX_SLIDE_ATTEMPTS = 3;

/**
 * Persist freshly styled sheets and the waiting-page slides cut from EVERY sheet the row then holds.
 *
 * 1. the sheets are merged into the row under its lock (a concurrent endpoint's sheet is kept);
 *    `fields` are extra character-row fields set in the same write (the standard endpoint records what the
 *    standard sheet was drawn for, prepare-title the costume type);
 * 2. the slides are cut from the sheets the row holds NOW, and written only if the row still holds
 *    exactly those sheets — otherwise the other endpoint landed meanwhile and the cut is redone,
 *    so the last writer never leaves slides that lack the other sheet.
 *
 * @returns {Promise<string[]>} the slides as stored (R2 URLs)
 */
async function persistPreparedSheets({ userId, characterId, exported, fields = {} }, deps = defaultDeps(), log = defaultLog) {
  const names = Object.keys(exported || {});
  if (names.length !== 1) throw new Error(`persistPreparedSheets: exactly one character expected, got ${names.length}`);
  const name = names[0];

  const fragment = { preGeneratedStyledAvatars: exported };
  await deps.offload(characterId, userId, fragment);
  // The sheets are stored under the row's CURRENT name: the visitor may have renamed the (provisional) character while the
  // sheet was being drawn, and the story job looks the sheets up by the row's name.
  let rowName = name;
  const saved = await deps.modifyRow(characterId, userId, (fresh) => {
    const c = fresh.characters?.[0];
    if (!c) return false;
    rowName = c.name || name;
    c.preGeneratedStyledAvatars = mergePreparedAvatars(c.preGeneratedStyledAvatars, { [rowName]: fragment.preGeneratedStyledAvatars[name] });
    Object.assign(c, fields);
  });
  if (!saved) throw new Error(`persistPreparedSheets: character row ${characterId} is gone`);

  for (let attempt = 1; attempt <= MAX_SLIDE_ATTEMPTS; attempt++) {
    const character = await deps.readCharacter(characterId);
    const sheets = character?.preGeneratedStyledAvatars?.[rowName];
    if (!sheets) throw new Error(`persistPreparedSheets: ${rowName} has no sheets on ${characterId} after the merge`);
    const signature = sheetSignature(sheets);
    const slides = await deps.buildSlides(sheets);
    if (slides.length === 0) throw new Error('persistPreparedSheets: no sheet could be cut into slides');
    const storedSlides = await deps.storeSlides(characterId, userId, slides);
    let written = false;
    let attestedSlides = null;
    await deps.modifyRow(characterId, userId, (fresh) => {
      const c = fresh.characters?.[0];
      if (!c || sheetSignature(c.preGeneratedStyledAvatars?.[rowName]) !== signature) return false;
      attestedSlides = writeCutSlides(c, slides, storedSlides);
      written = true;
    });
    if (written) return attestedSlides;
    log.info(`[TRIAL AVATARS] the sheets of ${name} changed while the slides were cut (attempt ${attempt}/${MAX_SLIDE_ATTEMPTS}) — cutting again`);
  }
  throw new Error(`persistPreparedSheets: the sheets kept changing; slides not stored after ${MAX_SLIDE_ATTEMPTS} attempts`);
}

/**
 * The first slides of a trial: the cells of the standard sheet's body row, written the moment that row lands (long before
 * the sheet is finished). Only when the row holds no slides yet (a costumed sheet may have landed first); the finished
 * sheet's slides replace them in persistPreparedSheets. Returns the slides the row holds afterwards, or null when it kept
 * the ones it had.
 */
async function persistBodyRowSlides({ userId, characterId, slides }, deps = defaultDeps()) {
  const storedSlides = await deps.storeSlides(characterId, userId, slides);
  let attestedSlides = null;
  await deps.modifyRow(characterId, userId, (fresh) => {
    const c = fresh.characters?.[0];
    if (!c || (Array.isArray(c.preGeneratedAvatarSlides) && c.preGeneratedAvatarSlides.length > 0)) return false;
    attestedSlides = writeCutSlides(c, slides, storedSlides);
  });
  return attestedSlides;
}

/**
 * Style `requirements` for one trial character inside the trial's cache scope, then persist what was made.
 * The single implementation behind both prepare endpoints.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {string} p.characterId  characters row id
 * @param {object} p.character    the character object handed to the styling pipeline
 * @param {Array}  p.requirements prepareStyledAvatars page requirements
 * @param {object} p.clothingRequirements
 * @param {object} p.styleOptions prepareStyledAvatars options (skipQualityEval, seasonOutfit, fastPass1)
 * @param {object} [p.fields]     extra character-row fields written with the sheets (preGeneratedStandardFor, preGeneratedCostumeType)
 * @returns {Promise<{ slides: string[] }>}
 */
async function styleAndPersistTrialSheets({ userId, characterId, character, requirements, clothingRequirements, styleOptions, fields = {} }, deps = {}) {
  const styled = deps.styledAvatars || require('./styledAvatars');
  const persist = deps.persist || ((args) => persistPreparedSheets(args));
  const characters = [character];
  return styled.runInCacheScope(`trial-${userId}`, async () => {
    await styled.prepareStyledAvatars(characters, TRIAL_ART_STYLE, requirements, clothingRequirements, null, null, styleOptions);
    const exportedAll = {};
    for (const [charName, avatars] of styled.exportStyledAvatarsForPersistence(characters, TRIAL_ART_STYLE)) exportedAll[charName] = avatars;
    const exported = onlyRequestedSheets(exportedAll, requirements);
    if (Object.keys(exported).length === 0) throw new Error(`no sheet was styled for ${character.name}`);

    // The job enters this scope a moment after the endpoint finishes: hand the scope over instead of wiping it
    // (docs/decisions.md 2026-09-06, prod job_1788698812047_q5b1vuds7).
    styled.retainCacheScopeForHandoff(`trial-${userId}`);
    styled.clearStyledAvatarCache();

    const slides = await persist({ userId, characterId, exported, fields });
    return { slides };
  });
}

module.exports = {
  TRIAL_ART_STYLE,
  standardSheetStamp,
  keepsDrawnBody,
  usablePreparedAvatars,
  mergePreparedAvatars,
  onlyRequestedSheets,
  sheetSignature,
  persistPreparedSheets,
  persistBodyRowSlides,
  styleAndPersistTrialSheets,
};

/**
 * THE BACK COVER OF A PRINTED BOOK (owner, 2026-11-12; docs/decisions.md 2026-11-12 "Printed books make a missing back cover").
 *
 * A book has a back cover; a PDF download does not. A story made before full stories drew one (32 production stories, the
 * newest 2026-08-16) prints a white cover spread, so the print build makes the cover first, through the same path a cover of
 * a new story takes: its beat from code (coverBeats), ONE per-page Art Director brief (beatsPipeline.expandBriefPerPage),
 * the cover brief checks (briefChecks), the page render (images.renderPageFromBrief, the render half of an iterate),
 * the app-side typography (coverTypography.stampRepaintedCover), stored like a regenerated cover (regeneration.js).
 * We pay for it (no credits): the cover is part of the book the customer already pays for.
 *
 *   - the outfit text the cover beat needs is read from the character's avatar when the wardrobe has none
 *     (fillStandardOutfits; character2x4Sheet.readAvatarOutfit);
 *   - a weak first picture (below the cover/page repair threshold) gets ONE more attempt and the better of the two is kept;
 *     a low score never blocks an order;
 *   - a story whose characters have no avatar stored uses today's characters (mergeFreshAvatars); a character who no longer
 *     exists throws a clear error: no picture is correct, a cover with a stranger on it is not;
 *   - a failed typography stamp throws (stampRepaintedCover only warns; a back cover without its line is not shipped).
 *
 * Which stories need one is ONE rule (backCoverTarget), asked by the print build and by the order page's endpoint.
 */

const { log } = require('../utils/logger');

// One make per story even when the order page is opened twice or two requests overlap.
const inflight = new Map();

const hasBackCoverRecord = (storyData) => !!(storyData && storyData.coverImages && storyData.coverImages.backCover);

/**
 * THE RULE: which story of a book gets a made back cover. A single-story book whose story has none; for a
 * multi-story book only when NO story has one (pdf.js borrows another story's back cover for the book's cover),
 * and then story 1. Works on stored (not rehydrated) story data too: a stored back cover is a coverImages record.
 *
 * @param {Array<{id: string, data: Object}>} stories  in book order
 * @returns {{id: string, data: Object, index: number}|null}
 */
function backCoverTarget(stories) {
  if (!Array.isArray(stories) || stories.length === 0) return null;
  if (stories.some(s => hasBackCoverRecord(s.data))) return null;
  return { ...stories[0], index: 0 };
}

/** A log object with the shape the Art Director helpers expect (their `gl`), writing to the server log. */
function makerLog(storyId) {
  const tag = `[BACK COVER ${storyId}]`;
  return {
    info: (code, message) => log.info(`${tag} ${message || code}`),
    warn: (code, message) => log.warn(`${tag} ${message || code}`),
    error: (code, message) => log.error(`${tag} ${message || code}`),
    setStage: () => {},
  };
}

/**
 * The picture of a character's day outfit: the story's styled standard avatar, else the permanent standard avatar.
 * @returns {Promise<string|null>} a data URI
 */
async function outfitPictureOf(character, artStyle) {
  const { resolveAvatarBytes } = require('./styledAvatars');
  const styled = character.avatars && character.avatars.styledAvatars && character.avatars.styledAvatars[artStyle];
  return (styled && await resolveAvatarBytes(styled, 'standard'))
    || await resolveAvatarBytes(character.avatars || character.clothingAvatars, 'standard')
    || null;
}

/**
 * Give every named character a `standard` day outfit description in the story's wardrobe, reading it off the avatar for
 * those that have none (one vision call each). Mutates `storyData.clothingRequirements`; returns the names it filled.
 * A character with no avatar to read throws: the cover beat cannot dress anyone from nothing (coverBeats.coverOutfits).
 *
 * @param {Object} storyData
 * @param {string[]} names  the cover's figures
 * @param {{readOutfit?: Function, usageTracker?: Function|null}} [deps]
 */
async function fillStandardOutfits(storyData, names, { readOutfit = null, usageTracker = null } = {}) {
  const { standardOutfitText, resolveCharacterReqs } = require('./clothingCategories');
  const read = readOutfit || ((image) => require('./character2x4Sheet').readAvatarOutfit(image, { usageTracker }));
  const filled = [];
  storyData.clothingRequirements = storyData.clothingRequirements || {};
  for (const name of names) {
    if (standardOutfitText(storyData.clothingRequirements, name)) continue;
    const character = (storyData.characters || []).find(c => c && c.name === name);
    if (!character) throw new Error(`Back cover: ${name} is not a character of this story`);
    const image = await outfitPictureOf(character, storyData.artStyle || 'pixar');
    if (!image) throw new Error(`Back cover: ${name} has no avatar to read the day outfit from`);
    const { outfit } = await read(image);
    // The wardrobe entry keeps its key and its other fields (used, signature, costumed); only the description is added.
    const entry = resolveCharacterReqs(storyData.clothingRequirements, name);
    if (entry) entry.standard = { ...(entry.standard || {}), used: true, description: outfit };
    else storyData.clothingRequirements[name] = { standard: { used: true, description: outfit } };
    filled.push(name);
    log.info(`👗 [BACK COVER] ${name}: day outfit read from the avatar: ${outfit}`);
  }
  return filled;
}

/**
 * The characters of the story as they must look today: the stored ones, with today's avatars for a character whose story
 * holds none. Throws when a figure of the cover has no usable avatar and no character of today to take one from.
 */
async function charactersForCover(storyId, storyData, castNames, { loadFreshCharacters = null } = {}) {
  const { hasUsableAvatar, mergeFreshAvatars } = require('./characterPhotos');
  const artStyle = storyData.artStyle || 'pixar';
  const onCover = (storyData.characters || []).filter(c => c && castNames.includes(c.name));
  if (!onCover.some(c => !hasUsableAvatar(c, artStyle))) return storyData.characters || [];
  const fresh = await (loadFreshCharacters || defaultLoadFreshCharacters)(storyId);
  const merged = mergeFreshAvatars(storyData.characters || [], fresh, artStyle);
  const stillMissing = merged.filter(c => c && castNames.includes(c.name) && !hasUsableAvatar(c, artStyle)).map(c => c.name);
  if (stillMissing.length) {
    throw new Error(`Back cover: ${stillMissing.join(', ')} ${stillMissing.length === 1 ? 'has' : 'have'} no avatar stored with the story and no character of today to take one from (deleted?)`);
  }
  return merged;
}

async function defaultLoadFreshCharacters(storyId) {
  const { dbQuery } = require('../services/database');
  const owner = await dbQuery('SELECT user_id FROM stories WHERE id = $1', [storyId]);
  if (!owner.length) throw new Error(`Back cover: story ${storyId} not found`);
  const rows = await dbQuery('SELECT data FROM characters WHERE user_id = $1', [owner[0].user_id]);
  const data = rows[0] && rows[0].data;
  return (typeof data === 'string' ? JSON.parse(data) : data || {}).characters || [];
}

/**
 * The brief of the back cover: beat from code, ONE per-page Art Director call, the decided fields pinned in, the cover brief
 * checks (one re-ask at most). Every model call here is the shared one; nothing is written to the database.
 *
 * @returns {Promise<{brief: string, beat: Object, expansion: Object}>}
 */
async function writeBackCoverBrief(storyData, gl, { writeBrief = null, checkBriefs = null } = {}) {
  const { buildCoverBeats, coverOutfits, coverCasts } = require('./coverBeats');
  const { coverFacts, assembleBriefs } = require('./jevBriefFields');
  const { MODEL_DEFAULTS, IMAGE_MODELS } = require('../config/models');
  const clothingRequirements = storyData.clothingRequirements;
  const visualBible = storyData.visualBible || null;
  // Placeless: no Jev decided this cover's place, so the beat carries the Art Director's own-place rule (placeDecided false),
  // the same backup a new story's cover takes when the decision could not place it.
  const [beat] = buildCoverBeats(storyData, { coverTypes: ['backCover'], clothingRequirements, centralFigure: null, placeDecided: false });
  const outfits = coverOutfits(coverCasts(storyData).backCover, clothingRequirements);
  const era = visualBible && typeof visualBible.era === 'string' ? visualBible.era.trim() : '';
  // The shot, the gaze (the cover looks at the viewer: docs/SETTLED.md) and the outfit are code's; `quiet` = no FIXED block shown.
  beat.jevFixed = { ...coverFacts({ coverKey: 'backCover', storyBeats: [], location: null, population: null, era, outfits }), quiet: true };

  const { buildAvailableAvatarsForPrompt } = require('./storyHelpers');
  const imgModelConfig = IMAGE_MODELS[MODEL_DEFAULTS.pageRenderImage];
  const ctx = {
    inputData: storyData, visualBible, clothingRequirements,
    availableAvatars: buildAvailableAvatarsForPrompt(storyData.characters || [], clothingRequirements),
    maxCharactersPerScene: imgModelConfig?.maxCharactersPerScene || 3,
    imageBackend: imgModelConfig?.backend,
    sceneModel: MODEL_DEFAULTS.sceneDescription,
    jevBackup: true,
    gl,
  };
  const expansion = await (writeBrief || require('./beatsPipeline').expandBriefPerPage)(beat, ctx);
  assembleBriefs([expansion], [beat], gl, visualBible);
  const expansions = [expansion];
  await (checkBriefs || require('./briefChecks').runBriefChecks)({
    inputData: storyData, expansions, briefBeats: [beat], visualBible,
    visualBibleJson: visualBible ? JSON.stringify(visualBible) : '',
    clothingRequirements, availableAvatars: ctx.availableAvatars, maxCharactersPerScene: ctx.maxCharactersPerScene,
    model: ctx.sceneModel, gl,
  });
  return { brief: expansions[0].brief, beat, expansion: expansions[0] };
}

/** The cover/page repair threshold: a picture scoring below it, or not scored, is weak. */
function isWeak(score) {
  const { REPAIR_DEFAULTS } = require('../config/models');
  return score === null || score === undefined || Number(score) < REPAIR_DEFAULTS.scoreThreshold;
}

/**
 * Render the brief; when the score is weak, render ONE more time and keep the better of the two (a weak score never fails).
 * @returns {Promise<{result: Object, attempts: number, scores: Array<number|null>}>}
 */
async function renderBetterOfTwo(render) {
  const first = await render();
  if (!isWeak(first.score)) return { result: first, attempts: 1, scores: [first.score] };
  log.warn(`⚠️ [BACK COVER] first picture scored ${first.score} (threshold below): one more attempt`);
  const second = await render();
  const rank = (r) => (r.score === null || r.score === undefined ? -1 : Number(r.score));
  const best = rank(second) > rank(first) ? second : first;
  return { result: best, attempts: 2, scores: [first.score, second.score] };
}

/**
 * Make the back cover of a story that has none and store it. The caller's `storyData` (rehydrated or not) is the working
 * copy: its wardrobe gains the outfit text and its `coverImages.backCover` the made cover (served bytes), so a PDF built
 * from it right after draws it. Returns `{made: false}` when the story already has one.
 *
 * @param {string} storyId
 * @param {Object} storyData
 * @param {Object} [deps]  test seams: readOutfit, loadFreshCharacters, writeBrief, checkBriefs, render, stamp, save
 * @returns {Promise<{made: boolean, score?: number|null, attempts?: number, costUsd?: number}>}
 */
function makeMissingBackCover(storyId, storyData, deps = {}) {
  if (hasBackCoverRecord(storyData)) return Promise.resolve({ made: false });
  if (inflight.has(storyId)) return inflight.get(storyId);
  const work = buildBackCover(storyId, storyData, deps).finally(() => inflight.delete(storyId));
  inflight.set(storyId, work);
  return work;
}

async function buildBackCover(storyId, storyData, deps) {
  if (!storyData.coverImages || !storyData.coverImages.frontCover) {
    throw new Error(`Back cover: story ${storyId} has no front cover, so there is no book cover to complete`);
  }
  if (storyData.trialMode === true) throw new Error(`Back cover: story ${storyId} is a trial story, whose covers have their own builder`);
  const gl = makerLog(storyId);
  const t0 = Date.now();
  const { priceUsage } = require('../config/models');
  let costUsd = 0;
  const usageTracker = (provider, usage, label, modelId) => { try { costUsd += priceUsage(modelId, usage) || 0; } catch { /* an unpriced model adds 0 */ } };

  const { coverCasts } = require('./coverBeats');
  const castNames = coverCasts(storyData).backCover;
  storyData.characters = await charactersForCover(storyId, storyData, castNames, deps);
  await fillStandardOutfits(storyData, castNames, { readOutfit: deps.readOutfit, usageTracker });

  const { brief, beat } = await writeBackCoverBrief(storyData, gl, deps);

  const { extractSceneMetadata } = require('./storyHelpers');
  const { castOfRewrittenBrief } = require('./sceneMetadata');
  const metadata = extractSceneMetadata(brief);
  if (!metadata) throw new Error('Back cover: the Art Director brief has no readable METADATA block');
  const sceneCharacters = castOfRewrittenBrief(brief, storyData.characters || []);
  if (sceneCharacters === null) throw new Error('Back cover: the brief declares no characters array');
  const coverRecord = {
    briefedAsPage: true, sceneDescription: brief, perCharClothing: metadata.characterClothing || null,
    jevFixed: beat.jevFixed, outlineExtract: `PLAN: ${beat.planLine}`,
  };

  const { COVER_PAGE_NUMBERS } = require('./coverKeys');
  const render = deps.render || (() => require('./images').renderPageFromBrief({
    pageNumber: COVER_PAGE_NUMBERS.backCover, storyData, coverKey: 'backCover', coverRecord,
    sceneCharacters, newSceneDescription: brief, newSceneMetadata: metadata, parentSceneMetadata: metadata,
    options: { usageTracker },
  }));
  const { result, attempts, scores } = await renderBetterOfTwo(render);
  if (!result || !result.imageData) throw new Error('Back cover: the render returned no picture');

  const stamped = await (deps.stamp || require('./coverTypography').stampRepaintedCover)(storyData, 'backCover', result, { force: true, skip: false, logTag: 'BACK-COVER-MAKER' });
  if (!stamped || !stamped.artImageData || !stamped.typographySpec) {
    throw new Error('Back cover: the text stamp ("magicalstory.ch") failed, so the cover is not stored');
  }

  const version = {
    imageData: stamped.servedImageData, qualityScore: result.score, description: brief, prompt: result.promptSent || result.imagePrompt || null,
    modelId: result.modelId || null, createdAt: new Date().toISOString(), type: 'generation', source: 'back-cover-maker',
    bboxDetection: result.bboxDetection || null, hasBboxOverlay: !!result.bboxDetection,
  };
  const save = deps.save || saveMadeBackCover;
  await save(storyId, storyData, { version, art: stamped.artImageData, coverRecord, sceneCharacters: sceneCharacters.map(c => ({ id: c.id, name: c.name })), result, brief, metadata, typography: stamped.typographySpec, costUsd, attempts, scores });
  log.info(`🎨 [BACK COVER] ${storyId}: made in ${((Date.now() - t0) / 1000).toFixed(1)}s, score ${result.score} (attempts ${attempts}: ${scores.join(', ')}), USD ${costUsd.toFixed(3)}`);
  return { made: true, score: result.score ?? null, attempts, costUsd };
}

/**
 * Store the made cover exactly as regeneration.js stores a regenerated one (version row at the next index, the textless art
 * beside it, the record with `briefedAsPage`, the version pinned active, the cost on the story), from a CLEAN copy of the
 * stored story: the caller's working copy is rehydrated, and saving it would re-store every page picture.
 */
async function saveMadeBackCover(storyId, storyData, made) {
  const { dbQuery, saveStoryData, saveStoryImage, getNextVersionIndex, setActiveVersion } = require('../services/database');
  const rows = await dbQuery('SELECT data FROM stories WHERE id = $1', [storyId]);
  if (!rows.length) throw new Error(`Back cover: story ${storyId} not found`);
  const stored = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  if (hasBackCoverRecord(stored)) throw new Error(`Back cover: story ${storyId} got a back cover while this one was made; not overwriting it`);

  const versionIndex = await getNextVersionIndex(storyId, 'backCover', null);
  await saveStoryImage(storyId, 'backCover', null, made.version.imageData, { qualityScore: made.result.score, generatedAt: made.version.createdAt, versionIndex });
  await saveStoryImage(storyId, 'backCoverArt', null, made.art, { versionIndex });
  made.version.dbVersionIndex = versionIndex;
  made.version._alreadySaved = true;
  try {
    const { applyScore } = require('./scoring');
    applyScore(made.version, { evalResult: { qualityScore: made.result.score, fixableIssues: made.result.fixableIssues || [], reasoning: made.result.reasoning || null }, entityResult: null, consolidatedPlan: null });
  } catch (err) { log.warn(`⚠️ [BACK COVER] ${storyId}: canonical score not stamped (${err.message})`); }

  stored.coverImages = stored.coverImages || {};
  stored.clothingRequirements = storyData.clothingRequirements;
  stored.coverImages.backCover = {
    imageData: made.version.imageData, description: made.brief, prompt: made.version.prompt, modelId: made.version.modelId,
    totalAttempts: made.attempts, retryHistory: [], typography: made.typography, imageVersions: [made.version],
    briefedAsPage: true, sceneDescription: made.brief, sceneMetadata: made.metadata,
    sceneCharacters: made.sceneCharacters, compressedScene: made.result.compressedScene || null,
    outlineExtract: made.coverRecord.outlineExtract, jevFixed: made.coverRecord.jevFixed, perCharClothing: made.coverRecord.perCharClothing,
    titleBaked: false,
  };
  stored.updatedAt = new Date().toISOString();
  await saveStoryData(storyId, stored);
  await setActiveVersion(storyId, 'backCover', versionIndex, { pinned: true });
  if (made.costUsd > 0) await addMakerCost(storyId, made.costUsd);

  // The caller's working copy now holds the cover, so the PDF built from it draws it.
  storyData.coverImages = storyData.coverImages || {};
  storyData.coverImages.backCover = { ...stored.coverImages.backCover, imageData: made.version.imageData };
}

async function addMakerCost(storyId, cost) {
  const { dbQuery } = require('../services/database');
  await dbQuery(`
    UPDATE stories SET data = jsonb_set(
      jsonb_set(data::jsonb, '{analytics,totalCost}', to_jsonb(COALESCE((data::jsonb->'analytics'->>'totalCost')::numeric, 0) + $1)),
      '{analytics,repairCost}', to_jsonb(COALESCE((data::jsonb->'analytics'->>'repairCost')::numeric, 0) + $1)
    ) WHERE id = $2`, [cost, storyId]);
}

module.exports = {
  backCoverTarget,
  makeMissingBackCover,
  fillStandardOutfits,
  charactersForCover,
  writeBackCoverBrief,
  renderBetterOfTwo,
  isWeak,
};

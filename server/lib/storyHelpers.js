/**
 * Story Helpers — re-export facade
 *
 * storyHelpers.js was split into domain modules (docs/plans/storyhelpers-split.md):
 *   - promptBuilders.js  — story/scene/image prompt builders + support data
 *                          (character descriptions, teaching guides, historical
 *                          locations/objects, art styles, language levels, ages)
 *   - sceneMetadata.js   — scene/page metadata parsers + position handling
 *   - clothingResolve.js — clothing/avatar category resolution + photo assembly
 *
 * This facade re-exports everything so existing `require('./storyHelpers')`
 * importers keep working byte-identically. New code may require the domain
 * modules directly; importer migration is opportunistic, never bulk
 * (docs/decisions.md). Only small residue lives here: landmark photo loaders,
 * calculateStoryPageCount, getHeadBodyRatio.
 */

const { log } = require('../utils/logger');
const { loadLandmarkPhotoVariant, servablePhotos, parseLandmarkPhotoCitation } = require('./landmarkPhotos');
const { parseClothingCategory, parseCharacterClothing, resolveClothingForPage, buildSceneClothingRequirements, buildAvailableAvatarsForPrompt, convertClothingToCurrentFormat, getCharacterPhotos, getCharacterPhotoDetails, buildWholeCastReferencePhotos, prefetchAvatarBytesForCharacters, applyReferenceMode } = require('./clothingResolve');
const { wrapUserInput, stripAgeWords, buildHairDescription, buildCharacterDescriptionsForBbox, buildSecondaryCharacterDescriptions, buildSecondaryExpectedCharacters, buildCastIdentityDescription, buildIdentityClothingText, buildIdentityLine, buildSecondaryExpectedForPage, buildTextZoneInstruction, buildEraGuard, buildLandmarkFidelityBlock, getAgeCategory, getAgeCategoryLabel, AGE_CATEGORY_ORDER, getAgeCategoryIndex, clampApparentAge, getTeachingGuide, getIdeaGuide, preloadHistoricalLocations, getHistoricalLocations, preloadHistoricalObjects, getHistoricalObjects, getAdventureGuide, getSceneComplexityGuide, ART_STYLES, WORLD_ART_STYLES, buildStyleWardrobeBlock, resolveArtStyle, resolveArtStyleForSheet, LANGUAGE_LEVELS, getReadingLevel, getTokensPerPage, extractCharacterVisualProfile, buildCharacterPhysicalDescription, buildGroundingPrompt, buildCharacterPromptBlock, buildRelativeHeightDescription, buildCharacterRestriction, buildCharacterReferenceList, buildReferenceCardColours, buildCoverPrompt, buildBasePrompt, buildSceneExpansionAllPrompt, buildSceneExpansionPrompt, buildSceneDescriptionPrompt, stripWornStateFromDescription, buildImagePrompt, sanitizeVbIdsInPrompt, buildOutlineReviewPrompt, buildTextRefinePrompt, parseRefinedText, BRIEF_TRAILING_MARKERS, buildBeatsPrompt, buildChallengeIdeasSection, buildArcCreatePrompt, buildArcPanelPrompt, buildArcRetellPrompt, buildArcHintsPrompt, parseArcHints, parseArcCreate, parseArcRetell, parseStoryLogic, filterPanelFindings, filterCritiqueFaults, arcRepairFindings, splitCommittedBlock, arcShapeCounts, arcInventedAllowance, critiqueMaxSeverity, buildPlanCheckPrompt, parsePlanCheck, buildReplanSection, replanRank, countsTowardConvergence, convergenceMustFixCount, replanRoundConverged, replanRoundRegressed, replanFindingKey, findingPages, buildArcReviewPrompt, buildArcAuditPrompt, buildTextAuditPrompt, buildTextAuditBlindPrompt, buildTextProofreadPrompt, buildTextDiffPrompt, countFaults, faultsByCategory, parseArcReview, buildStoryShapeSection, buildClothingReviewPrompt, parseClothingReview, parseBeats, parsePagePlan, parsePlanResponse, planBlocks, planInstant, buildSceneReviewPrompt, buildDoNotWriteSection, buildStoryTextFromBeatsPrompt, buildStoryBibleFromBeatsPrompt, buildTrialStoryPrompt, buildAvailableLandmarksSection, buildPreviousScenesContext, buildChildCriticPrompt, youngestMainAge } = require('./promptBuilders');
const { extractJsonFromText, parseProseMetadataFormat, splitBrief, POSITION_ABBREVIATIONS, expandPositionAbbreviations, stripEntityIds, stripSceneMetadata, parseCharacterDescriptions, enforceSpreadTextPosition, mirrorLeftRight, extractSceneMetadata, collectSceneCharacterNames, findCastMissingFromMetadata, getCharactersInScene, unionPageCast, parseSceneHintMetadata, parseStoryPages, parseSceneDescriptions, extractShortSceneDescriptions, extractCoverScenes, extractPageClothing, getPrimaryVantageForPage, resolvePagePlate, groupPagesByVantage, groupTrialPlatePagesByVantage, normalizePositionToLCR, getPageText, updatePageText } = require('./sceneMetadata');

/*
 * EXHAUSTIVE RE-EXPORT (2026-09-13). The facade used to list every forwarded
 * name by hand, twice — once in the destructures above, once in
 * `module.exports`. A function added to a domain module and NOT added to both
 * lists is simply absent here, and every importer that destructures it from
 * this facade binds `undefined` with no error at require time. That is exactly
 * how `parsePlanCheckRoster` (promptBuilders.js, added 2026-09-11 in df1eb1ff3)
 * reached `beatsPipeline.js:95` as undefined and killed the whole plan-counter
 * layer on every beats run for two days — behind a WARN, so nothing failed.
 * The module objects below are spread into `module.exports`, so a new domain
 * export is forwarded automatically. The explicit list after them is kept as
 * the documented surface and as the place local residue and the alias win.
 * `tests/unit/story-helpers-facade.test.ts` pins both properties.
 */
const promptBuildersModule = require('./promptBuilders');
const sceneMetadataModule = require('./sceneMetadata');
const clothingResolveModule = require('./clothingResolve');

/**
 * Calculate the actual page count for a story
 * Picture-book layout is the default for all reading levels: 1 scene = 1 page
 * (image on top, text below). Reading level only controls text density, not layout.
 * @param {Object} storyData - The story data object
 * @param {boolean} includeCoverPages - Whether to add 3 pages for covers (default: true)
 * @returns {number} Total page count
 */
function calculateStoryPageCount(storyData, includeCoverPages = true) {
  const sceneCount = storyData?.sceneImages?.length || storyData?.scenes?.length || 0;
  if (sceneCount === 0) return 0;

  // 1 scene = 1 physical page in picture-book layout
  // Add 3 pages for front cover, back cover, and initial page (title page)
  return includeCoverPages ? sceneCount + 3 : sceneCount;
}

// ============================================================================
// LANDMARK PHOTO LOADERS
// ============================================================================

/**
 * Get landmark reference photos for a scene based on LOC IDs in scene metadata
 * Parses objects like "Burgruine Stein [LOC002]" to extract LOC IDs
 * Also checks setting.location for landmark references
 * Supports on-demand loading of photo variants for Swiss landmarks
 * @param {Object} visualBible - Visual Bible object with locations
 * @param {Object} sceneMetadata - Scene metadata with objects array, setting.location and (iterate rewrites only) landmarkPhoto
 * @param {Object} [opts]
 * @param {number} [opts.pageNumber] - Current page. When given (positive int), a
 *   landmark is served only if its VB pages list includes this page — the
 *   writer's pages list is the authority on WHERE a landmark appears; an AD
 *   reference alone is not enough. Covers pass their NEGATIVE page number
 *   (coverKeys.COVER_PAGE_NUMBERS): the gate skips it, and it finds the
 *   vantage whose `pages` name the cover, i.e. the photo that vantage cites.
 * @param {string} [opts.vantageId] - the vantage a plate is being painted for
 *   (the vantage-plate path): that vantage's citation wins for its location.
 * @param {Array} [opts.misses] - caller-owned array; every landmark the scene
 *   cites that SHOULD have produced a photo but could not (fetch failed, no
 *   photo source at all) is pushed as {id, name, reason}. By-design "attach
 *   nothing" outcomes (a plate that cites "none") are NOT
 *   misses. Lets the page renderer downgrade loudly instead of silently
 *   rendering a real landmark blind (dragon run job_1788551692337_bc479p945:
 *   Commons fetches failed, 5 pages rendered with zero reference photos and
 *   no warning).
 * @returns {Promise<Array<{name: string, photoData: string, attribution: string, source: string, variantNumber: number}>>} Landmark photos
 */
async function getLandmarkPhotosForScene(visualBible, sceneMetadata, opts = {}) {
  if (!visualBible?.locations) return [];

  // Extract LOC IDs and names from objects like "Burgruine Stein [LOC002]" or "Kennedy Space Center [LOC001.2]".
  // A dotted `.N` is a Visual Bible VANTAGE id (the plate's camera position),
  // never a photo slot (docs/decisions.md 2026-09-24). It names the vantage
  // whose `landmarkPhoto` citation this page's photo is (landmarkPhotoCitation).
  const locIds = [];
  const locNames = [];
  const vantageIds = [];

  // Helper to extract LOC ID and name from a string like "Ruine Stein [LOC001]" or "Ruine Stein [LOC001.2]"
  const extractLocFromString = (str) => {
    if (!str || typeof str !== 'string') return;
    // Match [LOC###] or [LOC###.N] pattern
    const bracketMatch = str.match(/\[LOC(\d+)(?:\.(\d+))?\]/i);
    if (bracketMatch) {
      locIds.push(`LOC${bracketMatch[1].padStart(3, '0')}`);
      if (bracketMatch[2]) vantageIds.push(`LOC${bracketMatch[1].padStart(3, '0')}.${bracketMatch[2]}`);
      // Also extract the name before the bracket
      const namePart = str.replace(/\s*\[LOC\d+(?:\.\d+)?\]\s*/gi, '').trim();
      if (namePart) locNames.push(namePart.toLowerCase());
    }
    // Also match plain "LOC002" or "LOC002.3" format
    else if (str.match(/^LOC\d+(\.\d+)?$/i)) {
      locIds.push(str.split('.')[0].toUpperCase());
      if (str.includes('.')) vantageIds.push(str.trim().toUpperCase());
    }
    // Fallback: treat as location name (for historical locations)
    else if (str.trim()) {
      locNames.push(str.trim().toLowerCase());
    }
  };

  // Check setting.location first (e.g., "Ruine Stein [LOC001]")
  if (sceneMetadata?.setting?.location) {
    extractLocFromString(sceneMetadata.setting.location);
  }

  // Then check objects array (objects can be strings or {id, name, position} objects)
  if (sceneMetadata?.objects) {
    for (const obj of sceneMetadata.objects) {
      if (typeof obj === 'string') {
        extractLocFromString(obj);
      } else if (obj && typeof obj === 'object') {
        extractLocFromString(obj.id);
        extractLocFromString(obj.name);
      }
    }
  }

  if (locIds.length === 0 && locNames.length === 0) return [];

  // Find matching locations
  let matchingLocations = visualBible.locations.filter(loc =>
    (locIds.includes(loc.id) || locNames.includes(loc.name?.toLowerCase())) &&
    loc.isRealLandmark
  );

  // PAGE GATE (owner, 2026-09-04): the writer's VB pages list decides WHERE a
  // landmark appears; an AD objects[] reference alone must not pull it in.
  // piraterun5: LOC007 (a real Zurich fountain) had pages:[] — staged on no
  // page by the writer — yet the AD listed it on pages 4/5 and the photo was
  // served into a Mediterranean harbour scene. An empty pages list fails the
  // gate on every page; entries with NO pages field (legacy stored stories)
  // are served as before. Parse-time now also drops pages:[] landmarks
  // entirely (outlineParser/unified.js), so this gate is the backstop for
  // stories parsed before that fix.
  const gatePage = Number.isInteger(opts.pageNumber) && opts.pageNumber > 0 ? opts.pageNumber : null;
  if (gatePage != null) {
    matchingLocations = matchingLocations.filter(loc => {
      const pages = Array.isArray(loc.pages) ? loc.pages
        : (Array.isArray(loc.appearsInPages) ? loc.appearsInPages : null);
      if (pages == null || pages.includes(gatePage)) return true;
      log.warn(`[LANDMARK-SCENE] Page ${gatePage}: scene references "${loc.name}" [${loc.id}] but its VB pages [${pages.join(',')}] does not include this page — landmark photo not served`);
      return false;
    });
  }

  if (matchingLocations.length === 0) {
    // Debug: explain why no matches
    const allVbLocIds = visualBible.locations.map(l => `${l.id}(${l.isRealLandmark ? 'landmark' : 'location'})`);
    log.debug(`[LANDMARK-SCENE] No matches for IDs=[${locIds.join(',')}] names=[${locNames.join(',')}] in VB locations: [${allVbLocIds.join(', ')}]`);
    return [];
  }

  // Load the CITED photo for each matching location (landmarkPhotoCitation).
  // Covers pass their negative page number: it takes no part in the page gate
  // above, and it is how a cover finds the vantage whose `pages` name it.
  const citePage = Number.isInteger(opts.pageNumber) ? opts.pageNumber : null;
  if (opts.vantageId) vantageIds.push(String(opts.vantageId).trim().toUpperCase());
  const results = [];
  for (const loc of matchingLocations) {
    const photo = await resolveLandmarkPhotoForLocation(visualBible, loc, {
      citation: landmarkPhotoCitation(visualBible, loc, { sceneMetadata, pageNumber: citePage, vantageIds }),
      misses: opts.misses,
    });
    if (photo) results.push(photo);
  }

  return results;
}

/**
 * WHICH PHOTO A PAGE CITES for one real landmark (docs/decisions.md
 * 2026-09-26, "The Art Director cites the landmark photo").
 *
 * The Art Director cites a photo per PLATE, because the photo is what a plate
 * is painted from: `landmarkPhoto` on each vantage, or on the location itself
 * when it has no `vantages[]` (one viewpoint, one plate). A page is drawn on
 * its vantage's plate, so it takes that vantage's citation:
 *   1. 'page'     the page brief's own `landmarkPhoto`, for the location whose
 *                 plate the page authors itself — an iterate rewrite that writes
 *                 a fresh plate (`reuseEmptyScene: false`). Only the page's
 *                 primary location (getPrimaryVantageForPage), never a second
 *                 landmark the page also shows.
 *   2. 'vantage'  the vantage the page cites by its dotted id, else the one
 *                 whose `pages` name the page.
 *   3. 'location' a location with no `vantages[]`.
 * No level applies → `{ value: null }`, which the resolver reports as an error.
 * Nothing here looks at the page's shot, a view word or a photo's framing: the
 * citation is the whole selection.
 *
 * @returns {{value: number|'none'|null, source: 'page'|'vantage'|'location'|null, vantageId: string|null, raw: *}}
 */
function landmarkPhotoCitation(visualBible, loc, { sceneMetadata = null, pageNumber = null, vantageIds = [] } = {}) {
  const locId = String(loc?.id || '').toUpperCase();
  const own = sceneMetadata?.landmarkPhoto ?? sceneMetadata?.fullData?.landmarkPhoto;
  if (own !== undefined && own !== null && sceneMetadata) {
    const { getPrimaryVantageForPage } = require('./sceneMetadata');
    const primary = getPrimaryVantageForPage(sceneMetadata, visualBible, {
      pageNumber, emptyScenePrompt: sceneMetadata?.emptyScenePrompt || '',
    });
    if (primary && primary.locId === locId) {
      return { value: parseLandmarkPhotoCitation(own), source: 'page', vantageId: null, raw: own };
    }
  }
  const vantages = Array.isArray(loc?.vantages) ? loc.vantages.filter(Boolean) : [];
  if (vantages.length > 0) {
    const cited = vantages.find(v => vantageIds.includes(String(v.id || '').toUpperCase()));
    const onPage = pageNumber != null
      ? vantages.find(v => Array.isArray(v.pages) && v.pages.map(Number).includes(pageNumber)) : null;
    const v = cited || onPage;
    if (!v) return { value: null, source: null, vantageId: null, raw: undefined };
    return { value: parseLandmarkPhotoCitation(v.landmarkPhoto), source: 'vantage', vantageId: v.id || null, raw: v.landmarkPhoto };
  }
  return { value: parseLandmarkPhotoCitation(loc?.landmarkPhoto), source: 'location', vantageId: null, raw: loc?.landmarkPhoto };
}

/**
 * Every real-landmark PLATE's photo citation, checked against the photos the
 * landmark can serve (docs/decisions.md 2026-09-26). A plate is a vantage, or a
 * location with no vantages. Pure: the story run reports each fault once, on
 * the final bible after the scene review (storyJobPipeline.js, log.error +
 * genLog `landmark_photo_citation`), and the Lab stage returns them. Never
 * repairs one — the citation is the plate author's, and the scene review's
 * [landmark_photo_mismatch] check is the stage that corrects it.
 *
 * @returns {Array<{locId, plateId, cited, reason}>} the faults found
 */
function landmarkPhotoCitationFaults(visualBible) {
  const faults = [];
  for (const loc of (visualBible?.locations || [])) {
    if (!loc?.isRealLandmark) continue;
    const photos = servablePhotos(loc.photoVariants).map(v => v.variantNumber);
    const legacy = photos.length === 0 && (loc.referencePhotoUrl || loc.referencePhotoData);
    const allowed = legacy ? [1] : photos;
    const plates = Array.isArray(loc.vantages) && loc.vantages.length > 0
      ? loc.vantages.filter(Boolean).map(v => ({ id: v.id || `${loc.id}.?`, raw: v.landmarkPhoto }))
      : [{ id: loc.id, raw: loc.landmarkPhoto }];
    for (const p of plates) {
      const cited = parseLandmarkPhotoCitation(p.raw);
      let reason = null;
      if (p.raw === undefined || p.raw === null || p.raw === '') reason = 'no landmarkPhoto cited';
      else if (cited == null) reason = `landmarkPhoto ${JSON.stringify(p.raw)} is not a photo number or "none"`;
      else if (cited !== 'none' && !allowed.includes(cited)) reason = `landmarkPhoto ${cited} is not one of its photos (${allowed.join(',') || 'none servable'})`;
      if (reason) faults.push({ locId: loc.id, locName: loc.name, plateId: p.id, cited: p.raw ?? null, reason });
    }
  }
  return faults;
}

/**
 * SINGLE resolver for "which photo does this landmark location get".
 *
 * Two storage shapes exist and only one of them uses `photoFetchStatus`:
 *  - VARIANT landmarks (Swiss pre-indexed, 2-3 photos by kind) resolve
 *    on-demand through the cited slot + loadLandmarkPhotoVariant. They are
 *    deliberately EXCLUDED from prefetchLandmarkPhotos (see the
 *    `!l.photoVariants?.length` filter at its call site), so their
 *    photoFetchStatus stays 'pending_lazy' forever — checking it is always wrong.
 *  - LEGACY/single-photo landmarks carry referencePhotoUrl/Data and DO get
 *    'success' stamped by the prefetch.
 *
 * The trial empty-scene path implemented only the second shape and gated on
 * `photoFetchStatus === 'success'`, so no plate was ever built for a
 * variant-backed landmark. With no plate, packReferences promotes the RAW
 * photograph into a page slot and the page renders photographically instead of
 * in the story's art style (prod job_1787647410717_5dvfqu8jg p1: real
 * bystanders, real signage, in a watercolour book). Both callers now share this
 * resolver — never inline a third copy.
 *
 * The photo is the one the Art Director CITED (landmarkPhotoCitation): exactly
 * that slot, or nothing for "none". A missing citation, or a number that is not
 * one of the landmark's servable photos, is an ERROR — logged and reported as a
 * miss, and no photo is attached; nothing picks a photo in its place
 * (docs/decisions.md 2026-09-26). The metadata picker that chose by view word,
 * framing and score (pickVariantForView) is deleted.
 *
 * @param {Object} visualBible
 * @param {Object} loc - one VB location (isRealLandmark)
 * @param {Object} [opts]
 * @param {Object} [opts.citation] - landmarkPhotoCitation() for this location
 * @param {Array} [opts.misses] - see getLandmarkPhotosForScene; failure-to-serve
 *   entries {id, name, reason} are pushed here (never by-design nulls)
 * @returns {Promise<Object|null>} landmark photo entry, or null to attach nothing
 */
async function resolveLandmarkPhotoForLocation(visualBible, loc, opts = {}) {
  const misses = Array.isArray(opts.misses) ? opts.misses : null;
  const decision = decideLandmarkPhotoSource(loc, opts);
  if (decision.mode === 'none') return null; // cited "none": the prose carries the place
  if (decision.mode === 'error') {
    log.error(`❌ [LANDMARK-SCENE] "${loc.name}" [${loc.id}]: ${decision.reason} — no photo attached`);
    if (misses) misses.push({ id: loc.id, name: loc.name, reason: decision.reason });
    return null;
  }

  if (decision.mode === 'variant') {
    const variant = await loadLandmarkPhotoVariant(visualBible, loc.id, decision.variantNumber);
    if (!variant) {
      if (misses) {
        misses.push({ id: loc.id, name: loc.name, reason: `variant ${decision.variantNumber} photo fetch failed` });
      }
      return null;
    }
    log.debug(`[LANDMARK-SCENE] Loaded "${loc.name}" variant ${variant.variantNumber}`);
    // Carry the indexer's own classification of THIS photo (photo_type:
    // exterior | distant | close | interior | view-from) and its description
    // through to the prompt. The index classifies every photo by `kind`, and
    // every consumer dropped it, so buildLandmarkFidelityBlock had only a name
    // to go on and told the model "preserve the silhouette… never a tiny speck
    // against a wide cityscape" even when the reference was a village panorama,
    // which has no silhouette to preserve.
    const served = (loc.photoVariants || []).find(v => v.variantNumber === variant.variantNumber);
    return {
      name: loc.name,
      photoData: variant.photoData,
      attribution: variant.attribution,
      source: 'swiss-variant',
      variantNumber: variant.variantNumber,
      // `photoType` is the ONLY thing read downstream: it selects which
      // fidelity block buildLandmarkFidelityBlock emits. The photo's own
      // description is deliberately NOT carried — nothing consumed it
      // (removed 2026-09-15) — so do not diagnose a prompt as "having the
      // photo's description": it does not.
      photoType: served?.kind || null,
      // Where the citation came from, for the logs and the stored page record.
      citedBy: opts.citation?.source || null,
    };
  }

  // Legacy/single-photo landmark: referencePhotoUrl post-Phase-2,
  // referencePhotoData on legacy entries.
  return {
    name: loc.name,
    photoUrl: loc.referencePhotoUrl || null,
    photoData: loc.referencePhotoData || null,
    attribution: loc.photoAttribution,
    source: loc.photoSource,
    variantNumber: 1,
  };
}

/**
 * The POLICY half of resolveLandmarkPhotoForLocation, with no I/O: which photo
 * does the citation serve?
 *
 * A variant-backed landmark is decided on its VARIANTS, never on
 * `photoFetchStatus` (which only the legacy shape ever has stamped): the cited
 * number must be one of servablePhotos(loc.photoVariants) — the same list the
 * Art Director was shown. A legacy single-photo landmark shows the Art Director
 * one photo, number 1.
 *
 * @param {Object} loc
 * @param {Object} [opts]
 * @param {Object} [opts.citation] - landmarkPhotoCitation() result
 * @returns {{mode:'variant', variantNumber:number}|{mode:'legacy'}|{mode:'none'}|{mode:'error', reason:string}}
 */
function decideLandmarkPhotoSource(loc, opts = {}) {
  if (!loc) return { mode: 'error', reason: 'no location' };
  const citation = opts.citation || { value: null, source: null, raw: undefined };
  const hasVariants = Array.isArray(loc.photoVariants) && loc.photoVariants.length > 0;
  const hasLegacy = !hasVariants && (loc.referencePhotoUrl || loc.referencePhotoData) && loc.photoFetchStatus === 'success';
  if (!hasVariants && !hasLegacy) {
    log.debug(`[LANDMARK-SCENE] "${loc.name}" (${loc.id}) has no photos (variants=${loc.photoVariants?.length || 0}, fetchStatus=${loc.photoFetchStatus || 'none'})`);
    return { mode: 'error', reason: `no photo available (fetchStatus=${loc.photoFetchStatus || 'none'})` };
  }
  const where = citation.source === 'vantage' ? `vantage ${citation.vantageId || '?'}`
    : (citation.source || 'no vantage names this page');
  if (citation.value == null) {
    return {
      mode: 'error',
      reason: citation.raw === undefined || citation.raw === null
        ? `no landmarkPhoto cited (${where})`
        : `landmarkPhoto ${JSON.stringify(citation.raw)} is not a photo number or "none" (${where})`,
    };
  }
  if (citation.value === 'none') {
    log.info(`📍 [LANDMARK-SCENE] ${loc.name}: ${where} cites no photo — the prose carries the place`);
    return { mode: 'none' };
  }
  if (hasLegacy) {
    return citation.value === 1 ? { mode: 'legacy' }
      : { mode: 'error', reason: `landmarkPhoto ${citation.value} is not one of its photos (1) (${where})` };
  }
  const servable = servablePhotos(loc.photoVariants).map(v => v.variantNumber);
  if (!servable.includes(citation.value)) {
    return { mode: 'error', reason: `landmarkPhoto ${citation.value} is not one of its photos (${servable.join(',') || 'none servable'}) (${where})` };
  }
  return { mode: 'variant', variantNumber: citation.value };
}

/**
 * Guarantee that every landmark photo entry the renderer keeps actually has
 * image BYTES. Post-R2, legacy/single-photo entries can carry a photoUrl with
 * no inline data; if that URL cannot be fetched, the page prompt would still
 * ship the "preserve this exact building / immediately recognisable"
 * fidelity block with no photo attached — worse than no landmark at all
 * (owner, 2026-09-05). Entries whose bytes cannot be resolved inside the
 * timeout are DROPPED (and reported via `misses`), so the fidelity block and
 * the photo can never disagree: block ⇔ bytes.
 *
 * @param {Array} photos - entries from getLandmarkPhotosForScene
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=20000] - per-photo fetch bound
 * @param {Array} [opts.misses] - {id?, name, reason} pushed per dropped entry
 * @returns {Promise<Array>} the entries that have photoData
 */
async function ensureLandmarkPhotoBytes(photos, opts = {}) {
  const { timeoutMs = 20000 } = opts;
  const misses = Array.isArray(opts.misses) ? opts.misses : null;
  const kept = [];
  for (const p of (photos || [])) {
    if (p.photoData) { kept.push(p); continue; }
    if (!p.photoUrl) {
      if (misses) misses.push({ name: p.name, reason: 'no photo bytes and no URL' });
      continue;
    }
    try {
      const res = await fetch(p.photoUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      p.photoData = `data:${mime};base64,${buf.toString('base64')}`;
      kept.push(p);
    } catch (err) {
      log.warn(`[LANDMARK-SCENE] "${p.name}": photo fetch failed (${err.message}) — dropping entry so no fidelity block ships without its photo`);
      if (misses) misses.push({ name: p.name, reason: `photo URL fetch failed: ${err.message}` });
    }
  }
  return kept;
}

/**
 * page → landmark-photo promise for the TRIAL early background plates.
 *
 * Registered synchronously (the outline-stream callback that calls this cannot
 * be async — an un-awaited promise on the stream handler), but every actual
 * resolution is deferred behind `descriptionsPromise`.
 *
 * THAT AWAIT IS THE WHOLE POINT. `decideLandmarkPhotoSource` — the policy half
 * of resolveLandmarkPhotoForLocation — runs on the resolver's first line,
 * BEFORE any await. `loadLandmarkPhotoDescriptions` is what writes
 * `loc.photoVariants`, and it is merely STARTED in the same tick as the plate
 * block. Calling the resolver straight away therefore always decided on a
 * variant-less location: the variant arm is skipped and the legacy arm needs
 * `photoFetchStatus === 'success'`, which a variant-backed Swiss landmark never
 * reaches. Result: null, i.e. a plate rendered with NO landmark photo and no
 * fidelity / REFERENCE line, while the page itself (which awaits the same
 * promise) got the photo. Measured on staging job_1789337873076_qf2at21ui p6.
 *
 * @param {Object} visualBible
 * @param {Object} [opts]
 * @param {Promise} [opts.descriptionsPromise] - loadLandmarkPhotoDescriptions()
 * @returns {Object<number, Promise<Object|null>>} page number → photo promise
 *   (never rejects; a failed resolve yields null)
 */
function trialPlateLandmarkPromisesByPage(visualBible, opts = {}) {
  const byPage = {};
  for (const loc of (visualBible?.locations || [])) {
    if (!loc.isRealLandmark || !loc.pages?.length) continue;
    const p = (async () => {
      if (opts.descriptionsPromise) await opts.descriptionsPromise;
      // One plate per location (trial bibles carry no vantages), so the photo
      // is the one the trial writer cited on the location's own entry.
      const photo = await resolveLandmarkPhotoForLocation(visualBible, loc, {
        citation: landmarkPhotoCitation(visualBible, loc, { pageNumber: loc.pages[0] }),
      });
      if (!photo) return null;
      // block ⇔ bytes: a legacy entry can resolve to a URL with no inline data,
      // and the fidelity block must never ship without the photo it describes.
      // Same guard the page path applies.
      const [withBytes] = await ensureLandmarkPhotoBytes([photo]);
      return withBytes || null;
    })().catch(err => {
      log.warn(`⚠️ [TRIAL] Landmark photo resolve failed for "${loc.name}": ${err.message}`);
      return null;
    });
    for (const pn of loc.pages) {
      if (!byPage[pn]) byPage[pn] = p;
    }
  }
  return byPage;
}

/**
 * Age → head-to-body ratio lookup, used both at avatar-generation time
 * (prescribes the expected proportion) and at image-evaluation time (verifies
 * the generated figure matches). Returns a string like "1:6" or null if age
 * is missing/non-numeric.
 *
 * Keep this the single source of truth — `styledAvatars.js` and
 * `images.js` both call it so the prescribed and checked ratios can't drift.
 */
function getHeadBodyRatio(age) {
  const n = parseInt(age, 10);
  if (!Number.isFinite(n)) return null;
  if (n <= 3) return '1:4';
  if (n <= 6) return '1:5';
  if (n <= 10) return '1:6';
  if (n <= 12) return '1:6.5';
  if (n <= 17) return '1:7';
  return '1:8';
}

module.exports = {
  // Everything the three domain modules export, forwarded by construction.
  ...clothingResolveModule,
  ...sceneMetadataModule,
  ...promptBuildersModule,

  // Config
  ART_STYLES,
  resolveArtStyle,
  resolveArtStyleForSheet,
  LANGUAGE_LEVELS,

  // Level helpers
  getReadingLevel,
  getTokensPerPage,

  // Page calculations
  calculateStoryPageCount,

  // Age category
  getAgeCategory,
  getAgeCategoryLabel,

  // Character helpers
  getCharactersInScene,
  unionPageCast,
  getCharacterPhotos,
  parseClothingCategory,
  parseCharacterClothing,
  getCharacterPhotoDetails,
  buildWholeCastReferencePhotos,
  prefetchAvatarBytesForCharacters,
  buildCharacterPhysicalDescription,
  extractCharacterVisualProfile,
  buildGroundingPrompt,
  resolveClothingForPage,
  buildSceneClothingRequirements,
  buildCharacterPromptBlock,
  buildRelativeHeightDescription,
  buildCharacterReferenceList,
  buildReferenceCardColours,
  buildCoverPrompt,
  buildCharacterRestriction,
  buildHairDescription,
  getHeadBodyRatio,

  // Text position
  enforceSpreadTextPosition,
  mirrorLeftRight,
  buildCharacterDescriptionsForBbox,
  buildSecondaryCharacterDescriptions,
  buildSecondaryExpectedCharacters,
  buildCastIdentityDescription,
  buildIdentityClothingText,
  buildIdentityLine,
  buildSecondaryExpectedForPage,
  buildTextZoneInstruction,
  buildEraGuard,
  buildLandmarkFidelityBlock,
  applyReferenceMode,

  // Parsers
  parseStoryPages,
  parseSceneDescriptions,
  extractShortSceneDescriptions,
  extractCoverScenes,
  extractPageClothing,
  extractSceneMetadata,
  collectSceneCharacterNames,
  findCastMissingFromMetadata,
  stripSceneMetadata,
  parseSceneHintMetadata,
  parseProseMetadataFormat,
  splitBrief,

  // Prompt builders
  buildBasePrompt,
  buildSceneExpansionPrompt,
  buildSceneExpansionAllPrompt,
  buildSceneDescriptionPrompt,
  buildSceneIterationPrompt: buildSceneDescriptionPrompt,  // Alias: iteration = full description prompt
  buildImagePrompt,
  // Worn-vs-held / state-aware page-prompt guard (unit-tested). The prose
  // matcher that used to sit beside this one was deleted 2026-09-18 — the
  // page path reads the declared wornItems row only.
  stripWornStateFromDescription,
  buildOutlineReviewPrompt,
  buildTextRefinePrompt,
  parseRefinedText,
  BRIEF_TRAILING_MARKERS,
  buildBeatsPrompt,
  buildChallengeIdeasSection,
  buildArcCreatePrompt,
  buildArcPanelPrompt,
  buildArcRetellPrompt,
  buildArcHintsPrompt,
  parseArcHints,
  parseArcCreate,
  parseArcRetell,
  parseStoryLogic,
  filterPanelFindings,
  filterCritiqueFaults,
  arcRepairFindings,
  splitCommittedBlock,
  arcShapeCounts,
  arcInventedAllowance,
  critiqueMaxSeverity,
  buildPlanCheckPrompt,
  parsePlanCheck,
  buildReplanSection,
  replanRank,
  countsTowardConvergence,
  replanRoundConverged,
  replanRoundRegressed,
  replanFindingKey,
  convergenceMustFixCount,
  findingPages,
  buildArcReviewPrompt,
  buildArcAuditPrompt,
  buildChildCriticPrompt,
  youngestMainAge,
  buildTextAuditPrompt,
  buildTextAuditBlindPrompt,
  buildTextProofreadPrompt,
  buildTextDiffPrompt,
  countFaults,
  faultsByCategory,
  buildStoryShapeSection,
  parseArcReview,
  buildClothingReviewPrompt,
  buildStyleWardrobeBlock,
  WORLD_ART_STYLES,
  parseClothingReview,
  buildSceneReviewPrompt,
  buildStoryTextFromBeatsPrompt,
  buildStoryBibleFromBeatsPrompt,
  buildDoNotWriteSection,
  parseBeats,
  parsePagePlan,
  parsePlanResponse,
  planBlocks,
  planInstant,
  buildTrialStoryPrompt,
  buildPreviousScenesContext,
  buildAvailableAvatarsForPrompt,

  // Teaching guides
  getTeachingGuide,
  getIdeaGuide,
  getAdventureGuide,
  getSceneComplexityGuide,

  // Historical locations
  preloadHistoricalLocations,
  getHistoricalLocations,

  // Historical objects (Visual Bible — period objects)
  preloadHistoricalObjects,
  getHistoricalObjects,

  // Landmark helpers
  getLandmarkPhotosForScene,
  resolveLandmarkPhotoForLocation,
  decideLandmarkPhotoSource,
  landmarkPhotoCitation,
  landmarkPhotoCitationFaults,
  ensureLandmarkPhotoBytes,
  trialPlateLandmarkPromisesByPage,
  buildAvailableLandmarksSection,

  // Location vantages (canvas-per-vantage pipeline)
  getPrimaryVantageForPage,
  resolvePagePlate,
  groupPagesByVantage,
  groupTrialPlatePagesByVantage,

  // Position utilities
  expandPositionAbbreviations,
  normalizePositionToLCR,
  POSITION_ABBREVIATIONS,

  // Entity ID stripping (for image prompts)
  stripEntityIds,
  sanitizeVbIdsInPrompt,

  // Character parsing for bbox matching
  parseCharacterDescriptions,

  // Age-word stripping for legacy face/distinguishing-mark text
  stripAgeWords,

  // Apparent-age clamp + helpers
  AGE_CATEGORY_ORDER,
  getAgeCategoryIndex,
  clampApparentAge,

  // Clothing format conversion
  convertClothingToCurrentFormat,

  // Page text helpers
  getPageText,
  updatePageText,

  // JSON extraction
  extractJsonFromText,

  // Exposed for testing
  wrapUserInput
};

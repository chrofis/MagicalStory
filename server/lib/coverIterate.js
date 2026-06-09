/**
 * Shared cover iterate logic — used by both manual iterate endpoint
 * and the auto repair pipeline.
 *
 * Extracts the core cover regeneration logic: character selection,
 * prompt building, landmark/VB grid, image generation.
 */

const { log } = require('../utils/logger');
const { MODEL_DEFAULTS, IMAGE_MODELS } = require('../config/models');
const { resolveArtStyle, resolveArtStyleForEmptyScene } = require('./storyHelpers');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { applyStyledAvatars } = require('./styledAvatars');
const { coverKeyToType, coverKeyToHintKey, coverLabel } = require('./coverKeys');

function getStoryHelpers() {
  return require('./storyHelpers');
}

/**
 * Iterate a cover page: rebuild prompt from templates, select characters,
 * build landmark/VB references, generate new image. The single entry point
 * for every cover-render call site — unified-pipeline auto-repair, dev-mode
 * iterate button, and user-triggered "regenerate cover" all funnel through
 * here so there's exactly one place that decides composite vs direct.
 *
 * @param {string} coverKey - 'frontCover' | 'initialPage' | 'backCover'
 * @param {Object} storyData - Full story data (characters, visualBible, etc.)
 * @param {Object} options
 * @param {string} [options.imageModel] - Image model override
 * @param {Object} [options.evaluationFeedback] - { score, reasoning, fixableIssues }
 * @param {boolean} [options.useOriginalAsReference] - Pass current image as reference
 * @param {boolean} [options.blackoutIssues] - Black out issue regions
 * @param {Function} [options.usageTracker] - Usage tracking callback
 * @param {Array} [options.freshCharacters] - Fresh characters from DB (optional, for avatar merging)
 * @param {Array<number>} [options.selectedCharacterIds] - Filter cover characters to this set of IDs (user-regenerate UI feature)
 * @returns {Promise<Object>} { imageData, score, reasoning, modelId, prompt, referencePhotos, landmarkPhotos, visualBibleGrid, grokRefImages }
 */
async function iterateCover(coverKey, storyData, options = {}) {
  const {
    imageModel = null,
    evaluationFeedback = null,
    useOriginalAsReference = false,
    blackoutIssues = false,
    usageTracker = null,
    freshCharacters = null,
    selectedCharacterIds = null,
  } = options;

  const {
    getCharacterPhotoDetails,
    parseClothingCategory,
    buildCharacterReferenceList,
    convertClothingToCurrentFormat,
  } = getStoryHelpers();

  const {
    generateImageWithQualityRetry,
    generateImageCacheKey,
    deleteFromImageCache,
    blackoutIssueRegions,
  } = require('./images');

  const { buildFullVisualBiblePrompt } = require('./visualBible');

  // Get existing cover data. After the R2 migration `imageData` is stripped
  // from the JSON blob on save (bytes live in story_images + R2 URLs), so
  // requiring `imageData` to be non-null falsely rejected migrated stories
  // — including the test-models composite-preview path, which doesn't read
  // the existing image at all. Just require the cover record to exist; the
  // few downstream branches that DO need bytes (useOriginalAsReference /
  // blackoutIssues) rehydrate from story_images on-demand below.
  storyData.coverImages = storyData.coverImages || {};
  const existingCover = storyData.coverImages[coverKey];
  if (!existingCover) {
    throw new Error(`No cover image found for ${coverKey}`);
  }

  // Strip any perspective/depth annotations from the cover description.
  // Covers are group portraits — every character must face the viewer (see story-unified.txt
  // COVER RULES). If Claude slipped a `, depth: background, perspective: back view` into a
  // cover Characters line, drop it here so the cover prompt never sees it.
  const stripCoverAnnotations = (text) => {
    if (!text || typeof text !== 'string') return text;
    let stripped = text.replace(/(\s*,\s*(?:depth|perspective|position)\s*:\s*[^,\r\n]+)+/gi, '');
    // Count how many lines we touched for logging
    const stripCount = (text.match(/(?:depth|perspective|position)\s*:/gi) || []).length;
    if (stripCount > 0) {
      log.warn(`🔄 [COVER-ITERATE] ${coverKey}: Stripped ${stripCount} perspective/depth annotation(s) from cover description (covers must show all characters facing forward)`);
    }
    return stripped;
  };
  const rawSceneDescription = existingCover.description || 'A beautiful illustrated cover page.';
  const sceneDescription = stripCoverAnnotations(rawSceneDescription);
  log.info(`🔄 [COVER-ITERATE] ${coverKey}: Using stored description (${sceneDescription.length} chars)`);

  // --- Art style ---
  const artStyleId = storyData.artStyle || 'pixar';
  const coverModel = MODEL_DEFAULTS.coverImage || MODEL_DEFAULTS.image;
  const coverBackend = IMAGE_MODELS[coverModel]?.backend || null;
  const styleDescription = resolveArtStyle(artStyleId, coverBackend) || resolveArtStyle('pixar');

  // --- Characters ---
  const characters = storyData.characters || [];
  const visualBible = storyData.visualBible || null;

  // Parse clothing from scene description
  const coverClothing = parseClothingCategory(sceneDescription) || 'standard';
  const clothingRequirements = convertClothingToCurrentFormat(storyData.clothingRequirements);

  // Merge avatars with fresh characters if provided
  const mergedCharacters = freshCharacters
    ? characters.map(storyChar => {
        if (storyChar.avatars) return storyChar;
        const freshChar = freshCharacters.find(fc => fc.id === storyChar.id || fc.name === storyChar.name);
        if (freshChar?.avatars) {
          log.debug(`🔄 [COVER-ITERATE] ${coverKey}: Using fresh avatars for ${storyChar.name}`);
          return { ...storyChar, avatars: freshChar.avatars };
        }
        return storyChar;
      })
    : characters;

  // Character selection: use cover hints (authoritative) > scene description > fallback
  const MAX_COVER_CHARACTERS = 5;
  const normalizedCoverType = coverKeyToType(coverKey);

  // Cover hints from outline — authoritative character list with per-character clothing
  const hintKey = coverKeyToHintKey(coverKey);
  const coverHint = storyData.coverHints?.[hintKey];
  const hintCharClothing = coverHint?.characterClothing;

  let coverCharacterPhotos;
  let selectedCoverCharacters;

  if (hintCharClothing && Object.keys(hintCharClothing).length > 0) {
    // Primary: use outline's character list (matches initial generation logic)
    const hintCharNames = Object.keys(hintCharClothing);
    selectedCoverCharacters = mergedCharacters.filter(c =>
      hintCharNames.some(name => name.toLowerCase() === c.name.toLowerCase())
    ).slice(0, MAX_COVER_CHARACTERS);
    // Merge hint clothing into clothingRequirements for avatar lookup
    const mergedClothing = { ...clothingRequirements };
    for (const [charName, clothing] of Object.entries(hintCharClothing)) {
      mergedClothing[charName] = { ...(mergedClothing[charName] || {}), _currentClothing: clothing };
    }
    coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, mergedClothing);
    log.info(`🔄 [COVER-ITERATE] ${coverKey}: Selected ${selectedCoverCharacters.map(c => c.name).join(', ')} from coverHints`);
  } else {
    // Fallback: extract characters mentioned in the scene description
    const sceneDescLower = sceneDescription.toLowerCase();
    const mentionedChars = mergedCharacters.filter(c => sceneDescLower.includes(c.name.toLowerCase()));

    if (mentionedChars.length > 0) {
      selectedCoverCharacters = mentionedChars.slice(0, MAX_COVER_CHARACTERS);
      log.info(`🔄 [COVER-ITERATE] ${coverKey}: Selected ${selectedCoverCharacters.map(c => c.name).join(', ')} from scene description`);
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, clothingRequirements);
    } else {
      // Last fallback: main chars for front, split for others
      const mainChars = mergedCharacters.filter(c => c.isMainCharacter === true);
      const nonMainChars = mainChars.length > 0
        ? mergedCharacters.filter(c => !c.isMainCharacter)
        : mergedCharacters;
      if (normalizedCoverType === 'front') {
        selectedCoverCharacters = mainChars.length > 0 ? mainChars : mergedCharacters;
      } else {
        const mainCapped = mainChars.slice(0, MAX_COVER_CHARACTERS);
        const extraSlots = Math.max(0, MAX_COVER_CHARACTERS - mainCapped.length);
        const halfPoint = Math.ceil(nonMainChars.length / 2);
        const extras = normalizedCoverType === 'initialPage'
          ? nonMainChars.slice(0, halfPoint).slice(0, extraSlots)
          : nonMainChars.slice(halfPoint).slice(0, extraSlots);
        selectedCoverCharacters = [...mainCapped, ...extras];
      }
      selectedCoverCharacters = selectedCoverCharacters.slice(0, MAX_COVER_CHARACTERS);
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, clothingRequirements);
    }
  }

  // User-supplied character filter (the "Regenerate cover" UI lets the user
  // pick which characters appear). When provided, restrict selectedCover
  // Characters to that set — overrides hint/scene-description selection.
  if (Array.isArray(selectedCharacterIds) && selectedCharacterIds.length > 0) {
    const filterSet = new Set(selectedCharacterIds);
    const filtered = selectedCoverCharacters.filter(c => filterSet.has(c.id));
    if (filtered.length > 0) {
      const dropped = selectedCoverCharacters.filter(c => !filterSet.has(c.id)).map(c => c.name);
      if (dropped.length > 0) log.info(`🔄 [COVER-ITERATE] ${coverKey}: User filter dropped: ${dropped.join(', ')}`);
      selectedCoverCharacters = filtered;
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, clothingRequirements);
    }
  }

  // Back cover is a main-characters-only group portrait (same rule as front cover).
  // Drop any supporting characters that slipped in through the hint or scene description.
  if (normalizedCoverType === 'back' && selectedCoverCharacters.length > 0) {
    const mainIds = Array.isArray(storyData.mainCharacters) ? storyData.mainCharacters : [];
    const isMainChar = (c) =>
      c.isMainCharacter === true || (mainIds.length > 0 && mainIds.includes(c.id));
    const mainOnly = selectedCoverCharacters.filter(isMainChar);
    if (mainOnly.length > 0 && mainOnly.length !== selectedCoverCharacters.length) {
      const dropped = selectedCoverCharacters.filter(c => !isMainChar(c)).map(c => c.name).join(', ');
      log.info(`🔄 [COVER-ITERATE] backCover: Dropping non-main characters: ${dropped}`);
      selectedCoverCharacters = mainOnly;
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, clothingRequirements);
    }
  }

  // Apply styled avatars (skip if photos already have styled data from story persistence)
  const allAlreadyStyled = coverCharacterPhotos.every(p =>
    p.photoType?.startsWith('styled-') || p.photoType?.startsWith('costumed-')
  );
  if (!allAlreadyStyled && !coverClothing.startsWith('costumed')) {
    coverCharacterPhotos = applyStyledAvatars(coverCharacterPhotos, artStyleId);
  }
  // Phase 7: cell-crop refs from story-scoped 2×4 sheets when present.
  // Covers use front pose by default (head-on shot).
  {
    const sav = require('./storyAvatars');
    const fakeMeta = (coverCharacterPhotos || []).map(p => ({ name: p.name, pose: 'front', flip: false }));
    await sav.applyStoryCellRefs(coverCharacterPhotos, storyData.characterAvatars || null, fakeMeta);
  }

  log.debug(`🔄 [COVER-ITERATE] ${coverKey}: ${coverCharacterPhotos.length} characters, clothing: ${coverClothing}`);

  // --- Build cover prompt ---
  const visualBiblePrompt = visualBible ? buildFullVisualBiblePrompt(visualBible, { skipMainCharacters: true }) : '';
  const storyTitle = storyData.title || 'My Story';
  const coverDedication = storyData.dedication;

  let coverPrompt;
  if (normalizedCoverType === 'front') {
    coverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
      TITLE_PAGE_SCENE: sceneDescription,
      STYLE_DESCRIPTION: styleDescription,
      STORY_TITLE: storyTitle,
      CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(coverCharacterPhotos, storyData.characters),
      VISUAL_BIBLE: visualBiblePrompt
    });
  } else if (normalizedCoverType === 'initialPage') {
    coverPrompt = coverDedication
      ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
          INITIAL_PAGE_SCENE: sceneDescription,
          STYLE_DESCRIPTION: styleDescription,
          DEDICATION: coverDedication,
          CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(coverCharacterPhotos, storyData.characters),
          VISUAL_BIBLE: visualBiblePrompt
        })
      : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
          INITIAL_PAGE_SCENE: sceneDescription,
          STYLE_DESCRIPTION: styleDescription,
          STORY_TITLE: storyTitle,
          CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(coverCharacterPhotos, storyData.characters),
          VISUAL_BIBLE: visualBiblePrompt
        });
  } else {
    coverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
      BACK_COVER_SCENE: sceneDescription,
      STYLE_DESCRIPTION: styleDescription,
      CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(coverCharacterPhotos, storyData.characters),
      VISUAL_BIBLE: visualBiblePrompt
    });
  }

  // Append evaluation feedback
  if (evaluationFeedback) {
    const feedbackParts = [];
    if (evaluationFeedback.reasoning) {
      feedbackParts.push(`IMPORTANT - The previous generation had these quality issues that MUST be fixed:\n${evaluationFeedback.reasoning}`);
    }
    if (evaluationFeedback.fixableIssues?.length > 0) {
      feedbackParts.push('Specific problems to avoid:\n' +
        evaluationFeedback.fixableIssues.slice(0, 10).map(i => `- ${i.description || i.issue || i}`).join('\n'));
    }
    if (feedbackParts.length > 0) {
      coverPrompt = `${coverPrompt}\n\n${feedbackParts.join('\n\n')}`;
      log.info(`🔄 [COVER-ITERATE] ${coverKey}: Appended evaluation feedback (score: ${evaluationFeedback.score ?? 'N/A'})`);
    }
  }

  // Clear cache
  const cacheKey = generateImageCacheKey(coverPrompt, coverCharacterPhotos, null);
  deleteFromImageCache(cacheKey);

  // --- Build reference images ---
  // Rehydrate imageData on demand only for the two branches that actually
  // need the bytes. After R2 migration `existingCover.imageData` is usually
  // null; the active version's bytes live in story_images. Without this,
  // blackoutIssueRegions / useOriginalAsReference passed null and downstream
  // sharp operations threw "Input buffer contains unsupported image format".
  let previousImage = null;
  const needsImageBytes = blackoutIssues || useOriginalAsReference;
  let rehydratedCoverBytes = existingCover.imageData;
  if (needsImageBytes && !rehydratedCoverBytes) {
    try {
      const { getActiveVersion, getStoryImage } = require('../services/database');
      const storyId = storyData.id || storyData.storyId;
      if (storyId) {
        const activeIdx = await getActiveVersion(storyId, coverKey);
        const row = await getStoryImage(storyId, coverKey, null, activeIdx);
        rehydratedCoverBytes = row?.imageData || null;
        if (rehydratedCoverBytes) {
          log.info(`🔄 [COVER-ITERATE] ${coverKey}: Rehydrated active version imageData from story_images (v${activeIdx})`);
        }
      }
    } catch (rehydrateErr) {
      log.warn(`🔄 [COVER-ITERATE] ${coverKey}: Rehydrate failed: ${rehydrateErr.message}`);
    }
  }
  if (blackoutIssues) {
    const fixTargets = existingCover.fixTargets || [];
    if (fixTargets.length > 0 && rehydratedCoverBytes) {
      log.info(`🔄 [COVER-ITERATE] ${coverKey}: Blacking out ${fixTargets.length} issue regions`);
      previousImage = await blackoutIssueRegions(rehydratedCoverBytes, fixTargets);
    } else {
      previousImage = rehydratedCoverBytes;
    }
  } else if (useOriginalAsReference) {
    previousImage = rehydratedCoverBytes;
  }

  // --- Build cover references (landmark photos, empty-scene plate, VB grid) ---
  // Shared with the streaming initial-gen path so v0 and iterate use the same anchors.
  const coverLabelStr = coverLabel(coverKey);
  const refs = await buildCoverReferences({
    coverKey,
    visualBible,
    artStyle: storyData.artStyle,
    sceneDescription,
    coverHint,
    logLabel: `${coverLabelStr} ITERATE`,
  });
  const {
    landmarkPhotos: coverLandmarkPhotos,
    visualBibleGrid: coverVbGrid,
    sceneBackground: coverSceneBackground,
    sceneMetadata: coverSceneMetadata,
  } = refs;

  // --- Composite Cover branch (flag-gated) ──────────────────────────────
  // When MODEL_DEFAULTS.compositeCovers is true (or modelOverrides override),
  // skip the normal generation path and use the manual-composite + 2-pass
  // Grok edit method. Same return shape so all callers stay agnostic.
  const compositeOn = options.compositeCovers === true
    || MODEL_DEFAULTS.compositeCovers === true;
  if (compositeOn) {
    try {
      const { generateCoverViaComposite } = require('./coverComposite');
      // Pull artifact images from the visual bible so the composite layer
      // has the prop bytes ready.
      const enrichedHint = { ...(coverHint || {}) };
      enrichedHint._artifactImages = {};
      enrichedHint._artifactNames = {};
      for (const id of (coverHint?.objects || [])) {
        if (!/^ART\d+/.test(String(id))) continue;
        const art = (visualBible?.artifacts || []).find(a => a?.id === id);
        if (!art) continue;
        enrichedHint._artifactNames[id] = art.name || id;
        const src = art.referenceImageUrl || art.referenceImageData;
        if (src) enrichedHint._artifactImages[id] = src;
      }
      // First landmark photo for the cover
      const landmarkBuf = coverLandmarkPhotos?.[0]
        ? await loadLandmarkBytes(coverLandmarkPhotos[0])
        : null;
      // Composite path requires a real landmark photo for pass 2 (the
      // photo-protection edit). Without one, pass 2 is skipped and pass 1
      // returns figures-on-white — which then gets padded with gray bars
      // to fit the page aspect. For invented locations (no photo) we want
      // a full backdrop, not a white plate, so route those through the
      // normal generation path below where the LOC's prose description
      // drives the backdrop directly.
      if (!landmarkBuf) {
        log.info(`🎨 [COVER-ITERATE] ${coverKey}: no landmark photo for composite path — using normal generation with location prose`);
        // Fall through to the normal path. No throw, just skip the
        // composite branch entirely so generateImageWithQualityRetry runs.
      } else {
      const compositeResult = await generateCoverViaComposite({
        coverKey,
        // Use mergedCharacters (with fresh avatars merged) so the composite
        // pulls the same costumed avatars the rest of the pipeline uses.
        characters: mergedCharacters,
        coverHint: enrichedHint,
        // Pass the full scene prose so pass-1 / pass-2 prompts can include
        // the story-specific action (Emma holds the Schatztruhe with eyes on
        // contents, Noah gazes at the Schatzkarte). Without this the
        // composite fell back to generic positional pose templates and the
        // model invented arbitrary poses that contradicted the story.
        sceneDescription,
        // VB grid as a second image slot for pass 1. The grid carries
        // reference cells for every artifact / animal / secondary character
        // referenced by the cover hint. Pass 1 was previously blind to these
        // — only the first artifact was pasted into the input image as a
        // single "prop" buffer; multiple artifacts (Schatztruhe + Schatzkarte
        // in one scene), animals, and secondary characters had no visual
        // reference at all and Grok rendered them generically. Sending the
        // VB grid as a labeled second image gives Grok the actual look of
        // each element it should depict in the figures' hands.
        vbGrid: coverVbGrid,
        landmarkBuf,
        // sceneBackground = already-styled manga/watercolor empty scene of
        // the landmark, generated earlier by packReferences-equivalent code
        // around line 600 of this file. When present, the composite path
        // uses it as the figure backdrop and runs ONE Grok refinement edit
        // (no style transfer, no landmark protection needed — both are
        // already baked into the empty scene). Without this V2/V3/V4 of
        // job_1780564110486_g4gn4vzvu all dropped the landmark on pass 2.
        sceneBackground: coverSceneBackground,
        artStyle: storyData.artStyle || 'watercolor',
        title: storyData.title || '',
        dedication: storyData.dedication || '',
        styleHint: styleDescription,
        usageTracker,
      });
      log.info(`🎨 [COVER-ITERATE] ${coverKey}: composite-cover generated (modelId=${compositeResult.modelId})`);
      return {
        imageData: compositeResult.imageData,
        score: null, // composite path skips quality eval — returns immediately
        reasoning: 'composite-cover (no quality eval)',
        modelId: compositeResult.modelId,
        totalAttempts: compositeResult.totalAttempts || 1,
        prompt: compositeResult.prompt,
        referencePhotos: coverCharacterPhotos,
        landmarkPhotos: coverLandmarkPhotos,
        visualBibleGrid: null,
        grokRefImages: null,
        usage: { cost: 0.04, direct_cost: 0.04 }, // 2 Grok edits
        previousImage: rehydratedCoverBytes,
        previousScore: existingCover.qualityScore || null,
        compositeDebug: compositeResult.debug,
      };
      } // close else (landmarkBuf present)
    } catch (err) {
      log.warn(`⚠️ [COVER-ITERATE] composite path failed: ${err.message} — falling back to normal path`);
    }
  }

  // --- Generate image ---
  const imageResult = await generateImageWithQualityRetry(
    coverPrompt, coverCharacterPhotos, previousImage, 'cover', null, usageTracker, null,
    { imageModel: imageModel || null },
    `${coverLabelStr} ITERATE`,
    { landmarkPhotos: coverLandmarkPhotos, visualBibleGrid: coverVbGrid, sceneCharacters: selectedCoverCharacters, sceneMetadata: coverSceneMetadata, sceneBackground: coverSceneBackground }
  );

  log.info(`🔄 [COVER-ITERATE] ${coverKey}: Generated (score: ${imageResult.score}, attempts: ${imageResult.totalAttempts})`);

  return {
    imageData: imageResult.imageData,
    score: imageResult.score,
    reasoning: imageResult.reasoning,
    modelId: imageResult.modelId,
    totalAttempts: imageResult.totalAttempts,
    prompt: coverPrompt,
    referencePhotos: coverCharacterPhotos,
    landmarkPhotos: coverLandmarkPhotos,
    visualBibleGrid: coverVbGrid ? `data:image/jpeg;base64,${coverVbGrid.toString('base64')}` : null,
    grokRefImages: imageResult.grokRefImages || null,
    usage: imageResult.usage,
    previousImage: rehydratedCoverBytes,
    previousScore: existingCover.qualityScore || null,
  };
}

// Helper: turn a landmark-photo entry from getLandmarkPhotosForScene
// (could be { photoUrl, photoData, ... }) into a Buffer.
async function loadLandmarkBytes(lm) {
  if (!lm) return null;
  const r2 = require('./r2');
  const candidates = [lm.photoUrl, lm.photoData].filter(s => typeof s === 'string' && s.length > 0);
  for (const src of candidates) {
    try {
      const buf = await r2.bytesFromAnyImage(src);
      if (buf) return buf;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Build the cover-specific reference set (landmark photos, optional empty-scene
 * background plate, VB grid) so initial-gen and iterate can both use the same
 * anchors. Returns the same shape both call sites pass into
 * generateImageWithQualityRetry's options bag.
 *
 * @param {Object} args
 * @param {string} args.coverKey - 'frontCover' | 'initialPage' | 'backCover'
 * @param {Object} [args.visualBible]
 * @param {string} [args.artStyle]
 * @param {string} args.sceneDescription
 * @param {Object} [args.coverHint] - storyData.coverHints[hintKey]: { objects: ['LOC###','ART###',...] }
 * @param {Object} [args.sceneMetadata] - pre-computed metadata from scene expansion. When provided, replaces the extractSceneMetadata + landmark-name-match path.
 * @param {string} [args.imageModel] - empty-scene model override
 * @param {string} [args.imageBackend] - empty-scene backend override
 * @param {string} [args.emptyScenePromptOverride] - structured emptyScenePrompt from scene expansion
 * @param {Function} [args.usageTracker] - (usage, modelId) => void for empty-scene cost tracking
 * @param {string} [args.logLabel] - prefix for log lines (defaults to cover label)
 * @returns {Promise<{landmarkPhotos: Array, visualBibleGrid: Buffer|null, sceneBackground: string|null, sceneMetadata: Object|null, coverPageNumber: number}>}
 */
async function buildCoverReferences({
  coverKey,
  visualBible,
  artStyle,
  sceneDescription,
  coverHint = null,
  sceneMetadata: sceneMetadataInput = null,
  imageModel = null,
  imageBackend = null,
  emptyScenePromptOverride = null,
  usageTracker = null,
  logLabel = null,
}) {
  const { resolveArtStyle, resolveArtStyleForEmptyScene, extractSceneMetadata, getLandmarkPhotosForScene } = getStoryHelpers();
  const { generateImageOnly, buildVisualBibleGrid, buildEmptySceneVbGrid } = require('./images');
  const { getElementReferenceImagesForPage, getElementReferenceImagesByIds } = require('./visualBible');

  const label = logLabel || coverLabel(coverKey);

  // Resolve scene metadata: caller-provided wins; otherwise try parsing the
  // description (rarely succeeds for covers — they're plain prose) and fall
  // back to name-matching real landmarks against the text.
  let sceneMetadata = sceneMetadataInput || extractSceneMetadata(sceneDescription);
  if (!sceneMetadata && visualBible?.locations) {
    const matchedObjects = [];
    const sceneTextLower = (sceneDescription || '').toLowerCase();
    for (const loc of visualBible.locations) {
      if (!loc.isRealLandmark) continue;
      const nameMatch = loc.name && sceneTextLower.includes(loc.name.toLowerCase());
      const queryMatch = loc.landmarkQuery && sceneTextLower.includes(loc.landmarkQuery.toLowerCase());
      if (nameMatch || queryMatch) {
        matchedObjects.push(loc.id ? `${loc.name} [${loc.id}]` : loc.name);
      }
    }
    if (matchedObjects.length > 0) {
      sceneMetadata = { objects: matchedObjects };
    }
  }

  // Merge LOC IDs from coverHint.objects into sceneMetadata.objects so the
  // landmark photo lookup picks them up (cover scene expansion typically
  // emits ART IDs only — without this merge the explicit landmark from the
  // outline would be silently dropped).
  //
  // Photo-bearing non-landmarks (curated locations like Limmatufer) need a
  // separate channel: getLandmarkPhotosForScene gates on isRealLandmark and
  // would drop them. Track them here and append directly to landmarkPhotos
  // below so the composite-cover pipeline gets a backdrop.
  const photoOnlyLocs = [];
  if (coverHint?.objects && coverHint.objects.length > 0 && visualBible?.locations) {
    const matchedLocs = [];
    for (const id of coverHint.objects) {
      if (typeof id !== 'string' || !/^LOC\d+/i.test(id)) continue;
      const loc = visualBible.locations.find(l => l.id && l.id.toUpperCase() === id.toUpperCase());
      if (!loc) continue;
      const hasPhoto = !!(loc.referenceImageUrl || loc.referenceImageData);
      if (loc.isRealLandmark) {
        matchedLocs.push(`${loc.name} [${loc.id}]`);
      } else if (hasPhoto) {
        // Curated photo location — usable as a cover backdrop even though it's
        // not a real Wikidata-sourced landmark. Don't go through
        // getLandmarkPhotosForScene (which gates on isRealLandmark); load
        // directly and append to landmarkPhotos.
        photoOnlyLocs.push({
          name: loc.name,
          photoUrl: loc.referenceImageUrl || null,
          photoData: loc.referenceImageData || null,
          source: 'curated-non-landmark',
          attribution: loc.attribution || null,
        });
        log.info(`🔗 [COVER-REFS] ${label}: using curated photo from ${loc.id} (${loc.name}) — not a real landmark but has a usable photo`);
      } else {
        log.info(`🔗 [COVER-REFS] ${label}: invented location ${loc.id} (${loc.name}) — composite path skipped, using normal generation`);
      }
    }
    if (matchedLocs.length > 0) {
      const existing = (sceneMetadata?.objects || []).filter(Boolean);
      const existingLocSet = new Set(
        existing
          .map(o => (typeof o === 'string' ? o : o?.id || '').match(/LOC\d+/i)?.[0]?.toUpperCase())
          .filter(Boolean)
      );
      const toAppend = matchedLocs.filter(m => !existingLocSet.has(m.match(/LOC\d+/i)?.[0]?.toUpperCase()));
      sceneMetadata = { ...(sceneMetadata || {}), objects: [...existing, ...toAppend] };
    }
  }

  let landmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, sceneMetadata) : [];
  // Append curated non-landmark photos so the composite path's landmarkBuf
  // resolves and pass 2 (watercolor + landmark) actually runs. Without this
  // back covers whose outline picked a curated location (e.g. Limmatufer
  // Baden) silently fell back to figures-on-white because pass 2 was skipped.
  if (photoOnlyLocs.length > 0) {
    landmarkPhotos = [...landmarkPhotos, ...photoOnlyLocs];
  }

  // Cover page numbers follow the convention used across entityConsistency, repair
  // workflow, and the streaming generator: -1 frontCover, -2 initialPage, -3 backCover.
  const COVER_PAGE_NUMBERS = { frontCover: -1, initialPage: -2, backCover: -3 };
  const coverPageNumber = COVER_PAGE_NUMBERS[coverKey] ?? -1;

  // --- Generate empty scene for style anchoring ---
  // Respect MODEL_DEFAULTS.singlePassScene: when true (the default), pages render
  // in a single pass with no plate.
  let sceneBackground = null;
  if (MODEL_DEFAULTS.singlePassScene === true) {
    log.info(`🎛️ [COVER-REFS] ${label}: singlePassScene=true — skipping empty-scene plate`);
  } else {
    try {
      const artStyleDesc = resolveArtStyleForEmptyScene(artStyle || 'pixar')
        || resolveArtStyle(artStyle || 'pixar')
        || '';
      const emptyDesc = emptyScenePromptOverride
        || `**SETTING:** ${sceneDescription}\n**CAMERA:** wide shot`;
      const { buildEmptyScenePrompt } = require('../services/prompts');
      const emptyPrompt = buildEmptyScenePrompt({
        style: artStyleDesc,
        description: emptyDesc,
      });
      const emptySceneVbGrid = await buildEmptySceneVbGrid(visualBible, coverPageNumber, landmarkPhotos);
      const emptyOptions = {
        landmarkPhotos,
        visualBibleGrid: emptySceneVbGrid,
        skipCache: true,
        aspectRatio: MODEL_DEFAULTS.coverAspect
      };
      if (imageModel) emptyOptions.imageModelOverride = imageModel;
      if (imageBackend) emptyOptions.imageBackendOverride = imageBackend;
      const emptyResult = await generateImageOnly(emptyPrompt, [], emptyOptions);
      if (emptyResult?.imageData) {
        sceneBackground = emptyResult.imageData;
        log.info(`🎬 [COVER-REFS] ${label}: empty scene generated for style anchoring`);
        if (usageTracker && emptyResult.usage) {
          usageTracker(emptyResult.usage, emptyResult.modelId);
        }
      }
    } catch (err) {
      log.warn(`⚠️ [COVER-REFS] ${label}: empty scene failed: ${err.message}`);
    }
  }

  // --- Build VB grid ---
  let visualBibleGrid = null;
  if (visualBible) {
    let elementRefs = getElementReferenceImagesForPage(visualBible, coverPageNumber, 6);
    if (sceneBackground) {
      elementRefs = elementRefs.filter(e => e.type !== 'location');
    }
    // Merge IDs from coverHint.objects + sceneMetadata.fullData.
    const sceneIds = [];
    for (const id of coverHint?.objects || []) {
      if (typeof id === 'string' && !id.startsWith('LOC')) sceneIds.push(id.toUpperCase());
    }
    if (sceneMetadata?.fullData) {
      for (const char of sceneMetadata.fullData.characters || []) {
        if (char.id && char.id !== 'null') sceneIds.push(char.id);
      }
      for (const obj of sceneMetadata.fullData.objects || []) {
        const id = typeof obj === 'string' ? obj.match(/((?:ART|OBJ|CHR|VEH)\d+)/i)?.[1] : obj?.id;
        if (id && !id.startsWith('LOC')) sceneIds.push(id);
      }
    }
    if (sceneIds.length > 0) {
      const idBasedRefs = getElementReferenceImagesByIds(visualBible, sceneIds);
      const existingIds = new Set(elementRefs.map(r => r.id));
      const newRefs = idBasedRefs.filter(r => !existingIds.has(r.id));
      if (newRefs.length > 0) {
        log.info(`🔗 [VB-MATCH] Cover ${label}: Added ${newRefs.length} element(s) by scene hint ID: ${newRefs.map(r => r.id).join(', ')}`);
        elementRefs = [...elementRefs, ...newRefs].slice(0, 6);
      }
    }
    // Safety net: name-match VB entries against the description when nothing else matched.
    if (elementRefs.length === 0) {
      const descLower = (sceneDescription || '').toLowerCase();
      const nameMatched = [];
      const checkEntries = (entries, type, priority) => {
        for (const entry of entries || []) {
          if ((!entry.referenceImageData && !entry.referenceImageUrl) || !entry.name) continue;
          if (!descLower.includes(entry.name.toLowerCase())) continue;
          nameMatched.push({
            id: entry.id,
            name: entry.name,
            type,
            description: entry.extractedDescription || entry.description,
            referenceImageData: entry.referenceImageData,
            referenceImageUrl: entry.referenceImageUrl,
            priority,
          });
        }
      };
      checkEntries(visualBible.secondaryCharacters, 'character', 1);
      checkEntries(visualBible.animals, 'animal', 2);
      checkEntries(visualBible.artifacts, 'artifact', 3);
      checkEntries(visualBible.vehicles, 'vehicle', 4);
      if (nameMatched.length > 0) {
        nameMatched.sort((a, b) => a.priority - b.priority);
        elementRefs = nameMatched.slice(0, 6);
        log.info(`🔗 [VB-NAME-MATCH] Cover ${label}: Matched ${elementRefs.length} VB entries by name: ${elementRefs.map(r => r.id || r.name).join(', ')}`);
      }
    }
    const secondaryLandmarks = landmarkPhotos.slice(1);
    if (elementRefs.length > 0 || secondaryLandmarks.length > 0) {
      visualBibleGrid = await buildVisualBibleGrid(elementRefs, secondaryLandmarks);
    }
  }

  if (landmarkPhotos.length > 0 || visualBibleGrid) {
    log.debug(`🔗 [COVER-REFS] ${label}: ${landmarkPhotos.length} landmark photos, VB grid: ${visualBibleGrid ? 'yes' : 'no'}`);
  }

  return { landmarkPhotos, visualBibleGrid, sceneBackground, sceneMetadata, coverPageNumber };
}

/**
 * Build a deterministic SCENE prose string from a structured coverHint.
 *
 * This REPLACES the previous Haiku scene-expansion call for covers. The
 * outline already produced everything we need (mood + objects + per-
 * character details with holds/gazesAt/priority); this function templates
 * those structured fields into the SCENE string the cover prompt templates
 * (frontCover.txt / initialPage*.txt / backCover.txt) expect.
 *
 * Zero LLM calls. Pure JavaScript. Same result every time for the same input.
 *
 * Used by:
 *  - server.js streaming cover initial-gen (no second LLM call needed)
 *  - coverIterate.js iterate path (when stored description is missing or
 *    the caller wants a fresh deterministic rebuild)
 *  - regeneration.js user-triggered regenerate
 *
 * @param {Object} hint - coverHint shape from extractCoverHints():
 *                        { mood, objects, characterDetails, characters,
 *                          characterClothing, hint? }
 * @param {Object} visualBible - story.visualBible (for landmark + artifact name lookup)
 * @param {Array<Object>} characters - scene characters with physical traits
 * @returns {string} SCENE prose ready to drop into the cover prompt template
 */
function buildCoverSceneFromHint(hint, visualBible, characters) {
  if (!hint) return '';

  // Resolve landmark name from the first LOC### in objects
  const objects = Array.isArray(hint.objects) ? hint.objects : [];
  const locId = objects.find(o => typeof o === 'string' && /^LOC\d+/i.test(o));
  const loc = locId && Array.isArray(visualBible?.locations)
    ? visualBible.locations.find(l => l?.id && l.id.toUpperCase() === locId.toUpperCase())
    : null;
  const landmarkName = loc?.name || (locId ? 'the landmark' : 'a scenic outdoor setting');

  // Resolve artifact names from any ART### in objects
  const artMap = {};
  const artifacts = Array.isArray(visualBible?.artifacts) ? visualBible.artifacts : [];
  for (const o of objects) {
    if (typeof o !== 'string' || !/^ART\d+/i.test(o)) continue;
    const art = artifacts.find(a => a?.id && a.id.toUpperCase() === o.toUpperCase());
    if (art?.name) artMap[o.toUpperCase()] = art.name;
  }

  // Resolve gaze targets — same artifact-name lookup, plus pass-through for
  // viewer / distance / another character's name.
  const resolveGazeTarget = (gazesAt) => {
    if (!gazesAt) return '';
    const trimmed = String(gazesAt).trim();
    const m = trimmed.match(/^(ART\d+)/i);
    if (m && artMap[m[1].toUpperCase()]) return `the ${artMap[m[1].toUpperCase()]}`;
    if (/^the (viewer|camera)$/i.test(trimmed)) return 'the viewer';
    if (/^the distance$/i.test(trimmed)) return 'into the distance';
    return trimmed; // a character name or freeform target
  };

  // Sort characters by priority (essential first, then normal, then low) so
  // the most important figures lead the prose.
  const PRIO_RANK = { essential: 0, normal: 1, low: 2 };
  const details = (hint.characterDetails && typeof hint.characterDetails === 'object')
    ? Object.values(hint.characterDetails)
    : [];
  const sortedDetails = details
    .filter(d => d && d.name)
    .sort((a, b) => (PRIO_RANK[a.priority] ?? 1) - (PRIO_RANK[b.priority] ?? 1));

  const charSentences = sortedDetails.map(d => {
    const pos = d.position ? `in the ${d.position}` : '';
    const physChar = Array.isArray(characters)
      ? characters.find(c => c?.name === d.name)
      : null;
    // Brief physical descriptor — the cover prompt template's CHARACTER_REFERENCE_LIST
    // also provides per-character details, but mentioning the name in prose ties
    // pose to identity.
    const physTraits = physChar
      ? [physChar.age && `${physChar.age}-year-old`, physChar.gender].filter(Boolean).join(' ')
      : '';
    const intro = physTraits ? `${d.name}, ${physTraits},` : `${d.name}`;

    // Action: holds + gaze, resolved.
    const holds = String(d.holds || '').trim();
    const gaze = String(d.gazesAt || '').trim();
    const parts = [];
    if (pos) parts.push(`stands ${pos}`);
    if (holds && holds.toLowerCase() !== 'nothing') {
      const m = holds.match(/^(ART\d+)/i);
      const name = m && artMap[m[1].toUpperCase()] ? artMap[m[1].toUpperCase()] : holds;
      parts.push(`holds the ${name}`);
    }
    if (gaze) {
      const target = resolveGazeTarget(gaze);
      if (target) parts.push(`eyes on ${target}`);
    }
    return `${intro} ${parts.join(', ')}.`;
  });

  // Mood at the front; landmark behind everything; per-character sentences.
  const moodPhrase = hint.mood ? `${hint.mood[0].toUpperCase()}${hint.mood.slice(1)}.` : '';
  // Scale the composition phrase to the actual cast. "Group portrait" with only
  // one or two named characters makes the model invent extra strangers to fill
  // out the "group" — so only say "group" for 3+; otherwise state the exact
  // count and forbid extra figures.
  const nChars = sortedDetails.length;
  const sceneStarter = nChars >= 3
    ? `A wide group portrait set before ${landmarkName}.`
    : nChars === 2
      ? `A portrait of two characters set before ${landmarkName}. Only these two people appear; no other figures, no crowd.`
      : `A portrait of a single character set before ${landmarkName}. Only this one person appears; no other figures, no crowd.`;
  const lines = [moodPhrase, sceneStarter, ...charSentences].filter(Boolean);
  return lines.join(' ');
}

module.exports = { iterateCover, buildCoverReferences, buildCoverSceneFromHint };

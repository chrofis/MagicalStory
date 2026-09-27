'use strict';

/**
 * THE STORY RUN'S PLATES — one implementation for the story run
 * (storyJobPipeline.js Phase 5a-pre-vantage and Phase 5a-pre) and the Test Lab
 * `empty_scene` stage.
 *
 * Moved here verbatim on 2026-09-27 (owner: "The Lab must use 100% identical
 * code to production"). The Lab stage had rebuilt the plate call itself: the
 * mask came from getTextAreaMask(ctx.textPosition) instead of the spread-rule
 * position the run masks with, there was no QC retry, and a vantage page's
 * plate was painted from the page's OWN plate text, shot, light and objects
 * instead of the vantage's representative page — so a Lab plate for a shared
 * vantage was a different picture from the one the run gave that page. Both
 * callers now run these two functions; the Lab reconstructs `pageDataArray`
 * from the stored pages with the run's own builders.
 *
 * Pinned by tests/unit/lab-prod-call-parity.test.ts.
 */

const { log } = require('./serverLog');

/**
 * validateEmptyScene, with every verdict also handed to `onQc` — the Test Lab
 * reports each attempt's verdict. The run passes no observer and gets the
 * validator itself.
 */
function observedValidateEmptyScene(onQc) {
  const { validateEmptyScene } = require('./images');
  if (!onQc) return validateEmptyScene;
  return async (image, textPosition, label, opts) => {
    const qc = await validateEmptyScene(image, textPosition, label, opts);
    onQc({ label, textPosition, opts, qc });
    return qc;
  };
}

/**
 * buildEmptyScenePrompt, with a Test Lab A/B template (the stage's
 * promptOverride) when one is given. The run passes none.
 */
function plateTemplateBuilder(template) {
  const { buildEmptyScenePrompt } = require('../services/prompts');
  return template ? (opts) => buildEmptyScenePrompt({ ...opts, template }) : buildEmptyScenePrompt;
}

/**
 * The outline hint's own plate text (`emptyScenePrompt` in a JSON scene hint),
 * or null. The run's `pageData.emptyScenePrompt`; the stored page keeps the
 * hint as `outlineExtract` / `sceneHint`, so a replay reads the same value.
 */
function outlineEmptyScenePromptOf(scene) {
  let outlineEmptyScenePrompt = null;
  try {
    const hintJson = scene?.sceneHint || scene?.outlineExtract || '';
    if (hintJson.includes('{')) {
      const parsed = JSON.parse(hintJson.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim());
      outlineEmptyScenePrompt = parsed?.emptyScenePrompt || null;
    }
  } catch { /* not valid JSON — fine */ }
  return outlineEmptyScenePrompt;
}

/**
 * ONE Visual Bible vantage's plates: the base canvas (render + QC + one
 * fed-back retry) painted from the group's representative page, and every
 * angled or re-lit page's plate derived from it. Returns Map(pageNumber →
 * sceneBackground entry) for every page of the group; the caller decides which
 * slots it fills. Empty on failure (logged).
 *
 * @param {string} vantageId
 * @param {{vantage: object, pageNumbers: number[]}} group - groupPagesByVantage entry
 * @param {object} env - { visualBible, inputData, pageDataArray, addUsage, imageGenHeartbeat, genLog, derivePages? }
 *   Test Lab only: derivePages (derive only these pages' plates), onQc, plateTemplate.
 */
async function renderVantagePlates(vantageId, group, env) {
  const { visualBible, inputData, pageDataArray, addUsage, imageGenHeartbeat, genLog, derivePages = null } = env;
  const buildEmptyScenePrompt = plateTemplateBuilder(env.plateTemplate);
  const { buildEmptySceneVbGrid } = require('./referenceSheets');
  const { generateImageOnly } = require('./images');
  const { MODEL_DEFAULTS, emptyScenePlateRouting } = require('../config/models');
  const { resolveArtStyle, resolvePagePlate, buildEraGuard, getLandmarkPhotosForScene, ensureLandmarkPhotoBytes } = require('./storyHelpers');
  const pagePlates = new Map();
  const v = group.vantage;
  // THE REP MUST BE A PLATE-SHARING PAGE (owner, 2026-09-21). The base
  // plate is what every angled page is derived FROM, so it is painted
  // at eye level whenever the group holds such a page. Taking
  // pageNumbers[0] blindly could paint the base from a high-angle page
  // and hand that horizon to everyone else on the vantage.
  const { plateClass, PLATE_BASE_CLASS, buildPlateDeriveInstruction } = require('./shotVocabulary');
  const shotOfPage = (pn) => (pageDataArray.find(pd => pd.pageNumber === pn)
    ?.sceneMetadata?.fullData?.shot || '').trim();
  // ONE PLATE, ONE LIGHT (owner, 2026-09-24). A page's time of day and
  // weather are its brief's `timeOfDay` / `weather` (sceneLight.js),
  // never the plate's. The base plate is painted in the light most of
  // the vantage's pages declare, and a page declaring another light
  // gets a plate RE-LIT from the base below — same place, same camera.
  // Before this every page inherited the representative's light:
  // prod job_1790107559778_fcmlfa8kn p2/p4/p5/p6 all got p2's rain.
  const { declaredLight, lightKey, describeLight, relightClause, keepLightClause, buildPlateRelightInstruction } = require('./sceneLight');
  const lightOfPage = (pn) => declaredLight(pageDataArray.find(pd => pd.pageNumber === pn)?.sceneMetadata);
  const lightVotes = new Map();
  for (const pn of group.pageNumbers) {
    const k = lightKey(lightOfPage(pn));
    if (k) lightVotes.set(k, (lightVotes.get(k) || 0) + 1);
  }
  const commonLightKey = [...lightVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  // Pull a representative page so we can inherit aspect / model / landmark refs:
  // a plate-sharing page, in the common light when one is declared.
  const basePages = group.pageNumbers.filter(pn => plateClass(shotOfPage(pn)) === PLATE_BASE_CLASS);
  const repPageNum = basePages.find(pn => lightKey(lightOfPage(pn)) === commonLightKey)
    ?? basePages[0]
    ?? group.pageNumbers[0];
  const repPageData = pageDataArray.find(pd => pd.pageNumber === repPageNum);
  if (!repPageData) return pagePlates;
  const baseLight = lightOfPage(repPageNum);
  const baseLightKey = lightKey(baseLight);
  const artStyleDesc = resolveArtStyle(inputData.artStyle || 'pixar', repPageData.pageImageBackend) || '';
  const layoutAspect = inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect;
  // Vantage canvas is GENERIC — no character-space hints (the canvas
  // serves multiple pages with different cast/positions), no calm-zone
  // (text overlay zone differs per page via spread rule). The per-page
  // image render handles those.
  const eraGuard = buildEraGuard(repPageData.sceneMetadata?.era || null);
  // HYBRID PLATE (owner-approved 2026-08-29): Art Director prose
  // decides framing and foreground, and the vantage/LOC prose is
  // setting context underneath it. Before that the vantage path
  // DISCARDED the AD prose entirely and built the plate from Visual
  // Bible prose alone; 25 of 30 audited plates were prompt-wrong.
  //
  // The FRAMING paragraph is the VANTAGE's own plate since 2026-09-17
  // (owner: "we either reuse a plate or create a new one — the AD
  // decides"). The Art Director writes it once per vantage, so the
  // plate this canvas renders is the plate its author wrote for these
  // pages, not the first page's leftover. A stored story authored
  // per-page plates instead: resolvePagePlate falls back to the
  // representative page's, which is exactly today's behaviour and the
  // same page whose model / aspect / landmarks we inherit.
  const repPlate = resolvePagePlate({
    pageNumber: repPageNum,
    sceneMetadata: repPageData.sceneMetadata,
    visualBible,
    outlinePlate: repPageData.emptyScenePrompt,
    vantage: v,
  });
  const adEmptyPrompt = repPlate.text;
  if (repPlate.source === 'missing') {
    // Never substituted by another vantage's plate or another page's:
    // the canvas below is built from Visual Bible prose alone, which
    // is the prompt-wrong case the hybrid plate exists to prevent.
    log.error(`❌ [VANTAGE] ${vantageId} (${v.locationName} – ${v.name}) has NO plate: the bible authored no \`emptyScenePrompt\` for this vantage and page ${repPageNum} carries none either. Pages ${group.pageNumbers.join(',')} render on a canvas built from bible prose only.`);
    genLog.warn('vantage_plate_missing', `Vantage ${vantageId} has no emptyScenePrompt — pages ${group.pageNumbers.join(',')} render on bible prose alone`, null, {
      vantageId, pages: group.pageNumbers, locationName: v.locationName, vantageName: v.name,
    });
  } else {
    log.info(`🏛️ [VANTAGE] ${vantageId}: plate prose from ${repPlate.source}${repPlate.source === 'page' ? ` (page ${repPageNum})` : ''}`);
  }
  // Shot follows the same precedence: the AD's page shot wins over
  // the vantage's generic one.
  const vantageShot = (repPageData.sceneMetadata?.fullData?.shot || v.shot || '').trim();
  const shotPrefix = vantageShot ? `**SHOT:** ${vantageShot}\n\n` : '';
  // The LOCATION / VANTAGE lines and the vantage's description
  // (sceneMetadata.vantageSettingText). The vantage's own plate IS its
  // description since 2026-09-17 (the Art Director writes one text per
  // vantage), so it went out twice: here and again as FRAMING — ~500
  // chars that pushed staging job_1790277448294_5herh01j7's p1/p11
  // plates over the Grok cap. A description the FRAMING paragraph
  // already carries is not repeated. The plate QC reads this same
  // setting text as its EXPECTED SCENE and the FRAMING as its own field.
  const { vantageSettingText } = require('./storyHelpers');
  const vantageSetting = vantageSettingText(v, adEmptyPrompt);
  const emptySceneDesc = [
    `${shotPrefix}${vantageSetting}`,
    adEmptyPrompt
      ? `**FRAMING:** ${adEmptyPrompt}\n\n${vantageShot ? 'The SHOT line decides the camera: its height, angle and distance. The FRAMING paragraph decides the composition and what fills the foreground; a camera it names gives way to the SHOT line.' : 'The FRAMING paragraph decides the camera, the composition and what fills the foreground.'} The LOCATION and VANTAGE lines are setting context — use them for what the place looks like, not for how it is framed.`
      : '',
  ].filter(Boolean).join('\n\n');
  // Surfaces only, like the per-page note (shotVocabulary.buildPlateSurfaceNote);
  // the template's PLATE_NO_PEOPLE rule keeps people off the plate.
  const characterSpace = require('./shotVocabulary').buildPlateSurfaceNote(null);
  // THE PHOTO THIS VANTAGE CITES (docs/decisions.md 2026-09-26): the
  // plate is painted from the `landmarkPhoto` the Art Director wrote on
  // this vantage (or on its location, when it has no vantages), and a
  // second landmark the representative page also shows keeps its own
  // plate's citation. It used to take the representative page's photo,
  // chosen by that page's view and shot, whatever the vantage framed —
  // and, before that, the LOC's legacy referencePhotoData whatever the
  // vantage cited. Same resolver as every page (block ⇔ bytes).
  const vantageLandmarkMisses = [];
  const landmarkPhotos = await ensureLandmarkPhotoBytes(
    await getLandmarkPhotosForScene(visualBible, repPageData.sceneMetadata, {
      pageNumber: repPageNum, vantageId, misses: vantageLandmarkMisses,
    }),
    { misses: vantageLandmarkMisses },
  );
  if (vantageLandmarkMisses.length > 0) {
    genLog.warn('vantage_landmark_photo_missing', `Vantage ${vantageId} plate renders without its landmark photo: ${vantageLandmarkMisses.map(m => `${m.name}: ${m.reason}`).join('; ')}`, null, {
      vantageId, pages: group.pageNumbers, misses: vantageLandmarkMisses,
    });
  }
  const { buildLandmarkFidelityBlock } = require('./storyHelpers');
  try {
    // Built BEFORE the prompt: which reference family is attached
    // decides the REFERENCE line. Exactly one family per plate —
    // buildEmptySceneVbGrid returns null when a landmark photo is
    // present (owner, 2026-08-29).
    const repAboardId = repPageData.sceneMetadata?.aboard || null;
    // AD objects[] of the SAME rep page whose prose frames the plate —
    // gates which vehicles enter the plate prompt + grid (AD is the
    // authority on vehicle presence; VB pages is only the menu).
    const repSceneObjects = repPageData.sceneMetadata?.objects || null;
    const emptySceneVbGrid = await buildEmptySceneVbGrid(visualBible, repPageNum, landmarkPhotos, repAboardId, repSceneObjects);
    const emptySceneVbGridDataUrl = emptySceneVbGrid
      ? `data:image/jpeg;base64,${Buffer.from(emptySceneVbGrid).toString('base64')}`
      : null;
    const emptyPrompt = buildEmptyScenePrompt({
      style: artStyleDesc,
      description: emptySceneDesc,
      characterSpace,
      eraGuard,
      // Named fidelity block whenever a landmark photo is attached
      // below — '' otherwise (was trial-only; paid stories shipped
      // the generic unnamed plate prompt).
      landmarkFidelity: buildLandmarkFidelityBlock(landmarkPhotos[0], { era: repPageData.sceneMetadata?.era || null }),
      referenceKind: landmarkPhotos.length > 0 ? 'landmark' : (emptySceneVbGrid ? 'element' : null),
      visualBible,
      pageNumber: repPageData.pageNumber,
      aboardId: repAboardId,
      sceneObjects: repSceneObjects,
      // The SAME prose validateEmptyScene grades this plate's geometry
      // against, reduced to the geometry facts (no cast, no action).
      mainScenePrompt: repPageData.scene?.sceneDescription || null,
      castNames: (repPageData.sceneMetadata?.fullData?.characters || []).map(c => c?.name).filter(Boolean),
      light: baseLight,
    });
    const result = await generateImageOnly(emptyPrompt, [], {
      aspectRatio: layoutAspect,
      // Plates stay on the Standard tier regardless of the page tier.
      ...emptyScenePlateRouting(),
      landmarkPhotos,
      visualBibleGrid: emptySceneVbGrid,
      pageNumber: repPageNum,
      skipCache: true,
      pageContext: `vantage-${vantageId}`,
    });
    if (result?.usage) {
      const isRunware = result.modelId?.startsWith('runware:');
      const isGrok = result.modelId?.startsWith('grok-imagine');
      const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
      addUsage(provider, result.usage, 'page_images', result.modelId);
    }
    imageGenHeartbeat();  // per-plate heartbeat — keeps the phase alive
    if (!result?.imageData) {
      log.warn(`⚠️ [VANTAGE] ${vantageId} (${v.locationName} – ${v.name}) produced no image`);
      return pagePlates;
    }

    // Empty-scene QC on the vantage path (2026-08-31): the per-page
    // path below has always run validateEmptyScene + one
    // retry-with-feedback, but this block never did — on
    // job_1788123310558 empty-scene QC ran 0 times and the p2 plate
    // shipped with a blocked foreground and paper margins. Same
    // validator, same single retry. textPosition is null (a shared
    // plate serves pages with different text zones, so no calm-zone
    // grading) and the character placements are the UNION across the
    // plate's page group.
    let plateImage = result.imageData;
    let platePrompt = emptyPrompt;
    let plateRefs = result.grokRefImages || null;
    let plateQcRecord = null;
    // ONE set of QC options for the plate, its retry and every plate
    // derived from it — the retry was judged on pixels only and the
    // derived plates not at all (2026-09-23, dragon run 6).
    // The STRUCTURES text and the Visual Bible grid the plate call
    // carried — the same builder and the same grid (2026-09-26).
    let plateQcOpts = {
      artStyle: artStyleDesc, shot: plateClass(vantageShot), pageNumber: repPageNum, landmarkPhoto: landmarkPhotos[0] || null, light: baseLight,
      structures: require('../services/prompts').buildPlateStructuresText({ visualBible, pageNumber: repPageData.pageNumber, aboardId: repAboardId, sceneObjects: repSceneObjects }),
      structureGrid: emptySceneVbGrid || null,
    };
    const validateEmptyScene = observedValidateEmptyScene(env.onQc);
    const { decidePlateAfterRetry, plateQcRecord: buildPlateQcRecord, logPlateOutcome, nullOnPromptFit } = require('./plateQc');
    try {
      const seenPlacement = new Set();
      const placements = [];
      for (const pn of group.pageNumbers) {
        const pd = pageDataArray.find(x => x.pageNumber === pn);
        for (const c of (pd?.sceneMetadata?.fullData?.characters || [])) {
          if (!c?.name || !c?.position) continue;
          const key = `${c.name}|${c.position}`;
          if (seenPlacement.has(key)) continue;
          seenPlacement.add(key);
          placements.push({ name: c.name, position: c.position, depth: c.depth });
        }
      }
      plateQcOpts = {
        ...plateQcOpts,
        // The setting text above the FRAMING paragraph, whole; the
        // FRAMING rides as its own field, so it is not said twice.
        sceneDescription: `${shotPrefix}${vantageSetting}`,
        // The FRAMING paragraph this plate was painted from, uncut.
        framing: adEmptyPrompt || null,
        characterPlacements: placements.length > 0 ? placements : null,
        mainScenePrompt: repPageData.scene?.sceneDescription || null,
        // The era this plate's author was given (its eraGuard above),
        // classified by the same buildEraGuard inside the QC.
        era: repPageData.sceneMetadata?.era || null,
      };
      const qc = await validateEmptyScene(plateImage, null, `vantage-${vantageId}`, plateQcOpts);
      if (!qc.pass) {
        genLog.warn('vantage_plate_qc_failed', `Vantage plate ${vantageId} (${v.locationName} – ${v.name}, pages ${group.pageNumbers.join(',')}) failed QC: ${qc.issues.join(', ')} — retrying with feedback`);
        const fixHint = qc.visionFeedback
          ? `\n\nIMPORTANT: The previous attempt had this problem: ${qc.visionFeedback}. Fix this in the new version.`
          : '';
        log.info(`🔄 [VANTAGE] ${vantageId} failed QC (${qc.issues.join(', ')}), retrying with feedback...`);
        const retryPrompt = buildEmptyScenePrompt({
          style: artStyleDesc,
          description: emptySceneDesc + fixHint,
          characterSpace,
          eraGuard,
          landmarkFidelity: buildLandmarkFidelityBlock(landmarkPhotos[0], { era: repPageData.sceneMetadata?.era || null }),
          referenceKind: landmarkPhotos.length > 0 ? 'landmark' : (emptySceneVbGrid ? 'element' : null),
          visualBible,
          pageNumber: repPageData.pageNumber,
          aboardId: repAboardId,
          sceneObjects: repSceneObjects,
          mainScenePrompt: repPageData.scene?.sceneDescription || null,
          castNames: (repPageData.sceneMetadata?.fullData?.characters || []).map(c => c?.name).filter(Boolean),
          light: baseLight,
        });
        const retryResult = await generateImageOnly(retryPrompt, [], {
          aspectRatio: layoutAspect,
          ...emptyScenePlateRouting(),
          landmarkPhotos,
          visualBibleGrid: emptySceneVbGrid,
          pageNumber: repPageNum,
          skipCache: true,
          pageContext: `vantage-${vantageId}-retry`,
        }).catch(nullOnPromptFit);
        if (retryResult?.usage) {
          const isRunware = retryResult.modelId?.startsWith('runware:');
          const isGrok = retryResult.modelId?.startsWith('grok-imagine');
          const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
          addUsage(provider, retryResult.usage, 'page_images', retryResult.modelId);
        }
        imageGenHeartbeat();
        // The retry is judged exactly as the first plate was: a
        // pixel-only verdict "passed" a retry that fixed nothing the
        // vision check had failed. The keeper is picked by SEVERITY
        // (plateQc.js); a base plate has no plate behind it, so it
        // ships even with a hard defect — visibly.
        const retryQc = retryResult?.imageData
          ? await validateEmptyScene(retryResult.imageData, null, `vantage-${vantageId}-retry`, plateQcOpts)
          : null;
        const outcome = decidePlateAfterRetry({ firstQc: qc, retryQc, derived: false });
        plateQcRecord = buildPlateQcRecord({ firstImage: plateImage, firstQc: qc, retryImage: retryResult?.imageData, retryQc, retryPrompt, outcome });
        if (outcome.keep === 'retry') {
          plateImage = retryResult.imageData;
          platePrompt = retryPrompt;
          plateRefs = retryResult.grokRefImages || null;
        }
        logPlateOutcome(genLog, { event: 'vantage_plate_qc_retry', label: `Vantage plate ${vantageId}`, pages: group.pageNumbers, outcome, firstQc: qc, retryQc });
      } else {
        genLog.info('vantage_plate_qc', `Vantage plate ${vantageId} (pages ${group.pageNumbers.join(',')}) passed QC`);
      }
    } catch (qcErr) {
      // QC must never cost us a plate — a validator error keeps v1.
      log.warn(`⚠️ [VANTAGE] ${vantageId} QC errored (${qcErr.message}) — keeping the unvalidated plate`);
    }

    // AN ANGLED PAGE TAKES A PLATE DERIVED FROM THIS ONE (owner,
    // 2026-09-21). close-up/medium/wide/over-the-shoulder share the
    // base plate; high-angle, low-angle, aerial and ultra-wide move
    // the horizon or grow the coverage and cannot. The derived plate
    // is EDITED FROM the base rather than generated fresh, so the
    // buildings, trees and palette stay the same place — a fresh
    // generation breaks continuity exactly between adjacent pages of
    // one location, which is what a shared plate exists to prevent.
    // On failure the page keeps the base plate (owner's call): the
    // wrong camera on the right place beats no plate at all.
    //
    // A PAGE IN ANOTHER LIGHT TAKES A PLATE RE-LIT FROM THIS ONE
    // (owner, 2026-09-24), by the same edit + QC + one fed-back retry:
    // a relit derive keeps the place's buildings, trees and palette,
    // which a fresh generation would not. An angled page in another
    // light takes ONE edit that moves the camera and re-lights. A page
    // that declares no light (a brief written before the fields) keeps
    // the base plate's light.
    // A page is derived only for what its base plate lacks: a camera
    // move when its class differs from the class the base was ACTUALLY
    // painted in (a vantage with no eye-level page paints its base from
    // its angled page), a re-light when its light differs (platePlan.js).
    const derivedPlates = new Map();
    const { plateEditForPage } = require('./platePlan');
    const plateKeyOf = (pn) => ({
      ...plateEditForPage({ pageShot: shotOfPage(pn), baseShot: vantageShot, pageLight: lightOfPage(pn), baseLight }),
      light: lightOfPage(pn),
    });
    for (const pn of group.pageNumbers) {
      // The Test Lab replays ONE page: it derives only that page's
      // plate (the same key, the same edit). The run passes none.
      if (derivePages && !derivePages.includes(pn)) continue;
      const { cls, camera, light: pageLight, relit, key } = plateKeyOf(pn);
      if ((!camera && !relit) || derivedPlates.has(key)) continue;
      const deriveInstruction = camera
        ? buildPlateDeriveInstruction(vantageShot, cls, relit ? { relight: relightClause(pageLight) } : { keepLight: keepLightClause(baseLight) })
        : buildPlateRelightInstruction(pageLight);
      if (!deriveInstruction) continue;
      const deriveLabel = `${cls}${relit ? ` (${describeLight(pageLight)})` : ''}`;
      try {
        const { editImageWithPrompt } = require('./images');
        // The book's art style goes to the edit (it went as null, and
        // the p12 aerial derive of dragon run 6 came back reading as a
        // photograph), and the derived plate is judged like the base:
        // same QC, its own camera, one re-derive with the feedback.
        const derive = async (instruction) => {
          const r = await editImageWithPrompt(
            plateImage, instruction, MODEL_DEFAULTS.emptyScenePlateModel, [], inputData.artStyle || null, layoutAspect, { plateDerive: true });
          if (r?.usage) addUsage(String(r.usage.model || '').startsWith('grok-imagine') ? 'grok' : 'gemini_image', r.usage, 'page_images', r.usage.model || MODEL_DEFAULTS.emptyScenePlateModel);
          return r?.imageData || null;
        };
        // Judged on what the derive was told: its camera, the medium,
        // the place. Not the base's SHOT line, and not the page's
        // geometry facts or placements, which the edit never saw.
        const derivedQcOpts = {
          // The base's setting text without its SHOT line. No FRAMING:
          // the derive moves the base plate's camera, so the side and
          // height the base's FRAMING names are not its own.
          sceneDescription: vantageSetting,
          era: plateQcOpts.era || null,
          // The derive keeps the base plate's structures, which were
          // painted from this text and grid — judged against them, as
          // its landmark is against the base's photo below.
          structures: plateQcOpts.structures,
          structureGrid: plateQcOpts.structureGrid,
          artStyle: artStyleDesc,
          shot: cls,
          // Judged on the light the derive was told to paint.
          light: relit ? pageLight : baseLight,
          pageNumber: pn,
          // The derive keeps the base plate's landmark, which was
          // painted from this photo — judged against it, not the words.
          landmarkPhoto: plateQcOpts.landmarkPhoto || null,
        };
        let derivedImage = await derive(deriveInstruction);
        let derivedPrompt = deriveInstruction;
        let derivedQcRecord = null;
        if (derivedImage) {
          const dqc = await validateEmptyScene(derivedImage, null, `vantage-${vantageId}-${cls}`, derivedQcOpts);
          if (!dqc.pass) {
            genLog.warn('vantage_plate_qc_failed', `Derived ${deriveLabel} plate for ${vantageId} failed QC: ${dqc.issues.join(', ')} — re-deriving with feedback`);
            const retryInstruction = dqc.visionFeedback
              ? `${deriveInstruction} The previous attempt had this problem: ${dqc.visionFeedback}. Fix this in the new version.`
              : deriveInstruction;
            const retryImage = await derive(retryInstruction);
            const rqc = retryImage
              ? await validateEmptyScene(retryImage, null, `vantage-${vantageId}-${cls}-retry`, derivedQcOpts)
              : null;
            // Picked by SEVERITY (plateQc.js). Both attempts broken as
            // a picture → the pages keep the base plate: a wrong camera
            // on the right place beats a broken plate (owner).
            const outcome = decidePlateAfterRetry({ firstQc: dqc, retryQc: rqc, derived: true });
            derivedQcRecord = buildPlateQcRecord({ firstImage: derivedImage, firstQc: dqc, retryImage, retryQc: rqc, retryPrompt: retryInstruction, outcome });
            logPlateOutcome(genLog, { event: 'vantage_plate_qc_retry', label: `Derived ${deriveLabel} plate for ${vantageId}`, pages: group.pageNumbers.filter(p => plateKeyOf(p).key === key), outcome, firstQc: dqc, retryQc: rqc });
            if (outcome.keep === 'retry') {
              derivedImage = retryImage;
              derivedPrompt = retryInstruction;
            } else if (outcome.keep === 'base') {
              derivedImage = null;
            }
          }
        }
        if (derivedImage) {
          derivedPlates.set(key, { imageData: derivedImage, prompt: derivedPrompt, qcRecord: derivedQcRecord, label: deriveLabel, light: relit ? pageLight : baseLight });
          log.info(`🏛️ [VANTAGE] ${vantageId}: derived a ${deriveLabel} plate from the ${vantageShot || 'base'}${baseLightKey ? ` ${describeLight(baseLight)}` : ''} one`);
        } else {
          log.error(`❌ [VANTAGE] ${vantageId}: ${deriveLabel} plate derive ${derivedQcRecord?.keptAttempt === 'base' ? 'failed QC hard twice' : 'returned no image'} — those pages keep the base plate, drawn for a camera or a light that is not theirs`);
        }
      } catch (deriveErr) {
        log.error(`❌ [VANTAGE] ${vantageId}: ${deriveLabel} plate derive failed (${deriveErr.message}) — those pages keep the base plate`);
      }
      imageGenHeartbeat();
    }

    // Fan out the canvas to every page in the group — the base plate,
    // or the derived one where the page's own camera earned it.
    for (const pn of group.pageNumbers) {
      const derivedForPage = derivedPlates.get(plateKeyOf(pn).key) || null;
      pagePlates.set(pn, {
        imageData: derivedForPage ? derivedForPage.imageData : plateImage,
        prompt: derivedForPage ? derivedForPage.prompt : platePrompt,
        // The derive's identity — its camera class, plus the light
        // when it was re-lit ("eye-level (night, rain)").
        plateDerivedFor: derivedForPage ? derivedForPage.label : null,
        // The time of day and weather this plate was painted in.
        plateLight: describeLight(derivedForPage ? derivedForPage.light : baseLight) || null,
        // Refs packed into the call that produced THIS page's plate.
        // The base plate: the refs of its own call (the retry's, when
        // the retry won). A derived plate: the base plate itself — the
        // one image editImageWithPrompt sends. Same field name every
        // other image call stores its packed refs under.
        grokRefImages: derivedForPage ? [plateImage] : plateRefs,
        textAreaMask: null,
        emptySceneVbGrid: emptySceneVbGridDataUrl,
        vantageId,
        vantageName: v.name,
        locationName: v.locationName,
        // Same QC-history shape the per-page path stores (dev panel):
        // the derived plate's own history when it has one.
        ...((derivedForPage ? derivedForPage.qcRecord : plateQcRecord) || {}),
      });
    }
    log.info(`🏛️ [VANTAGE] ${vantageId} ${v.locationName} – ${v.name}: 1 canvas${derivedPlates.size ? ` + ${derivedPlates.size} derived` : ''} → pages [${group.pageNumbers.join(',')}]`);
  } catch (err) {
    log.warn(`⚠️ [VANTAGE] ${vantageId} failed: ${err.message}`);
  }
  return pagePlates;
}

/**
 * ONE page's own empty-scene plate (render + QC + one fed-back retry). Phase
 * 5a-pre renders every uncovered page with it, and the page-image retry reuses
 * it for a landmark page whose plate is missing. Returns null on failure
 * (logged).
 *
 * @param {object} pageData - the run's pageData (preparePageData)
 * @param {object} env - { visualBible, inputData, addUsage, imageGenHeartbeat, genLog }
 */
async function renderPagePlate(pageData, env) {
  const { visualBible, inputData, addUsage, imageGenHeartbeat, genLog } = env;
  const buildEmptyScenePrompt = plateTemplateBuilder(env.plateTemplate);
  const { buildEmptySceneVbGrid } = require('./referenceSheets');
  const { generateImageOnly } = require('./images');
  const { emptyScenePlateRouting } = require('../config/models');
  const { resolveArtStyle } = require('./storyHelpers');
  const sceneMetadata = pageData.sceneMetadata;
  const settingDesc = sceneMetadata?.setting?.description || sceneMetadata?.imageSummary || '';
  // The page's plate: the outline hint's, then the cited vantage's
  // (the Art Director writes one per vantage since 2026-09-17), then
  // the brief's own — which is where every stored story keeps it.
  // Pages that reach THIS loop are the ones the vantage pass did not
  // cover, so a page with no LOC at all legitimately resolves
  // 'missing' and falls through to the setting fields below.
  const { resolvePagePlate } = require('./storyHelpers');
  const pagePlate = resolvePagePlate({
    pageNumber: pageData.pageNumber,
    sceneMetadata,
    visualBible,
    outlinePlate: pageData.emptyScenePrompt,
  });
  const expandedEmptyPrompt = pagePlate.text;
  if (!settingDesc && !expandedEmptyPrompt) return null;

  const artStyleDesc = resolveArtStyle(inputData.artStyle || 'pixar', pageData.pageImageBackend) || '';
  const camera = sceneMetadata?.setting?.camera || 'wide shot';
  const lighting = sceneMetadata?.setting?.lighting || '';
  // The page's declared time of day and weather (sceneLight.js) — the
  // plate's LIGHT line. Replaces the `setting.weather` prose field.
  const pageLight = require('./sceneLight').declaredLight(sceneMetadata);

  // Use rich emptyScenePrompt from scene expansion if available, fallback to metadata fields.
  // Prepend a **SHOT:** line — the template ends with "Use the exact camera angle and
  // perspective described above" but Sonnet's emptyScenePrompt prose usually omits shot,
  // so without this prefix the "above" reference is dead text and Grok picks its own
  // angle (often disagreeing with the populated-page angle that uses the same background).
  const shotForCamera = (sceneMetadata?.fullData?.shot || camera || '').trim();
  const shotPrefix = shotForCamera ? `**SHOT:** ${shotForCamera}\n\n` : '';
  const emptySceneDesc = shotPrefix + (expandedEmptyPrompt
    || `**SETTING:** ${settingDesc}\n**CAMERA:** ${camera}${lighting ? `\n**LIGHTING:** ${lighting}` : ''}`);

  // The band note: which depth bands give FOOTING and stay open side
  // to side. Surfaces only — never a character and never a count: the
  // old note ("1 character in the foreground (1 on the left) ... will
  // be composited into this scene later") got those figures painted
  // onto the plate (2026-09-26, shotVocabulary.buildPlateSurfaceNote).
  const characterSpace = require('./shotVocabulary').buildPlateSurfaceNote(
    sceneMetadata?.fullData?.characters || [],
    sceneMetadata?.fullData?.shot || camera || '',
  );

  // Build text area instruction from scene metadata (keeps text area calm in empty scene too)
  // Enforce spread rule: odd pages = left side, even = right side
  const { enforceSpreadTextPosition, buildTextZoneInstruction, buildEraGuard } = require('./storyHelpers');
  // A cover's copy space is its beat's (coverRender.js), like its render prompt's.
  const sonnetTextPos = pageData.coverOpts?.textPosition || sceneMetadata?.textPosition || null;
  const textPos = enforceSpreadTextPosition(sonnetTextPos, pageData.pageNumber);
  // If spread rule flipped Sonnet's left/right, Sonnet's textZoneDescription
  // was written for the wrong side — discard it and let the code-generated
  // fallback (generic saturated-surface wording) drive the instruction.
  const sideFlipped = sonnetTextPos && textPos && sonnetTextPos !== textPos;
  const textZoneDesc = sideFlipped ? null : (sceneMetadata?.textZoneDescription || null);
  if (sideFlipped) {
    log.warn(`⚠️ [UNIFIED] Page ${pageData.pageNumber}: Sonnet picked ${sonnetTextPos} against spread rule → flipped to ${textPos}, discarding textZoneDescription`);
  }
  const langLevel = inputData.languageLevel || 'standard';
  // textInImage drives whether we ask the model to keep a calm zone for
  // text overlay AND whether we attach the visual mask reference. When
  // text is rendered below the image (advanced layout), neither is needed.
  const layoutTextInImage = pageData.textInImage;
  const layoutAspect = pageData.renderAspect;
  // Load pre-built text area mask (black=text zone ~20%, white=scene ~80%).
  // Sent as a reference slot so the model sees the shape directly.
  // One builder, shared with the Test Lab image stage (pageRenderCall.js).
  const textAreaMask = require('./pageRenderCall').pageTextAreaMask({
    textInImage: layoutTextInImage, rawTextPosition: sonnetTextPos, pageNumber: pageData.pageNumber, languageLevel: langLevel,
  });

  // Calm-zone instruction for the empty-scene generator. Story text is
  // WHITE and overlaid at textPos, so the zone must render as a saturated,
  // high-contrast surface. Sonnet picks the corner + surface; the code
  // owns wording + spread-rule enforcement.
  const emptyAreaPct = langLevel === '1st-grade' ? '10%' : langLevel === 'advanced' ? '40%' : '30%';
  const emptyTextAreaInstr = (layoutTextInImage && textPos)
    ? buildTextZoneInstruction(textPos, textZoneDesc, emptyAreaPct, { isEmptyScene: true })
    : '';

  const eraGuard = buildEraGuard(sceneMetadata?.era || null);
  // Named fidelity block whenever this page attaches a landmark
  // photo — '' otherwise (was trial-only).
  const { buildLandmarkFidelityBlock } = require('./storyHelpers');
  const pageLandmarkFidelity = buildLandmarkFidelityBlock(pageData.landmarkPhotos?.[0], { era: sceneMetadata?.era || null });

  // Build a FILTERED VB grid for empty-scene generation: vehicles + non-landmark
  // locations only. Characters, animals, and artifacts are excluded — they should
  // appear in the populated page, not in the background, and including them caused
  // doubling (e.g. an artifact rendered both in the empty scene and in the
  // character's hand on the page). Returns null when a landmark photo is
  // attached — one reference family per plate (owner, 2026-08-29).
  const pageAboardId = sceneMetadata?.aboard || null;
  // AD objects[] gates which vehicles enter the plate prompt + grid
  // (AD is the authority on vehicle presence; VB pages is only the menu).
  const pageSceneObjects = sceneMetadata?.objects || null;
  const emptySceneVbGrid = await buildEmptySceneVbGrid(visualBible, pageData.pageNumber, pageData.landmarkPhotos || [], pageAboardId, pageSceneObjects);
  // Persist the filtered grid as a data URL so the dev UI can show what
  // was actually attached to the empty-scene call (main-scene VB grid is
  // different; before this, the UI was displaying the wrong one).
  const emptySceneVbGridDataUrl = emptySceneVbGrid
    ? `data:image/jpeg;base64,${Buffer.from(emptySceneVbGrid).toString('base64')}`
    : null;
  const emptySceneRefKind = (pageData.landmarkPhotos || []).length > 0
    ? 'landmark'
    : (emptySceneVbGrid ? 'element' : null);

  const emptyPrompt = buildEmptyScenePrompt({
    style: artStyleDesc,
    description: emptySceneDesc,
    characterSpace,
    textAreaInstruction: emptyTextAreaInstr,
    eraGuard,
    landmarkFidelity: pageLandmarkFidelity,
    referenceKind: emptySceneRefKind,
    visualBible,
    pageNumber: pageData.pageNumber,
    aboardId: pageAboardId,
    sceneObjects: pageSceneObjects,
    // The SAME prose validateEmptyScene grades this plate's geometry
    // against, reduced to the geometry facts (no cast, no action).
    mainScenePrompt: pageData.scene?.sceneDescription || null,
    castNames: (sceneMetadata?.fullData?.characters || []).map(c => c?.name).filter(Boolean),
    light: pageLight,
  });

  try {

    const result = await generateImageOnly(emptyPrompt, [], {
      aspectRatio: layoutAspect,
      // Plates stay on the Standard tier regardless of the page tier.
      ...emptyScenePlateRouting(),
      landmarkPhotos: pageData.landmarkPhotos,
      visualBibleGrid: emptySceneVbGrid,
      textAreaMask,
      pageNumber: pageData.pageNumber,
      skipCache: true
    });
    // Track empty scene token usage
    if (result?.usage) {
      const isRunware = result.modelId?.startsWith('runware:');
      const isGrok = result.modelId?.startsWith('grok-imagine');
      const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
      addUsage(provider, result.usage, 'page_images', result.modelId);
    }
    imageGenHeartbeat();  // per-page heartbeat — keeps the phase alive

    // Validate the empty scene before using it as a background.
    // Phase 1: pixel analysis (white boxes, too dark, text area calmness) — <50ms, free
    // Phase 2: Gemini Flash vision (people, medium, landmark, artefacts) — ~2s, cheap
    // EVERY page plate is judged (owner, 2026-09-26). It used to be
    // skipped when the layout had no text in the image, and since every
    // level went text-below (2026-09-05) no per-page plate was judged at
    // all — only the vantage and derived plates were. A text-below page
    // has no calm zone, so it is judged with a null text position, as
    // the vantage plates are; a text-in-image page is graded on the
    // zone its author was told to keep calm (the same textPos).
    if (result?.imageData) {
      const validateEmptyScene = observedValidateEmptyScene(env.onQc);
      const { decidePlateAfterRetry, plateQcRecord: buildPlateQcRecord, logPlateOutcome, nullOnPromptFit, plateQcTextPosition } = require('./plateQc');
      const qcTextPos = plateQcTextPosition(layoutTextInImage, textPos);
      // Pass the outline's declared character positions so the vision check
      // can verify each has usable flat ground in the rendered empty scene.
      const placements = (sceneMetadata?.fullData?.characters || [])
        .filter(c => c?.name && c?.position)
        .map(c => ({ name: c.name, position: c.position, depth: c.depth }));
      const pageQcOpts = {
        // The author's description without the plate text, which rides
        // whole as FRAMING: the SHOT line, or the setting fields when
        // the page has no plate text.
        sceneDescription: expandedEmptyPrompt ? shotPrefix.trim() : emptySceneDesc,
        // The plate text this plate was painted from, uncut.
        framing: expandedEmptyPrompt || null,
        // The STRUCTURES text and the Visual Bible grid the plate call
        // carried — the same builder and the same grid (2026-09-26).
        structures: require('../services/prompts').buildPlateStructuresText({ visualBible, pageNumber: pageData.pageNumber, aboardId: pageAboardId, sceneObjects: pageSceneObjects }),
        structureGrid: emptySceneVbGrid || null,
        characterPlacements: placements.length > 0 ? placements : null,
        mainScenePrompt: pageData.scene?.sceneDescription || null,
        // The era this plate's author was given (eraGuard above),
        // classified by the same buildEraGuard inside the QC.
        era: sceneMetadata?.era || null,
        artStyle: artStyleDesc,
        shot: shotForCamera || null,
        pageNumber: pageData.pageNumber,
        landmarkPhoto: pageData.landmarkPhotos?.[0] || null,
        light: pageLight,
      };
      const qc = await validateEmptyScene(result.imageData, qcTextPos, `P${pageData.pageNumber}`, pageQcOpts);
      if (!qc.pass) {
        // Retry with Gemini's feedback appended to the description.
        // The text-area instruction is the first attempt's own
        // (emptyTextAreaInstr, '' on a text-below page) — only the
        // fixHint differs between the two prompts.
        const fixHint = qc.visionFeedback
          ? `\n\nIMPORTANT: The previous attempt had this problem: ${qc.visionFeedback}. Fix this in the new version.`
          : '';
        log.info(`🔄 [EMPTY SCENE] P${pageData.pageNumber} failed QC (${qc.issues.join(', ')}), retrying with feedback...`);
        const retryPrompt = buildEmptyScenePrompt({
          style: artStyleDesc,
          description: emptySceneDesc + fixHint,
          characterSpace,
          textAreaInstruction: emptyTextAreaInstr,
          eraGuard,
          landmarkFidelity: pageLandmarkFidelity,
          referenceKind: emptySceneRefKind,
          visualBible,
          pageNumber: pageData.pageNumber,
          aboardId: pageAboardId,
          sceneObjects: pageSceneObjects,
          mainScenePrompt: pageData.scene?.sceneDescription || null,
          castNames: (sceneMetadata?.fullData?.characters || []).map(c => c?.name).filter(Boolean),
          light: pageLight,
        });
        const retryResult = await generateImageOnly(retryPrompt, [], {
          aspectRatio: layoutAspect,
          // Plates stay on the Standard tier regardless of the page tier.
          ...emptyScenePlateRouting(),
          visualBibleGrid: emptySceneVbGrid,
          landmarkPhotos: pageData.landmarkPhotos,
          textAreaMask,
          pageContext: `empty-P${pageData.pageNumber}-retry`,
        }).catch(nullOnPromptFit);
        if (retryResult?.usage) {
          const isRunware = retryResult.modelId?.startsWith('runware:');
          const isGrok = retryResult.modelId?.startsWith('grok-imagine');
          addUsage(isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image', retryResult.usage, 'page_images', retryResult.modelId);
        }
        // Judged exactly as the first attempt was (vision included),
        // and the keeper picked by SEVERITY (plateQc.js) — the same
        // rule as the vantage base plate. Both attempts are stored.
        const retryQc = retryResult?.imageData
          ? await validateEmptyScene(retryResult.imageData, qcTextPos, `P${pageData.pageNumber}-retry`, pageQcOpts)
          : null;
        const outcome = decidePlateAfterRetry({ firstQc: qc, retryQc, derived: false });
        logPlateOutcome(genLog, { event: 'empty_scene_qc_retry', label: `Page ${pageData.pageNumber} plate`, pages: [pageData.pageNumber], outcome, firstQc: qc, retryQc });
        const kept = outcome.keep === 'retry'
          ? { imageData: retryResult.imageData, prompt: retryPrompt, grokRefImages: retryResult.grokRefImages || null }
          : { imageData: result.imageData, prompt: emptyPrompt, grokRefImages: result.grokRefImages || null };
        return {
          pageNumber: pageData.pageNumber, ...kept, textAreaMask, emptySceneVbGrid: emptySceneVbGridDataUrl,
          ...buildPlateQcRecord({ firstImage: result.imageData, firstQc: qc, retryImage: retryResult?.imageData, retryQc, retryPrompt, outcome }),
        };
      }
    }

    return { pageNumber: pageData.pageNumber, imageData: result?.imageData || null, prompt: emptyPrompt, grokRefImages: result?.grokRefImages || null, textAreaMask, emptySceneVbGrid: emptySceneVbGridDataUrl };
  } catch (err) {
    // Loud, and in the STORED log (2026-08-29). A page whose plate
    // failed still renders — the page path handles a null
    // sceneBackground — but the failure used to leave nothing behind
    // except a console warning, so "this page has no empty scene" was
    // indistinguishable from "empty-scene gen was off"
    // (job_1787959478282: p1 and p3 were the only two pages without a
    // plate, and nothing in the story said why).
    log.warn(`⚠️ [EMPTY SCENE] Page ${pageData.pageNumber} failed: ${err.message}`);
    genLog.warn('empty_scene_failed', `Page ${pageData.pageNumber} empty-scene generation failed: ${err.message}`);
    return null;
  }
}

module.exports = { outlineEmptyScenePromptOf, renderVantagePlates, renderPagePlate };

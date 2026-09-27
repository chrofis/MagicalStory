'use strict';

/**
 * THE CHAR-FIX CALL — every input of one automatic character repair, built
 * once, for the story run's repair round (repairPipeline.js
 * executeCharFixAction) and the Test Lab `char_repair` stage.
 *
 * WHY (owner, 2026-09-27: "The Lab must use 100% identical code to
 * production"). The Lab stage assembled its own repair: its own box ladder, its
 * own clothing text (buildClothingDescription, where the run reads the story's
 * requirement signature and then the page's worn state), no wardrobe-state
 * sheet, a page reference photo where the run sends the face photo, a forced
 * 'blended' mode and a 'face' target where the run resolves both from the
 * finding types, no borrowed-label or reference-gap guard, and no face-integrity
 * gate. A Lab char-fix was therefore not evidence about the run's char-fix.
 * This module is the run's code, moved verbatim; the Lab calls it with the
 * stored page and reports what the run would have sent.
 *
 * Returns `{ failure }` (the fields the run records for a refused repair) or
 * the call: `{ avatarPhoto, repairBbox, request, … }`, where `request` is the
 * buildCharRepairRequest contract repairCharacterMismatch takes.
 */

const { log } = require('../utils/logger');

/**
 * @param {Object} a
 * @param {Object} a.storyData      the story (clothingRequirements, visualBible, sceneImages, artStyle, id)
 * @param {Array}  a.characters     the story's characters
 * @param {string} a.artStyle
 * @param {Object} a.img            the page record (sceneCharacters, sceneMetadata, sceneDescription, text, bboxDetection)
 * @param {Object} a.decision       { charName, issueTypes, targetFigure? }
 * @param {string} a.currentImageData  the bytes being repaired
 * @param {Object} a.bestEval       the evaluation of those bytes ({bboxDetection, matches})
 * @param {Object} a.entityReport
 * @param {string} a.jobKey         metrics key (story id or job id)
 */
async function buildCharFixCall({ storyData, characters, artStyle, img, decision, currentImageData, bestEval, entityReport, jobKey }) {
  const pageNumber = img.pageNumber;
  const charName = decision.charName;
  const { resolveCharBbox } = require('./charRepairTarget');
  const { getStyledAvatarForClothing } = require('./entityConsistency');
  const { getFacePhoto } = require('./characterPhotos');

  // A decision carrying `targetFigure` (the presence model's MIXED case)
  // paints THAT figure into `charName`; the name is on no figure yet.
  const byFigure = decision.targetFigure != null;
  const targetResolved = byFigure
    ? require('./charRepairTarget').resolveFigureBbox(decision.targetFigure, { bestEval })
    : resolveCharBbox(charName, {
      bestEval, entityReport, pageNumber, imageData: currentImageData,
    });
  const faceBbox = targetResolved.faceBbox;
  const bodyBbox = targetResolved.bodyBbox;
  if (!faceBbox && !bodyBbox) {
    return { failure: { noBox: true, error: byFigure ? `no box for figure ${decision.targetFigure} (target ${charName})` : `no bbox for ${charName}` } };
  }

  // SAME GUARD THE MANUAL ENDPOINT USES. The detector distributes the names
  // it is given across the figures it sees and never refuses, so a page whose
  // brief names more characters than the render drew hands somebody a
  // borrowed label. Repainting the face under a borrowed label destroys a
  // bystander — an automatic repair does it without anyone watching, which is
  // worse than the manual case, not better.
  // Not for a figure-targeted repaint: there the figure is chosen by id from
  // the evaluation, and no detector label is borrowed.
  const { findBorrowedLabel } = require('./charRepairTarget');
  const borrowed = !byFigure && findBorrowedLabel({
    figures: Array.isArray(targetResolved.figures) ? targetResolved.figures : null,
    sceneCharacters: img.sceneCharacters || [],
    sceneMetadata: img.sceneMetadata || {},
    characterName: charName,
    pageNumber,
  });
  if (borrowed) {
    require('./runMetrics').forJob(jobKey).count('char_repair_reject_borrowed_label');
    return { failure: { error: borrowed.message, borrowedLabel: borrowed } };
  }

  // "not found" was the wrong sentence for the commonest case: the figure is
  // right there, drawn and detected, and what is missing is the REFERENCE a
  // repaint needs. charFixReferenceGap says which — one answer shared with
  // the router (which now declines earlier) and the manual endpoint.
  const { charFixReferenceGap } = require('./charRepairTarget');
  const refGap = charFixReferenceGap({ characters, characterName: charName });
  if (refGap) {
    require('./runMetrics').forJob(jobKey).count('char_repair_skip_no_reference');
    log.warn(`🚫 [CHAR-FIX] p${pageNumber}: ${refGap.message}`);
    return { failure: { error: `char-fix skipped: ${refGap.message}`, referenceGap: refGap.reason } };
  }
  // Same comparison the gap check just made, so the two can never disagree:
  // a canonical match that passed the gap must resolve to a character here.
  const { canonicalName } = require('./castResolver');
  const character = characters.find(c => c && c.name === charName)
    || characters.find(c => c && c.name && canonicalName(c.name) === canonicalName(charName));

  // The outfit the character was RENDERED in: the page's own per-character
  // clothing, else the cover brief / cover hint / pageClothing. One resolver
  // with the manual repair route and the Lab stage, so the reference sheet
  // and the clothing text below come from the same category.
  // NO DEFAULT (owner, 2026-08-07): the resolved category picks the styled
  // avatar this repair paints the character to match, so a guessed 'standard'
  // repaints the story outfit into a wardrobe from an unrelated story.
  const clothingCategory = require('./clothingCategories')
    .resolveRenderedClothingCategory(storyData, pageNumber, charName, img);
  if (!clothingCategory) {
    return { failure: { error: `no clothing category for ${charName} (page record, cover brief and pageClothing all empty) — refusing to repair into a guessed outfit` } };
  }
  // WARDROBE STATE — the third repair entry point gets the same sheet the
  // page was generated against. Without it a character repair repaints the
  // garment the brief took off straight back onto the body, because the only
  // reference it holds shows it worn.
  const wardrobeLookupCategory = (() => {
    try {
      const { wornResolvedForPage } = require('./storyAvatars');
      const { offIdsForCharacter, buildOffCategory } = require('./wardrobeVariants');
      const worn = wornResolvedForPage(storyData?.visualBible || null, img.sceneMetadata, img.sceneCharacters, pageNumber);
      const offIds = offIdsForCharacter(charName, worn);
      return offIds.length > 0 ? buildOffCategory(clothingCategory, offIds) : clothingCategory;
    } catch (err) {
      log.warn(`👕 [UNIFIED PIPELINE] Char-fix ${charName} p${pageNumber}: wardrobe-state lookup failed (${err.message}) — using the base sheet`);
      return clothingCategory;
    }
  })();
  const styledAvatar = await getStyledAvatarForClothing(character, artStyle, wardrobeLookupCategory);
  const avatarPhoto = styledAvatar || getFacePhoto(character);
  const avatarPhotoType = styledAvatar
    ? (clothingCategory.startsWith('costumed') ? `costumed-${clothingCategory.split(':')[1] || 'default'}` : `styled-${clothingCategory}`)
    : 'face';
  if (!avatarPhoto) {
    return { failure: { error: `no avatar photo for ${charName}` } };
  }

  // Repair axes resolved by the ONE central rule (resolveRepairAxes) against
  // the ACTUAL detected face box. A figure repainted INTO another character is
  // a whole-figure redraw, never a face patch.
  const { resolveRepairAxes } = require('./faceRepair');
  // `decision.forceTarget` ('face' | 'body') is set only by the Test Lab's
  // explicit whiteoutTarget knob; the run's decisions never carry it.
  const forceTarget = byFigure ? 'body' : (decision.forceTarget || null);
  const repairAxes = resolveRepairAxes({ hasFaceBbox: !!faceBbox, issueTypes: decision.issueTypes || null, ...(forceTarget ? { forceTarget } : {}) });
  const useFaceOnly = repairAxes.faceOnly;
  // THE FIGURE BOX, for a face repair too — the face goes separately as
  // `faceBbox`, and the face crop is built from that. Passing the face box
  // here made it the "body" box downstream, so the large-face-box guard
  // (face area / body area >= 0.6) saw face == body on every face repair and
  // turned it into a full-figure crosshatch confined to the face box + 10%
  // (job_1790100385959 p14).
  const repairBbox = bodyBbox || faceBbox;

  // The figure's declared facing picks the sheet CELL (the resolveCellPose
  // every generation path uses). Which cell — face alone for a face repair,
  // body alone for a body repair — is decided inside the repair spine by
  // charRepairReference.js, after face vs body is final.
  const referencePose = require('./charRepairReference').referencePoseFor(img, charName);

  // Protection list: same helper, iterated over sceneCharacters so
  // protection draws from the same source as the target lookup. If a
  // character has no bbox in any tier we skip them (can't protect what we
  // can't locate) rather than abort the repair.
  const protectedFaces = [];
  const protectedBodies = [];
  const protectedNames = [];
  const otherChars = (img.sceneCharacters || []).filter(c =>
    c?.name && c.name.toLowerCase() !== charName.toLowerCase()
  );
  for (const otherChar of otherChars) {
    const r = resolveCharBbox(otherChar.name, {
      bestEval, entityReport, pageNumber, imageData: currentImageData,
    });
    if (r.faceBbox) protectedFaces.push(r.faceBbox);
    if (r.bodyBbox) protectedBodies.push(r.bodyBbox);
    if (r.faceBbox || r.bodyBbox) protectedNames.push(otherChar.name);
  }

  // Detection's silhouette for the ORIGINAL figure: in-memory on this run,
  // else the stored figure_mask. Face repairs included: the treatments clip
  // the silhouette to the DINO face box, so the stored full-figure mask yields
  // the head mask.
  const figureMaskPng = await require('./charRepairTarget')
    .resolveFigureMask(charName, targetResolved, { storyId: storyData?.id || jobKey || null, pageNumber });

  // Per-story clothingRequirements is the source of truth (correct for THIS
  // story); avatars.clothing is character-level metadata that persists
  // across stories and can carry stale colours from a previous run. Same
  // priority as storyHelpers.resolveClothingDescription.
  const clothingDesc = (() => {
    const reqs = require('./clothingCategories').resolveCharacterReqs(storyData?.clothingRequirements, charName);
    if (reqs && reqs[clothingCategory]) {
      const cat = reqs[clothingCategory];
      if (cat.signature && cat.signature !== 'none') return cat.signature;
      if (cat.description) return cat.description;
    }
    return character.avatars?.clothing?.[clothingCategory] || '';
  })();
  const sceneDesc = img.sceneDescription || img.text || '';
  // …and then THIS PAGE's worn state on top (2026-09-15). A repaint dresses
  // the character the way the page did, through the same one resolver the
  // image prompt and every judge use.
  const pageClothingDesc = require('./wornItems')
    .resolveOutfitForStoryPage(clothingDesc, charName, storyData, pageNumber, sceneDesc);
  const pageTextPosition = (storyData?.sceneImages || []).find(s => s.pageNumber === pageNumber)?.textPosition || null;
  // Appearance text for the repair prompt (face/hair/build).
  const charDescForPrompt = (() => {
    const d = img.bboxDetection?.characterDescriptions?.[charName]
      ?? (storyData?.sceneImages || []).find(s => s.pageNumber === pageNumber)?.bboxDetection?.characterDescriptions?.[charName];
    const txt = (typeof d === 'string' ? d : d?.richDescription) || '';
    return txt || (character?.description || '');
  })();

  // ONE contract (charRepairRequest.js).
  const { buildCharRepairRequest } = require('./charRepairRequest');
  const request = buildCharRepairRequest({
    imageBackend: 'grok',
    // Structured type only — the prompt never carries the judge's sentence.
    defectTypes: decision.issueTypes || null,
    clothingDescription: pageClothingDesc,
    characterDescription: charDescForPrompt,
    photoType: avatarPhotoType,
    referencePose,
    sceneDescription: sceneDesc,
    faceBbox,
    protectedFaces,
    protectedBodies,
    whiteoutTarget: useFaceOnly ? 'face' : 'body',
    detectionBodyMask: figureMaskPng,
    textPosition: pageTextPosition,
    // The repair prompt's "Art style — match this medium" block; absent, the
    // model is told to match a style it is never told.
    artStyle: storyData?.artStyle || artStyle || null,
    includeDebug: true,
    // Pose lines name other figures by sight, never by name.
    repairNames: require('./repairLogic').buildPageRepairNameMap({
      storyData, sceneDescription: sceneDesc, pageNumber, artStyle,
      detectedFigures: img?.sharedBboxDetection?.figures || img?.bboxDetection?.figures || null,
    }),
  });

  return {
    character, clothingCategory, avatarPhoto, avatarPhotoType,
    targetResolved, faceBbox, bodyBbox, repairBbox, useFaceOnly,
    protectedNames, request,
  };
}

module.exports = { buildCharFixCall };

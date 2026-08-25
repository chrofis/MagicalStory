/**
 * WHO are we repairing, and WHERE are they — one implementation, both callers.
 *
 * WHY THIS EXISTS: the automatic pipeline and the manual repair endpoint each
 * grew their own answer to those two questions, and only one of them was any
 * good. The pipeline built a proper cast (identity lines + per-page clothing +
 * the Visual Bible's secondary characters) and resolved boxes through a tiered
 * ladder; the endpoint hand-rolled a bare list of names and a second ladder.
 *
 * That divergence produced the bug: on p15 of job_1787514666616_yw9qsv1vf the
 * endpoint's nameless lineup let the detector spread four user names over four
 * figures, "Sarah" landed on the Visual Bible secondary in the red coat, and a
 * face repair whited out the wrong person's head. Grok painted Sarah onto her,
 * three draws running, and the blend gate refused all three — correctly. The
 * pipeline, on the same page, would have described that secondary and named her.
 *
 * Repainting a human face is the single most destructive thing this codebase
 * does to an image. It gets ONE targeting implementation.
 */
'use strict';

const log = require('./logger');

const getStoryHelpers = () => require('./storyHelpers');
const images = () => require('./images');

/**
 * The cast the detector should be told to expect on a page: every character in
 * the scene with an identity line and their page clothing, plus the Visual
 * Bible secondaries the scene metadata names.
 *
 * `requiredName` is forced into the lineup even when the page metadata forgets
 * them — otherwise a lookup for that character can never succeed. It is NOT a
 * promise they are in the picture; findBorrowedLabel decides that.
 */
function buildPageCast({
  storyData,
  sceneCharacters = [],
  sceneMetadata = {},
  clothingByName = null,
  outlineCharacters = [],
  artStyle = null,
  requiredName = null,
  label = '',
  // Explicit because the pipeline carries the Visual Bible as its own context
  // field, separate from storyData — assuming they are the same object is how a
  // secondary character silently stops being described.
  visualBible = null,
} = {}) {
  const sh = getStoryHelpers();
  const clothing = clothingByName || sceneMetadata.characterClothing || {};
  const style = artStyle || storyData?.artStyle || null;

  const expected = (sceneCharacters || []).map((c) => {
    const name = c?.name || c;
    if (!c || typeof c !== 'object') return { name, description: '' };
    const clothingText = sh.buildIdentityClothingText(
      c, clothing[name], style, storyData?.clothingRequirements || null, { label },
    );
    return { name, description: sh.buildIdentityLine(c, clothingText) };
  }).filter(c => c.name);

  // Story-invented people (VB secondaries, animals). Without these the detector
  // has no name for a figure that is genuinely in the picture, and it will
  // borrow one from the user's cast rather than leave the figure unnamed.
  expected.push(...sh.buildSecondaryExpectedCharacters(
    visualBible || storyData?.visualBible, sceneMetadata, expected.map(c => c.name),
    { pageLabel: label, extraNames: outlineCharacters || [] },
  ));

  if (requiredName && !expected.some(c => String(c.name).toLowerCase() === String(requiredName).toLowerCase())) {
    const ch = (storyData?.characters || []).find(x => String(x?.name).toLowerCase() === String(requiredName).toLowerCase());
    const clothingText = ch
      ? sh.buildIdentityClothingText(ch, clothing[requiredName], style, storyData?.clothingRequirements || null, { label })
      : '';
    expected.push({ name: requiredName, description: ch ? sh.buildIdentityLine(ch, clothingText) : '' });
  }
  return expected;
}

/**
 * Every name the page was WRITTEN for — the brief, not the render.
 */
function briefNamesForPage({ sceneCharacters = [], sceneMetadata = {} } = {}) {
  const names = new Set();
  for (const c of (sceneCharacters || [])) {
    const n = typeof c === 'string' ? c : c?.name;
    if (n) names.add(n);
  }
  for (const n of Object.keys(sceneMetadata?.characterPositions || {})) if (n) names.add(n);
  for (const n of (sceneMetadata?.characters || [])) if (typeof n === 'string' && n) names.add(n);
  return names;
}

/**
 * A NAME IS NOT EVIDENCE WHEN THERE ARE FEWER FIGURES THAN NAMES.
 *
 * The detector distributes the names it is given across the figures it sees; it
 * never refuses. So when a page's brief names more characters than the render
 * actually drew, one label is necessarily borrowed — and a confident wrong
 * label is indistinguishable from a right one. Repainting the face under a
 * borrowed label destroys a bystander, which is strictly worse than declining.
 *
 * Returns null when the labels can be trusted, else a description of the doubt.
 * `figures` must come from the SAME detection that produced the target box: a
 * stored box is not more trustworthy than a fresh one, it is the same detector
 * cached, and caching a misattribution makes it permanent.
 */
function findBorrowedLabel({ figures, sceneCharacters = [], sceneMetadata = {}, characterName = '', pageNumber = null } = {}) {
  if (!Array.isArray(figures)) return null;      // no figure list → no opinion
  const brief = briefNamesForPage({ sceneCharacters, sceneMetadata });
  if (brief.size <= figures.length) return null;

  const drew = [...new Set(figures.map(f => f.name || 'unidentified figure'))];
  const who = drew.length
    ? `The detector labelled them ${drew.join(', ')} — one of those labels belongs to a character who was not drawn.`
    : 'No figures were detected at all.';
  log.warn(`[CHAR REPAIR] p${pageNumber}: brief lists ${brief.size} character(s) but only ${figures.length} figure(s) were drawn - "${characterName}" may be a borrowed label; refusing`);
  return {
    briefNames: [...brief],
    figureCount: figures.length,
    detectedFigures: drew,
    message: `${characterName} could not be reliably identified on page ${pageNumber} - nothing was repainted. The page was written for ${brief.size} characters but only ${figures.length} were drawn, so the name may belong to a different figure. ${who} Redo the page instead.`,
  };
}

/**
 * Where is this character on this page? Tiered, most-trusted first.
 *
 * Tier 1 entity report — appearances from the generation-time consistency pass,
 *        which ran with the full cast and cross-checked identity across pages.
 * Tier 2 canonical bbox detection figures (stored or fresh — same detector).
 * Tier 3 quality-eval matches (face only).
 *
 * Stored boxes are only valid for the bytes they were computed on: when
 * `imageData` is supplied every tier is fingerprint-checked (bboxPairsWith), so
 * a box stamped for an earlier version can never repaint the current one.
 *
 * MOVED HERE from repairPipeline.js so the manual endpoint stops carrying a
 * second, different ladder.
 */
function resolveCharBbox(charName, { bestEval, entityReport, pageNumber, imageData = null } = {}) {
  if (!charName || charName === 'UNKNOWN') {
    return { faceBbox: null, bodyBbox: null, source: null };
  }
  const pairs = (det) => !imageData || images().bboxPairsWith(det, imageData);
  const lowerName = charName.toLowerCase();
  const toRect = (b) => {
    if (!b) return null;
    if (Array.isArray(b)) return b;
    if (typeof b.y === 'number' && typeof b.height === 'number') {
      return [b.y, b.x, b.y + b.height, b.x + b.width];
    }
    return null;
  };

  // Tier 1: entity report (cascade-improved faces when available)
  const charEntity = entityReport?.characters?.[charName];
  if (charEntity?.byClothing) {
    for (const clothingData of Object.values(charEntity.byClothing)) {
      const app = clothingData.appearances?.find(a => a.pageNumber === pageNumber);
      if (app && (app.faceBox || app.bodyBox) && pairs(app)) {
        const faceBbox = toRect(app.faceBox);
        const bodyBbox = toRect(app.bodyBox);
        if (faceBbox || bodyBbox) {
          // `clothing` travels with the box: the manual endpoint resolves the
          // styled avatar to repaint towards from the appearance's own outfit,
          // and dropping it here would silently fall back to the page default.
          return { faceBbox, bodyBbox, source: 'entity', clothing: app.clothing || null };
        }
      }
    }
  }

  // Tier 2: canonical bbox detection figures
  const figures = pairs(bestEval?.bboxDetection) ? (bestEval?.bboxDetection?.figures || []) : [];
  const figure = figures.find(f => {
    if (!f.name || f.name === 'UNKNOWN') return false;
    return f.name.toLowerCase() === lowerName ||
      (f.label && f.label.toLowerCase().includes(lowerName));
  });
  if (figure && (figure.faceBox || figure.bodyBox)) {
    // Reuse the detection SAM silhouette (page-res PNG, _gdinoMasks index-
    // aligned with figures) so the repair blend gate skips re-segmenting the
    // ORIGINAL figure. Byte-safe: this tier only runs when pairs() confirmed
    // the detection matches the pixels being repaired. Absent on reloaded-from-
    // DB detections → null → the gate falls back to a fresh SAM call.
    const figIdx = figures.indexOf(figure);
    const bodyMask = (figIdx >= 0 && bestEval.bboxDetection._gdinoMasks?.[figIdx]) || null;
    return {
      faceBbox: toRect(figure.faceBox),
      bodyBbox: toRect(figure.bodyBox),
      source: 'bbox',
      bodyMask,
      figures,
    };
  }

  // Tier 3: quality eval matches (face only)
  const matches = bestEval?.matches || [];
  const match = matches.find(m =>
    m.name?.toLowerCase() === lowerName ||
    m.character?.toLowerCase() === lowerName
  );
  if (match && (match.face_bbox || match.bbox)) {
    return {
      faceBbox: toRect(match.face_bbox),
      bodyBbox: toRect(match.bbox),
      source: 'eval',
    };
  }

  return { faceBbox: null, bodyBbox: null, source: null, figures };
}

module.exports = {
  buildPageCast,
  briefNamesForPage,
  findBorrowedLabel,
  resolveCharBbox,
};

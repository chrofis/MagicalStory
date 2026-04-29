/**
 * Text-space repair — single source of truth for the calm-zone legibility loop.
 *
 * Used by:
 *   - server.js text-region phase (initial generation)
 *   - server/lib/images.js Step 7.5 (post-repair recovery, after iterate /
 *     inpaint / character-fix may have shifted content into the overlay zone)
 *
 * Rule (one rule, no fallbacks):
 *
 *   calmFoundPx = calm pixels INSIDE the polygon the renderer will draw text
 *                 into (getTextZonePolygon — triangle for corners, rectangle
 *                 for full-width strips, sized by languageLevel).
 *   calmNeededPx = words × pxPerWord(fontPt)   (font metrics, no heuristic)
 *
 *   if calmFoundPx < calmNeededPx → re-roll the image (up to maxRetries)
 *                                   with the textAreaMask hint, pick best
 *                                   by calmFoundPx.
 *
 * No "fall back to broad-zone coverage when the probe fails" — if we can't
 * measure, we throw. Silent fallbacks hide bugs.
 */

const sharp = require('sharp');
const { log } = require('../utils/logger');
const { detectAndLightenTextRegion } = require('./textRegion');
const { getTextZonePolygon, polygonArea, sizeNameFor } = require('./textMasks');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const {
  REPAIR,
  requiredTextPixels,
  requiredFontPt,
  countWords,
} = require('../config/textRegion');

/**
 * Probe the image's pixel dimensions. Throws on bad input — callers must
 * check for non-empty imageData before calling.
 */
async function probeDimensions(imageData) {
  const buf = Buffer.from((imageData || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) {
    throw new Error('image has no width/height — corrupt input?');
  }
  return { width: meta.width, height: meta.height };
}

/**
 * Run a single calm-pixel measurement against the rendered overlay polygon.
 * Returns { polygon, calmFoundPx, areaPx, rect, position }.
 */
async function measureCalmZone(imageData, textPosition, languageLevel, pageNumber) {
  const { width, height } = await probeDimensions(imageData);
  const polygon = getTextZonePolygon(textPosition, languageLevel, width, height);
  if (!polygon) throw new Error(`no polygon for textPosition=${textPosition}`);
  const det = await detectAndLightenTextRegion(imageData, textPosition, pageNumber, { overlayPolygon: polygon });
  return {
    polygon,
    calmFoundPx: det.overlayCalmPx ?? 0,
    areaPx: det.overlayAreaPx ?? polygonArea(polygon),
    rect: det.rect,
    position: det.position,
    score: det.score,
  };
}

/**
 * Ensure the page's calm zone has enough calm pixels to fit the actual text.
 * If the original image fails the gate, re-roll with the textAreaMask hint
 * up to REPAIR.maxRetries times and pick the best by calmFoundPx.
 *
 * Returns:
 *   {
 *     winnerImageData,       // the chosen image (original or a repair)
 *     winnerCandidate,       // the chosen entry from candidates[]
 *     winnerIndex,           // candidate array position (0 = original)
 *     calmNeededPx,
 *     candidates: [{
 *       imageData, source, calmFoundPx, areaPx, rect, position,
 *       prompt, modelId, grokRefImages,
 *     }, ...],
 *     report: {              // for textCoverageReport persistence
 *       words, fontPt, calmNeededPx, calmFoundPx, areaPx,
 *       passed, retriesUsed, winnerIndex,
 *       candidates: [{ index, source, calmFoundPx, calmPct, position }],
 *     },
 *   }
 *
 * `generateImage` is a caller-supplied async function so this module
 * doesn't import images.js (would be a circular require). It receives the
 * repair prompt and the textAreaMask + previousImage and returns the
 * generateImageOnly result shape ({ imageData, modelId, grokRefImages,
 * usage }).
 */
async function ensureCalmZone(opts) {
  const {
    imageData,                      // base64 of the page image
    text,                           // page text (for word count)
    textPosition,                   // 'top-left' / 'top-right' / etc.
    pageNumber,
    languageLevel,                  // 'standard' / '1st-grade' / 'advanced'
    textAreaMask,                   // pre-built B/W mask PNG (caller-supplied)
    sceneDescription = '',          // for the textSpaceRepair prompt
    generateImage,                  // async (repairPrompt, options) => result
    onUsage,                        // optional usage tracker callback
    label = 'TEXT-SPACE',           // log prefix label
  } = opts;

  if (!imageData) throw new Error('ensureCalmZone: imageData required');
  if (!textPosition) throw new Error('ensureCalmZone: textPosition required');
  if (typeof generateImage !== 'function') throw new Error('ensureCalmZone: generateImage callback required');

  const fontPt = requiredFontPt(languageLevel);
  const words = countWords(text);
  const calmNeededPx = requiredTextPixels(words, fontPt);

  // ── Detect on the original ──────────────────────────────────────────────
  const baseMeas = await measureCalmZone(imageData, textPosition, languageLevel, pageNumber);
  const candidates = [{
    imageData,
    source: 'original',
    calmFoundPx: baseMeas.calmFoundPx,
    areaPx: baseMeas.areaPx,
    rect: baseMeas.rect,
    position: baseMeas.position,
    prompt: null,
    modelId: null,
    grokRefImages: null,
  }];

  log.info(`📝 [${label}] P${pageNumber}: ${words}w@${fontPt}pt — calmNeeded ${calmNeededPx}px, calmFound ${baseMeas.calmFoundPx}px in ${Math.round(baseMeas.areaPx)}px ${sizeNameFor(languageLevel)} ${textPosition} polygon`);

  const passes = (px) => px >= calmNeededPx;

  // ── Repair loop ─────────────────────────────────────────────────────────
  if (!passes(baseMeas.calmFoundPx) && textAreaMask && REPAIR.maxRetries > 0) {
    log.info(`🩹 [${label}] P${pageNumber}: BELOW THRESHOLD → repairing (max ${REPAIR.maxRetries} attempts)`);
    for (let attempt = 1; attempt <= REPAIR.maxRetries; attempt++) {
      try {
        const repairPrompt = fillTemplate(PROMPT_TEMPLATES.textSpaceRepair, {
          SCENE_DESCRIPTION: sceneDescription.substring(0, 1200),
        });
        // Caller's previous-best is candidates[0].imageData (the original) —
        // the mask + the unchanged scene give the model a clean retry.
        const result = await generateImage(repairPrompt, {
          previousImage: candidates[0].imageData,
          textAreaMask,
        });
        if (!result?.imageData) {
          log.warn(`⚠️ [${label}] P${pageNumber} attempt ${attempt}: no image returned`);
          continue;
        }
        if (onUsage && result.usage) onUsage(result, attempt);

        const meas = await measureCalmZone(result.imageData, textPosition, languageLevel, pageNumber);
        candidates.push({
          imageData: result.imageData,
          source: `text-space-repair-${attempt}`,
          calmFoundPx: meas.calmFoundPx,
          areaPx: meas.areaPx,
          rect: meas.rect,
          position: meas.position,
          prompt: repairPrompt,
          modelId: result.modelId || null,
          grokRefImages: result.grokRefImages || null,
        });
        log.info(`🩹 [${label}] P${pageNumber} attempt ${attempt}: calmFound ${meas.calmFoundPx}px (need ${calmNeededPx}px)`);

        if (passes(meas.calmFoundPx)) break;
      } catch (err) {
        log.warn(`⚠️ [${label}] P${pageNumber} attempt ${attempt} failed: ${err.message}`);
      }
    }
  }

  // ── Pick the winner: highest calmFoundPx ────────────────────────────────
  let winnerIndex = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].calmFoundPx > candidates[winnerIndex].calmFoundPx) winnerIndex = i;
  }
  const winner = candidates[winnerIndex];
  const passed = passes(winner.calmFoundPx);

  log.info(`${passed ? '✅' : '⚠️'} [${label}] P${pageNumber}: winner v${winnerIndex} (${winner.source}) calmFound ${winner.calmFoundPx}px / needed ${calmNeededPx}px ${passed ? 'PASS' : 'STILL BELOW'} (${candidates.length - 1} retries)`);

  return {
    winnerImageData: winner.imageData,
    winnerCandidate: winner,
    winnerIndex,
    calmNeededPx,
    candidates,
    report: {
      words,
      fontPt,
      calmNeededPx,
      calmFoundPx: winner.calmFoundPx,
      areaPx: Math.round(winner.areaPx),
      passed,
      retriesUsed: candidates.length - 1,
      winnerIndex,
      candidates: candidates.map((c, i) => ({
        index: i,
        source: c.source,
        calmFoundPx: c.calmFoundPx,
        calmPct: c.areaPx ? Number(((c.calmFoundPx / c.areaPx) * 100).toFixed(1)) : 0,
        position: c.position,
      })),
    },
  };
}

module.exports = {
  ensureCalmZone,
  measureCalmZone,
};

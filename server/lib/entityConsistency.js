/**
 * Entity Consistency Module
 *
 * Groups entity appearances across story pages and evaluates consistency
 * using cropped grids per entity (character, object, pet).
 *
 * This provides more focused consistency checking than the legacy full-image approach.
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createLabeledGrid, escapeXml } = require('./repairGrid');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { log } = require('../utils/logger');
const { extractSceneMetadata, buildCharacterPhysicalDescription, getCharactersInScene, buildHairDescription, extractJsonFromText } = require('./storyHelpers');
const { getFacePhoto, loadAvatarBytes } = require('./characterPhotos');
const { detectAllBoundingBoxes, sanitizeForGemini } = require('./images');
const { getCurrentLogger } = require('./generationLogger');
const { COVER_HINT_KEY, COVER_PAGE_NUMBERS } = require('./coverKeys');
const r2 = require('./r2');
const geminiPad = require('./geminiPad');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PHOTO_ANALYZER_URL = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

/**
 * Resolve the active version for a scene image. Each version stores its own
 * imageData and bboxDetection — without this the grid was being composed from
 * page-level imageData (almost always v0), so a page where v0 had a wrong
 * character but v3 (active, score 95) had the correct one still produced a
 * mismatch finding. The active version is the source of truth.
 *
 * Priority for bboxDetection: sharedBboxDetection (unified pipeline pre-step)
 *   > active version's bboxDetection > page-level fallback.
 *
 * @param {Object} img - scene image record with imageVersions, activeVersion, imageData, bboxDetection
 * @returns {{ activeIdx: number, activeVersion: Object|null, imageData: string|null, bboxDetection: Object|null, versionIndex: number|null }}
 */
function resolveActiveVersionData(img) {
  const versions = Array.isArray(img.imageVersions) ? img.imageVersions : [];
  const lastIdx = versions.length - 1;
  // A detection is only usable with the bytes it was computed on — verify the
  // sourceImageFp stamp (see images.js bboxPairsWith). A stale candidate is
  // skipped, so downstream falls through to the next source or to fallback
  // re-detection on the current pixels.
  const { bboxPairsWith } = require('./images');
  const firstPairing = (imageData, ...cands) =>
    cands.find(d => d && bboxPairsWith(d, imageData)) || null;

  // Prefer the ROOT imageData/bboxDetection: rehydrate fills the root with the
  // image_version_meta-active version (the single source of truth — what PDFs,
  // prints and the share viewer serve), and the pipeline keeps it current
  // mid-generation. The old blob `img.activeVersion` branch was deleted; it was
  // a second source of truth that diverged from meta after a manual version pin.
  // Last version stays as a final fallback for callers that stripped the root
  // but kept version bytes.
  if (img.imageData) {
    return {
      activeIdx: -1,
      activeVersion: null,
      imageData: img.imageData,
      bboxDetection: firstPairing(img.imageData, img.sharedBboxDetection, img.bboxDetection),
      versionIndex: null
    };
  }
  const activeVersion = lastIdx >= 0 ? versions[lastIdx] : null;
  return {
    activeIdx: lastIdx,
    activeVersion,
    imageData: activeVersion?.imageData || null,
    bboxDetection: firstPairing(activeVersion?.imageData, img.sharedBboxDetection, activeVersion?.bboxDetection, img.bboxDetection),
    versionIndex: lastIdx >= 0 ? lastIdx : null
  };
}

/**
 * Detect faces in an illustration using anime + Haar cascades via Python service.
 * Returns face locations with padded crops. Much more accurate than Gemini bbox for
 * finding actual face positions in watercolor/cartoon illustrations.
 * @param {string} imageData - base64 data URL of the illustration
 * @param {number} padPercent - padding around face crops (default 60%)
 * @returns {Array<{source, confidence, faceBox, paddedBox, cropData}>} or empty array on failure
 */
async function detectIllustrationFaces(imageData, padPercent = 60) {
  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/detect-illustration-faces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData, pad_percent: padPercent }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      log.warn(`[CASCADE-DETECT] Python service returned ${response.status}`);
      return [];
    }
    const result = await response.json();
    if (!result.success) {
      log.warn(`[CASCADE-DETECT] Detection failed: ${result.error}`);
      return [];
    }
    log.debug(`[CASCADE-DETECT] Found ${result.total_faces} faces (anime: ${result.detectors?.anime}, haar: ${result.detectors?.haar})`);
    return result.faces || [];
  } catch (err) {
    log.warn(`[CASCADE-DETECT] Service unavailable: ${err.message}`);
    return [];
  }
}

/**
 * Validate a face crop with Gemini — is this actually a face?
 * Used for haar-only detections that might be false positives.
 * @param {string} cropData - base64 data URL of the cropped region
 * @returns {boolean} true if Gemini confirms this is a face
 */
async function validateFaceCropWithGemini(cropData) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    const base64 = r2.stripDataUriPrefix(cropData);
    const result = await model.generateContent([
      { inlineData: { mimeType: 'image/jpeg', data: base64 } },
      'Does this image show a human or illustrated character face? Answer only "yes" or "no".'
    ]);
    const answer = result.response.text().trim().toLowerCase();
    return answer.startsWith('yes');
  } catch (err) {
    log.warn(`[CASCADE-DETECT] Gemini face validation failed: ${err.message}`);
    return false; // Assume not a face on error
  }
}

/**
 * For every figure that has both faceBox and bodyBox, expand bodyBox to contain
 * the faceBox. Gemini often places faceBox above bodyBox in illustrations.
 * This runs after cascade merge (for cascade-improved figures) AND as a standalone
 * fallback when cascade detection is unavailable.
 */
function ensureFaceInsideBody(figures) {
  for (const fig of figures) {
    const fb = fig.faceBox;
    const bb = fig.bodyBox;
    if (!fb || !Array.isArray(fb) || fb.length < 4) continue;
    if (!bb || !Array.isArray(bb) || bb.length < 4) continue;

    const [fymin, fxmin, fymax, fxmax] = fb;
    const [bymin, bxmin, bymax, bxmax] = bb;

    if (fymin < bymin || fxmin < bxmin || fymax > bymax || fxmax > bxmax) {
      fig.bodyBox = [
        Math.min(bymin, fymin),
        Math.min(bxmin, fxmin),
        Math.max(bymax, fymax),
        Math.max(bxmax, fxmax),
      ];
      log.debug(`[BBOX-FIX] ${fig.name || fig.label}: expanded bodyBox to include faceBox`);
    }
  }
}

// Depth-tier face-height envelopes (face height as fraction of frame height).
// Face boxes are placed at the cascade detection's CENTER (reliable position),
// and sized using these envelopes — neither Gemini nor cascade dimensions are
// reliable, so we use a fixed-per-depth ideal size. Bumped 2026-04-25 after
// dry-run interview showed previous envelopes were systematically too small.
const DEPTH_FACE_HEIGHT = {
  foreground: { min: 0.15, ideal: 0.25, max: 0.42 },
  midground:  { min: 0.08, ideal: 0.13, max: 0.22 },
  background: { min: 0.04, ideal: 0.07, max: 0.12 },
};
const DEFAULT_FACE_HEIGHT = DEPTH_FACE_HEIGHT.midground;
// Face aspect ratio (width / height) — anime/illustration faces sit around 0.85.
const FACE_ASPECT = 0.85;

function depthEnvelopeFor(depth) {
  const key = String(depth || '').toLowerCase().trim();
  return DEPTH_FACE_HEIGHT[key] || DEFAULT_FACE_HEIGHT;
}

function clampFaceHeight(h, env) {
  return Math.max(env.min, Math.min(env.max, h));
}

/**
 * Build a face box of given dimensions centred on (cx, cy), all in 0-1
 * normalised frame coordinates. Returns [ymin, xmin, ymax, xmax].
 */
function makeFaceBox(cx, cy, faceHeight, faceWidth) {
  const halfH = faceHeight / 2;
  const halfW = faceWidth / 2;
  return [
    Math.max(0, cy - halfH),
    Math.max(0, cx - halfW),
    Math.min(1, cy + halfH),
    Math.min(1, cx + halfW),
  ];
}

/**
 * Merge cascade-detected faces into Gemini bbox figures.
 *
 * Strategy (after the 2026-04-25 dry-run interview across art styles):
 *
 *   - Cascade detection CENTERS are reliable; cascade BOX SIZES are not (the
 *     classifier sometimes fires on just an eye or the mouth).
 *   - Gemini identifies characters by name well, and gives roughly the right
 *     face SIZE, but its bbox positions are 50–100% off across every style.
 *   - The depth tier of each character (from scene metadata, passed in as
 *     `expectedCharacters`) is the most reliable size signal we have.
 *
 * For each named Gemini figure:
 *   1. Find the cascade detection nearest the figure's expected location.
 *   2. If matched, place a face box at the CASCADE CENTER, sized using the
 *      depth envelope (or Gemini's face height clamped to that envelope).
 *      Cascade `faceBox` (tight) is used for the center; `paddedBox` is
 *      ignored — its 60% padding drags the rectangle into the chest.
 *   3. If no cascade match but Gemini has a faceBox, keep Gemini's box but
 *      clamp its height to the depth envelope.
 *   4. If neither, leave the figure as-is (back-turned characters live here).
 *
 * @param {Array} geminiFigures - figures from detectAllBoundingBoxes
 * @param {Array} cascadeFaces  - faces from detectIllustrationFaces
 * @param {number} imgWidth     - source image width (px)
 * @param {number} imgHeight    - source image height (px)
 * @param {Array}  [expectedCharacters] - the list passed into the bbox
 *                  detection prompt; each element may have { name, depth }
 *                  or a `position` string ending in foreground/midground/
 *                  background. Used to pick the per-character depth envelope.
 * @returns {Array} merged figures with refined faceBox coordinates
 */
async function mergeCascadeFacesWithGemini(geminiFigures, cascadeFaces, imgWidth, imgHeight, expectedCharacters = []) {
  // Build a name → depth lookup. depth may be on a top-level field or embedded
  // in `position` (e.g. "left foreground", "center background").
  const depthByName = new Map();
  const extractDepth = (c) => {
    if (!c) return 'midground';
    if (c.depth) return c.depth;
    const p = String(c.position || '').toLowerCase();
    if (p.includes('foreground')) return 'foreground';
    if (p.includes('background')) return 'background';
    if (p.includes('midground')) return 'midground';
    return 'midground';
  };
  for (const c of (expectedCharacters || [])) {
    if (c?.name) depthByName.set(c.name.toLowerCase(), extractDepth(c));
  }

  // Depth detection uses multiple signals and picks the DEEPEST tier any
  // signal voted for (so foreground beats midground beats background).
  // Biases toward larger face boxes — undersizing was the user's main
  // complaint after the dry-run interview.
  const RANK = { foreground: 3, midground: 2, background: 1 };
  const tierFromString = (s) => {
    const t = String(s || '').toLowerCase();
    if (t.includes('foreground')) return 'foreground';
    if (t.includes('background')) return 'background';
    if (t.includes('midground')) return 'midground';
    return null;
  };
  const lookupDepth = (fig) => {
    const votes = [];
    // Signal A: explicit depth from scene metadata, by character name.
    if (fig?.name && depthByName.has(fig.name.toLowerCase())) {
      votes.push(depthByName.get(fig.name.toLowerCase()));
    }
    // Signal B: Gemini's position field (sometimes contains "foreground"/etc).
    const fromGeminiPos = tierFromString(fig?.position);
    if (fromGeminiPos) votes.push(fromGeminiPos);
    // Signal C: body-bbox height — wider thresholds so close-up portraits and
    // partially-visible foreground figures (head + torso, ~25-35% of frame)
    // get classed as foreground, not midground.
    const bb = fig?.bodyBox;
    if (Array.isArray(bb) && bb.length === 4) {
      const bodyH = bb[2] - bb[0];
      if (bodyH > 0.20) votes.push('foreground');
      else if (bodyH > 0.08) votes.push('midground');
      else votes.push('background');
    }
    // Signal D: Gemini's face height itself. If the face already takes up
    // more than 12% of the frame, the figure is foreground regardless of
    // what the body box says.
    const fb = fig?.faceBox;
    if (Array.isArray(fb) && fb.length === 4) {
      const faceH = fb[2] - fb[0];
      if (faceH > 0.12) votes.push('foreground');
      else if (faceH > 0.06) votes.push('midground');
    }
    if (votes.length === 0) return 'midground';
    // Pick the deepest tier (highest rank).
    return votes.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  };

  if (!cascadeFaces || cascadeFaces.length === 0) {
    // No cascade help — size each face to max(Gemini, ideal) capped at max.
    // Same max(Gemini, ideal) policy as the matched-cascade path.
    for (const fig of geminiFigures) {
      const fb = fig.faceBox;
      if (!Array.isArray(fb) || fb.length !== 4) continue;
      const env = depthEnvelopeFor(lookupDepth(fig));
      const h = fb[2] - fb[0];
      const newH = Math.min(env.max, Math.max(h, env.ideal));
      if (Math.abs(newH - h) > 0.005) {
        const cx = (fb[1] + fb[3]) / 2;
        const cy = (fb[0] + fb[2]) / 2;
        fig._geminiFaceBox = fb;
        fig.faceBox = makeFaceBox(cx, cy, newH, newH * FACE_ASPECT);
        fig._sizeAdjusted = true;
      }
    }
    ensureFaceInsideBody(geminiFigures);
    return geminiFigures;
  }

  const matchedCascade = new Set();

  for (const fig of geminiFigures) {
    const bb = fig.bodyBox;
    if (!bb || !Array.isArray(bb)) continue;

    const bodyCenterX = (bb[1] + bb[3]) / 2;
    const bodyTopY = bb[0];
    const bodyW = bb[3] - bb[1];
    const bodyH = bb[2] - bb[0];

    // Cascade match — anchor on Gemini's FACE center when present, fall
    // back to body top otherwise. Hard distance cap (15% of frame in
    // either axis) so a cascade detection on a different figure can't
    // claim this one. Earlier dry-run runs showed body-top anchoring
    // matched cascade faces 30% away on multi-figure scenes.
    const fbCur = fig.faceBox;
    const useFaceAnchor = Array.isArray(fbCur) && fbCur.length === 4;
    const anchorX = useFaceAnchor ? (fbCur[1] + fbCur[3]) / 2 : bodyCenterX;
    const anchorY = useFaceAnchor ? (fbCur[0] + fbCur[2]) / 2 : bodyTopY;
    const MAX_MATCH_DIST = 0.15; // fraction of frame

    let bestDist = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < cascadeFaces.length; i++) {
      if (matchedCascade.has(i)) continue;
      const cf = cascadeFaces[i];
      const cx = (cf.faceBox.x + cf.faceBox.width / 2) / imgWidth;
      const cy = (cf.faceBox.y + cf.faceBox.height / 2) / imgHeight;
      const dx = Math.abs(cx - anchorX);
      const dy = Math.abs(cy - anchorY);
      // Reject if cascade is too far from anchor in either axis.
      if (dx > MAX_MATCH_DIST || dy > MAX_MATCH_DIST) continue;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    const env = depthEnvelopeFor(lookupDepth(fig));
    const oldFace = fig.faceBox;
    const oldHeight = (Array.isArray(oldFace) && oldFace.length === 4) ? (oldFace[2] - oldFace[0]) : null;

    if (bestIdx >= 0) {
      // Cascade matched — use cascade CENTER + depth-envelope SIZE.
      // Use Gemini's face height as a hint when it falls inside the envelope;
      // otherwise fall back to the envelope's ideal value.
      const cf = cascadeFaces[bestIdx];
      matchedCascade.add(bestIdx);
      const cx = (cf.faceBox.x + cf.faceBox.width / 2) / imgWidth;
      const cy = (cf.faceBox.y + cf.faceBox.height / 2) / imgHeight;

      // Face height = max(Gemini face height, depth-tier ideal), clamped
      // to depth-tier max. Use whichever is bigger so we never undersize:
      // when Gemini's box is wide enough, trust it; when Gemini's box is
      // small or absent, fall back to the depth ideal. Cap at depth-max
      // so a wildly oversized Gemini box doesn't paint the whole figure.
      const faceH = Math.min(env.max, Math.max(oldHeight || 0, env.ideal));
      const faceW = faceH * FACE_ASPECT;
      const newFace = makeFaceBox(cx, cy, faceH, faceW);

      fig._geminiFaceBox = oldFace;
      fig.faceBox = newFace;
      fig._cascadeFace = cf.source;
      fig._depthTier = lookupDepth(fig);

      // Body box should still contain the face. Expand if needed.
      if (bb.length >= 4) {
        const [bymin, bxmin, bymax, bxmax] = bb;
        const [fymin, fxmin, fymax, fxmax] = newFace;
        if (fxmin < bxmin || fymin < bymin || fxmax > bxmax || fymax > bymax) {
          fig.bodyBox = [
            Math.min(bymin, fymin),
            Math.min(bxmin, fxmin),
            Math.max(bymax, fymax),
            Math.max(bxmax, fxmax),
          ];
        }
      }

      log.debug(`[CASCADE-MERGE] ${fig.name || fig.label}: cascade ${cf.source} center + ${fig._depthTier} envelope (h=${faceH.toFixed(3)})`);
      continue;
    }

    // No cascade match. Keep Gemini's center but force the height to be
    // at least the depth-tier ideal (and cap at the max). Same max(Gemini,
    // ideal) policy as the matched-cascade path. Back-turned figures land
    // here too — they keep Gemini's center, just sized properly.
    if (Array.isArray(oldFace) && oldFace.length === 4) {
      const cx = (oldFace[1] + oldFace[3]) / 2;
      const cy = (oldFace[0] + oldFace[2]) / 2;
      const newH = Math.min(env.max, Math.max(oldHeight || 0, env.ideal));
      if (Math.abs(newH - (oldHeight || 0)) > 0.005) {
        fig._geminiFaceBox = oldFace;
        fig.faceBox = makeFaceBox(cx, cy, newH, newH * FACE_ASPECT);
        fig._sizeAdjusted = true;
        log.debug(`[CASCADE-MERGE] ${fig.name || fig.label}: no cascade match — sized Gemini face to ${newH.toFixed(3)} (${lookupDepth(fig)})`);
      }
    }
  }

  // Unmatched cascade faces are not added as new figures (they're noise).
  const unmatchedCount = cascadeFaces.length - matchedCascade.size;
  if (unmatchedCount > 0) {
    log.debug(`[CASCADE-MERGE] ${unmatchedCount} unmatched cascade faces ignored (not adding as new figures)`);
  }

  ensureFaceInsideBody(geminiFigures);
  return geminiFigures;
}

// Configuration
const ENTITY_CHECK_MODEL = 'gemini-2.5-flash';  // Text model for evaluation
const FACE_CROP_SIZE = 256;   // Size for face crops
const BODY_CROP_SIZE = 512;   // Size for body crops
const MIN_APPEARANCES = 1;    // Minimum appearances to check consistency (1 = compare even single appearances against reference avatar)
const MAX_GRID_CELLS = 9;     // Maximum cells per grid (3x3)

// Canonical clothing category normalizer — single source of truth lives in
// clothingCategories.js. Re-exported here for backwards compat with existing
// callers in this module.
const { normalizeClothingCategory, resolveCharacterReqs } = require('./clothingCategories');

/**
 * Group appearances by clothing category
 *
 * @param {Array} appearances - Array of appearance objects with clothing field
 * @returns {Map<string, Array>} Map of clothingCategory -> appearances
 */
function groupAppearancesByClothing(appearances) {
  const groups = new Map();

  for (const app of appearances) {
    const clothing = normalizeClothingCategory(app.clothing);
    if (!groups.has(clothing)) {
      groups.set(clothing, []);
    }
    groups.get(clothing).push(app);
  }

  return groups;
}

/**
 * Get the appropriate styled avatar for a character based on clothing category
 *
 * @param {object} character - Character object with avatars
 * @param {string} artStyle - Art style (e.g., 'pixar', 'watercolor')
 * @param {string} clothingCategory - Clothing category (e.g., 'standard', 'winter', 'costumed:pirate')
 * @returns {string|null} Styled avatar URL/data URI, or null if not found
 */
async function getStyledAvatarForClothing(character, artStyle, clothingCategory, options = {}) {
  // exactCategory: return the styled avatar for THIS category or null — never a
  // cross-category substitute. Required by the garment-colour repair, which uses
  // the avatar's PIXELS as the colour target: falling back to another outfit's
  // sheet repaints the garment toward a colour from a different costume, and it
  // does so while looking like a confident correction. Measured: a character
  // whose only watercolour sheet was `costumed` had a `standard` page resolved
  // to the pirate sheet, so the "target colour" came from the pirate t-shirt.
  // Callers that only need a face/identity reference should NOT set this.
  const { exactCategory = false } = options;
  const avatars = character.avatars;
  const charName = character.name || 'Unknown';
  // Normalize at the single entry point — callers pass raw scene-metadata
  // values ('Winter', 'costumed:pirate') and a case/format miss on the
  // exact-key lookup below silently cascades into the standard-avatar
  // fallbacks (repairs then repaint the story outfit into standard).
  const requestedCategory = clothingCategory;
  clothingCategory = normalizeClothingCategory(clothingCategory);
  if (clothingCategory !== String(requestedCategory || '').trim()) {
    log.debug(`🔍 [AVATAR-LOOKUP] ${charName}: normalized clothing category "${requestedCategory}" → "${clothingCategory}"`);
  }

  // Helper to get fallback photo - uses centralized helper
  const getFallbackPhoto = () => getFacePhoto(character);

  // Resolve a styled-avatar slot value to a usable data: URI string. The
  // Phase 1e backfill turned plain-string slots into objects of shape
  // `{imageUrl, imageData}` where `imageData` is null after Phase 4. We
  // accept three shapes and always return a `data:image/jpeg;base64,…`
  // string so downstream callers (which buffer-decode it) keep working.
  const { fetchImageBytes } = require('./r2');
  const _styledFetchCache = {};
  const resolveStyled = async (v) => {
    if (!v) return null;
    if (typeof v === 'string') {
      if (v.startsWith('data:')) return v;
      // Post-R2-migration shape: the slot is a plain https URL string. The
      // old base64 wrap turned it into `data:image/jpeg;base64,https://...`,
      // which decoded to ~60 bytes of noise and 400'd every Grok repair that
      // used a styled avatar (staging 2026-07-10).
      if (/^https?:\/\//i.test(v)) {
        if (_styledFetchCache[v] !== undefined) return _styledFetchCache[v];
        const buf = await fetchImageBytes(v);
        const result = buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : null;
        _styledFetchCache[v] = result;
        return result;
      }
      // Legacy plain base64 (no data: prefix)
      return `data:image/jpeg;base64,${v}`;
    }
    if (typeof v === 'object') {
      if (typeof v.imageData === 'string' && v.imageData.length > 0) {
        return v.imageData.startsWith('data:') ? v.imageData : `data:image/jpeg;base64,${v.imageData}`;
      }
      if (typeof v.imageUrl === 'string' && v.imageUrl) {
        if (_styledFetchCache[v.imageUrl] !== undefined) return _styledFetchCache[v.imageUrl];
        const buf = await fetchImageBytes(v.imageUrl);
        const result = buf ? `data:image/jpeg;base64,${buf.toString('base64')}` : null;
        _styledFetchCache[v.imageUrl] = result;
        return result;
      }
    }
    return null;
  };

  // Base avatars (standard/summer/winter) read via loadAvatarBytes which
  // prefers the R2 URL field. Returns base64 — wrap as data URI for callers.
  const baseFromSlot = async (slot) => {
    const bytes = await loadAvatarBytes(avatars || {}, slot);
    return bytes ? `data:image/jpeg;base64,${bytes}` : null;
  };

  if (exactCategory && !avatars?.styledAvatars?.[artStyle]?.[
    (clothingCategory === 'costumed' || String(clothingCategory).startsWith('costumed:')) ? 'costumed' : clothingCategory
  ]) {
    log.info(`🔍 [AVATAR-LOOKUP] ${charName}: no styled avatar at [${artStyle}][${clothingCategory}] — exact lookup, returning null`);
    return null;
  }
  if (!avatars?.styledAvatars?.[artStyle]) {
    // No styled avatars for this art style — try base avatar before face
    // photo, REQUESTED CATEGORY FIRST: this branch is the normal path for
    // realistic style, and standard-first meant a winter-page repair/eval
    // got the standard-clothing avatar as its reference (Grok redressed the
    // character into standard clothes; entity eval flagged correct winter
    // outfits against a standard reference).
    const baseAvatar = (await baseFromSlot(clothingCategory)) || (await baseFromSlot('standard'));
    if (baseAvatar) {
      log.debug(`🔍 [AVATAR-LOOKUP] ${charName}: No styledAvatars for ${artStyle}, using base ${clothingCategory} avatar (or standard fallback)`);
      return baseAvatar;
    }
    const fallback = getFallbackPhoto();
    log.debug(`🔍 [AVATAR-LOOKUP] ${charName}: No styledAvatars for ${artStyle}, no base avatar, fallback=${fallback ? 'photo' : 'null'}`);
    return fallback;
  }

  const styledForArt = avatars.styledAvatars[artStyle];
  const availableKeys = Object.keys(styledForArt || {});
  log.debug(`🔍 [AVATAR-LOOKUP] ${charName}: styledAvatars[${artStyle}] has keys: [${availableKeys.join(', ')}]`);

  // Handle costumed category — one costume per story, grab the first
  if (clothingCategory === 'costumed' || clothingCategory.startsWith('costumed:')) {
    if (styledForArt.costumed && typeof styledForArt.costumed === 'object') {
      const firstCostume = Object.values(styledForArt.costumed)[0];
      const r = await resolveStyled(firstCostume);
      if (r) {
        log.debug(`🔍 [AVATAR-LOOKUP] ${charName}: Found costumed avatar`);
        return r;
      }
    }
    // Fallback to standard styled if no costume found.
    const r = await resolveStyled(styledForArt.standard);
    if (r) {
      log.warn(`⚠️ [AVATAR-LOOKUP] ${charName}: wanted ${clothingCategory} but no costumed avatars exist — sending standard (output will show standard clothing)`);
      return r;
    }
  }

  // Handle standard categories (standard, winter, summer)
  const styledAvatarRaw = styledForArt[clothingCategory];
  const resolved = await resolveStyled(styledAvatarRaw);
  if (resolved) {
    log.debug(`🔍 [AVATAR-LOOKUP] ${charName}: Found ${clothingCategory} avatar`);
    return resolved;
  }
  if (exactCategory) {
    log.info(`🔍 [AVATAR-LOOKUP] ${charName}: no ${clothingCategory} styled avatar for ${artStyle} — exact lookup, refusing a cross-category substitute`);
    return null;
  }

  // Realistic: styledAvatars.realistic only holds story-REDRESSED categories
  // (+costumes). When the requested category wasn't redressed, its BASE
  // avatar already matches the story outfit — a far better reference than a
  // redressed standard in the wrong clothing.
  if (artStyle === 'realistic') {
    const base = await baseFromSlot(clothingCategory);
    if (base) {
      log.debug(`🔍 [AVATAR-LOOKUP] ${charName}: realistic ${clothingCategory} not redressed — using base ${clothingCategory} avatar`);
      return base;
    }
  }

  // Fallback chain: requested → standard → any other styled avatar → original photo.
  const std = await resolveStyled(styledForArt.standard);
  if (std) {
    log.warn(`⚠️ [AVATAR-LOOKUP] ${charName}: wanted ${clothingCategory}, sending standard (output will show standard clothing)`);
    return std;
  }

  // Try any other available styled avatar (winter, summer, or first costumed)
  for (const [key, value] of Object.entries(styledForArt)) {
    if (key === 'costumed') continue;
    const r = await resolveStyled(value);
    if (r) {
      log.warn(`⚠️ [AVATAR-LOOKUP] ${charName}: wanted ${clothingCategory} but only ${key} exists — sending ${key} (output will show ${key} clothing)`);
      return r;
    }
  }

  // Try first costumed avatar if available
  if (styledForArt.costumed && typeof styledForArt.costumed === 'object') {
    const firstCostume = Object.values(styledForArt.costumed)[0];
    const r = await resolveStyled(firstCostume);
    if (r) {
      log.warn(`⚠️ [AVATAR-LOOKUP] ${charName}: wanted ${clothingCategory} but only costumed exists — sending costumed (output will show the costume)`);
      return r;
    }
  }

  // Try base avatars (not styled) as fallback before photo. Phase 2: same
  // URL-or-inline resolution as the early-return branch above.
  const baseFromCategory = await baseFromSlot(clothingCategory);
  if (baseFromCategory) {
    log.info(`🔍 [AVATAR-LOOKUP] ${charName}: No styled avatars, using base ${clothingCategory} avatar`);
    return baseFromCategory;
  }
  const baseFromStandard = await baseFromSlot('standard');
  if (baseFromStandard) {
    log.info(`🔍 [AVATAR-LOOKUP] ${charName}: No styled avatars, using base standard avatar`);
    return baseFromStandard;
  }

  // Final fallback to original photo
  const fallback = getFallbackPhoto();
  log.warn(`🔍 [AVATAR-LOOKUP] ${charName}: No styled/base avatars found, photo fallback=${fallback ? 'found' : 'null'}`);
  return fallback;
}

/**
 * Run entity-grouped consistency checks on a completed story
 *
 * @param {object} storyData - Story data with sceneImages
 * @param {Array<object>} characters - Main characters with photos
 * @param {object} options - Check options
 * @returns {Promise<object>} Entity consistency report
 */
async function runEntityConsistencyChecks(storyData, characters = [], options = {}) {
  const {
    checkCharacters = true,
    // Object/animal/artifact consistency disabled by default.
    // Reasons: (a) bbox detection rarely returns reliable crops for small artifacts,
    //         (b) characters who handle artifacts already drive the scene quality eval,
    //         (c) noisy "0 valid crops" warnings without actionable repair output.
    // Pass checkObjects:true explicitly only when investigating object continuity.
    checkObjects = false,
    minAppearances = MIN_APPEARANCES,
    saveGrids = false,
    outputDir = null,
    // gridsOnly: build crops + grid images WITHOUT the Gemini consistency eval
    // (pure compositing). Used by the pipeline's final assembled report: issues
    // come from the per-version stamps, the grids just show the picked crops.
    gridsOnly = false,
    // Heartbeat callback. Called between each entity (character/object) so
    // long object loops on stories with many distinct objects (Wilhelm Tell:
    // crossbow + apple + hat pole + horse + market square + boat + …) don't
    // trigger the front-end stall watcher. Caller wires this to an
    // `UPDATE story_jobs SET updated_at = NOW() …` ping. Optional.
    onHeartbeat = null
  } = options;
  const heartbeat = async () => {
    if (typeof onHeartbeat === 'function') {
      try { await onHeartbeat(); } catch (e) { /* never let heartbeat break the loop */ }
    }
  };

  const report = {
    timestamp: new Date().toISOString(),
    characters: {},
    objects: {},
    grids: [],
    totalIssues: 0,
    overallConsistent: true,
    summary: '',
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      model: ENTITY_CHECK_MODEL
    }
  };

  try {
    const sceneImages = storyData.sceneImages || [];
    const sceneDescriptions = storyData.sceneDescriptions || [];

    // Include covers in entity checks (covers often show multiple characters)
    const coverEntries = [];
    if (storyData.coverImages) {
      for (const [coverType, cover] of Object.entries(storyData.coverImages)) {
        if (cover && (cover.imageData || cover.hasImage)) {
          // Covers use the same numeric `activeVersion` index as scenes
          // (recomputeAllActiveVersions and the regen routes maintain it).
          // The boolean `isActive` flag is deprecated and written by nothing —
          // reading only it meant post-repair consistency checks silently
          // evaluated the stale v0 image. Kept as fallback for old blob data
          // saved before the numeric index existed.
          // Active version resolved via resolveActiveVersionData → the
          // image_version_meta-active root (single source of truth), never the
          // deprecated blob activeVersion/isActive.
          let imageData = cover.imageData;
          let coverBbox = cover.bboxDetection || null;
          if (cover.imageVersions?.length > 0) {
            const resolved = resolveActiveVersionData(cover);
            if (resolved.imageData) imageData = resolved.imageData;
            if (resolved.bboxDetection) coverBbox = resolved.bboxDetection;
          }
          // Drop a stored cover bbox stamped for different bytes — the
          // fallback detection in collectEntityAppearances re-detects on the
          // actual pixels instead of cropping with a stale box.
          if (coverBbox && !require('./images').bboxPairsWith(coverBbox, imageData)) {
            coverBbox = null;
          }
          if (imageData) {
            // Pull per-cover characterClothing from outline coverHints so the entity
            // collector can drive bbox detection with the actual cover cast instead
            // of falling back to the full story roster (too noisy for Gemini to ID).
            const hintKey = COVER_HINT_KEY[coverType];
            const coverHint = hintKey ? storyData.coverHints?.[hintKey] : null;
            const characterClothing = coverHint?.characterClothing
              && Object.keys(coverHint.characterClothing).length > 0
              ? coverHint.characterClothing
              : null;
            coverEntries.push({
              pageNumber: COVER_PAGE_NUMBERS[coverType],
              imageData,
              description: cover.description || cover.translatedDescription || '',
              text: '',
              bboxDetection: coverBbox,
              ...(characterClothing && { characterClothing }),
              _coverType: coverType,
            });
          }
        }
      }
    }
    const allImages = [...sceneImages, ...coverEntries];

    if (allImages.length < 2) {
      report.summary = 'Not enough images for entity consistency check';
      return report;
    }

    // Art style is read by collectEntityAppearances (for styled-avatar
    // lookup) AND by the per-character clothing-group loop below — hoist
    // the declaration above the first use to avoid the TDZ error
    // ("Cannot access 'artStyle' before initialization") my earlier fix
    // accidentally introduced when I added artStyle to the
    // collectEntityAppearances call without moving the existing `const
    // artStyle = ...` line above it.
    const artStyle = storyData.artStyle || 'pixar';

    // Story-invented characters are checked too, when they appear more than
    // once. They are not in `characters` (the photo-backed roster) but they do
    // drift, and until now nothing watched them: on job_1786780194082_s980g4s9a
    // Lira was named on 4 pages with no consistency check at all.
    const secondaryEntities = collectSecondaryEntities(storyData.visualBible || null, allImages);
    if (secondaryEntities.length) {
      log.info(`🔍 [ENTITY-CHECK] + ${secondaryEntities.length} visual-bible secondary character(s): ${secondaryEntities.map(e => `${e.name} (p${e.__vbPages.join('/')})`).join(', ')}`);
    }
    const entityRoster = [...characters, ...secondaryEntities];

    // Collect entity appearances from bbox detection data
    log.info('🔍 [ENTITY-CHECK] Collecting entity appearances from scene images...');
    const entityAppearances = await collectEntityAppearances(allImages, entityRoster, sceneDescriptions, {
      storyCharacters: characters,
      clothingRequirements: storyData.clothingRequirements || null,
      visualBible: storyData.visualBible || null,
      artStyle,
    });

    // Extract and forward pages where fallback bbox detection was run
    const pagesWithNewBbox = entityAppearances._pagesWithNewBbox || [];
    delete entityAppearances._pagesWithNewBbox;
    report.pagesWithNewBbox = pagesWithNewBbox;

    // Expose freshly-detected cover bboxes so callers can cache them on coverImages.
    // (Cover entries live locally in this function; without surfacing the detections,
    // every consistency-check pass re-runs Gemini bbox detection on the covers.)
    const coverBboxDetections = {};
    for (const cover of coverEntries) {
      if (pagesWithNewBbox.includes(cover.pageNumber) && cover.bboxDetection) {
        coverBboxDetections[cover._coverType] = cover.bboxDetection;
      }
    }
    if (Object.keys(coverBboxDetections).length > 0) {
      report.coverBboxDetections = coverBboxDetections;
    }

    if (entityAppearances.size === 0) {
      report.summary = 'No entity appearances found with bounding boxes';
      return report;
    }

    log.info(`🔍 [ENTITY-CHECK] Found ${entityAppearances.size} entities with appearances`);

    // Process each character entity - group by clothing for accurate evaluation.
    // (artStyle is hoisted above the collectEntityAppearances call.)
    if (checkCharacters) {
      // Flatten all character×clothing tasks for maximum parallelism
      // Instead of: 5 characters parallel, clothing groups serial within each
      // Now: ALL character+clothing combos run in parallel (e.g. 15 concurrent Gemini calls)
      const pLimit = require('p-limit');
      const entityLimit = pLimit(10); // All combos parallel, capped at 10 concurrent API calls

      // Phase 1: Collect all character×clothing tasks
      const tasks = [];
      for (const character of entityRoster) {
        const charName = character.name;
        const appearances = entityAppearances.get(charName);
        if (!appearances || appearances.length === 0) {
          log.verbose(`[ENTITY-CHECK] Skipping ${charName}: no appearances found`);
          continue;
        }

        // Initialize character report
        report.characters[charName] = {
          byClothing: {},
          issues: [],
          // Garment colour drift — reported separately from `issues` on purpose:
          // it is mechanically fixable, so it must not charge severity points or
          // trigger a redraw (decisions.md 2026-08-06).
          garmentColourMismatches: [],
          overallConsistent: true,
          overallScore: 10,
          totalIssues: 0
        };

        // A secondary has no clothing CATEGORIES — the roster system does not
        // dress them — so all of their appearances form one group judged against
        // the visual bible.
        const byClothing = character.__vbSecondary
          ? new Map([['visual-bible', appearances]])
          : groupAppearancesByClothing(appearances);
        log.info(`🔍 [ENTITY-CHECK] ${charName}: ${appearances.length} appearances, ${byClothing.size} clothing categories: ${[...byClothing.keys()].join(', ')}`);

        for (const [clothingCategory, groupAppearances] of byClothing) {
          const isCostumed = clothingCategory.startsWith('costumed:');
          const minRequired = isCostumed ? 1 : minAppearances;
          if (groupAppearances.length < minRequired) {
            log.verbose(`[ENTITY-CHECK] Skipping ${charName} (${clothingCategory}): only ${groupAppearances.length} appearances (need ${minRequired})`);
            continue;
          }
          tasks.push({ character, charName, clothingCategory, groupAppearances, minRequired });
        }
      }

      log.info(`🔍 [ENTITY-CHECK] Running ${tasks.length} character×clothing checks in parallel...`);

      // Phase 2: Run all tasks in parallel
      const results = await Promise.all(tasks.map(task => entityLimit(async () => {
        await heartbeat();  // bump updated_at so the heartbeat watcher sees progress
        const { character, charName, clothingCategory, groupAppearances, minRequired } = task;
        try {
          log.info(`🔍 [ENTITY-CHECK] Checking ${charName} (${clothingCategory}): ${groupAppearances.length} appearances`);

          const crops = await extractEntityCrops(groupAppearances);
          if (crops.length < minRequired) {
            log.warn(`⚠️  [ENTITY-CHECK] ${charName} (${clothingCategory}): only ${crops.length} valid crops`);
            return null;
          }

          // A secondary is judged against its VISUAL BIBLE entry: the generated
          // reference image as the comparison cell, the bible description as the
          // expected text. It has no styled avatar and no clothingRequirements
          // row, and asking for either would log an error and compare against
          // nothing.
          const refAvatar = character.__vbSecondary
            ? (character.__vbReferenceUrl || null)
            : await getStyledAvatarForClothing(character, artStyle, clothingCategory);
          // Expected clothing as TEXT from this story's clothingRequirements.
          // The grid prompt judges clothing against this description, not against
          // the reference avatar's pixels — style transfer can mutate the avatar's
          // outfit, and avatars.clothing can be stale across stories.
          const expectedClothing = character.__vbSecondary
            ? character.__vbDescription
            : buildClothingDescription(
              character, clothingCategory, artStyle, storyData.clothingRequirements || null
            );
          const gridLabel = `${charName} (${clothingCategory})`;

          // Split crops into batches for multiple 3x3 grids (8 crops + 1 ref per grid)
          const maxCrops = refAvatar ? MAX_GRID_CELLS - 1 : MAX_GRID_CELLS;
          const numGrids = Math.ceil(crops.length / maxCrops);
          const batches = [];
          if (numGrids <= 1) {
            batches.push(crops);
          } else {
            // Balance crops evenly across grids (e.g., 10 → 5+5, not 8+2)
            const baseSize = Math.floor(crops.length / numGrids);
            const remainder = crops.length % numGrids;
            let offset = 0;
            for (let g = 0; g < numGrids; g++) {
              const size = baseSize + (g < remainder ? 1 : 0);
              batches.push(crops.slice(offset, offset + size));
              offset += size;
            }
            log.info(`🔍 [ENTITY-CHECK] ${charName} (${clothingCategory}): ${crops.length} crops → ${numGrids} grids (${batches.map(b => b.length).join('+')})`);
          }

          // Create and evaluate each grid
          const gridResults = [];
          const allIssues = [];
          let worstScore = 10;
          let overallConsistent = true;

          for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            const batchCrops = batches[batchIdx];
            const batchLabel = batches.length > 1
              ? `${gridLabel} (${batchIdx + 1}/${batches.length})`
              : gridLabel;

            const gridResult = await createEntityGrid(batchCrops, batchLabel, refAvatar);
            // Built in gridsOnly mode too: the final stored report (the panel's
            // source) is a gridsOnly rebuild over the shipped versions, and the
            // head grid is pure sharp work — no model call.
            const headGrid = await createEntityHeadGrid(batchCrops, batchLabel);
            const evalResult = gridsOnly
              ? { consistent: true, score: null, issues: [], summary: 'grids-only (no eval)' }
              : await evaluateEntityConsistency(
                  gridResult.buffer, gridResult.manifest,
                  { entityType: 'character', entityName: charName, clothingCategory,
                    expectedClothing,
                    referencePhoto: refAvatar, cellCount: batchCrops.length },
                  headGrid?.buffer || null
                );

            gridResults.push({ gridResult, headGrid, evalResult, batchCrops });
            if (evalResult.issues) {
              // Stamp each issue with THIS grid's letter→page map, taken from the
              // manifest the model actually saw. Multi-grid batches each restart
              // lettering at 'A', so a single cross-grid map (or one rebuilt from
              // collection order) mis-attributes issues to the wrong page.
              const gridCellToPage = {};
              for (const cell of (gridResult.manifest?.cells || [])) {
                if (cell && cell.letter && cell.metadata && cell.metadata.pageNumber != null) {
                  gridCellToPage[cell.letter] = cell.metadata.pageNumber;
                }
              }
              for (const iss of evalResult.issues) iss._gridCellToPage = gridCellToPage;
              allIssues.push(...evalResult.issues);
            }
            if (evalResult.score < worstScore) worstScore = evalResult.score;
            if (!evalResult.consistent) overallConsistent = false;
          }

          // Return merged result — first grid as primary display, worst score across all
          return {
            charName, clothingCategory, groupAppearances, crops,
            gridResult: gridResults[0].gridResult,
            headGrid: gridResults[0].headGrid || null,
            evalResult: {
              ...gridResults[0].evalResult,
              issues: allIssues,
              score: worstScore,
              consistent: overallConsistent,
              summary: gridResults.map((g, i) =>
                batches.length > 1 ? `Grid ${i + 1}: ${g.evalResult.summary}` : g.evalResult.summary
              ).join(' | ')
            },
            additionalGrids: gridResults.slice(1).map(g => ({
              gridImage: `data:image/jpeg;base64,${g.gridResult.buffer.toString('base64')}`,
              headGridImage: g.headGrid ? `data:image/jpeg;base64,${g.headGrid.buffer.toString('base64')}` : null,
              manifest: g.gridResult.manifest,
              cellCount: g.batchCrops.length,
              evalResult: g.evalResult
            }))
          };
        } catch (err) {
          log.error(`❌ [ENTITY-CHECK] Error checking ${charName} (${clothingCategory}): ${err.message}`);
          return { charName, clothingCategory, error: err.message };
        }
      })));

      // Phase 3: Aggregate results into report (sequential, no race conditions)
      for (const result of results) {
        if (!result) continue;
        const { charName, clothingCategory, error } = result;

        if (error) {
          if (!report.characters[charName]) {
            // Fail CLOSED: a character whose check errored is NOT verified —
            // overallConsistent:false + evalFailed so it isn't a silent pass.
            report.characters[charName] = { byClothing: {}, issues: [], overallConsistent: false, evalFailed: true, overallScore: 0, totalIssues: 0, error };
          }
          // ...and the REPORT is not verified either. Setting only the
          // character-level flag stopped the failure one level below every
          // reader (summary, the ✓ badge, findBadPages), so an errored check
          // still presented as a clean pass.
          report.overallConsistent = false;
          continue;
        }

        const { groupAppearances, gridResult, evalResult, crops } = result;

        // Store grid(s) for dev panel — headGridImage is what the judge reads
        // faces from, shown next to the body grid.
        report.grids.push({
          entityName: charName, entityType: 'character', clothingCategory,
          gridImage: `data:image/jpeg;base64,${gridResult.buffer.toString('base64')}`,
          headGridImage: result.headGrid ? `data:image/jpeg;base64,${result.headGrid.buffer.toString('base64')}` : null,
          manifest: gridResult.manifest, cellCount: crops.length
        });
        // Store additional grids (multi-grid for stories with many pages)
        if (result.additionalGrids) {
          for (const addGrid of result.additionalGrids) {
            report.grids.push({
              entityName: charName, entityType: 'character', clothingCategory,
              gridImage: addGrid.gridImage,
              headGridImage: addGrid.headGridImage || null,
              manifest: addGrid.manifest, cellCount: addGrid.cellCount
            });
          }
        }

        if (saveGrids && outputDir) {
          await saveEntityGrid(gridResult.buffer, `${charName}_${clothingCategory}`, 'character', outputDir);
        }

        // Store per-clothing result — include all grid images for display
        const allGridImages = [`data:image/jpeg;base64,${gridResult.buffer.toString('base64')}`];
        if (result.additionalGrids) {
          for (const addGrid of result.additionalGrids) {
            allGridImages.push(addGrid.gridImage);
          }
        }
        report.characters[charName].byClothing[clothingCategory] = {
          gridImage: allGridImages[0],
          gridImages: allGridImages.length > 1 ? allGridImages : undefined,  // Only set if multi-grid
          consistent: evalResult.consistent,
          score: evalResult.score,
          issues: evalResult.issues || [],
          summary: evalResult.summary,
          cellCount: crops.length,
          appearances: groupAppearances.map(a => ({
            pageNumber: a.pageNumber, faceBox: a.faceBox || null,
            bodyBox: a.bodyBox || null, clothing: a.clothing || clothingCategory,
          })),
          // O7: raw output persisted for successful evals too (was error-only)
          ...(evalResult.rawResponse && { rawResponse: evalResult.rawResponse }),
          ...(evalResult.parseError && { parseError: true })
        };

        // Aggregate stats
        if (!evalResult.consistent) {
          report.characters[charName].overallConsistent = false;
          report.overallConsistent = false;
        }
        const issueCount = evalResult.issues?.length || 0;
        report.characters[charName].totalIssues += issueCount;
        report.totalIssues += issueCount;

        // Stamp issues with the pages that were evaluated in this group so
        // the feedback-consolidator can filter entity issues to the page it's
        // currently repairing. Without this, every page's consolidator sees
        // every other page's entity noise, ~80% of the prompt wasted on
        // irrelevant cross-page issues.
        //
        // An issue is stamped with the ONE page its first cell resolves to, or
        // with none at all. There is deliberately no "attribute it to the whole
        // group" path any more — see the NO DEFAULT note below.
        // Cell→page comes from the grid MANIFEST the model saw (stamped per grid
        // at eval time), NOT from groupAppearances collection order — the latter
        // diverged whenever covers (appended last but sorted first in the grid)
        // or dropped crops shifted the lettering, routing repair feedback to the
        // wrong page. Fall back to the primary grid's manifest if an issue lacks
        // its stamp.
        const primaryCellToPage = new Map();
        for (const cell of (gridResult.manifest?.cells || [])) {
          if (cell && cell.letter && cell.metadata && cell.metadata.pageNumber != null) {
            primaryCellToPage.set(cell.letter, cell.metadata.pageNumber);
          }
        }
        // Translate "Cell X" → "Cell X (page N)" in human-facing strings so
        // log output and dev panels surface page numbers directly. The Gemini
        // API call already happened on the grid image where the model saw
        // bare cell letters — we're only rewriting the stored display strings.
        // Handles the plural/lowercase form too — see cellLettersOf for why.
        const annotateCells = (text, cellMap) => {
          if (!text || typeof text !== 'string') return text;
          return text
            .replace(/\bCell\s+([A-Z])\b(?!\s*\(page)/g, (match, letter) => {
              const page = cellMap.get(letter);
              return page != null ? `${match} (page ${page})` : match;
            })
            .replace(/\b([Cc]ells\s+)([A-Z]\b(?:\s*(?:,|and|&)\s*[A-Z]\b)*)/g, (match, lead, list) =>
              lead + list.replace(/[A-Z]\b(?!\s*\(page)/g, (L) => {
                const page = cellMap.get(L);
                return page != null ? `${L} (page ${page})` : L;
              }));
        };

        /**
         * The cell letters an issue is about.
         *
         * PREFER THE STRUCTURED FIELD (2026-08-09). This used to read the prose
         * only, via /\bCell\s+([A-Z])\b/. The model routinely writes the plural
         * lowercase form — "Hans's hat in cells A, B, C, D, F is a soft white
         * cap" — where `cells A` cannot match `Cell` + whitespace. The mapping
         * then came out EMPTY and `pageNumbers` fell back to every page in the
         * group: job_1786287569165_7f75jspcz stored `cellsToPages: {}` with
         * `pageNumbers: [3,4,5,7,8,10,12,13,14,-2,-3]` — eleven pages including
         * both covers — for a finding about five cells. Silent, because an empty
         * map is indistinguishable from "no cells were named".
         *
         * `issue.cells` is emitted by the model as an array and needs no parsing.
         * Letters are still resolved through OUR manifest, never the model's own
         * page numbers, so the guarantee the previous fix established holds.
         * Prose stays as the fallback for evaluations that omit the field.
         */
        const cellLettersOf = (issue, desc) => {
          const out = [];
          const push = (s) => {
            const L = String(s == null ? '' : s).trim().toUpperCase();
            if (/^[A-Z]$/.test(L) && !out.includes(L)) out.push(L);
          };
          if (Array.isArray(issue.cells)) issue.cells.forEach(push);
          if (out.length) return out;
          // Letters are matched uppercase-only and must end on a word boundary,
          // so the "and" in "cells A and B" cannot itself be read as cell A.
          for (const m of desc.matchAll(/\b[Cc]ells?\s+([A-Z]\b(?:\s*(?:,|and|&)\s*[A-Z]\b)*)/g)) {
            for (const L of m[1].split(/[^A-Z]+/)) push(L);
          }
          return out;
        };

        for (const issue of (evalResult.issues || [])) {
          const cellToPage = issue._gridCellToPage
            ? new Map(Object.entries(issue._gridCellToPage))
            : primaryCellToPage;
          const desc = String(issue.description || issue.issue || '');
          const cellsMentioned = cellLettersOf(issue, desc);

          // Build cell→page mapping for every cell letter named by the issue.
          const cellsToPages = {};
          for (const letter of cellsMentioned) {
            const p = cellToPage.get(letter);
            if (p != null) cellsToPages[letter] = p;
          }

          // Use ONLY the FIRST cell as the target page. Earlier code unioned
          // every cell letter in the description — but most issues name a
          // problematic cell ("Cell B (page -2)") AND one or more reference
          // cells ("...different from Cell A (page 3) and Cell R"). Stamping
          // all of those into pageNumbers caused the consolidator to pipe the
          // issue into every mentioned page's repair call. The page=3
          // consolidator then received a finding about page -2's cell B and
          // asked Grok to "fix" page 3 against a description that wasn't about
          // page 3 at all. First-RESOLVED, so a leading "Cell R" — the identity
          // reference, which has no page — falls through to the real target.
          const firstResolved = cellsMentioned.find(L => cellToPage.get(L) != null);

          // NO DEFAULT (2026-08-09). The old fallback was `pageNumbers =
          // groupPages` — an unlocatable finding was attributed to EVERY page in
          // the group, covers included, and the consolidator then asked for a
          // repair on each. An unplaceable finding is not a finding about all
          // pages; it is a finding we cannot place. Empty means the per-page
          // filter in feedbackConsolidator excludes it everywhere, while the
          // issue still appears in the report carrying the reason.
          let pageNumbers = [];
          let unlocatedReason = null;
          if (firstResolved != null) {
            pageNumbers = [cellToPage.get(firstResolved)];
          } else {
            unlocatedReason = cellsMentioned.length
              ? `named cells [${cellsMentioned.join(',')}] map to no page in this grid`
              : 'issue names no cell';
            log.warn(`⚠️ [ENTITY-CHECK] ${charName}: issue not attributable to a page (${unlocatedReason}) — not routed to any repair`);
          }

          const annotated = {
            ...issue,
            clothingCategory,
            pageNumbers,
            cellsToPages,
            ...(unlocatedReason ? { unlocatedReason } : {}),
            description: annotateCells(issue.description, cellToPage),
            issue: annotateCells(issue.issue, cellToPage),
            fixInstruction: annotateCells(issue.fix || issue.fixInstruction, cellToPage),
          };
          delete annotated._gridCellToPage; // internal-only; don't persist
          report.characters[charName].issues.push(annotated);
        }

        for (const m of (evalResult.garmentColourMismatches || [])) {
          report.characters[charName].garmentColourMismatches.push(m);
        }

        if (evalResult.score < report.characters[charName].overallScore) {
          report.characters[charName].overallScore = evalResult.score;
        }

        if (evalResult.usage) {
          report.tokenUsage.inputTokens += evalResult.usage.promptTokenCount || 0;
          report.tokenUsage.outputTokens += evalResult.usage.candidatesTokenCount || 0;
          report.tokenUsage.calls++;
        }
      }

      // Clean up characters with no evaluated clothing categories
      for (const charName of Object.keys(report.characters)) {
        if (Object.keys(report.characters[charName].byClothing).length === 0 && !report.characters[charName].error) {
          delete report.characters[charName];
        }
      }
    }

    // Process objects (after character loop)
    if (checkObjects) {
      // Collect object appearances from bboxDetection.objects + objectMatches.
      // Pass the Visual Bible so detector variant names collapse into canonical
      // VB entries (e.g. "plush elephant toy with red scarf" → "Eli").
      const objectAppearances = collectObjectAppearances(sceneImages, storyData.visualBible || null);

      for (const [objName, appearances] of objectAppearances) {
        if (appearances.length < minAppearances) continue;

        await heartbeat();  // bump updated_at so the heartbeat watcher sees progress
        log.info(`🔍 [ENTITY-CHECK] Checking object ${objName}: ${appearances.length} appearances`);

        try {
          // Extract crops (objects only have bodyBox)
          const crops = await extractEntityCrops(appearances);

          if (crops.length < minAppearances) {
            log.warn(`⚠️  [ENTITY-CHECK] ${objName}: only ${crops.length} valid crops`);
            continue;
          }

          // Create grid (no reference photo for objects)
          const gridResult = await createEntityGrid(crops, objName, null);

          // Store grid for dev panel
          report.grids.push({
            entityName: objName,
            entityType: 'object',
            gridImage: `data:image/jpeg;base64,${gridResult.buffer.toString('base64')}`,
            manifest: gridResult.manifest,
            cellCount: crops.length
          });

          // Save grid to disk if requested
          if (saveGrids && outputDir) {
            await saveEntityGrid(gridResult.buffer, objName, 'object', outputDir);
          }

          // Evaluate consistency
          const evalResult = await evaluateEntityConsistency(
            gridResult.buffer,
            gridResult.manifest,
            {
              entityType: 'object',
              entityName: objName,
              referencePhoto: null,
              cellCount: crops.length
            }
          );

          // Store result
          report.objects[objName] = {
            gridImage: `data:image/jpeg;base64,${gridResult.buffer.toString('base64')}`,
            consistent: evalResult.consistent,
            score: evalResult.score,
            issues: evalResult.issues || [],
            summary: evalResult.summary,
            // Include debug info for parse failures
            // O7: raw output persisted for successful evals too (was error-only)
          ...(evalResult.rawResponse && { rawResponse: evalResult.rawResponse }),
          ...(evalResult.parseError && { parseError: true })
          };

          // Aggregate
          if (!evalResult.consistent) {
            report.overallConsistent = false;
          }
          report.totalIssues += evalResult.issues?.length || 0;

          // Track token usage
          if (evalResult.usage) {
            report.tokenUsage.inputTokens += evalResult.usage.promptTokenCount || 0;
            report.tokenUsage.outputTokens += evalResult.usage.candidatesTokenCount || 0;
            report.tokenUsage.calls++;
          }

        } catch (err) {
          log.error(`❌ [ENTITY-CHECK] Error checking object ${objName}: ${err.message}`);
          report.objects[objName] = {
            error: err.message,
            consistent: false,  // Fail closed — an errored check is NOT a pass
            evalFailed: true,
            score: 10,
            issues: []
          };
          // Fail closed at the REPORT level too — see the character branch.
          report.overallConsistent = false;
        }
      }
    }

    // Build summary. It must reflect ALL THREE facts — issues found, checks
    // that FAILED TO RUN, and the consistency flag. Deriving it from
    // totalIssues alone was how the isGarmentColour TDZ crash hid: an errored
    // check contributes zero issues, so a report that had thrown on every grid
    // still announced "All N entities are consistent across pages".
    const entities = [...Object.values(report.characters), ...Object.values(report.objects)];
    const checkedCount = entities.length;
    const failedCount = entities.filter(e => e && e.evalFailed).length;

    const parts = [];
    if (report.totalIssues > 0) parts.push(`${report.totalIssues} consistency issue(s)`);
    if (failedCount > 0) parts.push(`${failedCount} check(s) FAILED to run`);

    if (parts.length) {
      report.summary = `${checkedCount} entities checked: ${parts.join('; ')}`;
    } else if (report.overallConsistent) {
      report.summary = `All ${checkedCount} entities are consistent across pages`;
    } else {
      // Inconsistent, nothing recorded, nothing reported as failed. This
      // combination should be unreachable — say so loudly instead of rounding
      // it down to a pass, because it means an error was swallowed upstream.
      report.summary = `${checkedCount} entities checked: flagged INCONSISTENT but no issues recorded — an error was likely swallowed upstream`;
    }

    log.info(`📋 [ENTITY-CHECK] Complete: ${report.summary}`);

  } catch (error) {
    log.error(`❌ [ENTITY-CHECK] Error running checks: ${error.message}`);
    if (error.stack) log.error(`[ENTITY-CHECK] Stack: ${error.stack.split('\n').slice(0, 5).join(' | ')}`);
    report.error = error.message;
  }

  return report;
}

/**
 * Collect entity appearances from scene images using bbox detection data
 *
 * @param {Array<object>} sceneImages - Scene images with retryHistory
 * @param {Array<object>} characters - Characters to look for
 * @param {Array<object>} sceneDescriptions - Scene descriptions for extracting clothing metadata
 * @returns {Map<string, Array>} Map of entityName -> appearances
 */

/**
 * Visual-bible secondary characters that appear on MORE THAN ONE page
 * (owner, 2026-08-15).
 *
 * They were never checked. On job_1786780194082_s980g4s9a the entity report
 * covered [Emma, Hans, Noah, Sarah, Daniel] while Lira — a mermaid on pages
 * 3, 4, 7 and 9, correctly detected and named on every one — had nothing
 * watching her for drift. One appearance cannot drift, so two is the floor.
 *
 * They are judged against their VISUAL BIBLE entry and nothing else: the
 * `description` (which already carries hair, build, signature look AND
 * clothing) as the expected text, and `referenceImageUrl` as the comparison
 * cell. This is why they need no clothing category — the roster's
 * category system does not apply to them ("secondary characters are described,
 * never dressed", decisions.md), and asking clothingRequirements for an entry
 * that cannot exist would only log an error and compare against nothing.
 *
 * The returned object is shaped like a roster character so the existing
 * collection, cropping and grid code needs no special case: `name` for the
 * figure-name match, plus a marker the three judging points branch on.
 */
function collectSecondaryEntities(visualBible, sceneImages = []) {
  const vb = visualBible || {};
  const list = Array.isArray(vb.secondaryCharacters)
    ? vb.secondaryCharacters
    : Object.values(vb.secondaryCharacters || {});
  const out = [];
  for (const e of list) {
    if (!e || !e.name) continue;
    // Prefer pages we ACTUALLY detected them on; fall back to their own
    // declaration when detection has not run yet (gridsOnly rebuilds).
    const detected = new Set();
    for (const img of sceneImages) {
      const figs = img?.bboxDetection?.figures || [];
      if (figs.some(f => (f?.name || '').toLowerCase() === String(e.name).toLowerCase())) {
        detected.add(img.pageNumber);
      }
    }
    const declared = Array.isArray(e.pages) ? e.pages : (Array.isArray(e.appearsInPages) ? e.appearsInPages : []);
    const pages = detected.size ? [...detected] : declared.map(Number);
    if (pages.length < 2) continue;
    const description = e.description
      || [e.age, e.build, e.hair && `hair: ${e.hair}`, e.face, e.signatureLook, e.clothing && `Clothing: ${e.clothing}`]
        .filter(Boolean).join('. ');
    if (!description) continue;
    out.push({
      name: e.name,
      __vbSecondary: true,
      __vbDescription: description,
      __vbReferenceUrl: e.referenceImageUrl || null,
      __vbPages: pages,
    });
  }
  return out;
}

async function collectEntityAppearances(sceneImages, characters = [], sceneDescriptions = [], options = {}) {
  const { skipMinAppearancesFilter = false, storyCharacters = null, clothingRequirements = null, visualBible = null, artStyle = 'watercolor' } = options;
  const pagesWithNewBbox = [];
  const appearances = new Map();

  // Initialize for each character
  for (const char of characters) {
    appearances.set(char.name, []);
  }

  for (const img of sceneImages) {
    const pageNumber = img.pageNumber;

    // See resolveActiveVersionData() at the top of this file for the rationale.
    const { activeVersion, imageData, versionIndex, bboxDetection: bboxDetectionInit } = resolveActiveVersionData(img);

    if (!imageData) continue;

    let bboxDetection = bboxDetectionInit;

    // Get clothing info for this page - try multiple sources
    // Priority: img.characterClothing > scene description metadata > clothingRequirements
    // NO 'standard' DEFAULT (owner, 2026-08-07): this label decides which
    // reference avatar each crop is judged against, so a guessed category
    // manufactures "clothing_inconsistent" findings against an outfit the page
    // never had. Null here means the crop is skipped, not relabelled.
    let characterClothing = img.characterClothing || img.sceneCharacterClothing || {};
    let defaultClothing = img.clothing || null;

    // If no per-character clothing found, try to extract from scene description metadata
    if (Object.keys(characterClothing).length === 0 && sceneDescriptions.length > 0) {
      const sceneDesc = sceneDescriptions.find(s => s.pageNumber === pageNumber);
      if (sceneDesc?.description) {
        const metadata = extractSceneMetadata(sceneDesc.description);
        if (metadata) {
          // Extract per-character clothing from metadata
          if (metadata.characterClothing && Object.keys(metadata.characterClothing).length > 0) {
            characterClothing = metadata.characterClothing;
            log.debug(`[ENTITY-COLLECT] Page ${pageNumber}: Extracted clothing from scene metadata: ${JSON.stringify(characterClothing)}`);
          }
          // Also check for global clothing in metadata
          if (metadata.clothing && !defaultClothing) {
            defaultClothing = metadata.clothing;
          }
        }
      }
    }

    // Safety net: use story-level clothingRequirements when per-page clothing is still missing
    // (old stories, or lost metadata). Only assume a character is COSTUMED when
    // the costume is their SOLE outfit across the whole story — clothingRequirements
    // is page-agnostic, so promoting anyone who wears a costume ANYWHERE to costumed
    // on EVERY page mis-flagged Emma (uses standard + costumed:ninja) as costumed on
    // page 1, where she is standard and merely HOLDS the costume — the entity check
    // then pulled her ninja avatar and repainted her (job_1783889777354 P1). A
    // character who also uses standard/winter/summer is left unresolved here and
    // their crop is skipped downstream — ambiguity is not a licence to guess.
    if (Object.keys(characterClothing).length === 0 && clothingRequirements) {
      const NON_COSTUMED = ['standard', 'winter', 'summer', 'formal'];
      for (const char of characters) {
        const charReqs = clothingRequirements[char.name];
        if (!charReqs?.costumed?.used || !charReqs.costumed.costume) continue;
        const usesNonCostumed = NON_COSTUMED.some(cat => charReqs[cat]?.used);
        if (usesNonCostumed) continue; // ambiguous — can't infer this page; keep standard default
        characterClothing[char.name] = `costumed:${charReqs.costumed.costume}`;
      }
      if (Object.keys(characterClothing).length > 0) {
        log.debug(`[ENTITY-COLLECT] Page ${pageNumber}: Using story clothingRequirements fallback (costume-only chars): ${JSON.stringify(characterClothing)}`);
      }
    }

    // Debug: log clothing info for this page
    if (Object.keys(characterClothing).length > 0) {
      log.debug(`[ENTITY-COLLECT] Page ${pageNumber}: Per-char clothing: ${JSON.stringify(characterClothing)}`);
    }

    // Get figures from bbox detection - now includes direct character identification via figure.name
    let figures = bboxDetection?.figures || [];

    // Debug logging for entity collection
    if (!bboxDetection) {
      log.debug(`[ENTITY-COLLECT] Page ${pageNumber}: No bboxDetection found in retryHistory (entries: ${img.retryHistory?.length || 0})`);
    } else {
      const identifiedFigures = figures.filter(f => f.name && f.name !== 'UNKNOWN');
      log.debug(`[ENTITY-COLLECT] Page ${pageNumber}: ${figures.length} figures, ${identifiedFigures.length} identified: ${identifiedFigures.map(f => f.name).join(', ')}`);
    }

    // Fallback: run on-the-fly bbox detection for pages with missing or unusable data.
    // Triggers when: no detection at all, empty figures array, or all figures are UNKNOWN.
    const identifiedCount = figures.filter(f => f.name && f.name !== 'UNKNOWN').length;
    const needsFallbackDetection = !bboxDetection || figures.length === 0 || identifiedCount === 0;

    if (needsFallbackDetection && storyCharacters) {
      // Determine which characters are expected on this page
      let pageCharNames = [];
      const sceneDesc = sceneDescriptions.find(s => s.pageNumber === pageNumber);
      if (sceneDesc?.description) {
        const pageChars = getCharactersInScene(sceneDesc.description, storyCharacters);
        pageCharNames = pageChars.map(c => c.name);

        // Also check for VB animals and secondary characters mentioned in the scene
        // (e.g., "Funke the dragon" — not a main character but should be detected)
        const sceneText = sceneDesc.description.toLowerCase();
        const vb = visualBible || null;
        if (vb) {
          for (const animal of (vb.animals || [])) {
            if (animal.name && sceneText.includes(animal.name.toLowerCase()) && !pageCharNames.includes(animal.name)) {
              pageCharNames.push(animal.name);
            }
          }
          for (const sc of (vb.secondaryCharacters || [])) {
            if (sc.name && sceneText.includes(sc.name.toLowerCase()) && !pageCharNames.includes(sc.name)) {
              pageCharNames.push(sc.name);
            }
          }
        }
      }
      if (pageCharNames.length === 0 && pageNumber < 0) {
        // Covers: prefer per-cover character list from characterClothing (set from cover hint).
        // Sending all 10 story characters to bbox detection produces 0 identifications because
        // the prompt becomes too noisy. Fall back to all only if cover hint is missing.
        const coverChars = Object.keys(characterClothing || {});
        if (coverChars.length > 0) {
          pageCharNames = coverChars;
          log.debug(`[ENTITY-COLLECT] Page ${pageNumber} (cover): Using ${pageCharNames.length} characters from cover hint: ${pageCharNames.join(', ')}`);
        } else {
          pageCharNames = storyCharacters.map(c => c.name);
          log.debug(`[ENTITY-COLLECT] Page ${pageNumber} (cover): No cover hint, falling back to all ${pageCharNames.length} story characters`);
        }
      }
      // Fallback for regular pages: if scene description parsing found no characters,
      // use all story characters so bbox detection still runs
      if (pageCharNames.length === 0 && pageNumber > 0) {
        pageCharNames = storyCharacters.map(c => c.name);
        log.debug(`[ENTITY-COLLECT] Page ${pageNumber}: Scene description yielded no characters, falling back to all ${pageCharNames.length} story characters`);
      }

      if (pageCharNames.length > 0) {
        // Build expected characters with physical descriptions + clothing for Gemini
        const { extractSceneMetadata } = require('./storyHelpers');
        const sceneMetadata = sceneDesc ? extractSceneMetadata(sceneDesc.description || sceneDesc.sceneDescription) : null;
        const charClothing = sceneMetadata?.characterClothing || {};

        const vb = visualBible || null;
        const expectedChars = pageCharNames.map(name => {
          const fullChar = storyCharacters.find(c => c.name === name);

          // Check VB for non-main characters (animals, secondary chars)
          if (!fullChar && vb) {
            const vbAnimal = vb.animals?.find(a => a.name === name || a.id === name);
            const vbSecondary = vb.secondaryCharacters?.find(c => c.name === name || c.id === name);
            const vbEntry = vbAnimal || vbSecondary;
            if (vbEntry) {
              const desc = vbEntry.extractedDescription || vbEntry.description || name;
              return { name, description: sanitizeForGemini(desc, 'full'), position: '' };
            }
          }

          // If the page didn't tag clothing for this character, prefer costumed
          // when the character only has costumed avatars (historical stories).
          // Hardcoded 'standard' default produced the AVATAR-LOOKUP warning
          // "wanted standard but only costumed exists" and the eval ran with
          // the wrong reference clothing.
          const styledForArt = fullChar?.avatars?.styledAvatars?.[artStyle] || {};
          const onlyHasCostumed = !!styledForArt.costumed
            && !styledForArt.standard
            && !styledForArt.winter
            && !styledForArt.summer;
          const fallbackCategory = onlyHasCostumed ? 'costumed' : 'standard';
          // Case-insensitive lookup — scene metadata can key characterClothing
          // with different casing than the canonical character name, and an
          // exact-key miss silently degraded the eval to the fallback category.
          const charClothingKey = Object.keys(charClothing)
            .find(k => k.toLowerCase() === name.toLowerCase());
          const clothingCategory = (charClothingKey && charClothing[charClothingKey]) || fallbackCategory;
          // Resolve category to actual clothing description.
          // buildClothingDescription prefers this story's clothingRequirements
          // (signature → description) and only falls back to avatars.clothing,
          // which is character-level metadata that can be stale across stories.
          const clothing = fullChar
            ? buildClothingDescription(fullChar, clothingCategory, artStyle, clothingRequirements)
            : '';
          const physDesc = fullChar ? buildCharacterPhysicalDescription(fullChar) : 'character';
          const position = sceneMetadata?.characterPositions?.[name] || '';
          // Sanitize age/gender terms to avoid Gemini safety blocks on children in costumes
          const sanitizedDesc = sanitizeForGemini(clothing ? `${physDesc}. Wearing: ${clothing}` : physDesc, 'full');
          return {
            name,
            description: sanitizedDesc,
            position
          };
        });

        // Build scene context for disambiguation (sanitized for Gemini safety)
        let sceneContext = null;
        if (sceneMetadata?.imageSummary) {
          const contextParts = [`**SCENE:** ${sanitizeForGemini(sceneMetadata.imageSummary, 'full')}`];
          const sceneChars = sceneMetadata.characters || [];
          if (sceneChars.length > 0) {
            contextParts.push(sceneChars.map(c => {
              const parts = [`- ${c.name}:`];
              if (c.position) parts.push(c.position);
              if (c.action) parts.push(c.action);
              return parts.join(', ');
            }).join('\n'));
          }
          sceneContext = contextParts.join('\n\n');
        }

        log.info(`🔍 [ENTITY-COLLECT] Page ${pageNumber}: Running fallback bbox detection for ${pageCharNames.join(', ')}${sceneContext ? ' (with scene context)' : ''}`);
        try {
          const detection = await detectAllBoundingBoxes(imageData, { expectedCharacters: expectedChars, sceneContext, artStyle });
          if (detection) {
            bboxDetection = detection;
            figures = detection.figures || [];
            // Mark figures as from fallback detection (for overlay coloring)
            for (const fig of figures) fig._source = 'fallback';
            // Cache result back on the image for future use
            img.bboxDetection = detection;
            pagesWithNewBbox.push(pageNumber);

            const newIdentified = figures.filter(f => f.name && f.name !== 'UNKNOWN');
            log.info(`🔍 [ENTITY-COLLECT] Page ${pageNumber}: Fallback detection found ${figures.length} figures, ${newIdentified.length} identified: ${newIdentified.map(f => f.name).join(', ')}`);
          }
        } catch (err) {
          log.warn(`⚠️  [ENTITY-COLLECT] Page ${pageNumber}: Fallback bbox detection failed: ${err.message}`);
        }
      }
    }

    // Run cascade face detection to improve faceBox coordinates
    // Anime + Haar cascades are much more accurate than Gemini for locating faces in illustrations
    if (figures.length > 0) {
      let cascadeRan = false;
      try {
        const cascadeFaces = await detectIllustrationFaces(imageData, 60);
        if (cascadeFaces.length > 0) {
          // Get image dimensions for normalization (from sharp if available, else estimate)
          let imgW = 1024, imgH = 1024;
          try {
            const buf = await r2.bytesFromAnyImage(imageData);
            if (buf) {
              const meta = await sharp(buf).metadata();
              imgW = meta.width || 1024;
              imgH = meta.height || 1024;
            }
          } catch { /* use defaults */ }

          figures = await mergeCascadeFacesWithGemini(figures, cascadeFaces, imgW, imgH);
          cascadeRan = true;
          const cascadeImproved = figures.filter(f => f._cascadeFace).length;
          if (cascadeImproved > 0) {
            log.info(`🎯 [ENTITY-COLLECT] Page ${pageNumber}: Cascade improved ${cascadeImproved}/${figures.length} face boxes`);
          }
        }
      } catch (err) {
        log.debug(`[ENTITY-COLLECT] Page ${pageNumber}: Cascade face detection skipped: ${err.message}`);
      }
      // Fallback: even without cascade, ensure bodyBox contains faceBox
      if (!cascadeRan) {
        ensureFaceInsideBody(figures);
      }
    }

    // Match characters by figure.name (direct AI identification)
    for (const char of characters) {
      const charName = char.name;
      const charApps = appearances.get(charName);

      // Skip if we already have an appearance for this page
      if (charApps && charApps.some(a => a.pageNumber === pageNumber)) continue;

      // Find figure by direct name match (new bbox detection includes character name in figure.name)
      const charNameLower = charName.toLowerCase();
      let matchingFigure = figures.find(f => {
        const figureName = (f.name || '').toLowerCase();
        return figureName === charNameLower;
      });

      // Fallback: try label matching if name didn't match
      // NOTE: Be strict - only match if character name appears as a word in label
      // Don't use substring matching (e.g., "man" in "manuel") as this causes false matches
      if (!matchingFigure) {
        matchingFigure = figures.find(f => {
          const label = (f.label || '').toLowerCase();
          // Match if character name appears as a complete word in the label.
          // Escape regex metacharacters (PIPE-8) — names like "Lea (Mami)" or "A+"
          // would otherwise mis-match or throw SyntaxError (swallowed upstream →
          // entity check silently disabled for the whole story).
          const escapedName = charNameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const namePattern = new RegExp(`\\b${escapedName}\\b`, 'i');
          return namePattern.test(label);
        });
      }

      if (matchingFigure) {
        const rawClothing = characterClothing[charName] || defaultClothing;
        if (!rawClothing) {
          log.error(`❌ [ENTITY-COLLECT] ${charName} p${pageNumber}: no clothing category on the page — crop EXCLUDED from the consistency grid. Judging it against a guessed category invents clothing findings.`);
          continue;
        }
        const clothing = normalizeClothingCategory(rawClothing);
        // Determine confidence based on how we matched
        const confidence = (matchingFigure.name || '').toLowerCase() === charNameLower
          ? (matchingFigure.confidence === 'high' ? 0.95 : matchingFigure.confidence === 'medium' ? 0.8 : 0.65)
          : 0.5;  // Lower confidence for label-based match

        if (!charApps) {
          appearances.set(charName, []);
        }
        const appearance = {
          pageNumber,
          versionIndex,
          imageData,
          faceBox: matchingFigure.faceBox || null,
          bodyBox: matchingFigure.bodyBox || null,
          position: matchingFigure.position,
          label: matchingFigure.label,
          clothing,
          confidence,
          // Stamp which bytes these boxes belong to — char repair verifies
          // this before applying a stored appearance box to a page image
          // (see images.js bboxPairsWith).
          sourceImageFp: require('./images').imageFingerprint(imageData)
        };
        // Reuse the detection SAM silhouette for this figure (page-res PNG,
        // index-aligned with figures via _gdinoMasks — the same source the
        // overlay strip reads). extractEntityCrops uses it to cut the figure
        // out of its rectangle. Non-enumerable, like _gdinoMasks itself: never
        // serialized into stories.data (the persisted appearance shape at the
        // grid-build site picks fields explicitly). Absent → null → rectangle
        // crop on reloaded-from-DB detections where masks were never stored.
        const figIdx = figures.indexOf(matchingFigure);
        const figMask = (figIdx >= 0 && bboxDetection?._gdinoMasks?.[figIdx]) || null;
        Object.defineProperty(appearance, 'mask', { value: figMask, enumerable: false });
        appearances.get(charName).push(appearance);
      }
    }
  }

  // Filter out entities with too few appearances (unless skip requested for repair use case)
  if (!skipMinAppearancesFilter) {
    for (const [name, apps] of appearances) {
      if (apps.length < MIN_APPEARANCES) {
        log.debug(`[ENTITY-COLLECT] Filtering out "${name}" with only ${apps.length} appearances (min: ${MIN_APPEARANCES})`);
        appearances.delete(name);
      }
    }
  }

  // Log summary
  const totalAppearances = Array.from(appearances.values()).reduce((sum, apps) => sum + apps.length, 0);
  log.info(`[ENTITY-COLLECT] Found ${appearances.size} characters with ${totalAppearances} total appearances: ${Array.from(appearances.entries()).map(([name, apps]) => `${name}(${apps.length})`).join(', ')}`);

  if (pagesWithNewBbox.length > 0) {
    log.info(`[ENTITY-COLLECT] Ran fallback bbox detection on ${pagesWithNewBbox.length} pages: ${pagesWithNewBbox.join(', ')}`);
  }

  // Return both appearances and metadata about new detections
  appearances._pagesWithNewBbox = pagesWithNewBbox;
  return appearances;
}

/**
 * Collect object appearances from scene images using bbox detection data
 *
 * @param {Array<object>} sceneImages - Scene images with retryHistory
 * @returns {Map<string, Array>} Map of objectName -> appearances
 */
/**
 * Build a canonical-name lookup from the Visual Bible. For each animal,
 * artifact, and vehicle entry, extract searchable keywords (from name +
 * description). When the bbox detector returns variant labels like
 * "stuffed elephant toy" / "plush elephant toy with red scarf", we match
 * them against VB entries by keyword overlap and collapse them to the
 * canonical VB name.
 */
function buildVisualBibleEntityIndex(visualBible) {
  if (!visualBible) return [];
  const index = [];
  const STOP_WORDS = _expandedStopWords();
  const extractKeywords = (text) => {
    if (!text) return new Set();
    return new Set(
      String(text).toLowerCase().split(/[\s,.'"\-()/]+/)
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
    );
  };
  const addCategory = (arr, type) => {
    for (const entry of (arr || [])) {
      if (!entry || !entry.name) continue;
      const keywords = new Set([
        ...extractKeywords(entry.name),
        ...extractKeywords(entry.extractedDescription || entry.description || ''),
      ]);
      if (keywords.size === 0) continue;
      index.push({
        id: entry.id || null,
        name: entry.name,
        type,
        keywords,
      });
    }
  };
  addCategory(visualBible.animals, 'animal');
  addCategory(visualBible.artifacts, 'artifact');
  addCategory(visualBible.vehicles, 'vehicle');
  // Also secondary characters — sometimes the detector labels them as "objects"
  addCategory(visualBible.secondaryCharacters, 'secondary-character');
  return index;
}

/**
 * Match a detected object label against the Visual Bible index by
 * keyword overlap. Returns the canonical VB entry (with .name, .id) if
 * there's a meaningful match; otherwise null.
 */
function canonicalizeObjectName(label, vbIndex) {
  if (!label || vbIndex.length === 0) return null;
  const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'in', 'on', 'at', 'for', 'to', 'is', 'toy', 'small', 'large', 'red', 'blue', 'green', 'yellow', 'black', 'white', 'grey', 'gray', 'brown']);
  const labelWords = new Set(
    String(label).toLowerCase().split(/[\s,.'"\-()/]+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
  );
  if (labelWords.size === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const entry of vbIndex) {
    let overlap = 0;
    for (const w of labelWords) if (entry.keywords.has(w)) overlap++;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = entry;
    }
  }
  // Require at least 2 overlapping non-color keywords to avoid matching
  // on a single common adjective (e.g. "red and white checkered picnic
  // blanket" shouldn't match "Eli — red scarf" just because both say red).
  // Fall back to 1 for entries whose keyword set is small (e.g. very short
  // VB entries with only 1-2 keywords) since the bar can't be higher than
  // the entry's own keyword count.
  const minNeeded = best && best.keywords.size >= 2 ? 2 : 1;
  return bestScore >= minNeeded ? best : null;
}

// Also exclude color words from the VB keyword index to keep matching symmetric.
function _expandedStopWords() {
  return new Set(['the', 'a', 'an', 'of', 'and', 'with', 'in', 'on', 'at', 'for', 'to', 'is', 'toy', 'small', 'large', 'red', 'blue', 'green', 'yellow', 'black', 'white', 'grey', 'gray', 'brown']);
}

function collectObjectAppearances(sceneImages, visualBible = null) {
  const appearances = new Map();
  const vbIndex = buildVisualBibleEntityIndex(visualBible);

  for (const img of sceneImages) {
    const pageNumber = img.pageNumber;

    // Active-version-aware: object crops come from the version the user is
    // looking at, not whatever v0 happened to have stored at page level.
    // See resolveActiveVersionData() at the top of this file for the rationale.
    const { imageData, bboxDetection: bboxDetectionInit } = resolveActiveVersionData(img);

    if (!imageData) continue;

    let bboxDetection = bboxDetectionInit;

    if (!bboxDetection?.objects) continue;

    // Match objects via objectMatches or use labels directly
    for (const obj of bboxDetection.objects) {
      // Skip objects the detector flagged as not found, or that have no usable bbox.
      // Without this guard they pass the appearance-count threshold and then fail
      // crop extraction every entity-check pass ("0 valid crops" warning spam).
      if (obj.found === false) continue;
      if (!obj.bodyBox || !Array.isArray(obj.bodyBox) || obj.bodyBox.length !== 4) continue;

      const match = bboxDetection.objectMatches?.find(m =>
        m.label === obj.label
      );
      const rawName = match?.reference || obj.label || obj.name;

      // Skip objects without a valid name
      if (!rawName) {
        log.debug(`[ENTITY-COLLECT] Skipping object without name on page ${pageNumber}`);
        continue;
      }

      // Canonicalize against the Visual Bible so detector variants like
      // "plush elephant toy with red scarf" vs "stuffed elephant toy"
      // collapse into the single VB entry (e.g. "Eli" / ANI001).
      const canonical = canonicalizeObjectName(rawName, vbIndex);
      const name = canonical?.name || rawName;

      if (!appearances.has(name)) {
        appearances.set(name, []);
      }

      appearances.get(name).push({
        pageNumber,
        imageData,
        bodyBox: obj.bodyBox,
        faceBox: null,  // Objects don't have faces
        label: obj.label,
        rawLabel: rawName,
        canonicalId: canonical?.id || null,
        confidence: match?.confidence || 0.7,
        isObject: true  // Mark as object for 15% padding in crop extraction
      });
    }
  }

  // Filter out objects with too few appearances
  for (const [name, apps] of appearances) {
    if (apps.length < MIN_APPEARANCES) {
      appearances.delete(name);
    }
  }

  return appearances;
}

/**
 * Extract cropped images for each entity appearance
 *
 * @param {Array<object>} appearances - Entity appearances with bbox info
 * @param {object} options - Extraction options
 * @param {boolean} options.forRegeneration - If true, output PNG and store original image data for compositing
 * @returns {Promise<Array>} Array of crop objects with buffer, paddedBox, and optionally originalImageData
 */
async function extractEntityCrops(appearances, options = {}) {
  const { forRegeneration = false } = options;
  const crops = [];

  for (const app of appearances) {
    try {
      // Prefer body crop (more reliable than face detection)
      const bbox = app.bodyBox || app.faceBox;  // Prefer body, fallback to face
      const cropType = 'body';  // Always use body crop
      const isObject = app.isObject || false;

      if (!bbox) {
        log.verbose(`[ENTITY-CROP] No bbox for page ${app.pageNumber}`);
        continue;
      }

      // Extract crop from image
      // Figures: asymmetric padding (10% up, 5% sides) to avoid cutting off heads
      // Objects: 15% uniform padding, no resize, original aspect
      const cropResult = await extractCropFromImage(
        app.imageData,
        bbox,
        null,  // No resize - keep original size
        isObject ? 0.15 : 0,  // Uniform padding for objects
        {
          forRegeneration,
          // Asymmetric padding for figures: extend upward to capture full head
          asymmetricPadding: isObject ? null : { top: 0.10, bottom: 0, left: 0.05, right: 0.05 },
          // Detection SAM silhouette for this figure (page-res PNG), when the
          // appearance was built from an in-process detection; null for objects
          // and reloaded-from-DB appearances → rectangle crop.
          mask: app.mask || null
        }
      );

      if (cropResult && cropResult.buffer) {
        // Get original crop dimensions for proper resizing after repair
        const cropMeta = await sharp(cropResult.buffer).metadata();

        // HEAD crop for the consistency judge (owner, 2026-08-14): the face
        // box intersected with the body crop — cut OUT OF the body-crop buffer,
        // which already carries the SAM silhouette, so neighbours and
        // background are gone for free. Never a second read of the page image.
        let headBuffer = null;
        if (!isObject && Array.isArray(app.faceBox) && app.faceBox.length === 4 && cropResult.paddedBox) {
          try {
            const [fy1, fx1, fy2, fx2] = app.faceBox;
            const fh = fy2 - fy1, fw = fx2 - fx1;
            const [py1, px1, py2, px2] = cropResult.paddedBox; // page-normalized
            const pw = px2 - px1, ph = py2 - py1;
            if (fh > 0.005 && fw > 0.005 && pw > 0 && ph > 0) {
              // Head box in page coords (hair margin above, cut below the box),
              // then mapped into body-crop pixel coords and clamped to it.
              const hb = {
                y1: Math.max(py1, fy1 - fh * 0.35),
                x1: Math.max(px1, fx1 - fw * 0.25),
                y2: Math.min(py2, fy2 + fh * 0.10),
                x2: Math.min(px2, fx2 + fw * 0.25),
              };
              const left = Math.round(((hb.x1 - px1) / pw) * cropMeta.width);
              const top = Math.round(((hb.y1 - py1) / ph) * cropMeta.height);
              const w = Math.round(((hb.x2 - hb.x1) / pw) * cropMeta.width);
              const h = Math.round(((hb.y2 - hb.y1) / ph) * cropMeta.height);
              if (w >= 32 && h >= 32) {
                headBuffer = await sharp(cropResult.buffer)
                  .extract({ left: Math.max(0, left), top: Math.max(0, top),
                             width: Math.min(w, cropMeta.width - Math.max(0, left)),
                             height: Math.min(h, cropMeta.height - Math.max(0, top)) })
                  .toBuffer();
              }
            }
          } catch (err) { log.debug(`[ENTITY-CROP] head crop failed p${app.pageNumber}: ${err.message}`); }
        }

        const cropData = {
          buffer: cropResult.buffer,
          headBuffer,
          pageNumber: app.pageNumber,
          versionIndex: app.versionIndex ?? null,
          cropType,
          clothing: app.clothing,
          position: app.position,
          confidence: app.confidence,
          // NEW: Store for compositing back
          paddedBox: cropResult.paddedBox,
          // Store original dimensions for resizing repaired cells
          originalWidth: cropMeta.width,
          originalHeight: cropMeta.height
        };

        // Store original image data reference for regeneration/compositing
        if (forRegeneration) {
          cropData.originalImageData = app.imageData;
        }

        crops.push(cropData);
      }
    } catch (err) {
      log.warn(`⚠️  [ENTITY-CROP] Failed to extract crop for page ${app.pageNumber}: ${err.message}`);
    }
  }

  return crops;
}

/**
 * Extract a crop from an image given a bounding box
 *
 * @param {string} imageData - Base64 image data
 * @param {number[]} bbox - Bounding box [ymin, xmin, ymax, xmax] normalized 0-1
 * @param {number|null} targetSize - Target crop size in pixels, or null for no resize (keep original)
 * @param {number} padding - Uniform padding ratio to add around bbox (0-0.5)
 * @param {object} options - Additional options
 * @param {boolean} options.forRegeneration - If true, output PNG for lossless quality
 * @param {object} options.asymmetricPadding - Optional asymmetric padding {top, bottom, left, right} as ratios
 * @returns {Promise<{buffer: Buffer, paddedBox: number[]}|null>} Cropped image buffer and normalized padded box
 */
async function extractCropFromImage(imageData, bbox, targetSize, padding = 0, options = {}) {
  const { forRegeneration = false, asymmetricPadding = null, mask = null } = options;

  try {
    const imgBuffer = await r2.bytesFromAnyImage(imageData);
    if (!imgBuffer) return null;

    // Get image dimensions
    const metadata = await sharp(imgBuffer).metadata();
    const width = metadata.width;
    const height = metadata.height;

    // Convert normalized bbox to pixel coordinates
    const [ymin, xmin, ymax, xmax] = bbox;
    let x1 = Math.round(xmin * width);
    let y1 = Math.round(ymin * height);
    let x2 = Math.round(xmax * width);
    let y2 = Math.round(ymax * height);

    // Add padding if specified
    if (asymmetricPadding) {
      // Asymmetric padding: different amounts for each direction
      const bboxWidth = x2 - x1;
      const bboxHeight = y2 - y1;
      const padTop = Math.round(bboxHeight * (asymmetricPadding.top || 0));
      const padBottom = Math.round(bboxHeight * (asymmetricPadding.bottom || 0));
      const padLeft = Math.round(bboxWidth * (asymmetricPadding.left || 0));
      const padRight = Math.round(bboxWidth * (asymmetricPadding.right || 0));

      y1 = Math.max(0, y1 - padTop);
      y2 = Math.min(height, y2 + padBottom);
      x1 = Math.max(0, x1 - padLeft);
      x2 = Math.min(width, x2 + padRight);
    } else if (padding > 0) {
      // Uniform padding
      const bboxWidth = x2 - x1;
      const bboxHeight = y2 - y1;
      const padX = Math.round(bboxWidth * padding);
      const padY = Math.round(bboxHeight * padding);

      x1 = Math.max(0, x1 - padX);
      y1 = Math.max(0, y1 - padY);
      x2 = Math.min(width, x2 + padX);
      y2 = Math.min(height, y2 + padY);
    }

    // Calculate normalized padded box for later compositing
    const paddedBox = [y1 / height, x1 / width, y2 / height, x2 / width];

    // Guard against degenerate bboxes (ymin >= ymax or xmin >= xmax)
    const cropW = x2 - x1;
    const cropH = y2 - y1;
    if (cropW < 1 || cropH < 1) {
      log.warn(`[ENTITY-CROP] Skipping degenerate bbox: ${cropW}x${cropH} (coords: x=${x1}-${x2}, y=${y1}-${y2})`);
      return null;
    }

    // Extract crop (no resize if targetSize is null)
    let sharpPipeline = sharp(imgBuffer)
      .extract({
        left: x1,
        top: y1,
        width: cropW,
        height: cropH
      });

    // SAM cutout: gate the crop to the figure silhouette so the eval sees the
    // figure alone on white — no neighbours/background inside the rectangle.
    // Done on the SMALL crop region (dest-in the same rect of the page-res mask),
    // not on the full page — masking a small crop avoids a wasteful full-page
    // PNG encode per crop. Skipped for forRegeneration crops (composited back,
    // need the true rectangle). Same page bytes → mask dims == page dims; a
    // mismatch or failure degrades to the rectangle (logged), never throws.
    let didMask = false;
    if (mask && !forRegeneration) {
      try {
        const mMeta = await sharp(mask).metadata();
        if (mMeta.width === width && mMeta.height === height) {
          const maskCrop = await sharp(mask)
            .extract({ left: x1, top: y1, width: cropW, height: cropH })
            .ensureAlpha()
            .png()
            .toBuffer();
          const cropBuf = await sharpPipeline.toBuffer();
          // Materialize the cutout to a buffer BEFORE the flatten/encode below.
          // sharp reorders ops within one pipeline (flatten runs before
          // composite), so a chained .composite().flatten() fills the masked-out
          // area BLACK. A separate pipeline over the already-transparent buffer
          // flattens to white correctly. Small crop → cheap (~tens of ms).
          const maskedBuf = await sharp(cropBuf).ensureAlpha()
            .composite([{ input: maskCrop, blend: 'dest-in' }])
            .png()
            .toBuffer();
          sharpPipeline = sharp(maskedBuf);
          didMask = true;
        } else {
          log.warn(`[ENTITY-CROP] SAM mask ${mMeta.width}x${mMeta.height} != page ${width}x${height}; using rectangle crop`);
        }
      } catch (e) {
        log.warn(`[ENTITY-CROP] SAM cutout failed (${e.message}); using rectangle crop`);
      }
    }

    // Only resize if targetSize is specified
    if (targetSize) {
      sharpPipeline = sharpPipeline.resize(targetSize, targetSize, { fit: 'cover' });
    }

    // Use PNG for regeneration (lossless), JPEG otherwise. A masked crop is
    // flattened onto white so the transparent (non-figure) area reads as a
    // clean backdrop in the JPEG the evaluator sees.
    const cropBuffer = forRegeneration
      ? await sharpPipeline.png().toBuffer()
      : didMask
        ? await sharpPipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer()
        : await sharpPipeline.jpeg({ quality: 90 }).toBuffer();

    return { buffer: cropBuffer, paddedBox };
  } catch (err) {
    log.error(`[ENTITY-CROP] Extraction error: ${err.message}`);
    return null;
  }
}

/**
 * Create an entity grid image from appearance crops
 *
 * @param {Array<object>} crops - Array of crop objects
 * @param {string} entityName - Name of the entity
 * @param {string|null} referencePhoto - Optional reference photo URL
 * @returns {Promise<{buffer: Buffer, manifest: Object, cellMap: Object}>}
 */
async function createEntityGrid(crops, entityName, referencePhoto = null) {
  // Sort by page number
  const sortedCrops = [...crops].sort((a, b) => a.pageNumber - b.pageNumber);

  // Limit to max grid cells (leave 1 slot for reference if available)
  const maxCrops = referencePhoto ? MAX_GRID_CELLS - 1 : MAX_GRID_CELLS;
  const cropsToUse = sortedCrops.slice(0, maxCrops);

  // Build cells array
  const cells = [];

  // Add reference photo as first cell if available
  if (referencePhoto) {
    try {
      const refBuffer = await r2.bytesFromAnyImage(referencePhoto);

      if (refBuffer) {
        cells.push({
          buffer: refBuffer,
          letter: 'R',  // R for Reference
          pageInfo: 'Ref',
          metadata: {
            isReference: true,
            entityName
          }
        });
      }
    } catch (err) {
      log.warn(`⚠️  [ENTITY-GRID] Failed to add reference photo: ${err.message}`);
    }
  }

  // Add appearance crops
  for (let i = 0; i < cropsToUse.length; i++) {
    const crop = cropsToUse[i];
    const letter = String.fromCharCode(65 + i);  // A, B, C...

    cells.push({
      buffer: crop.buffer,
      letter,
      pageInfo: `P${crop.pageNumber}`,
      metadata: {
        pageNumber: crop.pageNumber,
        versionIndex: crop.versionIndex ?? null,
        cropType: crop.cropType,
        clothing: crop.clothing,
        position: crop.position,
        confidence: crop.confidence
      }
    });
  }

  // Create grid using shared utility
  return createLabeledGrid(cells, {
    title: `${entityName} - Entity Consistency`,
    cellSize: FACE_CROP_SIZE,
    showPageInfo: true,
    maxCols: 3,
    maxRows: 3
  });
}

/**
 * Head grid — the same cells as the body grid, cropped to the head region, so
 * the judge sees each face at cell size instead of ~40px inside a body crop.
 *
 * Body-only grids made hair and face comparison a thumbnail guess: a
 * different-haired child sat next to the blonde reference and the judge
 * reported nothing (P4, job_1786653013328). Face DETECTION was deliberately
 * dropped as unreliable (extractEntityCrops: cropType 'body' always), so this
 * does not bring it back — the head is cut geometrically from the top of the
 * body crop, which the asymmetric top padding already keeps in frame.
 *
 * Same letters as the body grid. Returns null when no cell yields a head crop
 * (objects, or crops too small to slice).
 */
async function createEntityHeadGrid(crops, entityName) {
  const sortedCrops = [...crops].sort((a, b) => a.pageNumber - b.pageNumber);
  const cropsToUse = sortedCrops.slice(0, MAX_GRID_CELLS - 1);
  const cells = [];
  for (let i = 0; i < cropsToUse.length; i++) {
    const crop = cropsToUse[i];
    try {
      let buffer = crop.headBuffer || null;
      if (!buffer) {
        // Fallback for appearances without a faceBox (reloaded detections):
        // top band of the body crop. Coarse, but keeps the cell present.
        const meta = await sharp(crop.buffer).metadata();
        if (!meta.width || !meta.height || meta.height < 96) continue;
        const headH = Math.max(64, Math.round(meta.height * 0.32));
        const headW = Math.max(64, Math.round(meta.width * 0.7));
        const left = Math.round((meta.width - headW) / 2);
        buffer = await sharp(crop.buffer)
          .extract({ left, top: 0, width: headW, height: Math.min(headH, meta.height) })
          .toBuffer();
      }
      cells.push({
        buffer,
        letter: String.fromCharCode(65 + i),
        pageInfo: `P${crop.pageNumber}`,
        metadata: { pageNumber: crop.pageNumber, cropType: 'head' },
      });
    } catch { /* cell skipped — body grid still carries it */ }
  }
  if (cells.length === 0) return null;
  return createLabeledGrid(cells, {
    title: `${entityName} - Heads`,
    cellSize: FACE_CROP_SIZE,
    showPageInfo: true,
    maxCols: 3,
    maxRows: 3
  });
}

/**
 * Evaluate entity consistency using Gemini
 *
 * @param {Buffer} gridBuffer - Grid image buffer
 * @param {Object} manifest - Grid manifest
 * @param {Object} entityInfo - Entity information
 * @returns {Promise<Object>} Evaluation result
 */
async function evaluateEntityConsistency(gridBuffer, manifest, entityInfo, headGridBuffer = null) {
  const { entityType, entityName, referencePhoto, cellCount, clothingCategory, expectedClothing } = entityInfo;

  // Build prompt from template
  const promptTemplate = PROMPT_TEMPLATES.entityConsistencyCheck;
  if (!promptTemplate) {
    // Missing template is a deploy/code bug (never transient) — fail CLOSED and
    // loud, never silently mark the story entity-consistent.
    log.error('❌ [ENTITY-CHECK] Missing prompt template: entity-consistency-check.txt — failing entity check closed');
    return {
      consistent: false,
      evalFailed: true,
      score: 10,
      issues: [],
      summary: 'Prompt template not available',
      error: 'Missing prompt template'
    };
  }

  // Build cell info JSON. NO DEFAULT (owner, 2026-08-07): every cell reaching
  // here was labelled at collection time, so a missing category means the
  // pipeline lost it — say so in the cell rather than telling the judge
  // "standard" and having it score the crop against an outfit from another
  // story. 'unknown' is inert: the prompt has no expectations attached to it.
  const cellInfo = manifest.cells.map(cell => {
    const clothing = cell.clothing || clothingCategory;
    if (!clothing && !cell.isReference) {
      log.error(`❌ [ENTITY-GRID] cell ${cell.letter} (page ${cell.pageNumber}) has no clothing category — sending 'unknown' rather than defaulting to 'standard'.`);
    }
    return {
      cell: cell.letter,
      page: cell.isReference ? 'Reference Photo' : cell.pageNumber,
      clothing: clothing || 'unknown',
      cropType: cell.cropType || 'face',
    };
  });

  // Build reference photo info
  const refPhotoInfo = referencePhoto
    ? 'A reference photo of this character is provided as cell R.'
    : 'No reference photo available.';

  // Build clothing context info. Cell R is authoritative for IDENTITY only;
  // expected clothing comes as text from the story's clothingRequirements
  // (styled-avatar pixels can drift from the story's clothing spec).
  let clothingContextInfo = '';
  if (clothingCategory) {
    const isCostumed = clothingCategory === 'costumed' || clothingCategory.startsWith('costumed:');
    const costumeType = isCostumed
      ? (clothingCategory.startsWith('costumed:') ? clothingCategory.replace('costumed:', '') : 'costume')
      : null;
    const lines = [
      '',
      '## Clothing Context',
      '',
      `This evaluation is for the **${clothingCategory}** clothing category${costumeType ? ` (costume: ${costumeType})` : ''}.`,
    ];
    if (referencePhoto) {
      lines.push('Cell R is authoritative for identity only (face, hair, skin tone, age). Do not treat the outfit shown in Cell R as the expected clothing.');
    }
    if (expectedClothing) {
      lines.push(`Expected clothing for these cells: ${expectedClothing}`);
      lines.push('Judge clothing against this description; flag cells whose outfit contradicts it or differs from the other cells.');
    } else {
      lines.push(`All cells should show the character in ${clothingCategory} attire; flag outfits that differ between cells.`);
    }
    if (isCostumed && referencePhoto) {
      lines.push('Even if only one appearance exists, verify its identity against Cell R.');
    }
    clothingContextInfo = lines.join('\n');
  }

  // Fill template — fillTemplate is global + $-safe (entityName is
  // user-derived; a chained string .replace would interpret $-sequences
  // and only hit the first occurrence).
  // The garment vocabulary is rendered from the SAME constant the repair
  // validates against (garmentColourFix.GARMENT_ENUM), so the words the
  // evaluator is taught and the words the detector can be asked cannot drift.
  const { garmentEnumForPrompt } = require('./garmentColourFix');
  const prompt = fillTemplate(promptTemplate, {
    ENTITY_TYPE: entityType,
    ENTITY_NAME: entityName,
    REFERENCE_PHOTO_INFO: refPhotoInfo,
    HEAD_GRID_INFO: headGridBuffer
      ? 'A second image shows the same cells cropped to the head only, with the same letters. Judge facial features, hair colour and hair style on the second image; it shows each face at full size.'
      : '',
    CLOTHING_CONTEXT: clothingContextInfo,
    CELL_INFO: JSON.stringify(cellInfo, null, 2),
    CELL_COUNT: cellCount.toString(),
    GARMENT_ENUM: garmentEnumForPrompt(),
  });

  const model = genAI.getGenerativeModel({
    model: ENTITY_CHECK_MODEL,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192  // Increased from 2048 to handle complex responses with many issues
    }
  });

  // Retry transient Gemini/parse failures instead of failing OPEN. Previously a
  // single error returned consistent:true — silently marking the story entity-
  // verified and disabling repair for the WHOLE story. Now we retry, and on a
  // genuine failure fail CLOSED (evalFailed:true, consistent:false, no issues)
  // so it's visible and never counts as a clean pass. issues stays empty, so no
  // phantom repair is triggered.
  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType: 'image/jpeg', data: gridBuffer.toString('base64') } },
        ...(headGridBuffer ? [{ inlineData: { mimeType: 'image/jpeg', data: headGridBuffer.toString('base64') } }] : []),
      ]);
      const response = result.response;
      const text = response.text();

      // Parse JSON response — extractJsonFromText handles fenced blocks, raw
      // JSON, and balanced-brace extraction.
      const parsed = extractJsonFromText(text);
      if (!parsed) {
        log.warn(`⚠️  [ENTITY-CHECK] Failed to parse response for ${entityName} (attempt ${attempt}/${MAX_ATTEMPTS})`);
        log.debug(`[ENTITY-CHECK] Raw response: ${text.substring(0, 200)}...`);
        lastErr = new Error('unparseable evaluation response');
        if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
        break;
      }

      // Convert issues to unified format
      // Declared BEFORE first use: it is referenced by the issues filter just
      // below AND by the garment-colour split further down. Declaring it at the
      // later site put it in the temporal dead zone for this line, so every
      // entity grid that returned the new fixable_issues shape threw
      // "Cannot access before initialization", was caught, and was recorded as
      // a FAILED evaluation - consistent:false with zero issues.
      const isGarmentColour = (i) => /^garment_colou?r$/i.test(String(i && i.type || ""));
      const issues = (Array.isArray(parsed.fixable_issues)
        ? parsed.fixable_issues.filter(i => !isGarmentColour(i))
        : (parsed.issues || [])).map(issue => ({
        id: `entity_${entityName.toLowerCase().replace(/\s+/g, '_')}_${issue.pagesToFix?.[0] || 'unknown'}`,
        source: 'entity',
        pageNumber: issue.pagesToFix?.[0] || null,
        region: null,  // Will be enriched later if needed
        type: 'consistency',
        subType: issue.type,
        severity: issue.severity || 'major',
        description: issue.description,
        fixInstruction: issue.fix || issue.fixInstruction,
        affectedCharacter: entityName,
        cells: issue.cells,
        pagesToFix: issue.pagesToFix,
        canonicalVersion: issue.canonicalVersion
      }));

      // Garment colour drift is reported on its OWN channel, never merged into
      // `issues`. A garment of the right shape in the wrong colour is fixable
      // mechanically (masked L*a*b* match toward the character's canonical
      // colour), so it must not charge severity points or trip the redo gate —
      // regenerating a whole character to change a shirt's hue is the expensive
      // wrong answer, and it churns everything else in the frame.
      // Unified issue array (2026-08-08): garment colour is now type
      // "garment_colour" inside fixable_issues rather than a private channel.
      // It still routes to the mechanical fixer and still costs no score
      // (scoring.js ZERO_POINT_TYPES) - only where it travels has changed.
      // The legacy array is still read so stored evaluations keep working.
      const unified = Array.isArray(parsed.fixable_issues) ? parsed.fixable_issues : [];
      const garmentColourMismatches = [
        ...unified.filter(isGarmentColour),
        ...(parsed.garmentColourMismatches || []),
      ]
        .filter(m => m && Array.isArray(m.pagesToFix) && m.pagesToFix.length)
        .map(m => ({
          source: 'entity-garment-colour',
          affectedCharacter: entityName,
          clothingCategory: clothingCategory || null,
          garment: m.garment || 'garment',
          expectedColour: m.expectedColour || null,
          observedColour: m.observedColour || null,
          cells: m.cells || [],
          pagesToFix: m.pagesToFix,
        }));
      if (garmentColourMismatches.length) {
        log.info(`🎨 [ENTITY-CHECK] ${entityName}: ${garmentColourMismatches.length} garment-colour mismatch(es) → mechanical fix, no redraw: ` +
          garmentColourMismatches.map(m => `p${m.pagesToFix.join('/')} ${m.garment} ${m.observedColour}→${m.expectedColour}`).join(', '));
      }

      return {
        consistent: parsed.consistent ?? true,
        score: parsed.score ?? 10,
        issues,
        garmentColourMismatches,
        summary: parsed.summary || 'Evaluation complete',
        // O7: verbatim model output — was kept only on parse failure, so a
        // successful eval's raw judgment was unreconstructable afterwards.
        rawResponse: text,
        usage: response.usageMetadata
      };
    } catch (err) {
      lastErr = err;
      log.warn(`⚠️  [ENTITY-CHECK] Gemini eval error for ${entityName} (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
    }
  }

  // All attempts failed → fail CLOSED. score:10 so a failed check doesn't drag
  // worstScore down (we didn't FIND issues — we couldn't look); consistent:false
  // + evalFailed:true so it never reads as verified-good and the report shows
  // the story wasn't entity-checked.
  log.error(`❌ [ENTITY-CHECK] Entity eval failed for ${entityName} after ${MAX_ATTEMPTS} attempts: ${lastErr?.message}`);
  return {
    consistent: false,
    evalFailed: true,
    score: 10,
    issues: [],
    summary: `Evaluation failed: ${lastErr?.message || 'unknown error'}`,
    error: lastErr?.message || 'unknown'
  };
}

// Repair model (same as repairGrid.js)
// (removed: repairEntityConsistency and its REPAIR_MODEL const — confirmed zero callers in audit 2026-05-22. Use repairSinglePage instead.)

/**
 * Save entity grid to disk
 *
 * @param {Buffer} gridBuffer - Grid image buffer
 * @param {string} entityName - Entity name
 * @param {string} entityType - Entity type (character, object)
 * @param {string} outputDir - Output directory
 * @returns {Promise<string>} Path to saved grid
 */
async function saveEntityGrid(gridBuffer, entityName, entityType, outputDir) {
  try {
    // Create output directory if needed
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Sanitize entity name for filename
    const safeName = entityName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${entityType}_${safeName}_grid.jpg`;
    const filepath = path.join(outputDir, filename);

    fs.writeFileSync(filepath, gridBuffer);
    log.info(`💾 [ENTITY-CHECK] Saved grid: ${filepath}`);

    return filepath;
  } catch (err) {
    log.error(`❌ [ENTITY-CHECK] Failed to save grid: ${err.message}`);
    return null;
  }
}

/**
 * Save all entity grids to disk
 *
 * @param {Array<object>} grids - Array of grid objects from report
 * @param {string} outputDir - Output directory
 * @returns {Promise<Array<string>>} Paths to saved grids
 */
async function saveEntityGrids(grids, outputDir) {
  const paths = [];

  for (const grid of grids) {
    const buffer = await r2.bytesFromAnyImage(grid.gridImage);
    if (!buffer) continue;

    const savedPath = await saveEntityGrid(
      buffer,
      grid.entityName,
      grid.entityType,
      outputDir
    );

    if (savedPath) {
      paths.push(savedPath);
    }
  }

  return paths;
}

// Gemini's minimum recommended size for good repair results
const GEMINI_MIN_SIZE = 512;

// Gemini aspect-ratio padding lives in the shared ./geminiPad module. The two
// wrappers below bind entityConsistency's specific behavior so callers here (and
// the exported signatures) stay unchanged: pad against the PIXEL-derived ratio
// table (from Gemini's actual output dims), fill with MIRROR edge-extension,
// keep the raw (input-format) buffer, and unpad by extracting the scaled
// original region ('extract-original'). See ./geminiPad for the ratio-table
// difference vs repairGrid (pure-math table + solid fill + JPEG).

/**
 * Pad an image to a Gemini-supported aspect ratio (mirror fill, raw output).
 * @param {Buffer} imageBuffer - Image buffer
 * @returns {Promise<{buffer: Buffer, paddingInfo: object}>}
 */
async function padToGeminiRatio(imageBuffer) {
  const { buffer, paddingInfo } = await geminiPad.padToGeminiRatio(imageBuffer, {
    ratios: geminiPad.GEMINI_RATIOS_PIXELS,
    padMode: 'mirror',
    encode: null,
  });
  return { buffer, paddingInfo };
}

/**
 * Remove padding from a repaired image (extract scaled original region).
 * @param {Buffer} imageBuffer - Padded repaired image
 * @param {object} paddingInfo - Padding info from padToGeminiRatio
 * @returns {Promise<Buffer>}
 */
async function removePadding(imageBuffer, paddingInfo) {
  return geminiPad.removePadding(imageBuffer, paddingInfo, {
    strategy: 'extract-original',
    encode: null,
  });
}

/**
 * Prepare an image for Gemini repair (dynamic upscale + pad)
 * @param {Buffer} cropBuffer - Original crop buffer
 * @returns {Promise<object>} Prepared image data
 */
async function prepareForGeminiRepair(cropBuffer) {
  const meta = await sharp(cropBuffer).metadata();
  const minDim = Math.min(meta.width, meta.height);

  let buffer = cropBuffer;
  let upscaleFactor = 1;

  // Only upscale if image is too small
  if (minDim < GEMINI_MIN_SIZE) {
    upscaleFactor = Math.ceil(GEMINI_MIN_SIZE / minDim);
    buffer = await sharp(cropBuffer)
      .resize(meta.width * upscaleFactor, meta.height * upscaleFactor, {
        kernel: sharp.kernel.lanczos3
      })
      .toBuffer();
    log.debug(`[SINGLE-PAGE-REPAIR] Upscaled ${meta.width}x${meta.height} by ${upscaleFactor}x`);
  }

  // Pad to Gemini-supported aspect ratio
  const { buffer: padded, paddingInfo } = await padToGeminiRatio(buffer);

  return {
    buffer: padded,
    paddingInfo,
    upscaleFactor,
    originalWidth: meta.width,
    originalHeight: meta.height
  };
}

/**
 * Build a human-readable description of character's physical traits
 *
 * @param {object} character - Character object with physical traits
 * @returns {string} Physical traits description
 */
function buildPhysicalTraitsDescription(character) {
  const p = character.physical || {};
  const parts = [];

  // Age and gender
  if (character.age) parts.push(`${character.age} year old`);
  if (character.gender) parts.push(character.gender);

  // Hair — derived from detailedHairAnalysis + hairColor (single source of truth).
  const hairDesc = buildHairDescription(p) || p.hair;
  if (hairDesc) parts.push(`${hairDesc} hair`);

  // Eyes
  if (p.eyeColor) parts.push(`${p.eyeColor} eyes`);

  // Skin
  if (p.skinTone) {
    const skinDesc = p.skinUndertone ? `${p.skinTone} skin with ${p.skinUndertone} undertone` : `${p.skinTone} skin`;
    parts.push(skinDesc);
  }

  // Build
  if (p.build) parts.push(`${p.build} build`);

  // Face shape
  if (p.face) parts.push(`${p.face} face`);

  // Facial hair (for males)
  if (p.facialHair && p.facialHair !== 'none') parts.push(p.facialHair);

  // Other distinctive features
  if (p.other) parts.push(p.other);

  return parts.length > 0 ? parts.join(', ') : 'See reference image for physical traits';
}

/**
 * Build a clothing description for the character in this scene
 *
 * @param {object} character - Character object
 * @param {string} clothingCategory - Clothing category (standard, winter, costumed:wizard, etc.)
 * @param {string} artStyle - Art style being used
 * @returns {string} Clothing description
 */
function buildClothingDescription(character, clothingCategory, artStyle, clothingRequirements = null) {
  const avatars = character.avatars;

  // Per-story clothingRequirements is the source of truth for THIS story;
  // avatars.clothing[category] is character-level metadata that can be
  // stale across stories. Priority: signature → description → avatars.
  // Per the 2026-05-22 codebase-audit decision, avatars.clothing is kept as
  // a fallback rather than removed.
  const charReqs = resolveCharacterReqs(clothingRequirements, character?.name);
  if (!charReqs && clothingRequirements && character?.name) {
    log.error(`❌ [CLOTHING] "${character.name}" missing from clothingRequirements (keys: ${Object.keys(clothingRequirements).join(', ')}) — falling back to stored clothing, story outfit may be wrong`);
  }

  // Handle costumed clothing — bare 'costumed' (Phase 5) or legacy 'costumed:<sub>'.
  if (clothingCategory === 'costumed' || clothingCategory.startsWith('costumed:')) {
    const colonSub = clothingCategory.startsWith('costumed:') ? clothingCategory.replace('costumed:', '') : null;
    if (charReqs?.costumed?.signature && charReqs.costumed.signature !== 'none') return charReqs.costumed.signature;
    if (charReqs?.costumed?.description) return charReqs.costumed.description;
    // Nested-by-subtype legacy shape: prefer the matching key, else first entry.
    if (avatars?.costumed && typeof avatars.costumed === 'object') {
      if (colonSub && avatars.costumed[colonSub]?.clothing) return avatars.costumed[colonSub].clothing;
      const firstEntry = Object.values(avatars.costumed)[0];
      if (firstEntry?.clothing) return firstEntry.clothing;
    }
    return `${colonSub || 'costume'} as shown in reference`;
  }

  // Standard categories: per-story signature/description wins over stale avatars.clothing.
  if (charReqs?.[clothingCategory]?.signature && charReqs[clothingCategory].signature !== 'none') {
    return charReqs[clothingCategory].signature;
  }
  if (charReqs?.[clothingCategory]?.description) {
    return charReqs[clothingCategory].description;
  }
  if (avatars?.clothing?.[clothingCategory]) {
    return avatars.clothing[clothingCategory];
  }

  // Fall back to structured clothing from character definition
  const clothing = character.clothing;
  if (clothing?.structured) {
    const s = clothing.structured;
    if (s.fullBody) {
      return s.fullBody;
    }
    const parts = [];
    if (s.upperBody) parts.push(s.upperBody);
    if (s.lowerBody) parts.push(s.lowerBody);
    if (s.shoes) parts.push(s.shoes);
    if (parts.length > 0) {
      return parts.join(', ');
    }
  }

  // Fall back to legacy current clothing
  if (clothing?.current) {
    return clothing.current;
  }

  // Default based on category
  const categoryDefaults = {
    winter: 'Warm winter clothing as shown in reference',
    summer: 'Light summer clothing as shown in reference',
    formal: 'Formal attire as shown in reference',
    standard: 'Casual everyday clothing as shown in reference'
  };

  return categoryDefaults[clothingCategory] || 'Clothing as shown in reference image';
}

/**
 * Repair a single page's entity appearance
 *
 * Simplified approach: Just send styled avatar + target page
 * The avatar already shows the correct appearance in the right style/clothing.
 *
 * @param {object} storyData - Story data with sceneImages, sceneDescriptions, artStyle
 * @param {object} character - Character object with name, photoUrl, avatars
 * @param {number} pageNumber - Page number to repair
 * @param {object} options - Repair options
 * @returns {Promise<object>} Repair result
 */
async function repairSinglePage(storyData, character, pageNumber, options = {}) {
  const charName = character.name;
  const artStyle = storyData.artStyle || 'pixar';

  log.info(`🔧 [SINGLE-PAGE-REPAIR] Starting repair for ${charName} on page ${pageNumber}`);

  try {
    // Collect all appearances for this character (skip min filter - repair compares against avatar)
    const sceneImages = storyData.sceneImages || [];
    const sceneDescriptions = storyData.sceneDescriptions || [];
    const entityAppearances = await collectEntityAppearances(sceneImages, [character], sceneDescriptions, { skipMinAppearancesFilter: true });
    const appearances = entityAppearances.get(charName);

    if (!appearances || appearances.length < 1) {
      return { success: false, error: `No appearances found for ${charName}` };
    }

    // Find the specific page's appearance
    const targetAppearance = appearances.find(a => a.pageNumber === pageNumber);
    if (!targetAppearance) {
      return { success: false, error: `${charName} not found on page ${pageNumber}` };
    }

    // Extract crop for the target page only
    const [targetCrop] = await extractEntityCrops([targetAppearance], { forRegeneration: true });

    if (!targetCrop) {
      return { success: false, error: `Failed to extract crop for page ${pageNumber}` };
    }

    // Determine clothing category for target page — crop metadata first, then
    // the stored per-page clothing. NO DEFAULT (owner, 2026-08-07): the old
    // bare 'standard' made this repair repaint the story outfit into standard
    // clothes, because an unused category has no description and resolves to
    // the character's stored wardrobe from an unrelated story.
    const { resolvePageClothingCategory } = require('./clothingCategories');
    const clothingCategory = targetCrop.clothing
      ? normalizeClothingCategory(targetCrop.clothing)
      : resolvePageClothingCategory(storyData, pageNumber, charName);
    if (!clothingCategory) {
      return { success: false, error: `No clothing category for ${charName} on page ${pageNumber} (crop metadata and pageClothing both empty) — refusing to repair into a guessed outfit` };
    }
    if (!targetCrop.clothing) {
      log.warn(`⚠️ [SINGLE-PAGE-REPAIR] Page ${pageNumber} crop has no clothing metadata — resolved "${clothingCategory}" from pageClothing`);
    }
    log.info(`🔧 [SINGLE-PAGE-REPAIR] Target page ${pageNumber} has clothing: ${clothingCategory}`);

    // Get styled avatar for this clothing category
    const styledAvatar = await getStyledAvatarForClothing(character, artStyle, clothingCategory);

    if (!styledAvatar) {
      return { success: false, error: `No styled avatar found for ${charName} with ${clothingCategory} clothing` };
    }

    log.info(`🔧 [SINGLE-PAGE-REPAIR] Using styled avatar for ${clothingCategory}`);

    // Prepare avatar image — accepts data: URI, raw base64, or http(s) URL.
    const avatarBuffer = await r2.bytesFromAnyImage(styledAvatar);
    if (!avatarBuffer) {
      throw new Error('Failed to load styledAvatar bytes for repair');
    }

    // Prepare the target image for repair (dynamic upscale + pad)
    const preparedTarget = await prepareForGeminiRepair(targetCrop.buffer);

    // Build physical traits description
    const physicalTraits = buildPhysicalTraitsDescription(character);
    const hairColor = character.physical?.hairColor || 'as shown in reference';
    // Derive the hair-style slot from detailedHairAnalysis (styling + length/texture).
    const builtHair = buildHairDescription(character.physical || {}, character.physicalTraitsSource);
    const hairStyle = builtHair || 'as shown in reference';

    // Build clothing description for this scene — pass clothingRequirements
    // so the current-story signature wins over stale avatars.clothing.
    const clothingDescription = buildClothingDescription(character, clothingCategory, artStyle, storyData.clothingRequirements);

    // Format issues found for this page (if provided in options)
    let issuesFoundText = '';
    if (options.issues && options.issues.length > 0) {
      const pageIssues = options.issues.filter(issue =>
        issue.pagesToFix?.includes(pageNumber)
      );
      if (pageIssues.length > 0) {
        issuesFoundText = '\n## Issues to Fix\n\nThe consistency check found these specific problems on this page:\n';
        for (const issue of pageIssues) {
          issuesFoundText += `\n**${issue.type}** (${issue.severity}):\n`;

          // Use canonicalVersion and fixInstruction which don't have cell references
          // The description often has cell references which won't make sense here
          if (issue.canonicalVersion) {
            issuesFoundText += `- Correct appearance (match IMAGE 1): ${issue.canonicalVersion}\n`;
          }
          if (issue.fix || issue.fixInstruction) {
            // Clean up fix instructions - replace cell references with IMAGE 1
            let fix = issue.fixInstruction;
            fix = fix.replace(/cell [A-Z]/gi, 'IMAGE 1');
            fix = fix.replace(/to match cell [A-Z]/gi, 'to match IMAGE 1');
            issuesFoundText += `- Required fix: ${fix}\n`;
          }
          // Add details if available (shows what's wrong vs what's correct)
          if (issue.details) {
            if (issue.details.cellA) {
              issuesFoundText += `- What it should look like: ${issue.details.cellA}\n`;
            }
            if (issue.details.cellB) {
              issuesFoundText += `- What's wrong on this page: ${issue.details.cellB}\n`;
            }
          }
        }
        issuesFoundText += '\n';
        log.info(`🔧 [SINGLE-PAGE-REPAIR] Including ${pageIssues.length} specific issues in prompt`);
      }
    }

    log.info(`🔧 [SINGLE-PAGE-REPAIR] Physical traits: ${physicalTraits.substring(0, 100)}...`);
    log.info(`🔧 [SINGLE-PAGE-REPAIR] Clothing: ${clothingDescription}`);

    // Load the single-page repair prompt
    const promptTemplate = PROMPT_TEMPLATES.entitySinglePageRepair;
    if (!promptTemplate) {
      log.warn('⚠️  [SINGLE-PAGE-REPAIR] Using fallback prompt (entity-single-page-repair.txt not found)');
    }

    const prompt = promptTemplate
      ? promptTemplate
          .replace(/\{ENTITY_NAME\}/g, charName)
          .replace(/\{PAGE_NUMBER\}/g, pageNumber.toString())
          .replace(/\{CLOTHING_CATEGORY\}/g, clothingCategory)
          .replace(/\{PHYSICAL_TRAITS\}/g, physicalTraits)
          .replace(/\{HAIR_COLOR\}/g, hairColor)
          .replace(/\{HAIR_STYLE\}/g, hairStyle)
          .replace(/\{CLOTHING_DESCRIPTION\}/g, clothingDescription)
          .replace(/\{ISSUES_FOUND\}/g, issuesFoundText)
      : buildFallbackSinglePagePrompt(charName, pageNumber, clothingCategory, physicalTraits, clothingDescription);

    // Use Grok blended repair (same as character repair button) — blurs the character,
    // sends to Grok with avatar reference, feathered blend back onto scene.
    // This preserves scene context and avoids Gemini content blocking.
    const { repairCharacterMismatch } = require('./images');

    // Get the full page image
    const pageImage = targetCrop.originalImageData;
    if (!pageImage) {
      return { success: false, error: `No image data for page ${pageNumber}` };
    }

    // Build bbox from the target appearance. Prefer body (full figure repair)
    // and fall back to face-only. The whiteoutTarget drives the default Grok
    // mode: body → cutout (extract figure, inpaint, composite back), face →
    // blended (tight blur, feathered blend).
    const useBodyBox = !!targetAppearance.bodyBox;
    const bbox = targetAppearance.bodyBox || targetAppearance.faceBox;
    if (!bbox) {
      return { success: false, error: `No bbox found for ${charName} on page ${pageNumber}` };
    }

    // URLs pass through untouched — repairCharacterMismatchWithGrok fetches
    // them. Blind-wrapping a URL as base64 made a ~60-byte garbage reference.
    const avatarDataUri = (styledAvatar.startsWith('data:') || /^https?:\/\//i.test(styledAvatar))
      ? styledAvatar
      : `data:image/jpeg;base64,${styledAvatar}`;
    const sceneDesc = storyData.sceneDescriptions?.find(s => s.pageNumber === pageNumber)?.description || '';
    const whiteoutTarget = useBodyBox ? 'body' : 'face';

    log.info(`🔧 [SINGLE-PAGE-REPAIR] Grok repair for ${charName} on page ${pageNumber} (whiteoutTarget=${whiteoutTarget})`);

    const pageTextPosition = (storyData.sceneImages || []).find(s => s.pageNumber === pageNumber)?.textPosition || null;
    const grokResult = await repairCharacterMismatch(
      pageImage, avatarDataUri, bbox, charName, {
        imageBackend: 'grok',
        // Default mode is picked from whiteoutTarget: body → cutout, face → blended
        whiteoutTarget,
        issueDescription: issuesFoundText || '',
        clothingDescription: clothingDescription || '',
        sceneDescription: sceneDesc,
        faceBbox: targetAppearance.faceBox || null,
        textPosition: pageTextPosition,
      }
    );

    if (!grokResult?.imageData) {
      // A no-image return is a GATE decision, never a missing response: the
      // spine returns rejectedReason + gateMessage (style drift / blend-gate
      // IoU / blurred figure) and carries the rejected images with it. Reporting
      // it as "no image" sent an investigation after a Grok outage that never
      // happened. See the same fix in routes/regeneration.js.
      const why = grokResult?.gateMessage
        || (grokResult?.rejectedReason ? `rejected by the ${grokResult.rejectedReason.replace(/_/g, ' ')}` : null);
      log.warn(`🚫 [SINGLE-PAGE-REPAIR] ${charName} p${pageNumber}: ${why || 'no image and no reason reported'}`);
      return {
        success: false,
        error: why ? `Repair rejected — ${why}` : 'Grok repair returned no image (no reason reported)',
        rejectedReason: grokResult?.rejectedReason || null,
        gateMessage: grokResult?.gateMessage || null,
      };
    }

    const repairedPageData = grokResult.imageData;

    log.info(`✅ [SINGLE-PAGE-REPAIR] Page ${pageNumber} repaired for ${charName} via Grok blended`);

    return {
      success: true,
      entityName: charName,
      entityType: 'character',
      pageNumber,
      clothingCategory,
      updatedImages: [{
        pageNumber,
        imageData: repairedPageData,
        clothingCategory
      }],
      cellsRepaired: 1,
      comparison: {
        before: `data:image/jpeg;base64,${targetCrop.buffer.toString('base64')}`,
        reference: `data:image/png;base64,${avatarBuffer.toString('base64')}`
      },
      verification: { improved: true, confidence: 'high', explanation: 'Grok blended repair applied' },
      avatarUsed: `data:image/png;base64,${avatarBuffer.toString('base64')}`,
      usage: grokResult.usage || {},
      method: grokResult.method || 'grok_blended'
    };

  } catch (err) {
    log.error(`❌ [SINGLE-PAGE-REPAIR] Error repairing ${charName} page ${pageNumber}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Fallback prompt for single-page repair if template file doesn't exist
 */
function buildFallbackSinglePagePrompt(entityName, pageNumber, clothingCategory, physicalTraits, clothingDescription) {
  return `# Single Page Entity Repair

You are repairing character consistency in a children's picture book illustration.

## Input Images

**IMAGE 1 - CHARACTER REFERENCE:**
Shows the correct appearance of "${entityName}" in the art style of this book.
This is the ONLY source of truth for how the character should look.

**IMAGE 2 - PAGE TO REPAIR:**
The illustration from page ${pageNumber} where "${entityName}" needs to be fixed.

## Character Details

**Physical Traits:**
${physicalTraits || 'See reference image'}

**Clothing for this scene:**
${clothingDescription || 'As shown in reference image'}

## Your Task

Regenerate IMAGE 2 with "${entityName}" corrected to match IMAGE 1.

### MUST MATCH from IMAGE 1 (reference):
- FACE - exact facial features, eye shape, nose, mouth, face shape as shown
- HAIR - exact color, style, length, texture
- SKIN TONE - exact complexion as shown
- CLOTHING - match the outfit shown in IMAGE 1
- BODY PROPORTIONS - size, build, posture style

### PIXEL-PERFECT PRESERVATION (CRITICAL):
Everything EXCEPT "${entityName}" must be IDENTICAL to IMAGE 2:
- BACKGROUND - every single pixel of scenery, sky, ground, walls, furniture
- OTHER CHARACTERS - do not change any other person or creature
- OBJECTS - every item, prop, and detail stays exactly the same
- LIGHTING - same light direction, shadows, highlights
- COLORS - same color palette for everything except the target character
- COMPOSITION - exact same framing, no cropping, no shifting
- ART STYLE - maintain the exact illustration style

Think of it as: surgically replacing ONLY "${entityName}" while the rest of the image is a protected layer that cannot be modified.

## Output

Generate the repaired version of IMAGE 2:
- EXACT same dimensions as IMAGE 2
- EXACT same aspect ratio as IMAGE 2
- Single image (not a grid or collage)
- The ONLY difference should be "${entityName}" now matching IMAGE 1

## Quality Standards

- Sharp, clean edges on the character
- No blur, smearing, or artifacts
- Character blends naturally with preserved background
- Vibrant colors consistent with the art style`;
}

module.exports = {
  // Main functions
  runEntityConsistencyChecks,
  repairSinglePage,

  // Helper functions (exported for testing)
  detectIllustrationFaces,
  mergeCascadeFacesWithGemini,
  normalizeClothingCategory,
  groupAppearancesByClothing,
  collectEntityAppearances,
  collectObjectAppearances,
  extractEntityCrops,
  extractCropFromImage,
  createEntityGrid,
  createEntityHeadGrid,
  evaluateEntityConsistency,
  getStyledAvatarForClothing,
  saveEntityGrid,
  saveEntityGrids,
  prepareForGeminiRepair,
  padToGeminiRatio,
  removePadding,
  buildPhysicalTraitsDescription,
  buildClothingDescription,

  // Constants
  FACE_CROP_SIZE,
  BODY_CROP_SIZE,
  MIN_APPEARANCES,
  MAX_GRID_CELLS,
  GEMINI_MIN_SIZE
};

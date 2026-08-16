/**
 * Bounding-Box Detection Module
 * VB-object grounding, content-hashed bbox cache, fingerprint/pairing
 * invariants, detectAllBoundingBoxes / detectSubRegion, expected-character
 * building, overlay rendering, enrichWithBoundingBoxes.
 *
 * Extracted VERBATIM from server/lib/images.js (lines 2427-4156 at commit
 * 205b0a292) — Phase 3 of the god-file split. Deliberately a SIBLING of
 * figureDetection.js, not merged into it: this cluster lazily requires
 * ./entityConsistency (which top-level requires ./images), so folding it into
 * figureDetection would invert figureDetection's bottom-of-graph position
 * (its own header says so) and create a load-time cycle. This module requires
 * ./figureDetection one-way, preserving the DAG. images.js re-exports every
 * name exported here (facade) — consumer imports from './images' never change.
 *
 * Back-edges into images.js (callGrokVisionAPI x4, sanitizeForGemini x1,
 * GEMINI_SAFETY_SETTINGS x3, modelSupportsThinking x1) are lazy
 * `require('./images')` at the call sites — the same pattern this cluster
 * already used for ./storyHelpers and ./entityConsistency. These nine one-line
 * edits are the ONLY non-verbatim changes to the moved code.
 *
 * Binding invariants (docs/decisions.md):
 * - sourceImageFp stamping (2026-07-19): imageFingerprint, bboxPairsWith, the
 *   detectAllBoundingBoxes stamping wrapper and the enrichWithBoundingBoxes
 *   re-stamp are ONE implementation — no duplicate predicate anywhere. The
 *   unstamped _detectAllBoundingBoxesImpl is intentionally NOT exported.
 * - _gdinoMasks rides detection results NON-ENUMERABLY (2026-07-21) — never
 *   rebuild a detection with {...spread} in scaffolding around this module.
 * - One-detection-per-bytes + detectionForVersion resolution order (2026-08-09).
 *
 * NOTE: requiring this module pulls in the pipeline require graph, which opens
 * handles — standalone scripts must call process.exit() explicitly when done.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate, applyRepairStyleGuard } = require('../services/prompts');
const { MODEL_DEFAULTS, withRetry } = require('./textModels');
const { MODEL_DEFAULTS: CONFIG_DEFAULTS, TEXT_MODELS } = require('../config/models');
const { getCurrentLogger } = require('./generationLogger');
const r2Lib = require('./r2');
const { detectFiguresWithGroundingDino, attachSamMasksToFigures, _shortGarmentPhrase } = require('./figureDetection');

// bbox-refine-overlay.txt loaded exactly as images.js's LOCAL_PROMPTS did
// (STR-6 mechanism) — moved here with its only consumer, the 2-pass refine.
const LOCAL_PROMPTS_DIR = path.join(__dirname, '../../prompts');
const readPrompt = (f) => applyRepairStyleGuard(fs.readFileSync(path.join(LOCAL_PROMPTS_DIR, f), 'utf-8'));
const LOCAL_PROMPTS = {
  bboxRefineOverlay: readPrompt('bbox-refine-overlay.txt'),
};

// storyHelpers functions (lazy-loaded to avoid circular dependencies)
let storyHelpersModule = null;
function getStoryHelpers() {
  if (!storyHelpersModule) {
    storyHelpersModule = require('./storyHelpers');
  }
  return storyHelpersModule;
}

// Distinct color per figure — high contrast palette, shared between overlay drawing and prompt building
const FIGURE_COLORS = [
  { hex: '#e6194b', name: 'Red' },
  { hex: '#3cb44b', name: 'Green' },
  { hex: '#4363d8', name: 'Blue' },
  { hex: '#f58231', name: 'Orange' },
  { hex: '#911eb4', name: 'Purple' },
  { hex: '#42d4f4', name: 'Cyan' },
  { hex: '#f032e6', name: 'Magenta' },
  { hex: '#bfef45', name: 'Lime' },
  { hex: '#fabed4', name: 'Pink' },
  { hex: '#dcbeff', name: 'Lavender' },
];

/**
 * Parse Visual Bible objects from the image prompt
 * Looks for REQUIRED OBJECTS section with format:
 * * **ObjectName** (type): Description
 *
 * @param {string} prompt - The full image generation prompt
 * @returns {string[]} Array of object names found
 */
function parseVisualBibleObjects(prompt) {
  if (!prompt || typeof prompt !== 'string') return [];

  const objects = [];

  // Look for REQUIRED OBJECTS section
  const requiredSection = prompt.match(/\*\*REQUIRED OBJECTS[^*]*\*\*:?\s*([\s\S]*?)(?=\n\n|\*\*[A-Z]|$)/i);
  if (requiredSection) {
    // Match entries like: * **ObjectName** (type): Description
    const entryPattern = /\*\s*\*\*([^*]+)\*\*\s*\((\w+)\):/g;
    let match;
    while ((match = entryPattern.exec(requiredSection[1])) !== null) {
      const name = match[1].trim();
      const type = match[2].toLowerCase();
      // Only include objects and animals, not locations
      if (type !== 'location') {
        objects.push(name);
      }
    }
  }

  return objects;
}

/**
 * Translate Visual-Bible entity IDs (e.g. "ART003", "CHR001", "LOC001.2") into
 * their natural-language names from the visualBible. Entries that don't look
 * like IDs pass through unchanged. Without this step, `expectedObjects` passed
 * to the bbox detector contain opaque IDs — the detector has nothing visual to
 * match against, reports `found:false`, and downstream entity-check generates
 * fake appearance records with null bboxes.
 *
 * @param {string[]} entries - Mix of VB IDs and plain names (order preserved)
 * @param {Object|null} visualBible - Story visual bible
 * @returns {string[]} Array of names, deduplicated case-insensitively
 */
function resolveExpectedObjectLabels(entries, visualBible) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const vb = visualBible || {};
  const byId = new Map();
  const addPool = (list) => {
    for (const e of (list || [])) {
      if (e && e.id && e.name) byId.set(String(e.id).toUpperCase(), e.name);
    }
  };
  addPool(vb.artifacts);
  addPool(vb.animals);
  addPool(vb.vehicles);
  addPool(vb.secondaryCharacters);
  // Locations are skipped downstream in parseVisualBibleObjects, but LOC IDs
  // still appear in scene metadata objects[] — translate them too so the
  // detector doesn't see "LOC001".
  addPool(vb.locations);

  const seen = new Set();
  const out = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'string') continue;
    const cleaned = raw.trim();
    if (!cleaned) continue;
    // VB ID pattern: three uppercase letters + three digits, optional .N variant
    const idMatch = cleaned.match(/^([A-Z]{3}\d{3})(?:\.\d+)?$/);
    let name = cleaned;
    if (idMatch) {
      const vbName = byId.get(idMatch[1]);
      if (vbName) {
        name = vbName;
      } else {
        // Unknown ID — skip rather than send opaque token to the detector
        continue;
      }
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Per-label grounding hints for the GroundingDINO object pass. VB names are
 * story-language (often German), which DINO's English text encoder grounds
 * poorly — German labels latch onto salient figures instead of the prop. The
 * VB descriptions are English, so DINO grounds on those. Locations are marked
 * so the object pass can skip them (a location IS the scene — grounding it
 * yields a useless whole-frame or random box).
 *
 * @returns {Object} label(lowercase) → { text: english description, kind }
 */
function buildObjectGroundingHints(entries, visualBible) {
  const vb = visualBible || {};
  const byName = new Map();
  const addPool = (list, kind) => {
    for (const e of (list || [])) {
      if (e && e.name) byName.set(String(e.name).toLowerCase(), { text: String(e.description || ''), kind });
    }
  };
  addPool(vb.artifacts, 'artifact');
  addPool(vb.animals, 'animal');
  addPool(vb.vehicles, 'vehicle');
  addPool(vb.secondaryCharacters, 'secondary');
  addPool(vb.locations, 'location');
  const hints = {};
  for (const label of (entries || [])) {
    const h = byName.get(String(label).toLowerCase());
    if (h) hints[String(label).toLowerCase()] = h;
  }
  return hints;
}

// Content-hashed bbox cache. Without this, the eval + entity-consistency
// passes each detect bboxes for the same regenerated image — burning a
// Gemini call per redundant pair (~$0.30-0.60/story across a 3-pass repair).
// Cache key is sha256 of image bytes + expected-character names (since the
// model uses that list to identify figures; different expectations would
// yield different `name` fields on figures even on identical pixels).
// Entries expire after BBOX_CACHE_TTL_MS and an LRU-ish eviction caps memory.
// (crypto is required at the top of this module — reused here.)
const _bboxCache = new Map(); // key -> { result, ts }
const BBOX_CACHE_TTL_MS = 30 * 60 * 1000;
const BBOX_CACHE_MAX_ENTRIES = 500;
const _bboxCacheStats = { hits: 0, misses: 0 };

function _hashBboxKey(imageData, expectedCharacters, expectedObjects) {
  if (!imageData) return null;
  const b64 = typeof imageData === 'string' && imageData.includes(',')
    ? imageData.split(',', 2)[1]
    : imageData;
  if (typeof b64 !== 'string') return null;
  const h = crypto.createHash('sha256');
  h.update(b64);
  // Names only — descriptions/positions don't affect detection identity.
  h.update('|chars:' + (expectedCharacters || []).map(c => (c.name || c)).sort().join(','));
  h.update('|objs:' + (expectedObjects || []).slice().sort().join(','));
  return h.digest('hex').slice(0, 32);
}

function _bboxCacheGet(key) {
  if (!key) return null;
  const entry = _bboxCache.get(key);
  if (!entry) { _bboxCacheStats.misses++; return null; }
  if (Date.now() - entry.ts > BBOX_CACHE_TTL_MS) {
    _bboxCache.delete(key);
    _bboxCacheStats.misses++;
    return null;
  }
  _bboxCacheStats.hits++;
  return entry.result;
}

function _bboxCacheSet(key, result) {
  if (!key || !result) return;
  if (_bboxCache.size >= BBOX_CACHE_MAX_ENTRIES) {
    // Drop oldest insertion (Map preserves insertion order).
    const oldest = _bboxCache.keys().next().value;
    if (oldest) _bboxCache.delete(oldest);
  }
  _bboxCache.set(key, { result, ts: Date.now() });
}

function getBboxCacheStats() {
  return { ..._bboxCacheStats, size: _bboxCache.size };
}


/**
 * Detect bounding boxes for a specific issue using Gemini's native detection
 * This is stage 2 of the two-stage detection approach:
 * Stage 1: Quality evaluation identifies issues (no bboxes needed)
 * Stage 2: This function detects ALL figures, faces, and objects in one call
 *
 * @param {string} imageData - Base64 image data
 * @param {Object} options - Detection options
 * @param {Array<{name: string, description: string, position: string}>} options.expectedCharacters - Characters to identify
 * @param {string[]} options.expectedObjects - Objects to check for
 * @param {boolean} [options.skipCache] - Bypass the bbox cache (force fresh detection)
 * @returns {Promise<{figures: Array, objects: Array, usage: Object}|null>}
 */
/**
 * Fingerprint of the exact image bytes a detection was computed on.
 * Detections are only meaningful for the bytes they ran on — a box from
 * version A applied to the pixels of version B silently crops/repairs the
 * wrong region. Every detectAllBoundingBoxes result is stamped with
 * `sourceImageFp`; consumers verify via bboxPairsWith() before reusing a
 * stored detection and fall back to fresh detection on mismatch.
 */
function imageFingerprint(imageData) {
  if (!imageData || typeof imageData !== 'string') return null;
  return require('crypto').createHash('sha1').update(imageData).digest('hex').slice(0, 16);
}

/**
 * COVER-TEXT RESTAMP EXCEPTION — the ONLY sanctioned mutation of a
 * detection's sourceImageFp to different bytes (owner decision 2026-08-15).
 * Cover typography (composeCover / restampCover / restampServedCover)
 * overlays title, dedication and branding text on the art; no figure moves,
 * so the boxes stay geometrically valid for the stamped bytes. Without this
 * re-point, every stamped cover fails bboxPairsWith and character repair
 * falls back to fresh detection on covers whose boxes we already have.
 * NEVER call this after anything that can change figure geometry — crop,
 * repaint, regenerate, aspect change — those need a fresh detection.
 */
function restampDetectionForCoverText(detection, stampedImageData) {
  if (!detection || !stampedImageData) return detection;
  const fp = imageFingerprint(stampedImageData);
  if (fp) detection.sourceImageFp = fp;
  return detection;
}

/**
 * True when a stored detection may be paired with these image bytes.
 * Legacy detections (no sourceImageFp stamp) are trusted — they predate the
 * invariant and are usually stored alongside the bytes they ran on.
 */
function bboxPairsWith(detection, imageData) {
  if (!detection) return false;
  if (!detection.sourceImageFp) return true;
  const fp = imageFingerprint(imageData);
  return !fp || detection.sourceImageFp === fp;
}

/**
 * Detection stored on an image VERSION (owner decision 2026-07-31:
 * "detection is part of every image version" — covers AND pages, exactly
 * like grokRefImages are stored per version). Single resolution rule used
 * by every version-entry writer:
 *   1. v.bboxDetection — a detection stamped directly on the version
 *      (e.g. the final-assembly fresh-bbox refresh, regen/iterate results)
 *      always wins: it was computed on this version's own bytes.
 *   2. v.evaluation.bboxDetection — the eval-time detection attached when
 *      the version was scored.
 *   3. null — version never had a detection (the dev endpoint's refresh
 *      button re-detects on demand).
 */
function detectionForVersion(v) {
  return v?.bboxDetection || v?.evaluation?.bboxDetection || null;
}

// Public entry — stamps every result with the fingerprint of the bytes it was
// computed on (see imageFingerprint above). Cache hits keep the stamp from
// when they were computed; the cache key already includes the image hash, so
// a hit is always for the same bytes.
async function detectAllBoundingBoxes(imageData, options = {}) {
  const result = await _detectAllBoundingBoxesImpl(imageData, options);
  if (result && !result.sourceImageFp) result.sourceImageFp = imageFingerprint(imageData);
  return result;
}

async function _detectAllBoundingBoxesImpl(imageData, options = {}) {
  const { expectedCharacters = [], expectedObjects = [], sceneContext = null, bboxModelOverride = null, pageContext = '', skipCache = false, artStyle = null, objectGroundingHints = null } = options;
  const pageLabel = pageContext ? `[${pageContext}] ` : '';

  // Cache check — content-hashed by image bytes + expected names. Hits skip
  // the full Gemini round-trip; misses fall through to the API and populate.
  const cacheKey = _hashBboxKey(imageData, expectedCharacters, expectedObjects);
  if (!skipCache && cacheKey) {
    const cached = _bboxCacheGet(cacheKey);
    if (cached) {
      log.debug(`♻️ [BBOX-CACHE] ${pageLabel}hit (${cached.figures?.length || 0} figures)`);
      return cached;
    }
  }

  // Alternative detection backend: local Grounded-SAM (GroundingDINO → MobileSAM).
  // Figure detection only — object detection stays with Gemini, so this path is
  // used when there are expected characters (the common repair / figure case);
  // it emits no objects (missingObjects empty → no false "missing object" flags).
  // Gated to styles that render a recognisable clothed human figure (see
  // MODEL_DEFAULTS.figureDetectionEligibleStyles). With the concise
  // buildGroundingPrompt, GDINO grounds on figure shape + clothing colour and
  // works across the range (realistic 0.69, anime 0.59, watercolor 0.63,
  // 2026-07-15). Only super-deformed/abstract styles (chibi, pixel, lowpoly)
  // stay on Gemini. Fails open: any null/error → Gemini below.
  let gdinoDiag = null;  // persisted with whichever backend produces the result
  // Undercounted-but-complete DINO result awaiting the Gemini second opinion
  // (owner, 2026-08-09): fewer persons than expected either means the painter
  // painted fewer (DINO right → keep its boxes+masks) or DINO merged two
  // overlapping figures (Gemini finds more → its boxes win, SAM-masked below).
  let dinoUndercountResult = null;
  const eligibleStyles = CONFIG_DEFAULTS.figureDetectionEligibleStyles || ['realistic'];
  const gdinoEligible = CONFIG_DEFAULTS.figureDetectionBackend === 'grounding-dino'
    && !!artStyle && eligibleStyles.includes(String(artStyle).toLowerCase());
  if (gdinoEligible && expectedCharacters.length > 0) {
    try {
      const gd = await detectFiguresWithGroundingDino(imageData, expectedCharacters, {
        pageLabel, expectedObjects, objectGroundingHints,
        // Lab knobs — see figureDetection Stage 3 / badge anchor.
        badgeAnchor: options.badgeAnchor,
      });
      gdinoDiag = gd?.diag || null;
      if (gd && Array.isArray(gd.figures) && gd.figures.length > 0) {
        // No Haar cascade merge here — faceBoxes come from DINO "face" boxes
        // (cleaner: no phantom faces, found background faces Haar missed).
        const foundObjects = (gd.objects || []).filter(o => o.found).map(o => o.name);
        const result = {
          figures: gd.figures,
          objects: gd.objects || [],
          expectedCharacters,
          expectedObjects,
          foundObjects,
          // Deliberately empty: a DINO miss is not evidence of absence, so it
          // must not raise missing-object flags (docs/decisions.md).
          missingObjects: [],
          unknownFigures: gd.figures.filter(f => f.name === 'UNKNOWN').length,
          usage: { input_tokens: 0, output_tokens: 0 },
          rawPrompt: 'grounding-dino',
          rawResponse: null,
          refinementResponse: null,
          detectionBackend: 'grounding-dino',
          gdinoDiag: gd.diag || null,
        };
        // Per-figure mask PNGs ride along non-enumerably: the overlay renderer
        // uses them for the cutout strip, JSON persistence (stories.data JSONB)
        // and the raw API response never see them.
        Object.defineProperty(result, '_gdinoMasks', { value: gd.masks || [], enumerable: false });
        if (gd.diag?.undercount) {
          // Don't trust-or-discard yet — stash and fall through to the Gemini
          // detection below, which acts as the second opinion. Not cached: the
          // cache stores only the arbitrated final answer.
          dinoUndercountResult = result;
          log.info(`🦖 [BBOX-DETECT] ${pageLabel}GroundingDINO undercount (${gd.diag.undercount}) — asking Gemini for a second opinion`);
        } else {
          if (!skipCache && cacheKey) _bboxCacheSet(cacheKey, result);
          log.info(`🦖 [BBOX-DETECT] ${pageLabel}GroundingDINO backend (${gd.figures.length} figures, ${foundObjects.length} objects)`);
          return result;
        }
      }
      if (!dinoUndercountResult) {
        log.warn(`⚠️ [BBOX-DETECT] ${pageLabel}GroundingDINO backend returned nothing — falling back to Gemini`);
        getCurrentLogger()?.warn?.('detection_fallback', `${pageLabel}figure detection fell back to Gemini — GroundingDINO returned nothing (analyzer cold/unhealthy?)`, null, { pageLabel, reason: gdinoDiag?.reason || 'no figures' });
      }
    } catch (gdErr) {
      log.warn(`⚠️ [BBOX-DETECT] ${pageLabel}GroundingDINO backend error (${gdErr.message}) — falling back to Gemini`);
      getCurrentLogger()?.warn?.('detection_fallback', `${pageLabel}figure detection fell back to Gemini — GroundingDINO ERROR: ${gdErr.message} (analyzer down/unhealthy?)`, null, { pageLabel, error: gdErr.message });
    }
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      log.warn('⚠️  [BBOX-DETECT] Gemini API key not configured');
      return dinoUndercountResult || null;
    }

    // Load prompt template
    if (!PROMPT_TEMPLATES.boundingBoxDetection) {
      log.warn('⚠️  [BBOX-DETECT] Bounding box detection prompt template not loaded');
      return dinoUndercountResult || null;
    }

    // Build dynamic prompt with expected characters and objects
    let prompt = PROMPT_TEMPLATES.boundingBoxDetection;

    // Inject expected characters section
    if (expectedCharacters.length > 0) {
      const charSection = `EXPECTED CHARACTERS (identify by name if found):\n` +
        expectedCharacters.map((c, i) =>
          `${i + 1}. ${c.name} - ${c.description}${c.position ? `\n   Expected position: ${c.position}` : ''}`
        ).join('\n');
      prompt = prompt.replace('{{EXPECTED_CHARACTERS}}', charSection);
    } else {
      prompt = prompt.replace('{{EXPECTED_CHARACTERS}}', '(No expected characters provided - detect all figures as UNKNOWN)');
    }

    // Inject expected objects section
    if (expectedObjects.length > 0) {
      const objSection = `EXPECTED OBJECTS (check if present):\n` +
        expectedObjects.map(o => `- ${o}`).join('\n');
      prompt = prompt.replace('{{EXPECTED_OBJECTS}}', objSection);
    } else {
      prompt = prompt.replace('{{EXPECTED_OBJECTS}}', '(No expected objects provided)');
    }

    // Inject scene context (helps distinguish characters by position and action)
    if (sceneContext) {
      prompt = prompt.replace('{{SCENE_CONTEXT}}', `SCENE DESCRIPTION (use to identify characters by position and action):\n${sceneContext}`);
    } else {
      prompt = prompt.replace('{{SCENE_CONTEXT}}', '');
    }

    // Extract base64 and mime type
    const base64Data = r2Lib.stripDataUriPrefix(imageData);
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    const parts = [
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      },
      { text: prompt }
    ];

    // Bbox needs spatial precision — use dedicated bbox model
    const modelId = bboxModelOverride || MODEL_DEFAULTS.bboxDetection || 'gemini-2.5-flash';
    const modelConfig = TEXT_MODELS[modelId];

    // Route based on provider
    let data;
    let inputTokens = 0;
    let outputTokens = 0;
    if (modelConfig?.provider === 'anthropic') {
      // Claude vision path — uses callTextModel with images option
      log.info(`🔲 [BBOX-DETECT] ${pageLabel}Using Claude vision: ${modelId}`);
      const { callTextModel } = require('./textModels');
      const imageDataUri = `data:${mimeType};base64,${base64Data}`;
      const claudeResult = await callTextModel(prompt, 16000, modelId, { images: [imageDataUri], usageLabel: 'bbox_detect' });
      if (!claudeResult?.text) {
        log.warn('⚠️  [BBOX-DETECT] Claude returned no text response');
        return dinoUndercountResult || null;
      }
      // Wrap in Gemini-compatible format for downstream parsing
      data = {
        candidates: [{ content: { parts: [{ text: claudeResult.text }] } }],
        usageMetadata: { promptTokenCount: claudeResult.usage?.input_tokens || 0, candidatesTokenCount: claudeResult.usage?.output_tokens || 0 }
      };
      inputTokens = claudeResult.usage?.input_tokens || 0;
      outputTokens = claudeResult.usage?.output_tokens || 0;
    } else if (modelConfig?.provider === 'xai') {
      log.info(`🔲 [BBOX-DETECT] ${pageLabel}Using Grok vision: ${modelId}`);
      const { callGrokVisionAPI } = require('./images'); // lazy back-edge into images.js (see module header)
      const grokResponse = await callGrokVisionAPI(modelId, modelConfig.modelId || modelId, parts, prompt);
      data = await grokResponse.json();
      if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        log.warn('⚠️  [BBOX-DETECT] Grok returned no text response');
        return dinoUndercountResult || null;
      }
      inputTokens = data.usageMetadata?.promptTokenCount || data.usage?.prompt_tokens || 0;
      outputTokens = data.usageMetadata?.candidatesTokenCount || data.usage?.completion_tokens || 0;
    } else {
      // Gemini path — retry once on empty response (0 output tokens)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
      for (let bboxAttempt = 1; bboxAttempt <= 2; bboxAttempt++) {
        const response = await withRetry(async () => {
          return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: {
                // A clean bbox response for 5 figures + 5 objects is ~600
                // tokens. When Gemini 2.5-flash-lite hits 15k+ it's stuck in
                // a repetition loop inside a verbose label, not producing
                // more figures. A tighter cap (2500) fails fast on repetition
                // loops so the Grok fallback kicks in quickly. The real fix
                // is the ≤10-word label cap in the prompt — this cap is the
                // pressure valve if the prompt rule doesn't hold.
                maxOutputTokens: 2500,
                temperature: 0.5,  // Google recommends >0 for bbox to prevent repetition loops
                responseMimeType: 'application/json',
                // Disable thinking unconditionally — Google's image-understanding docs
                // explicitly recommend thinkingBudget=0 for object detection (thinking
                // adds latency without improving spatial accuracy). Without this,
                // gemini-2.5-flash burns ~3-4k thinking tokens before output and trips
                // MAX_TOKENS before producing the JSON. The previous gate
                // `modelSupportsThinking(modelId)` checks IMAGE_MODELS, but gemini-2.5-flash
                // is a TEXT_MODELS entry — the gate was always false for bbox detection.
                // The field is silently ignored on non-thinking models.
                thinkingConfig: { thinkingBudget: 0 },
              },
              safetySettings: require('./images').GEMINI_SAFETY_SETTINGS // lazy back-edge into images.js (see module header)
            })
          });
        }, { maxRetries: 2, baseDelay: 1000 });

        if (!response.ok) {
          const error = await response.text();
          const errorOneLine = error.replace(/[\n\r]+/g, ' ').replace(/\s{2,}/g, ' ').substring(0, 200);
          log.warn(`⚠️ [BBOX-DETECT] API error ${response.status} (${modelId}): ${errorOneLine}`);
          // Try Grok fallback on API error
          const grokFallbackId = (bboxModelOverride && TEXT_MODELS[bboxModelOverride]?.provider === 'xai') ? bboxModelOverride : 'grok-4-fast';
          const grokModel = TEXT_MODELS[grokFallbackId];
          if (grokModel?.provider === 'xai') {
            log.info(`🔄 [BBOX-DETECT] Gemini API error, falling back to Grok vision (${grokFallbackId})...`);
            try {
              const { callGrokVisionAPI } = require('./images'); // lazy back-edge into images.js (see module header)
              const grokResp = await callGrokVisionAPI(grokFallbackId, grokModel.modelId || grokFallbackId, parts, prompt);
              data = await grokResp.json();
              if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                inputTokens = data.usage?.prompt_tokens || 0;
                outputTokens = data.usage?.completion_tokens || 0;
                log.info(`✅ [BBOX-DETECT] Grok fallback succeeded after API error`);
                break;
              }
            } catch (grokErr) {
              log.warn(`⚠️  [BBOX-DETECT] Grok fallback also failed: ${grokErr.message}`);
            }
          }
          return dinoUndercountResult || null;
        }

        data = await response.json();

        inputTokens = data.usageMetadata?.promptTokenCount || 0;
        outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
        log.debug(`📊 [BBOX-DETECT] Token usage - input: ${inputTokens}, output: ${outputTokens}${bboxAttempt > 1 ? ` (retry ${bboxAttempt})` : ''}`);

        const finishReason = data.candidates?.[0]?.finishReason;
        if (finishReason && finishReason !== 'STOP') {
          log.warn(`⚠️  [BBOX-DETECT] Finish reason: ${finishReason}`);
        }

        if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
          break; // Got content
        }

        // Log full response structure for debugging empty responses
        const candidateCount = data.candidates?.length || 0;
        const promptBlockReason = data.promptFeedback?.blockReason || null;
        const promptSafety = data.promptFeedback?.safetyRatings?.map(r => `${r.category}:${r.probability}${r.blocked ? '(BLOCKED)' : ''}`).join(', ') || 'none';
        const candBlockReason = data.candidates?.[0]?.blockReason || null;
        const candSafety = data.candidates?.[0]?.safetyRatings?.map(r => `${r.category}:${r.probability}${r.blocked ? '(BLOCKED)' : ''}`).join(', ') || 'none';
        const blockReason = promptBlockReason || candBlockReason;
        log.warn(`⚠️  [BBOX-DETECT] ${pageLabel}Empty response: candidates=${candidateCount}, finishReason=${finishReason || 'none'}, blockReason=${blockReason || 'none'}, model=${modelId}`);
        log.warn(`⚠️  [BBOX-DETECT] ${pageLabel}Safety details: prompt=[${promptSafety}], candidate=[${candSafety}]`);

        // PROHIBITED_CONTENT is most often triggered by prompt TEXT (German
        // story vocabulary like "stumble", "fall into water", combined with
        // child references), not the image. Sanitize the text portion of the
        // prompt and retry — same approach SEMANTIC eval uses. Only fall
        // through to Grok if sanitization-retry also fails.
        if (blockReason === 'PROHIBITED_CONTENT' && bboxAttempt < 2) {
          const { sanitizeForGemini } = require('./images'); // lazy back-edge into images.js (see module header)
          const sanitized = sanitizeForGemini(prompt, 'full');
          if (sanitized !== prompt) {
            log.warn(`⚠️  [BBOX-DETECT] ${pageLabel}Blocked (PROHIBITED_CONTENT), retrying with full text sanitization...`);
            parts[parts.length - 1] = { text: sanitized };
            prompt = sanitized;
            continue;
          }
          // Sanitization produced no change — go to Grok fallback below.
          log.warn(`⚠️  [BBOX-DETECT] ${pageLabel}PROHIBITED_CONTENT and sanitization is no-op, routing to Grok fallback`);
        }

        if (bboxAttempt < 2 && blockReason !== 'PROHIBITED_CONTENT') {
          log.warn(`⚠️  [BBOX-DETECT] ${pageLabel}Empty response (0 output tokens), retrying in 2s...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          // Gemini failed — try Grok vision as fallback
          const grokFallbackId2 = (bboxModelOverride && TEXT_MODELS[bboxModelOverride]?.provider === 'xai') ? bboxModelOverride : 'grok-4-fast';
          const grokFallbackModel = TEXT_MODELS[grokFallbackId2];
          if (grokFallbackModel?.provider === 'xai') {
            log.info(`🔄 [BBOX-DETECT] Gemini failed, falling back to Grok vision (${grokFallbackId2})...`);
            try {
              const { callGrokVisionAPI } = require('./images'); // lazy back-edge into images.js (see module header)
              const grokResponse = await callGrokVisionAPI(grokFallbackId2, grokFallbackModel.modelId || grokFallbackId2, parts, prompt);
              data = await grokResponse.json();
              if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                inputTokens = data.usageMetadata?.promptTokenCount || data.usage?.prompt_tokens || 0;
                outputTokens = data.usageMetadata?.candidatesTokenCount || data.usage?.completion_tokens || 0;
                log.info(`✅ [BBOX-DETECT] Grok fallback succeeded (${outputTokens} output tokens)`);
                break; // Got content from Grok
              }
              log.warn('⚠️  [BBOX-DETECT] Grok fallback also returned no text');
            } catch (grokErr) {
              log.warn(`⚠️  [BBOX-DETECT] Grok fallback failed: ${grokErr.message}`);
            }
          }
          log.warn('🔄 [FALLBACK] No response for bbox detection after retry');
          return dinoUndercountResult || null;
        }
      }
    }

    // Guard: if all attempts failed (e.g., PROHIBITED_CONTENT block), data has no candidates
    if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      log.warn('🔄 [FALLBACK] Detection failed, no bounding boxes available');
      return dinoUndercountResult || null;
    }

    const responseText = data.candidates[0].content.parts[0].text.trim();

    // Parse JSON response
    let parsedResult;
    try {
      parsedResult = getStoryHelpers().extractJsonFromText(responseText);
    } catch (e) {
      log.warn(`⚠️  [BBOX-DETECT] Failed to parse response: ${e.message}`);
      log.debug(`⚠️  [BBOX-DETECT] Raw response (first 1000 chars): ${responseText.substring(0, 1000)}`);

      // Attempt to repair truncated JSON (e.g. from MAX_TOKENS finish reason)
      try {
        const jsonStart = responseText.match(/\{[\s\S]*/);
        if (jsonStart) {
          let truncated = jsonStart[0];

          // Strategy: Find last complete object in array and truncate there
          // Look for pattern like: }, or }] that marks end of complete object
          const lastCompleteObject = truncated.lastIndexOf('},');
          const lastArrayEnd = truncated.lastIndexOf('}]');
          const cutPoint = Math.max(lastCompleteObject, lastArrayEnd);

          if (cutPoint > 0 && cutPoint < truncated.length - 5) {
            // Cut at the last complete structure
            truncated = truncated.substring(0, cutPoint + 1);
          } else {
            // Fallback: remove incomplete trailing data
            truncated = truncated.replace(/,(\s*)$/, '$1');
            // Remove incomplete arrays like [10, 20, or [10, 20, 30
            truncated = truncated.replace(/\[\s*[\d\s,]*$/, '');
            // Remove incomplete key-value pairs
            truncated = truncated.replace(/,?\s*"[^"]*":\s*("(?:[^"\\]|\\.)*)?$/, '');
            truncated = truncated.replace(/,?\s*"[^"]*":\s*\[?\s*$/, '');
            truncated = truncated.replace(/,?\s*"[^"]*"\s*$/, '');
          }

          // Count open brackets/braces and close them
          const openBraces = (truncated.match(/\{/g) || []).length - (truncated.match(/\}/g) || []).length;
          const openBrackets = (truncated.match(/\[/g) || []).length - (truncated.match(/\]/g) || []).length;
          // Remove any trailing comma before we close
          truncated = truncated.replace(/,\s*$/, '');
          // Close in correct order: inner brackets first, then braces
          truncated += ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));
          parsedResult = JSON.parse(truncated);
          // Re-read from `data` — the `finishReason` const lives inside the
          // retry loop above and is out of scope here. Referencing it threw a
          // ReferenceError that the enclosing `catch (repairError)` swallowed,
          // so a SUCCESSFULLY repaired JSON was reported as "repair failed"
          // and thrown away.
          log.info(`🔧 [BBOX-DETECT] Repaired truncated JSON (finishReason: ${data?.candidates?.[0]?.finishReason || 'STOP'})`);
        }
      } catch (repairError) {
        log.warn(`⚠️  [BBOX-DETECT] JSON repair failed: ${repairError.message}`);

        // Last resort: try to extract complete figure objects using regex
        try {
          const figurePattern = /\{\s*"label"\s*:\s*"([^"]+)"\s*,\s*"position"\s*:\s*"([^"]+)"\s*,\s*"face_box"\s*:\s*\[(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\]\s*,\s*"body_box"\s*:\s*\[(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\]\s*\}/g;
          const extractedFigures = [];
          let match;
          while ((match = figurePattern.exec(responseText)) !== null) {
            extractedFigures.push({
              label: match[1],
              position: match[2],
              face_box: [parseInt(match[3]), parseInt(match[4]), parseInt(match[5]), parseInt(match[6])],
              body_box: [parseInt(match[7]), parseInt(match[8]), parseInt(match[9]), parseInt(match[10])]
            });
          }
          if (extractedFigures.length > 0) {
            parsedResult = { figures: extractedFigures, objects: [] };
            log.info(`🔧 [BBOX-DETECT] Extracted ${extractedFigures.length} figures via regex fallback`);
          }
        } catch (regexError) {
          log.warn(`⚠️  [BBOX-DETECT] Regex extraction also failed: ${regexError.message}`);
        }

        if (!parsedResult) {
          return dinoUndercountResult || null;
        }
      }
    }

    if (!parsedResult) {
      // Dump the full response (head + tail + total length) so we can see
      // whether the model truncated inside a long label, hit a repetition
      // loop, or produced something entirely different from JSON.
      const total = responseText.length;
      const head = responseText.slice(0, 400);
      const tail = total > 800 ? responseText.slice(-400) : '';
      log.warn(`⚠️  [BBOX-DETECT] No JSON found in response (${total} chars). HEAD: ${head}${tail ? `\n...TAIL: ${tail}` : ''}`);
      return dinoUndercountResult || null;
    }

    // Normalize coordinates from 0-1000 to 0.0-1.0
    const normalizeBox = (box) => {
      if (!box || !Array.isArray(box) || box.length !== 4) return null;
      const [ymin, xmin, ymax, xmax] = box;
      // Handle both 0-1000 format (Gemini native) and 0-1 format (already normalized)
      const scale = (ymax > 1 || xmax > 1) ? 1000 : 1;
      return [
        Math.max(0, Math.min(1, ymin / scale)),
        Math.max(0, Math.min(1, xmin / scale)),
        Math.max(0, Math.min(1, ymax / scale)),
        Math.max(0, Math.min(1, xmax / scale))
      ];
    };

    // Normalize all figures (now includes name and confidence from AI identification)
    const figures = (parsedResult.figures || []).map(fig => ({
      name: fig.name || 'UNKNOWN',  // Character name or "UNKNOWN"
      label: fig.label,
      position: fig.position,
      faceBox: normalizeBox(fig.face_box),
      bodyBox: normalizeBox(fig.body_box),
      confidence: fig.confidence || 'low'  // "high", "medium", "low"
    }));

    // Normalize all objects (now includes found status and expected name)
    const objects = (parsedResult.objects || []).map(obj => ({
      name: obj.name,  // Expected object name (from input)
      found: obj.found !== false,  // Default true for backward compatibility
      label: obj.label,
      position: obj.position,
      bodyBox: normalizeBox(obj.body_box)
    }));

    // Log character identifications (pass 1)
    const identifiedChars = figures.filter(f => f.name !== 'UNKNOWN');
    const unknownFiguresPass1 = figures.filter(f => f.name === 'UNKNOWN');
    if (identifiedChars.length > 0) {
      log.info(`📦 [BBOX-DETECT] Pass 1: Identified ${identifiedChars.length} characters: ${identifiedChars.map(f => `${f.name} (${f.confidence})`).join(', ')}`);
    }
    if (unknownFiguresPass1.length > 0) {
      log.info(`📦 [BBOX-DETECT] Pass 1: ${unknownFiguresPass1.length} UNKNOWN figures: ${unknownFiguresPass1.map(f => f.label).join(', ')}`);
    }
    log.info(`📦 [BBOX-DETECT] Pass 1: ${figures.length} figures, ${objects.length} objects`);

    // ── Pass 2: Refinement — send pass-1 boxes back for verification/correction ──
    // Skip refinement if explicitly disabled or if using Grok (different API format)
    let finalFigures = figures;
    let finalObjects = objects;
    let refinementResponse = null;
    let totalInputTokens = inputTokens;
    let totalOutputTokens = outputTokens;

    // Only refine if we have identified main characters (skip UNKNOWN-only results)
    const mainCharacters = figures.filter(f => f.name && f.name !== 'UNKNOWN');
    if (options.skipRefinement !== true && mainCharacters.length > 0) {
      try {
        // Generate overlay image from pass 1 so the model can see its own drawn boxes
        const pass1Result = { figures, objects, expectedCharacters, expectedObjects };
        const overlayDataUri = await createBboxOverlayImage(imageData, pass1Result);

        if (overlayDataUri) {
          const overlayBase64 = r2Lib.stripDataUriPrefix(overlayDataUri);
          const overlayMime = overlayDataUri.match(/^data:(image\/\w+);base64,/)
            ? overlayDataUri.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

          // Same focused prompt as the manual "Bbox verfeinern" button (iterate-bbox endpoint)
          const figuresSummary = mainCharacters.map((f, i) => {
            const fb = f.faceBox ? `face:[${f.faceBox.map(v => Math.round(v * 1000)).join(',')}]` : 'no face';
            const bb = f.bodyBox ? `body:[${f.bodyBox.map(v => Math.round(v * 1000)).join(',')}]` : 'no body';
            return `  ${i + 1}. "${f.name}" (${f.confidence}) — ${fb}, ${bb}`;
          }).join('\n');

          const refinePrompt = fillTemplate(LOCAL_PROMPTS.bboxRefineOverlay, {
            FIGURES_SUMMARY: figuresSummary,
          });

          const refineModelId = bboxModelOverride || MODEL_DEFAULTS.bboxDetection || 'gemini-2.5-flash';
          const refineModelConfig = TEXT_MODELS[refineModelId];
          let refineData;

          if (refineModelConfig?.provider === 'xai') {
            const refineParts = [
              { inline_data: { mime_type: overlayMime, data: overlayBase64 } },
              { text: refinePrompt }
            ];
            const { callGrokVisionAPI } = require('./images'); // lazy back-edge into images.js (see module header)
            const grokResp = await callGrokVisionAPI(refineModelId, refineModelConfig.modelId || refineModelId, refineParts, refinePrompt);
            refineData = await grokResp.json();
          } else {
            const refineUrl = `https://generativelanguage.googleapis.com/v1beta/models/${refineModelId}:generateContent?key=${apiKey}`;
            const refineResp = await withRetry(async () => {
              return fetch(refineUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [
                    { inline_data: { mime_type: overlayMime, data: overlayBase64 } },
                    { text: refinePrompt }
                  ] }],
                  generationConfig: {
                    // Refine pass: smaller response (just refined main character boxes),
                    // so a tight cap is fine and prevents repetition loops.
                    maxOutputTokens: 2500,
                    temperature: 0.5,
                    responseMimeType: 'application/json',
                    ...(require('./images').modelSupportsThinking(refineModelId) /* lazy back-edge into images.js (see module header) */ && { thinkingConfig: { thinkingBudget: 0 } })
                  },
                  safetySettings: require('./images').GEMINI_SAFETY_SETTINGS // lazy back-edge into images.js (see module header)
                })
              });
            }, { maxRetries: 1, baseDelay: 1000 });

            if (!refineResp.ok) throw new Error(`Refine API ${refineResp.status}`);
            refineData = await refineResp.json();
          }

          totalInputTokens += refineData?.usageMetadata?.promptTokenCount || 0;
          totalOutputTokens += refineData?.usageMetadata?.candidatesTokenCount || 0;

          const refineText = refineData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (refineText) {
            refinementResponse = refineText;
            const refined = getStoryHelpers().extractJsonFromText(refineText);
            if (refined?.figures) {
              // Merge: update main characters with refined boxes, keep UNKNOWN crowd from pass 1
              const refinedMap = new Map();
              for (const fig of refined.figures) {
                refinedMap.set((fig.name || '').toLowerCase(), {
                  name: fig.name || 'UNKNOWN',
                  label: fig.label,
                  position: fig.position,
                  faceBox: normalizeBox(fig.face_box),
                  bodyBox: normalizeBox(fig.body_box),
                  confidence: fig.confidence || 'low'
                });
              }
              finalFigures = [];
              for (const mc of mainCharacters) {
                finalFigures.push(refinedMap.get(mc.name.toLowerCase()) || mc);
              }
              // Keep UNKNOWN crowd figures from pass 1
              for (const uf of figures.filter(f => f.name === 'UNKNOWN')) {
                finalFigures.push(uf);
              }
              log.info(`📦 [BBOX-DETECT] Pass 2 (refine): refined ${refinedMap.size} main character boxes, kept ${finalFigures.length - refinedMap.size} crowd figures`);
            }
          }
        }
      } catch (refineErr) {
        log.warn(`⚠️  [BBOX-DETECT] Pass 2 refinement failed, keeping pass 1 results: ${refineErr.message}`);
      }
    }

    // Cascade face merge — Gemini face boxes are often tight/cropped. The cascade
    // detector (anime + haar) typically finds looser, better-centered faces. Merge
    // them in before returning so every downstream consumer (character repair,
    // masking, entity check) gets the improved box.
    try {
      const { detectIllustrationFaces, mergeCascadeFacesWithGemini } = require('./entityConsistency');
      const cascadeFaces = await detectIllustrationFaces(imageData, 60);
      if (cascadeFaces.length > 0) {
        let imgW = 1024, imgH = 1024;
        try {
          const meta = await sharp(Buffer.from(r2Lib.stripDataUriPrefix(imageData), 'base64')).metadata();
          imgW = meta.width || 1024;
          imgH = meta.height || 1024;
        } catch { /* use defaults */ }
        finalFigures = await mergeCascadeFacesWithGemini(finalFigures, cascadeFaces, imgW, imgH, expectedCharacters);
        const improved = finalFigures.filter(f => f._cascadeFace).length;
        if (improved > 0) {
          log.info(`🎯 [BBOX-DETECT] ${pageLabel}Cascade improved ${improved}/${finalFigures.length} face boxes`);
        }
      }
    } catch (cascadeErr) {
      log.debug(`[BBOX-DETECT] ${pageLabel}Cascade merge skipped: ${cascadeErr.message}`);
    }

    // Compute found/missing objects from final results
    const foundObjects = finalObjects.filter(o => o.found).map(o => o.name);
    const missingObjects = finalObjects.filter(o => !o.found).map(o => o.name);

    const finalResult = {
      figures: finalFigures,
      objects: finalObjects,
      // Include expected inputs for dev mode display
      expectedCharacters,
      expectedObjects,
      foundObjects,
      missingObjects,
      unknownFigures: finalFigures.filter(f => f.name === 'UNKNOWN').length,
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      // Include raw prompt and response for dev mode debugging
      rawPrompt: prompt,
      rawResponse: responseText,
      refinementResponse,
      // When the flag is on but GroundingDINO fell back to Gemini, keep its
      // diagnostics (raw batched scores + why it fell back) on the result so
      // the page is still debuggable.
      detectionBackend: gdinoDiag ? 'gemini-fallback' : undefined,
      gdinoDiag: gdinoDiag || undefined,
    };

    // ── Second-opinion arbitration (owner, 2026-08-09) ─────────────────────
    // A stashed undercounted DINO result means Gemini just ran as the second
    // opinion. More Gemini figures than DINO persons → DINO merged overlapping
    // figures (e.g. a child standing in front of an adult) → Gemini's boxes
    // win, and SAM masks are attached to THEM so cutouts/carve-out still work.
    // Same-or-fewer → the painter really painted fewer people; DINO's tight
    // boxes + masks + SoM names stand, and the undercount stays visible to the
    // evals as genuinely missing characters.
    if (dinoUndercountResult) {
      const dinoN = dinoUndercountResult.figures.length;
      const gemN = (finalResult.figures || []).length;
      if (gemN > dinoN) {
        try {
          const masks = await attachSamMasksToFigures(imageData, finalResult.figures, { pageLabel });
          Object.defineProperty(finalResult, '_gdinoMasks', { value: masks, enumerable: false });
        } catch (maskErr) {
          log.warn(`⚠️ [BBOX-DETECT] ${pageLabel}SAM mask attach on Gemini boxes failed (${maskErr.message}) — boxes stay maskless`);
        }
        finalResult.detectionBackend = 'gemini-second-opinion';
        finalResult.gdinoDiag = { ...(dinoUndercountResult.gdinoDiag || {}), secondOpinion: { dino: dinoN, gemini: gemN, chose: 'gemini' } };
        log.info(`⚖️ [BBOX-DETECT] ${pageLabel}second opinion: Gemini ${gemN} > DINO ${dinoN} figures — DINO merged; using Gemini boxes + SAM masks`);
        if (!skipCache) _bboxCacheSet(cacheKey, finalResult);
        return finalResult;
      }
      dinoUndercountResult.gdinoDiag = { ...(dinoUndercountResult.gdinoDiag || {}), secondOpinion: { dino: dinoN, gemini: gemN, chose: 'dino' } };
      log.info(`⚖️ [BBOX-DETECT] ${pageLabel}second opinion: Gemini ${gemN} ≤ DINO ${dinoN} figures — painter painted fewer; keeping DINO boxes+masks`);
      if (!skipCache) _bboxCacheSet(cacheKey, dinoUndercountResult);
      return dinoUndercountResult;
    }

    // Populate the cache so the entity-consistency pass can reuse this on
    // the same image without re-paying the Gemini call.
    if (!skipCache) _bboxCacheSet(cacheKey, finalResult);

    return finalResult;

  } catch (error) {
    log.error(`❌ [BBOX-DETECT] Error detecting bounding boxes: ${error.message}`);
    if (dinoUndercountResult) {
      // The second opinion failed to materialize — the undercounted DINO
      // result is still strictly better than nothing (real boxes + masks).
      log.warn(`⚠️ [BBOX-DETECT] ${pageLabel}Gemini second opinion errored — keeping the undercounted DINO result`);
      dinoUndercountResult.gdinoDiag = { ...(dinoUndercountResult.gdinoDiag || {}), secondOpinion: { chose: 'dino', error: error.message } };
      return dinoUndercountResult;
    }
    return null;
  }
}

/**
 * Detect a specific sub-region within a character crop
 * Stage 2 of targeted repair: refines full body_box to specific element (shoes, shirt, hands, etc.)
 *
 * @param {Buffer|string} characterCrop - Cropped image of the character (Buffer or base64)
 * @param {string} targetElement - What to find (shoes, shirt, hands, etc.)
 * @returns {Promise<{found: boolean, box: [number,number,number,number]|null, confidence: string, description: string}|null>}
 */
async function detectSubRegion(characterCrop, targetElement) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      log.warn('⚠️  [SUB-REGION] Gemini API key not configured');
      return null;
    }

    // Load prompt template
    if (!PROMPT_TEMPLATES.subRegionDetection) {
      log.warn('⚠️  [SUB-REGION] Sub-region detection prompt template not loaded');
      return null;
    }

    // Build prompt with target element
    const prompt = fillTemplate(PROMPT_TEMPLATES.subRegionDetection, {
      TARGET_ELEMENT: targetElement
    });

    // Convert to base64 if Buffer
    let base64Data;
    let mimeType = 'image/jpeg';
    if (Buffer.isBuffer(characterCrop)) {
      base64Data = characterCrop.toString('base64');
    } else if (typeof characterCrop === 'string') {
      const base64Match = characterCrop.match(/^data:(image\/\w+);base64,(.+)$/);
      if (base64Match) {
        mimeType = base64Match[1];
        base64Data = base64Match[2];
      } else {
        base64Data = characterCrop;
      }
    } else {
      log.warn('⚠️  [SUB-REGION] Invalid characterCrop type');
      return null;
    }

    const parts = [
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      },
      { text: prompt }
    ];

    // Bbox needs spatial precision — use dedicated bbox model (gemini-2.5-flash)
    const modelId = MODEL_DEFAULTS.bboxDetection || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const response = await withRetry(async () => {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            maxOutputTokens: 2000,
            temperature: 0.1,
            responseMimeType: 'application/json'
          },
          safetySettings: require('./images').GEMINI_SAFETY_SETTINGS // lazy back-edge into images.js (see module header)
        })
      });
    }, { maxRetries: 2, baseDelay: 1000 });

    if (!response.ok) {
      const error = await response.text();
      log.error(`❌ [SUB-REGION] Gemini API error ${response.status}: ${error.replace(/[\n\r]+/g, ' ').substring(0, 200)}`);
      return null;
    }

    const data = await response.json();

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    log.debug(`📊 [SUB-REGION] Token usage - input: ${inputTokens}, output: ${outputTokens}`);

    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      log.warn('⚠️  [SUB-REGION] No response from Gemini');
      return null;
    }

    const responseText = data.candidates[0].content.parts[0].text.trim();

    // Parse JSON response
    let parsedResult;
    try {
      parsedResult = getStoryHelpers().extractJsonFromText(responseText);
    } catch (e) {
      log.warn(`⚠️  [SUB-REGION] Failed to parse response: ${e.message}`);
      log.debug(`⚠️  [SUB-REGION] Raw response: ${responseText.substring(0, 500)}`);
      return null;
    }

    if (!parsedResult) {
      log.warn(`⚠️  [SUB-REGION] No JSON found in response`);
      return null;
    }

    // Normalize coordinates from 0-1000 to 0.0-1.0
    let normalizedBox = null;
    if (parsedResult.found && parsedResult.box && Array.isArray(parsedResult.box) && parsedResult.box.length === 4) {
      const [ymin, xmin, ymax, xmax] = parsedResult.box;
      // Handle both 0-1000 format (Gemini native) and 0-1 format (already normalized)
      const scale = (ymax > 1 || xmax > 1) ? 1000 : 1;
      normalizedBox = [
        Math.max(0, Math.min(1, ymin / scale)),
        Math.max(0, Math.min(1, xmin / scale)),
        Math.max(0, Math.min(1, ymax / scale)),
        Math.max(0, Math.min(1, xmax / scale))
      ];
    }

    const result = {
      found: parsedResult.found === true,
      box: normalizedBox,
      confidence: parsedResult.confidence || 'low',
      description: parsedResult.description || '',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    };

    if (result.found) {
      log.info(`🎯 [SUB-REGION] Found "${targetElement}": ${result.description} (${result.confidence})`);
    } else {
      log.info(`🎯 [SUB-REGION] "${targetElement}" not found: ${result.description}`);
    }

    return result;

  } catch (error) {
    log.error(`❌ [SUB-REGION] Error detecting sub-region: ${error.message}`);
    return null;
  }
}


/**
 * Build expected characters array for bbox detection from character descriptions, positions, and clothing
 * @param {Object} characterDescriptions - Map of charName → {age, gender, isChild, genderTerm}
 * @param {Object} expectedPositions - Map of charName → position string
 * @param {Object} characterClothing - Map of charName → clothing description string
 * @returns {Array<{name: string, description: string, position: string}>}
 */

function buildExpectedCharactersForBbox(characterDescriptions, expectedPositions, characterClothing = {}) {
  const chars = [];
  const addedNames = new Set();

  // Helper to get clothing for a character name (case-insensitive lookup)
  const getClothing = (name) => {
    return characterClothing?.[name] ||
           characterClothing?.[name.charAt(0).toUpperCase() + name.slice(1)] ||
           characterClothing?.[name.toLowerCase()] || '';
  };

  // Category names that aren't actual wearable descriptions — these are internal
  // metadata tags (e.g. "standard", "costumed:wizard") and must never leak into
  // the detector prompt as if they were clothing.
  const isCategoryLabel = (str) => {
    if (!str || typeof str !== 'string') return false;
    const s = str.trim().toLowerCase();
    if (['standard', 'winter', 'summer', 'costumed'].includes(s)) return true;
    if (s.startsWith('costumed:')) return true;
    return false;
  };

  // Resolve a clothing category (including nested costumed:type) to a prose
  // description. char.avatars.clothing has this shape:
  //   { standard: "...", winter: "...", costumed: { cowboy: "...", wizard: "..." } }
  // so "costumed:cowboy" needs to hit avatars.clothing.costumed.cowboy, not
  // avatars.clothing["costumed:cowboy"] which doesn't exist.
  const resolveClothingDesc = (clothingDescriptions, category) => {
    if (!clothingDescriptions || !category) return '';
    // Costumed (bare or legacy 'costumed:<type>') — one costume per character,
    // so pick the first entry of the nested costumed object regardless of any
    // legacy subtype string.
    if (category === 'costumed' || category.startsWith('costumed:')) {
      const costumed = clothingDescriptions.costumed;
      if (typeof costumed === 'string') return costumed;
      if (costumed && typeof costumed === 'object') {
        // If legacy subtype-keyed, prefer the matching key; else first entry.
        if (category.startsWith('costumed:')) {
          const type = category.split(':')[1];
          if (costumed[type]) return costumed[type];
        }
        const firstCostume = Object.values(costumed).find(v => typeof v === 'string');
        if (firstCostume) return firstCostume;
      }
      return '';
    }
    if (clothingDescriptions[category]) return clothingDescriptions[category];
    return '';
  };

  // First, add characters from characterDescriptions (which have age/gender info)
  for (const [name, desc] of Object.entries(characterDescriptions || {})) {
    const position = expectedPositions?.[name] || expectedPositions?.[name.charAt(0).toUpperCase() + name.slice(1)] || '';
    // Use clothing from characterClothing map, or from parsed description (covers), or empty
    let clothingCategory = getClothing(name) || desc.clothing || '';
    // Resolve category names (standard/winter/summer/costumed:X) to actual descriptions
    let clothing = clothingCategory;
    if (desc.clothingDescriptions && clothingCategory) {
      const resolved = resolveClothingDesc(desc.clothingDescriptions, clothingCategory);
      if (resolved) {
        clothing = resolved;
      } else if (clothingCategory === 'standard' && desc.clothingDescriptions.standard) {
        clothing = desc.clothingDescriptions.standard;
      }
    }
    // Strip bare category labels — they're metadata tags, not wearable descriptions
    if (isCategoryLabel(clothing)) {
      clothing = '';
    }

    let description;
    if (desc.richDescription) {
      // For bbox DETECTION (not image generation), Gemini's safety filter is not
      // triggered by gender words — this is a text comprehension task on an
      // already-rendered image. Keep "boy"/"girl"/"man"/"woman": crucial for
      // disambiguating multiple characters. Only strip explicit numeric ages.
      const sanitized = desc.richDescription
        .replace(/\b\d+[-\s]?years?[-\s]?old\s+/gi, '')   // "7-year-old " → ""
        .replace(/\bage[sd]?\s*\d+\b/gi, '')              // "aged 7" → ""
        .replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
      // If we have a resolved per-page clothing, it OVERRIDES the baked-in
      // default clothing from richDescription. Without this, the detector
      // was told to look for "Lukas wearing striped hoodie" on a cowboy-page
      // where Lukas is actually in a cowboy costume — Gemini saw the
      // clothing mismatch and tagged every figure UNKNOWN.
      if (clothing) {
        const stripped = sanitized.replace(/\.?\s*Wearing:\s*[^.]+\.?\s*$/i, '').trim().replace(/[.,;]\s*$/, '');
        description = `${stripped}. Wearing: ${clothing}`;
      } else {
        description = sanitized;
      }
    } else {
      // Minimal description from prompt parsing — keep "character" placeholder
      // rather than "figure" (less likely to confuse the detector as a typo).
      const descParts = ['character'];
      if (clothing) descParts.push(clothing);
      description = descParts.join(', ');
    }
    // Concise grounding/identity prompt: identity (age/gender/hair/beard/
    // glasses) + a SHORT garment phrase. Feeds the SoM character lines (and
    // the layout fallback), so the garment must be a real visible garment:
    // structured clothing strings ("headwear: none; top: red striped shirt
    // under a leather vest; bottom: …") previously produced "wearing
    // headwear: none" (first segment naively taken) or a mid-word 50-char cut.
    const gdinoIdentity = desc.gdinoIdentity || null;
    let gdinoPrompt = null;
    if (gdinoIdentity) {
      const shortClothing = _shortGarmentPhrase(clothing);
      gdinoPrompt = shortClothing ? `${gdinoIdentity} wearing ${shortClothing}` : gdinoIdentity;
    }
    chars.push({
      name,
      description,
      position,
      // Clothing kept separate (in addition to being inside `description`) so the
      // GroundingDINO detection path can build negative/disambiguation prompts
      // from the OTHER characters' clothing on an overlap retry.
      clothing: clothing || '',
      // Concise prompt for GroundingDINO (null → detector falls back to `description`).
      gdinoPrompt,
    });
    addedNames.add(name.toLowerCase());
  }

  // Then, add any characters from expectedPositions that weren't in characterDescriptions.
  // Skip Visual-Bible IDs (e.g. "CHR001") entirely — they have no descriptive traits
  // for the detector and just add noise ("figure, costumed:wizard" is unmatchable).
  for (const [name, position] of Object.entries(expectedPositions || {})) {
    if (addedNames.has(name.toLowerCase())) continue;
    if (/^(CHR|LOC|ANI|VEH|ART|OBJ)\d+$/i.test(name)) {
      log.debug(`📦 [BBOX-BUILD] Skipping VB-id "${name}" — no descriptive traits available`);
      continue;
    }
    let clothing = getClothing(name);
    if (isCategoryLabel(clothing)) clothing = '';
    chars.push({
      name,
      description: clothing || 'character',
      position,
      clothing: clothing || ''
    });
    addedNames.add(name.toLowerCase());
    log.debug(`📦 [BBOX-BUILD] Added character "${name}" from expectedPositions (clothing: ${clothing || 'none'})`);
  }

  return chars;
}

/**
 * Create an overlay image with bounding boxes drawn on it
 * @param {string} imageData - Base64 image data
 * @param {Object} bboxDetection - Result from detectAllBoundingBoxes (includes qualityMatches, objectMatches)
 * @returns {Promise<string|null>} Base64 image with boxes drawn, or null on error
 */
async function createBboxOverlayImage(imageData, bboxDetection) {
  if (!bboxDetection || (!bboxDetection.figures?.length && !bboxDetection.objects?.length)) {
    return null;
  }

  try {
    // Extract base64 data
    const base64Match = imageData.match(/^data:image\/\w+;base64,(.+)$/);
    const base64Data = base64Match ? base64Match[1] : imageData;
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Get image dimensions
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    // Build SVG overlay — figures, faces, and detected VB object boxes
    const svgParts = [`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`];

    const unknownColor = '#888888'; // Gray for unidentified figures

    // Draw figure boxes — each figure gets a unique color for both body and face
    for (let i = 0; i < (bboxDetection.figures || []).length; i++) {
      const fig = bboxDetection.figures[i];
      const isIdentified = fig.name && fig.name !== 'UNKNOWN';
      const figColor = isIdentified ? FIGURE_COLORS[i % FIGURE_COLORS.length].hex : unknownColor;

      // Body box
      if (fig.bodyBox) {
        const [ymin, xmin, ymax, xmax] = fig.bodyBox;
        const x = Math.round(xmin * width);
        const y = Math.round(ymin * height);
        const w = Math.round((xmax - xmin) * width);
        const h = Math.round((ymax - ymin) * height);

        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${figColor}" stroke-width="4"/>`);

        // Label — character name or "? Figure N"
        const label = isIdentified ? fig.name : `? ${fig.label ? fig.label.substring(0, 25) : `Figure ${i + 1}`}`;
        const labelWidth = Math.min(label.length * 8 + 10, 200);
        svgParts.push(`<rect x="${x}" y="${Math.max(0, y - 22)}" width="${labelWidth}" height="22" fill="${figColor}" opacity="0.9" rx="3"/>`);
        svgParts.push(`<text x="${x + 5}" y="${Math.max(16, y - 5)}" font-family="Arial" font-size="13" font-weight="bold" fill="white">${escapeXml(label)}</text>`);
      }

      // Raw GroundingDINO person box (dashed, dimmer) — shown when SAM tightened
      // it into the bodyBox above, so drift between the two is visible.
      if (fig.gdinoBox) {
        const [ymin, xmin, ymax, xmax] = fig.gdinoBox;
        const x = Math.round(xmin * width);
        const y = Math.round(ymin * height);
        const w = Math.round((xmax - xmin) * width);
        const h = Math.round((ymax - ymin) * height);
        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${figColor}" stroke-width="2" stroke-dasharray="6,4" opacity="0.55"/>`);
        svgParts.push(`<text x="${x + 2}" y="${y + h - 4}" font-family="Arial" font-size="9" fill="${figColor}" opacity="0.7">dino${fig.score != null ? ` ${fig.score}` : ''}</text>`);
      }

      // Original Gemini face box (dashed, dimmer) — shown when cascade improved the face
      if (fig._geminiFaceBox && fig._cascadeFace) {
        const [ymin, xmin, ymax, xmax] = fig._geminiFaceBox;
        const x = Math.round(xmin * width);
        const y = Math.round(ymin * height);
        const w = Math.round((xmax - xmin) * width);
        const h = Math.round((ymax - ymin) * height);
        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${figColor}" stroke-width="2" stroke-dasharray="6,4" opacity="0.5"/>`);
        svgParts.push(`<text x="${x + 2}" y="${y - 3}" font-family="Arial" font-size="9" fill="${figColor}" opacity="0.6">gemini</text>`);
      }

      // Final face box (solid = cascade-improved, or dashed = Gemini-only if no cascade)
      if (fig.faceBox) {
        const [ymin, xmin, ymax, xmax] = fig.faceBox;
        const x = Math.round(xmin * width);
        const y = Math.round(ymin * height);
        const w = Math.round((xmax - xmin) * width);
        const h = Math.round((ymax - ymin) * height);
        const isCascade = !!fig._cascadeFace;
        const isDinoFace = fig._faceSource === 'dino';
        const strokeStyle = (isCascade || isDinoFace) ? '' : ' stroke-dasharray="8,4"'; // solid if local detector, dashed if gemini-only
        const strokeWidth = (isCascade || isDinoFace) ? 4 : 3;
        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${figColor}" stroke-width="${strokeWidth}"${strokeStyle}/>`);
        // DINO face anchor — red dot at the face center
        if (isDinoFace) {
          svgParts.push(`<circle cx="${x + w / 2}" cy="${y + h / 2}" r="8" fill="#FF2D55" stroke="white" stroke-width="2.5"/>`);
        }
        // Face label
        const sourceTag = isCascade ? ` [${fig._cascadeFace}]` : isDinoFace ? ` [dino${fig._faceScore != null ? ` ${fig._faceScore}` : ''}]` : '';
        const faceLabel = isIdentified ? `FACE ${fig.name}${sourceTag}` : `FACE ${i + 1}${sourceTag}`;
        const faceLabelWidth = Math.min(faceLabel.length * 7 + 10, 200);
        svgParts.push(`<rect x="${x}" y="${y + h}" width="${faceLabelWidth}" height="16" fill="${figColor}" opacity="0.9" rx="2"/>`);
        svgParts.push(`<text x="${x + 4}" y="${y + h + 12}" font-family="Arial" font-size="10" font-weight="bold" fill="white">${escapeXml(faceLabel)}</text>`);
      }
    }

    // Detected object boxes (VB props) — yellow dashed so they read apart from figures
    const objColor = '#FFD60A';
    for (const obj of (bboxDetection.objects || [])) {
      if (!obj?.bodyBox || obj.found === false) continue;
      const [ymin, xmin, ymax, xmax] = obj.bodyBox;
      const x = Math.round(xmin * width);
      const y = Math.round(ymin * height);
      const w = Math.round((xmax - xmin) * width);
      const h = Math.round((ymax - ymin) * height);
      svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${objColor}" stroke-width="3" stroke-dasharray="10,5"/>`);
      const objLabel = `${obj.label || obj.name}${obj.score != null ? ` ${obj.score}` : ''}`.substring(0, 40);
      const objLabelWidth = Math.min(objLabel.length * 7 + 10, 280);
      svgParts.push(`<rect x="${x}" y="${Math.min(height - 18, y + h)}" width="${objLabelWidth}" height="18" fill="${objColor}" opacity="0.9" rx="2"/>`);
      svgParts.push(`<text x="${x + 4}" y="${Math.min(height - 5, y + h + 13)}" font-family="Arial" font-size="11" font-weight="bold" fill="black">${escapeXml(objLabel)}</text>`);
    }

    svgParts.push('</svg>');
    const svgBuffer = Buffer.from(svgParts.join(''));

    // Composite SVG over image
    let resultBuffer = await sharp(imageBuffer)
      .composite([{ input: svgBuffer, top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toBuffer();

    // Cutout strip — per-figure SAM cutouts appended below the annotated page.
    // Masks arrive as a non-enumerable `_gdinoMasks` (index-aligned with
    // figures) so they exist only in-process, never in stories.data.
    const gdinoMasks = bboxDetection._gdinoMasks;
    if (Array.isArray(gdinoMasks) && gdinoMasks.some(Boolean)) {
      try {
        const STRIP_H = 260, GAP = 8, LABEL_H = 20;
        const tiles = [];
        for (let i = 0; i < (bboxDetection.figures || []).length; i++) {
          const maskPng = gdinoMasks[i];
          const fig = bboxDetection.figures[i];
          if (!maskPng || !fig?.bodyBox) continue;
          const [ymin, xmin, ymax, xmax] = fig.bodyBox;
          const pad = 12;
          const ex = Math.max(0, Math.round(xmin * width) - pad);
          const ey = Math.max(0, Math.round(ymin * height) - pad);
          const ew = Math.min(width, Math.round(xmax * width) + pad) - ex;
          const eh = Math.min(height, Math.round(ymax * height) + pad) - ey;
          if (ew < 4 || eh < 4) continue;
          // Two steps — sharp applies extract BEFORE composite regardless of
          // call order, so masking and cropping must be separate pipelines.
          const masked = await sharp(imageBuffer).ensureAlpha()
            .composite([{ input: maskPng, blend: 'dest-in' }])
            .png().toBuffer();
          const cut = await sharp(masked)
            .extract({ left: ex, top: ey, width: ew, height: eh })
            .resize({ height: STRIP_H - LABEL_H })
            .png().toBuffer();
          const cutMeta = await sharp(cut).metadata();
          tiles.push({ png: cut, w: cutMeta.width, name: fig.name || `Figure ${i + 1}`, named: !!(fig.name && fig.name !== 'UNKNOWN') });
        }
        if (tiles.length > 0) {
          const stripW = width;
          // Named characters lead the strip — on crowd pages the row must
          // never cut off a named figure in favour of background UNKNOWNs.
          tiles.sort((a, b) => Number(b.named) - Number(a.named));
          // Shrink-to-fit instead of dropping: scale every tile by the same
          // factor so all cutouts stay visible (floor 35% to keep them
          // recognisable; below that the smallest UNKNOWNs are dropped).
          const totalW = tiles.reduce((s, t) => s + t.w, 0) + GAP * (tiles.length + 1);
          let scale = Math.min(1, (stripW - GAP * (tiles.length + 1)) / Math.max(1, tiles.reduce((s, t) => s + t.w, 0)));
          while (scale < 0.35 && tiles.length > 1 && !tiles[tiles.length - 1].named) {
            tiles.pop();
            scale = Math.min(1, (stripW - GAP * (tiles.length + 1)) / Math.max(1, tiles.reduce((s, t) => s + t.w, 0)));
          }
          if (scale < 1) {
            for (const t of tiles) {
              const h = Math.max(24, Math.round((STRIP_H - LABEL_H) * scale));
              t.png = await sharp(t.png).resize({ height: h }).png().toBuffer();
              t.w = (await sharp(t.png).metadata()).width;
            }
          }
          let cursor = GAP;
          const comps = [];
          const labelSvg = [`<svg width="${stripW}" height="${STRIP_H}" xmlns="http://www.w3.org/2000/svg">`];
          for (const t of tiles) {
            if (cursor + t.w > stripW) break; // safety — should not trigger after scaling
            comps.push({ input: t.png, left: cursor, top: GAP });
            labelSvg.push(`<text x="${cursor + 4}" y="${STRIP_H - 6}" font-family="Arial" font-size="14" font-weight="bold" fill="white">${escapeXml(t.name)}</text>`);
            cursor += t.w + GAP;
          }
          labelSvg.push('</svg>');
          const strip = await sharp({ create: { width: stripW, height: STRIP_H, channels: 3, background: { r: 34, g: 34, b: 34 } } })
            .composite([...comps, { input: Buffer.from(labelSvg.join('')), top: 0, left: 0 }])
            .jpeg({ quality: 85 }).toBuffer();
          resultBuffer = await sharp({ create: { width, height: height + STRIP_H, channels: 3, background: { r: 34, g: 34, b: 34 } } })
            .composite([{ input: resultBuffer, top: 0, left: 0 }, { input: strip, top: height, left: 0 }])
            .jpeg({ quality: 85 }).toBuffer();
        }
      } catch (stripErr) {
        log.debug(`📦 [BBOX-OVERLAY] cutout strip skipped: ${stripErr.message}`);
      }
    }

    const result = 'data:image/jpeg;base64,' + resultBuffer.toString('base64');
    const figCount = bboxDetection.figures?.length || 0;
    const objCount = (bboxDetection.objects || []).filter(o => o.found !== false && o.bodyBox).length;
    log.debug(`📦 [BBOX-OVERLAY] Created overlay image: ${figCount} figures, ${objCount} objects (${Math.round(resultBuffer.length / 1024)}KB)`);
    return result;

  } catch (error) {
    log.error(`❌ [BBOX-OVERLAY] Error creating overlay: ${error.message}`);
    return null;
  }
}

// Helper to escape XML special characters
function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


/**
 * Detect all bounding boxes in image and match to fixable issues
 * Single API call detects ALL figures, faces, and objects for dev mode display
 *
 * @param {string} imageData - Base64 image data
 * @param {Array<{description: string, severity: string, type: string, fix: string}>} fixableIssues - Issues from quality eval
 * @param {Array<{figure: number, reference: string, confidence: number, position: string, hair: string, clothing: string}>} qualityMatches - Character→figure mapping from quality eval (legacy, not used)
 * @param {Array<{reference: string, type: string, position: string, appearance: string, confidence: number}>} objectMatches - Object/animal/landmark matches from quality eval (legacy, not used)
 * @returns {Promise<{targets: Array, detectionHistory: Object}>} - Enriched fix targets and full detection for display
 */
async function enrichWithBoundingBoxes(imageData, fixableIssues, qualityMatches = [], objectMatches = [], expectedPositions = {}, expectedObjects = [], characterDescriptions = {}, characterClothing = {}, sceneContext = null, bboxModelOverride = null, pageContext = '', sharedBboxDetection = null, artStyle = null, objectGroundingHints = null) {
  // Build expected characters for bbox detection (AI will identify by name)
  const expectedCharacters = buildExpectedCharactersForBbox(characterDescriptions, expectedPositions, characterClothing);

  const pageLabel = pageContext ? `[${pageContext}] ` : '';

  // Reuse shared bbox detection if provided (avoids redundant API call)
  let allDetections;
  if (sharedBboxDetection && !bboxPairsWith(sharedBboxDetection, imageData)) {
    log.warn(`⚠️ [BBOX-ENRICH] ${pageLabel}Shared bbox was computed on DIFFERENT image bytes (stale version) — discarding, re-detecting`);
    sharedBboxDetection = null;
  }
  if (sharedBboxDetection) {
    log.info(`♻️  [BBOX-ENRICH] ${pageLabel}Reusing shared bbox detection (${sharedBboxDetection.figures?.length || 0} figures, ${sharedBboxDetection.objects?.length || 0} objects)`);
    allDetections = sharedBboxDetection;
  } else {
    log.info(`📦 [BBOX-ENRICH] ${pageLabel}Detecting figures/objects with ${expectedCharacters.length} expected characters, ${expectedObjects.length} expected objects${sceneContext ? ', with scene context' : ''}${bboxModelOverride ? `, model: ${bboxModelOverride}` : ''}...`);
    allDetections = await detectAllBoundingBoxes(imageData, {
      expectedCharacters,
      expectedObjects,
      sceneContext,
      bboxModelOverride,
      pageContext,
      artStyle,
      objectGroundingHints
    });
  }

  if (!allDetections) {
    log.warn(`🔄 [FALLBACK] Detection failed, no bounding boxes available`);
    return { targets: [], detectionHistory: null };
  }

  log.info(`📦 [BBOX-ENRICH] Found ${allDetections.figures.length} figures, ${allDetections.objects.length} objects`);

  // Direct mapping - AI already labeled figures with character names
  const charToDetectionFigure = {};
  const unknownFigures = [];
  for (const figure of allDetections.figures) {
    if (figure.name && figure.name !== 'UNKNOWN') {
      charToDetectionFigure[figure.name.toLowerCase()] = figure;
      log.verbose(`📦 [BBOX-ENRICH] Character identified: "${figure.name}" (${figure.confidence}) → "${figure.label}"`);
    } else {
      unknownFigures.push(figure);
    }
  }

  if (Object.keys(charToDetectionFigure).length > 0) {
    log.info(`📦 [BBOX-ENRICH] Identified ${Object.keys(charToDetectionFigure).length} characters: ${Object.keys(charToDetectionFigure).join(', ')}`);
  }
  if (unknownFigures.length > 0) {
    log.info(`📦 [BBOX-ENRICH] ${unknownFigures.length} UNKNOWN figures: ${unknownFigures.map(f => f.label).join(', ')}`);
  }

  // Track position mismatches between expected and detected
  const positionMismatches = [];
  const foundCharacters = new Set(Object.keys(charToDetectionFigure).map(n => n.toLowerCase()));

  for (const [charNameLower, figure] of Object.entries(charToDetectionFigure)) {
    // Find expected position (try both lowercase and capitalized versions)
    const charName = charNameLower.charAt(0).toUpperCase() + charNameLower.slice(1);
    const expectedPos = expectedPositions[charName] || expectedPositions[charNameLower];
    if (expectedPos) {
      const expectedLCR = getStoryHelpers().normalizePositionToLCR(expectedPos);
      if (expectedLCR && figure.position && figure.position !== expectedLCR) {
        positionMismatches.push({
          character: charName,
          expected: expectedPos,
          expectedLCR: expectedLCR,
          actual: figure.position
        });
        log.debug(`📍 [BBOX-ENRICH] Position note: "${charName}" expected at ${expectedLCR} (${expectedPos}) but detected at ${figure.position}`);
      }
    }
  }

  // Detect missing characters (expected in scene but not identified by AI)
  const missingCharacters = Object.keys(expectedPositions)
    .filter(name => !foundCharacters.has(name.toLowerCase()));
  if (missingCharacters.length > 0) {
    log.info(`📍 [BBOX-ENRICH] Missing characters (expected but not identified): ${missingCharacters.join(', ')}`);
  }

  // Object tracking is now direct from detection results
  const foundObjects = allDetections.foundObjects || [];
  const missingObjects = allDetections.missingObjects || [];
  const matchedExpectedObjects = foundObjects.map(name => ({ expected: name, matched: name }));

  if (foundObjects.length > 0 || missingObjects.length > 0) {
    log.info(`📦 [BBOX-ENRICH] Objects: ${foundObjects.length} found, ${missingObjects.length} missing`);
  }

  // Build detection history for dev mode display
  const detectionHistory = {
    figures: allDetections.figures,
    objects: allDetections.objects,
    expectedCharacters: allDetections.expectedCharacters,
    expectedObjects: allDetections.expectedObjects,
    expectedPositions: Object.keys(expectedPositions).length > 0 ? expectedPositions : undefined,
    positionMismatches: positionMismatches.length > 0 ? positionMismatches : undefined,
    missingCharacters: missingCharacters.length > 0 ? missingCharacters : undefined,
    foundObjects: foundObjects.length > 0 ? foundObjects : undefined,
    missingObjects: missingObjects.length > 0 ? missingObjects : undefined,
    matchedObjects: matchedExpectedObjects.length > 0 ? matchedExpectedObjects : undefined,
    unknownFigures: unknownFigures.length,
    characterDescriptions: Object.keys(characterDescriptions).length > 0 ? characterDescriptions : undefined,
    usage: allDetections.usage,
    rawPrompt: allDetections.rawPrompt,
    rawResponse: allDetections.rawResponse,
    // Which backend produced this + GroundingDINO per-figure diagnostics (raw
    // batched scores, recovery, low-conf flags, collisions, fallback reason) so
    // detection is debuggable from the stored record, not only live logs.
    detectionBackend: allDetections.detectionBackend,
    gdinoDiag: allDetections.gdinoDiag,
    // Byte-pairing stamp (see imageFingerprint) — must survive this rebuild,
    // detectionHistory IS the object persisted as bboxDetection. The shared
    // detection was verified against imageData above, so its fp equals ours.
    sourceImageFp: allDetections.sourceImageFp || imageFingerprint(imageData),
    timestamp: new Date().toISOString()
  };
  // Carry the in-process SAM mask PNGs across to the overlay renderer
  // (non-enumerable — never serialized into stories.data).
  if (allDetections._gdinoMasks) {
    Object.defineProperty(detectionHistory, '_gdinoMasks', { value: allDetections._gdinoMasks, enumerable: false });
  }

  // If no issues to fix, just return the detections
  if (!fixableIssues || fixableIssues.length === 0) {
    return { targets: [], detectionHistory };
  }

  // Match issues to detected elements for repair targets
  // Now uses direct character name matching from AI identification
  const enrichedTargets = [];
  const allElements = [
    ...allDetections.figures.map(f => ({ ...f, elementType: 'figure' })),
    ...allDetections.objects.map(o => ({ ...o, elementType: 'object', faceBox: null }))
  ];

  // Helper: extract character names mentioned in issue text
  const extractCharacterNames = (text) => {
    const textLower = (text || '').toLowerCase();
    const foundChars = [];
    for (const charName of Object.keys(charToDetectionFigure)) {
      const escapedName = charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escapedName}(?:[\u2019']s)?\\b`, 'i');
      if (regex.test(textLower)) {
        foundChars.push(charName);
      }
    }
    return foundChars;
  };

  // Helper: extract meaningful keywords from text
  const commonWords = new Set(['with', 'that', 'this', 'from', 'have', 'been', 'were', 'being', 'their', 'there', 'which', 'would', 'could', 'should', 'about', 'figure', 'image', 'shown', 'visible']);
  const extractKeywords = (text) => {
    return (text || '').toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !commonWords.has(w));
  };

  // Only character-targeted issues get bbox enrichment. Object / scene /
  // composition issues ("wooden crossbow is missing", "extra building in
  // background", "deep shadow band at bottom") pass through as text only —
  // they flow downstream through the consolidator (inpaintPage → Haiku →
  // scene_fix.instruction), which doesn't need a per-issue bbox.
  //
  // The bbox detector doesn't reliably localise objects today: expected
  // objects that aren't found come back as found:false/null-bbox, and even
  // when they ARE found, the old targeted-magenta inpaint rarely improved
  // them. Skipping those issues here eliminated a noisy "Could not match"
  // log spam (~48 warnings per run) without losing real repair capability
  // — the main pipeline already handles non-character fixes via prose.
  //
  // Revive object bbox-enrichment when/if we build a dedicated
  // object-targeted repair pass. For now, character-only keeps the path
  // simple and honest about what actually works.
  const characterTypes = new Set(['face', 'hand', 'clothing', 'limb', 'proportion']);
  const isCharacterIssue = (issue) => {
    if (issue.character) return true;
    if (issue.type && characterTypes.has(String(issue.type).toLowerCase())) return true;
    // Fallback: issue text mentions a known character name.
    return extractCharacterNames((issue.description || '') + ' ' + (issue.fix || '')).length > 0;
  };

  for (const issue of fixableIssues) {
    if (!isCharacterIssue(issue)) {
      log.verbose(`📦 [BBOX-ENRICH] Skipping non-character issue (passes through as text): ${(issue.description || '').substring(0, 60)}`);
      continue;
    }

    const issueDesc = (issue.description || '').toLowerCase();
    const issueFix = (issue.fix || '').toLowerCase();
    const issueKeywords = extractKeywords(issueDesc + ' ' + issueFix);

    let bestMatch = null;
    let matchedCharacter = null;

    // PRIORITY 1: Use explicit character field from Pass 2 fixable_issues
    if (issue.character) {
      const charKey = issue.character.toLowerCase();
      const figure = charToDetectionFigure[charKey];
      if (figure) {
        bestMatch = { ...figure, elementType: 'figure' };
        matchedCharacter = charKey;
        log.debug(`📦 [BBOX-ENRICH] Issue has character="${issue.character}" → direct match to "${figure.label}"`);
      }
    }

    // PRIORITY 2: Check if issue text mentions a character name we know about
    if (!bestMatch) {
      const mentionedChars = extractCharacterNames(issueDesc + ' ' + issueFix);
      if (mentionedChars.length > 0) {
        for (const charName of mentionedChars) {
          const figure = charToDetectionFigure[charName];
          if (figure) {
            bestMatch = { ...figure, elementType: 'figure' };
            matchedCharacter = charName;
            log.verbose(`📦 [BBOX-ENRICH] Issue mentions "${charName}" → direct match to "${figure.label}"`);
            break;
          }
        }
      }
    }

    // Fallback: character-type issues without an explicit character name or
    // mention get pinned to the most likely figure (identified character, or
    // largest figure as a last resort). Object issues are filtered out above
    // and never reach this block — see the isCharacterIssue gate.
    if (!bestMatch) {
      // If the issue explicitly NAMES a character we know but PRIORITY 1/2
      // couldn't find that character's detected figure, do NOT fall back to a
      // different person's figure — repairing the wrong character (e.g.
      // Patrick's clothing issue pinned to Nicole's figure) is worse than
      // leaving it text-only. Only the last-resort largest/identified-figure
      // fallback is for GENERIC "a child / the boy" issues that name nobody.
      const namesAKnownChar = !!issue.character
        || extractCharacterNames(issueDesc + ' ' + issueFix).length > 0;
      if (namesAKnownChar) {
        log.debug(`📦 [BBOX-ENRICH] Issue names a character whose figure wasn't detected — leaving text-only (not mis-assigning to another person): "${(issue.description || '').substring(0, 60)}"`);
      } else if (issue.type === 'face' || issue.type === 'hand' || issue.type === 'clothing'
                 || issue.type === 'accessory' || issue.type === 'accessory_missing') {
        // For character-related issues, prefer identified characters or largest figure
        const identifiedFigures = allDetections.figures.filter(f => f.name && f.name !== 'UNKNOWN');
        if (identifiedFigures.length > 0) {
          bestMatch = { ...identifiedFigures[0], elementType: 'figure' };
        } else if (allDetections.figures.length > 0) {
          // Use largest figure
          bestMatch = allDetections.figures.reduce((largest, fig) => {
            const getArea = (box) => box ? (box[2] - box[0]) * (box[3] - box[1]) : 0;
            return getArea(fig.bodyBox) > getArea(largest?.bodyBox) ? fig : largest;
          }, allDetections.figures[0]);
          bestMatch = { ...bestMatch, elementType: 'figure' };
        }
      } else {
        // Character-typed issue we couldn't confidently pin to a figure —
        // leave it text-only. Better than repairing the wrong region.
        log.debug(`📦 [BBOX-ENRICH] Issue "${(issue.description || '').substring(0, 60)}" — no matching figure, skipping`);
      }
    }

    if (bestMatch) {
      // Choose appropriate box based on issue type
      let boundingBox = bestMatch.bodyBox || bestMatch.faceBox;
      if (issue.type === 'face' && bestMatch.faceBox) {
        boundingBox = bestMatch.faceBox;
      }

      enrichedTargets.push({
        faceBox: bestMatch.faceBox,
        bodyBox: bestMatch.bodyBox,
        boundingBox: boundingBox,
        bounds: boundingBox,
        issue: issue.description,
        fix_instruction: issue.fix || `Fix: ${issue.description}`,
        severity: issue.severity,
        type: issue.type,
        element: issue.type,
        affectedCharacter: matchedCharacter || bestMatch.name,
        fixPrompt: issue.fix || `Fix: ${issue.description}`,
        label: bestMatch.label,
        matchedPosition: bestMatch.position,
        matchMethod: matchedCharacter ? 'character' : 'fallback',
        matchedCharacter: matchedCharacter || (bestMatch.name !== 'UNKNOWN' ? bestMatch.name : null)
      });
      log.verbose(`📊 [EVAL] Matched: "${issue.description.substring(0, 30)}..." → "${bestMatch.label}" (${matchedCharacter ? 'character' : 'fallback'})`);
    } else {
      // Missing-character/element issues have no bbox by definition — that's
      // the issue. Only warn when we expected to find a region.
      const isMissing = issue.type === 'missing_character' || issue.type === 'missing_element' ||
        /\b(missing|entirely missing|not present|absent)\b/i.test(issue.description || '');
      if (isMissing) {
        log.debug(`[BBOX-ENRICH] No bbox for missing-element issue: ${issue.description.substring(0, 50)}...`);
      } else {
        log.warn(`[BBOX-ENRICH] Could not match issue: ${issue.description.substring(0, 50)}...`);
      }
    }
  }

  // Summarize matching methods used
  const byChar = enrichedTargets.filter(t => t.matchMethod === 'character').length;
  const byFallback = enrichedTargets.filter(t => t.matchMethod === 'fallback').length;
  const methodSummary = [
    byChar > 0 ? `${byChar} by character name` : null,
    byFallback > 0 ? `${byFallback} by fallback` : null
  ].filter(Boolean).join(', ');
  log.info(`📦 [BBOX-ENRICH] Matched ${enrichedTargets.length}/${fixableIssues.length} issues to detected elements${methodSummary ? ` (${methodSummary})` : ''}`);

  return { targets: enrichedTargets, detectionHistory };
}

module.exports = {
  parseVisualBibleObjects,
  resolveExpectedObjectLabels,
  buildObjectGroundingHints,
  _hashBboxKey,
  _bboxCacheGet,
  _bboxCacheSet,
  getBboxCacheStats,
  imageFingerprint,
  bboxPairsWith,
  restampDetectionForCoverText,
  detectionForVersion,
  detectAllBoundingBoxes,
  // _detectAllBoundingBoxesImpl deliberately NOT exported — the stamping
  // wrapper above is the only entry (sourceImageFp invariant, 2026-07-19).
  detectSubRegion,
  buildExpectedCharactersForBbox,
  createBboxOverlayImage,
  escapeXml,
  enrichWithBoundingBoxes,
  FIGURE_COLORS,
};

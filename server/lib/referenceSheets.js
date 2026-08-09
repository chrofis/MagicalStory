/**
 * Reference sheets and Visual Bible grids — the reference imagery a page
 * generation is given, not the page itself.
 *
 * Split out of images.js 2026-08-09. Builds the VB element grid, splits a
 * generated sheet back into per-element references, and assembles the
 * per-page reference bundles (empty-scene grid, composite refs).
 *
 * callGeminiAPIForImage is required LAZILY: images.js calls
 * buildEmptySceneVbGrid and buildPageCompositeRefs, so a top-level require of
 * images.js would close a cycle.
 */

const sharp = require('sharp');
const { log } = require('../utils/logger');
const r2Lib = require('./r2');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');

const callGeminiAPIForImage = (...args) => require('./images').callGeminiAPIForImage(...args);

async function splitGridIntoReferences(gridImage, count) {
  // Convert input to BOTH a Buffer (for sharp fallback) and a base64 string
  // (for the Python call) so we don't pay the conversion twice.
  let buffer;
  let base64;
  if (typeof gridImage === 'string') {
    base64 = r2Lib.stripDataUriPrefix(gridImage);
    buffer = Buffer.from(base64, 'base64');
  } else {
    buffer = gridImage;
    base64 = buffer.toString('base64');
  }

  // Try Python service first — variance-based separator detection that
  // finds the ACTUAL cell boundaries instead of blindly dividing pixels.
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
  try {
    const response = await fetch(`${photoAnalyzerUrl}/split-reference-sheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: `data:image/png;base64,${base64}`,
        count,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const result = await response.json();
      if (result.success && Array.isArray(result.cells) && result.cells.length === count) {
        log.info(`[REF-SHEET] Python split: ${result.layout.cols}x${result.layout.rows}, separators v=[${result.separators.vertical.join(',')}] h=[${result.separators.horizontal.join(',')}]`);
        return result.cells;
      }
      log.warn(`[REF-SHEET] Python split returned ${result.cells?.length ?? 'no'} cells (expected ${count}) — falling back to sharp`);
    } else {
      log.debug(`[REF-SHEET] Python service unavailable (${response.status}) — using sharp fallback`);
    }
  } catch (err) {
    log.debug(`[REF-SHEET] Python service unreachable (${err.message}) — using sharp fallback`);
  }

  // Fallback: blind equal-cell math via sharp. Works only when cells are
  // really equal-sized with no padding/separator/title bar.
  const metadata = await sharp(buffer).metadata();
  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error('Could not get grid image dimensions');
  }

  // Calculate grid layout — match prompt logic: 2x2 only for exactly 4, otherwise single column
  const cols = count === 4 ? 2 : 1;
  const rows = count === 4 ? 2 : count;
  const cellWidth = Math.floor(width / cols);
  const cellHeight = Math.floor(height / rows);

  log.debug(`[REF-SHEET] Sharp fallback: ${width}x${height} → ${cols}x${rows} cells (${cellWidth}x${cellHeight} each)`);

  const references = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);

    try {
      const cropped = await sharp(buffer)
        .extract({
          left: col * cellWidth,
          top: row * cellHeight,
          width: cellWidth,
          height: cellHeight
        })
        .png()
        .toBuffer();

      references.push(cropped.toString('base64'));
      log.debug(`[REF-SHEET] Sharp extracted cell ${i + 1}/${count} (col=${col}, row=${row})`);
    } catch (err) {
      log.error(`[REF-SHEET] Sharp failed to extract cell ${i}: ${err.message}`);
      references.push(null);
    }
  }

  return references;
}

/**
 * Build reference sheet prompt for a batch of elements
 *
 * @param {Array} elements - Elements to include (from getElementsNeedingReferenceImages)
 * @param {string} styleDescription - Art style description
 * @returns {string} Complete prompt for reference sheet generation
 */
function buildReferenceSheetPrompt(elements, styleDescription) {
  const count = elements.length;
  // Only use 2x2 for exactly 4 elements. Everything else uses a single column
  // to avoid partial rows (e.g. 3 elements in a 2x2 leaves an empty cell that
  // confuses image models and grid splitters).
  const cols = count === 4 ? 2 : 1;
  const rows = count === 4 ? 2 : count;

  // Build grid layout description.
  // We deliberately omit el.name from the per-cell line. The model treats
  // "Top-left: Erste Schatzkarte (artifact) - <description>" as a labeled
  // cell and renders the name/type onto the artifact (e.g. "Erste Schatzkarte"
  // gets painted on the parchment). Once that text is baked into the VB
  // reference image, every page that uses that reference inherits the text.
  // Pure visual prose — no labels, no IDs — keeps the cell intent clear to
  // the model without giving it strings to render. Splitter still works on
  // the grid borders.
  const positions2x2 = ['Top-left', 'Top-right', 'Bottom-left', 'Bottom-right'];
  const gridLayoutLines = elements.map((el, i) => {
    const pos = cols === 2 ? (positions2x2[i] || `Cell ${i + 1}`) : `Row ${i + 1}`;
    const desc = el.extractedDescription || el.description;
    return `${pos}: ${desc}`;
  });

  // Describe the grid in natural language. Passing literal digit-strings like
  // "2x2" used to bake "2x2" onto the rendered image (the model treated it as
  // a label). Use words for the count and an explicit row/column phrase so the
  // model never sees a stringy template token to copy.
  const numWord = (n) => ['', 'one', 'two', 'three', 'four', 'five', 'six'][n] || String(n);
  const gridShapePhrase = (cols === 2 && rows === 2)
    ? 'square grid with two rows and two columns (four cells total)'
    : (cols === 1)
      ? `single vertical column with ${numWord(rows)} cell${rows === 1 ? '' : 's'} stacked top-to-bottom`
      : `${numWord(rows)}-row by ${numWord(cols)}-column grid`;

  const prompt = fillTemplate(PROMPT_TEMPLATES.referenceSheet, {
    STYLE_DESCRIPTION: styleDescription,
    GRID_SHAPE_PHRASE: gridShapePhrase,
    GRID_LAYOUT: gridLayoutLines.join('\n'),
  });

  return prompt;
}

/**
 * Generate reference sheet for Visual Bible elements
 * Creates a grid image with reference illustrations for secondary characters and key objects
 *
 * @param {Object} visualBible - Visual Bible object
 * @param {string} styleDescription - Art style description for the story
 * @param {Object} options - Generation options
 * @param {number} options.minAppearances - Minimum page appearances (default 2)
 * @param {number} options.maxPerBatch - Maximum elements per grid (default 4)
 * @param {string} options.imageModel - Image model override
 * @returns {Promise<{generated: number, failed: number, elements: Array}>}
 */
async function generateReferenceSheet(visualBible, styleDescription, options = {}) {
  const {
    minAppearances = 2,
    // Every secondary character qualifies for a reference on a single page
    // (default 1) so none inherits the primary's face. Non-character elements
    // keep `minAppearances`. Same rule in trial (bounded by maxElements).
    characterMinAppearances = 1,
    maxPerBatch = 4,
    imageModel = null,
    maxElements = null,
    storyId = null,    // when present, each generated reference image is
                       // uploaded to R2 and the URL is stored on the VB entry.
  } = options;
  const { saveVbReferenceToR2 } = storyId ? require('../services/database') : { saveVbReferenceToR2: null };

  // Generate reference sheets using whatever image model is configured
  // (same flow for Gemini, Grok, etc.)

  // DEBUG: Log visual bible contents to diagnose reference image generation
  log.info(`[REF-SHEET] Visual Bible summary:`);
  log.info(`  - Secondary characters: ${visualBible?.secondaryCharacters?.length || 0}`);
  log.info(`  - Artifacts: ${visualBible?.artifacts?.length || 0}`);
  log.info(`  - Animals: ${visualBible?.animals?.length || 0}`);
  log.info(`  - Vehicles: ${visualBible?.vehicles?.length || 0}`);
  log.info(`  - Locations (non-landmark): ${(visualBible?.locations || []).filter(l => !l.isRealLandmark).length}`);

  // Log each element with page appearances for debugging
  const logEntries = (entries, type) => {
    for (const e of entries || []) {
      const pages = e.appearsInPages || e.pages || [];
      const status = pages.length >= minAppearances ? '✓' : '✗';
      log.debug(`  ${status} ${type}: "${e.name}" pages=[${pages.join(',')}] (${pages.length} appearances)`);
    }
  };
  logEntries(visualBible?.secondaryCharacters, 'char');
  logEntries(visualBible?.artifacts, 'artifact');
  logEntries(visualBible?.animals, 'animal');
  logEntries(visualBible?.vehicles, 'vehicle');
  logEntries((visualBible?.locations || []).filter(l => !l.isRealLandmark), 'location');

  // Import the function here to avoid circular dependency
  const { getElementsNeedingReferenceImages, updateElementReferenceImage } = require('./visualBible');

  // Get elements that need reference images
  let needsReference = getElementsNeedingReferenceImages(visualBible, minAppearances, characterMinAppearances);

  // Observability: how many secondary CHARACTER references we're generating.
  // These are the extra image-gen calls the "every secondary gets its own
  // face" fix introduces — log them so cost/latency is traceable in Railway.
  const secondaryCharRefs = needsReference.filter(e => e.type === 'character');
  if (secondaryCharRefs.length > 0) {
    log.info(`[REF-SHEET] 🧑 ${secondaryCharRefs.length} secondary CHARACTER reference(s) — each secondary gets its own face so none inherits the primary's identity: ${secondaryCharRefs.map(e => `${e.name} (${e.pageCount}p)`).join(', ')}`);
  }

  // Limit elements if maxElements specified (trial mode)
  if (maxElements && needsReference.length > maxElements) {
    // Sort by page count descending, then alphabetically
    needsReference.sort((a, b) => b.pageCount - a.pageCount || a.name.localeCompare(b.name));
    needsReference.length = maxElements;
    log.info(`[REF-SHEET] Limited to top ${maxElements} elements (trial mode)`);
  }

  if (needsReference.length === 0) {
    log.info('[REF-SHEET] No elements need reference images (none with 2+ page appearances)');
    return { generated: 0, failed: 0, elements: [] };
  }

  log.info(`[REF-SHEET] 🎨 Generating reference images for ${needsReference.length} element(s)`);
  log.info(`[REF-SHEET] Elements: ${needsReference.map(e => `${e.name} (${e.type}, ${e.pageCount} pages)`).join(', ')}`);

  let generated = 0;
  let failed = 0;
  const processedElements = [];

  // Batch elements into grids, balancing across batches so we never end up
  // with a lone-element batch (which costs a full generation for 1 output
  // and leaves no "neighbours" for the splitter to calibrate against).
  // With N total and max per batch M: batchCount = ceil(N/M), perBatch =
  // ceil(N/batchCount). Then distribute N elements across batchCount slots
  // as evenly as possible.
  //   N=5, M=4 → 2 batches of 3,2   (was 4,1)
  //   N=6, M=4 → 2 batches of 3,3   (was 4,2)
  //   N=9, M=4 → 3 batches of 3,3,3 (was 4,4,1)
  const batches = [];
  const N = needsReference.length;
  const batchCount = Math.max(1, Math.ceil(N / maxPerBatch));
  const basePer = Math.floor(N / batchCount);
  const remainder = N - basePer * batchCount; // first `remainder` batches get +1
  let cursor = 0;
  for (let b = 0; b < batchCount; b++) {
    const size = basePer + (b < remainder ? 1 : 0);
    batches.push(needsReference.slice(cursor, cursor + size));
    cursor += size;
  }

  log.info(`[REF-SHEET] Processing ${batches.length} batch(es) — sizes: ${batches.map(b => b.length).join(', ')}`);

  // Capture source grids per batch so callers can persist them for debugging.
  // The grid image is normally discarded after splitting — keep it for the
  // dev panel so users can see what got cut and verify the splitter is right.
  const sourceGrids = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    log.info(`[REF-SHEET] Batch ${batchIdx + 1}/${batches.length}: ${batch.length} elements`);

    try {
      // Build the prompt for this batch
      const prompt = buildReferenceSheetPrompt(batch, styleDescription);

      // Generate the grid image using the configured image model (Gemini, Grok, etc.)
      const imageModelOverride = imageModel || null;
      const result = await callGeminiAPIForImage(prompt, [], null, 'avatar', null, imageModelOverride, null, '');

      if (!result || !result.imageData) {
        throw new Error('Image generation did not return an image');
      }

      // Extract base64 from data URI
      const gridImageData = r2Lib.stripDataUriPrefix(result.imageData);

      log.info(`[REF-SHEET] ✓ Generated ${batch.length}-element grid (${Math.round(gridImageData.length / 1024)}KB)`);

      // Capture the source grid for debugging (caller persists it)
      sourceGrids.push({
        batchIdx,
        imageData: result.imageData,
        elementNames: batch.map(e => `${e.name} (${e.type})`),
        elementIds: batch.map(e => e.id),
      });

      // Split grid into individual references
      const references = await splitGridIntoReferences(gridImageData, batch.length);

      // Update Visual Bible with extracted references. When storyId is set,
      // each reference is also uploaded to R2 in parallel; the URL lands on
      // the VB entry as referenceImageUrl.
      const r2Uploads = saveVbReferenceToR2
        ? await Promise.all(batch.map(async (element, i) => {
            const refImage = references[i];
            if (!refImage) return { id: element.id, url: null };
            const url = await saveVbReferenceToR2(storyId, element.id, refImage);
            return { id: element.id, url };
          }))
        : [];
      const urlById = new Map(r2Uploads.map(({ id, url }) => [id, url]));
      for (let i = 0; i < batch.length; i++) {
        const element = batch[i];
        const refImage = references[i];

        if (refImage) {
          updateElementReferenceImage(visualBible, element.id, `data:image/png;base64,${refImage}`, urlById.get(element.id) || null);
          generated++;
          processedElements.push({
            id: element.id,
            name: element.name,
            type: element.type,
            success: true
          });
        } else {
          failed++;
          processedElements.push({
            id: element.id,
            name: element.name,
            type: element.type,
            success: false,
            error: 'Failed to extract from grid'
          });
        }
      }
    } catch (err) {
      log.error(`[REF-SHEET] ❌ Batch ${batchIdx + 1} failed: ${err.message}`);

      // Mark all elements in batch as failed
      for (const element of batch) {
        failed++;
        processedElements.push({
          id: element.id,
          name: element.name,
          type: element.type,
          success: false,
          error: err.message
        });
      }
    }
  }

  log.info(`[REF-SHEET] Complete: ${generated} generated, ${failed} failed`);

  return {
    generated,
    failed,
    elements: processedElements,
    sourceGrids,  // Source grid images per batch — caller persists for debugging
  };
}

// =============================================================================
// VISUAL BIBLE GRID BUILDER
// Combines VB elements and secondary landmarks into a single labeled grid image
// =============================================================================

/**
 * Build a labeled grid image combining Visual Bible elements and secondary landmarks
 * This reduces API image count by combining multiple references into one grid
 *
 * @param {Array} vbElements - Elements from getElementReferenceImagesForPage()
 *   Each element: { name, type, referenceImageData, description }
 * @param {Array} secondaryLandmarks - Secondary landmark photos (2nd+ landmarks)
 *   Each landmark: { name, photoData }
 * @returns {Promise<Buffer|null>} - JPEG buffer of the grid image, or null if no elements
 */
/**
 * Build a VB grid filtered for EMPTY SCENE generation: vehicles + non-landmark locations only.
 * Skips characters, animals, and artifacts (these belong on the populated page, not the
 * empty background — and including artifacts caused doubling, e.g. a book rendered both
 * in the background and later in the character's hand).
 *
 * @param {Object} visualBible - Story visual bible
 * @param {number} pageNumber - Page number to filter elements for
 * @param {Array} pageLandmarkPhotos - Landmark photos already loaded for this page
 * @returns {Promise<Buffer|null>} VB grid buffer (with rawElements property), or null if empty
 */
async function buildEmptySceneVbGrid(visualBible, pageNumber, pageLandmarkPhotos = []) {
  if (!visualBible) return null;
  const { getEmptySceneElementReferences } = require('./visualBible');
  const vehicleAndLocationRefs = getEmptySceneElementReferences(visualBible, pageNumber, 9);
  const secondaryLandmarks = (pageLandmarkPhotos || []).slice(1);
  if (vehicleAndLocationRefs.length === 0 && secondaryLandmarks.length === 0) return null;
  return buildVisualBibleGrid(vehicleAndLocationRefs, secondaryLandmarks);
}

/**
 * Composite references for a PAGE render: which VB elements + landmarks go
 * into the grid, with the canonical filter rules (single source of truth —
 * the iterate path and the Test Lab image stage both call this):
 *   - background plate set → vehicles/locations/landmarks are already painted
 *     into the plate; drop them all.
 *   - other refs present (original image, landmark photos) → drop locations
 *     only (the location anchor is covered), keep the rest.
 * Returns { visualBibleGrid, landmarkPhotos } — landmarkPhotos is what the
 * caller should pass to image generation (emptied when the plate covers it).
 */
async function buildPageCompositeRefs(visualBible, pageNumber, landmarkPhotos = [], { hasBackground = false, hasOtherRefs = false, logTag = 'PAGE-REFS' } = {}) {
  const { getElementReferenceImagesForPage } = require('./visualBible');
  let elementReferences = getElementReferenceImagesForPage(visualBible, pageNumber, 6);
  let secondaryLandmarks = (landmarkPhotos || []).slice(1);
  let finalLandmarkPhotos = landmarkPhotos || [];
  if (hasBackground) {
    elementReferences = elementReferences.filter(e => e.type !== 'vehicle' && e.type !== 'location');
    secondaryLandmarks = [];
    finalLandmarkPhotos = [];
    log.debug(`🔲 [${logTag}] Page ${pageNumber}: sceneBackground set — dropping vehicles/locations/landmarks from composite refs`);
  } else if (hasOtherRefs || (landmarkPhotos || []).length > 0) {
    elementReferences = elementReferences.filter(e => e.type !== 'location');
  }
  let visualBibleGrid = null;
  if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
    visualBibleGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
  }
  return { visualBibleGrid, landmarkPhotos: finalLandmarkPhotos };
}

async function buildVisualBibleGrid(vbElements = [], secondaryLandmarks = [], options = {}) {
  // stripLabels: 'all' (default, or `true`) omits the text strip on every cell.
  // Characters now flow as separate cropped cell-refs (see images.js:7633), so
  // the in-grid name caption is redundant for them — and prior behaviour leaked
  // the text into the generated illustration (model "copying" the caption into
  // the painted scene). 'none' keeps labels on every cell (legacy). 'generic'
  // keeps labels only on proper-named entities (legacy mid-state).
  const stripLabelsRaw = options.stripLabels;
  const labelMode = stripLabelsRaw === 'none'
    ? 'none'
    : stripLabelsRaw === 'generic'
      ? 'generic'
      : 'all'; // default
  const NAMED_TYPES = new Set(['character', 'landmark']);
  const shouldDropLabel = (el) => {
    if (labelMode === 'all') return true;
    if (labelMode === 'none') return false;
    return !NAMED_TYPES.has(el.type);
  };
  const allElements = [];

  // Add VB elements (secondary chars, animals, artifacts, vehicles, locations).
  // loadVbReferenceBytes returns base64; wrap as a data URI so the grid
  // composer treats every entry uniformly.
  //
  // For CHARACTER entries whose reference image is a 2×4 sheet (Phase 5/6/7
  // makes every character avatar a 2×4 now), crop a single appropriate cell:
  await Promise.all(vbElements.map(async (el) => {
    if (!el.referenceImageData && !el.referenceImageUrl) return;
    const bytes = await loadVbReferenceBytes(el);
    if (!bytes) return;
    const imageData = `data:image/jpeg;base64,${bytes}`;
    allElements.push({ name: el.name, type: el.type, imageData });
  }));

  // Add secondary landmarks (2nd+ go in grid, 1st stays as separate photo).
  // Try photoUrl first, fall back to photoData when URL can't be loaded.
  for (const lm of secondaryLandmarks) {
    const candidates = [lm?.photoUrl, lm?.photoData].filter(s => typeof s === 'string' && s.length > 0);
    if (candidates.length === 0) continue;
    let buf = null;
    for (const source of candidates) {
      try { buf = await r2Lib.bytesFromAnyImage(source); if (buf) break; } catch { /* try next */ }
    }
    if (!buf) continue;
    allElements.push({
      name: lm.name,
      type: 'landmark',
      imageData: `data:image/jpeg;base64,${buf.toString('base64')}`
    });
  }

  if (allElements.length === 0) {
    return null;
  }

  // Max 9 elements (4 right column + 5 bottom row in Grok's bordered scene layout)
  const gridElements = allElements.slice(0, 9);
  if (allElements.length > 9) {
    const dropped = allElements.slice(9).map(e => `${e.name} (${e.type})`).join(', ');
    log.warn(`⚠️ [VB-GRID] Grid overflow: ${allElements.length} elements, keeping first 9, dropping: ${dropped}`);
  }

  // Single element: return the image directly with a small label strip on top.
  // No grid wrapper, no dark background, no wasted space.
  if (gridElements.length === 1) {
    try {
      const el = gridElements[0];
      const base64Data = r2Lib.stripDataUriPrefix(el.imageData);
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const resized = await sharp(imageBuffer)
        .resize({ width: 512, withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });
      if (shouldDropLabel(el)) {
        const gridBuffer = await sharp(resized.data).jpeg({ quality: 85 }).toBuffer();
        log.info(`🔲 [VB-GRID] Single element (label dropped, ${labelMode}): ${el.name} (${el.type}), ${resized.info.width}x${resized.info.height}px, ${Math.round(gridBuffer.length / 1024)}KB`);
        gridBuffer.rawElements = gridElements;
        return gridBuffer;
      }
      const labelHeight = 24;
      const totalHeight = resized.info.height + labelHeight;
      const labelText = `${el.name} (${el.type})`;
      const displayText = escapeXml(labelText.length > 40 ? labelText.substring(0, 37) + '...' : labelText);
      const labelSvg = `<svg width="512" height="${labelHeight}">
        <rect width="512" height="${labelHeight}" fill="#555"/>
        <text x="256" y="17" font-family="Arial, sans-serif" font-size="13" fill="white" text-anchor="middle">${displayText}</text>
      </svg>`;
      const gridBuffer = await sharp({
        create: { width: 512, height: totalHeight, channels: 3, background: { r: 255, g: 255, b: 255 } }
      })
        .composite([
          { input: Buffer.from(labelSvg), left: 0, top: 0 },
          { input: resized.data, left: 0, top: labelHeight },
        ])
        .jpeg({ quality: 85 })
        .toBuffer();
      log.info(`🔲 [VB-GRID] Single element: ${el.name} (${el.type}), ${512}x${totalHeight}px, ${Math.round(gridBuffer.length / 1024)}KB`);
      gridBuffer.rawElements = gridElements;
      return gridBuffer;
    } catch (err) {
      log.warn(`⚠️ [VB-GRID] Single element layout failed: ${err.message}, falling back to stack`);
    }
  }

  // Multi-element: single column vertical stack — each element gets full width.
  // Cells touch directly (gap=0) on a pure-white background — Grok was picking
  // up the prior dark-gray (rgb 50,50,50) inter-cell gap as a "frame" and
  // baking it into the rendered page as a gray border around the illustration.
  // The image-generation + empty-scene prompts already specify "edge-to-edge,
  // no borders, pure white background" — match those in the reference grid too
  // so Grok has nothing border-like to copy.
  const cellWidth = 512;
  const labelHeight = 28;
  const gap = 0;

  log.debug(`🔲 [VB-GRID] Building vertical stack with ${gridElements.length} elements`);

  try {
    // First pass: resize all images and calculate total height
    const resizedElements = [];
    for (const el of gridElements) {
      const base64Data = r2Lib.stripDataUriPrefix(el.imageData);
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const resized = await sharp(imageBuffer)
        .resize({ width: cellWidth, withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });
      resizedElements.push({ el, buffer: resized.data, width: resized.info.width, height: resized.info.height });
    }

    const gridWidth = cellWidth;
    // Per-cell label decision is made up front so the height calc matches the
    // composites we emit below.
    const cellLayout = resizedElements.map(r => ({ ...r, drop: shouldDropLabel(r.el) }));
    const gridHeight = cellLayout.reduce((sum, r) => sum + r.height + (r.drop ? 0 : labelHeight) + gap, 0) - gap;

    // Create composite operations — stack vertically
    const composites = [];
    let y = 0;
    let droppedCount = 0;
    for (const { el, buffer, height, drop } of cellLayout) {
      if (drop) {
        droppedCount++;
      } else {
        // Label above the image
        const labelText = `${el.name} (${el.type})`;
        const displayText = escapeXml(labelText.length > 40 ? labelText.substring(0, 37) + '...' : labelText);
        const labelSvg = `
          <svg width="${cellWidth}" height="${labelHeight}">
            <rect width="${cellWidth}" height="${labelHeight}" fill="#333"/>
            <text x="${cellWidth / 2}" y="20" font-family="Arial, sans-serif" font-size="14"
                  fill="white" text-anchor="middle">${displayText}</text>
          </svg>
        `;
        composites.push({ input: Buffer.from(labelSvg), left: 0, top: y });
        y += labelHeight;
      }

      // Image below the label (or at top if labels stripped)
      composites.push({ input: buffer, left: 0, top: y });
      y += height + gap;
    }
    if (droppedCount > 0) {
      log.info(`🔲 [VB-GRID] Dropped labels for ${droppedCount}/${cellLayout.length} cells (mode=${labelMode})`);
    }

    // Create base image and composite all elements on PURE WHITE bg —
    // see the gap=0 comment above for why this is white, not gray.
    const gridBuffer = await sharp({
      create: {
        width: gridWidth,
        height: gridHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    })
      .composite(composites)
      .jpeg({ quality: 85 })
      .toBuffer();

    log.info(`🔲 [VB-GRID] Created vertical stack: ${gridElements.length} elements, ${gridWidth}x${gridHeight}px, ${Math.round(gridBuffer.length / 1024)}KB`);

    // Attach raw elements so Grok's packReferences can lay them out individually
    // around the empty scene (256x256 cells in a right column + bottom row).
    // Buffers are mutable objects in Node, so adding a property is safe and the
    // buffer continues to behave like a normal Buffer for image consumers.
    gridBuffer.rawElements = gridElements;

    return gridBuffer;
  } catch (error) {
    log.error(`❌ [VB-GRID] Failed to build grid: ${error.message}`);
    return null;
  }
}

module.exports = {
  splitGridIntoReferences,
  buildReferenceSheetPrompt,
  generateReferenceSheet,
  buildEmptySceneVbGrid,
  buildPageCompositeRefs,
  buildVisualBibleGrid,
};

const { photoAnalyzerUrl } = require('./photoAnalyzerClient');
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
const { loadVbReferenceBytes } = require('./characterPhotos');
const { escapeXml } = require('./repairGrid');

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
  const analyzerBase = photoAnalyzerUrl();
  try {
    const response = await fetch(`${analyzerBase}/split-reference-sheet`, {
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
function buildReferenceSheetPrompt(elements, styleDescription, visualBible = null) {
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
    // A reference image carries POSE, not just appearance: reference-conditioned
    // models reproduce a referenced object's exact appearance AND pose whatever
    // the instruction says (OminiControl arXiv:2411.15098; leakage/shortcut in
    // RetriBooru arXiv:2312.02521), and neither Grok nor Gemini exposes a
    // conditioning-strength dial to trade fidelity for pose freedom. Measured:
    // every prop reference in staging job_1787514666616_yw9qsv1vf rendered flat
    // and face-up, and 7 of 7 pages holding one reproduced that pose, including
    // a page whose brief asked for the opposite.
    //
    // So the side a face-prop shows has to come from the reference. Since
    // 2026-08-26 that is expressed as TWO bible entries — "(turned away)" and
    // "(face to camera)" — each with its own description and therefore its own
    // reference image, which the Art Director selects between per page through
    // objects[]. Nothing to override in the cell: the entry's own description
    // already says which side it is. This replaced a `referenceView` field that
    // appended the closed state to a single entry; two entries do the same job
    // and also put the orientation into the page prompt.
    // A solo call has no position to name — a bare "Row 1:" prefix is a stringy
    // label on an image with nothing to index.
    return count === 1 ? desc : `${pos}: ${desc}`;
  });

  // Describe the grid in natural language. Passing literal digit-strings like
  // "2x2" used to bake "2x2" onto the rendered image (the model treated it as
  // a label). Use words for the count and an explicit row/column phrase so the
  // model never sees a stringy template token to copy.
  const numWord = (n) => ['', 'one', 'two', 'three', 'four', 'five', 'six'][n] || String(n);
  const gridShapePhrase = count === 1
    ? 'single full-frame illustration with no grid and no dividing lines'
    : (cols === 2 && rows === 2)
      ? 'square grid with two rows and two columns (four cells total)'
      : (cols === 1)
        ? `single vertical column with ${numWord(rows)} cell${rows === 1 ? '' : 's'} stacked top-to-bottom`
        : `${numWord(rows)}-row by ${numWord(cols)}-column grid`;

  // A ONE-element call must not ask for gridlines. The template is written for
  // a sheet — "cells separated by thick black gridlines", three times over —
  // and a single-cell render obeys it: a solo VEH001 render came back with a
  // black grid painted across the ship, which would then ride onto every page
  // using that reference. The separator language is therefore parametrised and
  // dropped when there is nothing to separate. This also fixes the pre-existing
  // single-element re-render in the character cell gate below.
  const gridSeparation = count > 1
    ? ' Cells are separated by thick, perfectly straight black gridlines so each cell can be cropped out cleanly.'
    : '';
  const cellLayoutReq = count > 1
    ? '- Equal-sized cells separated by thick straight black gridlines'
    : '- The element fills the frame; no gridlines, borders or dividing lines anywhere in the image';
  const closing = count > 1
    ? 'Generate as a single image with equal-sized cells arranged exactly as described in the LAYOUT above. Thick black gridlines separate every cell so each cell can be extracted cleanly.'
    : 'Generate as a single image showing that one element edge to edge, with no gridlines, borders or dividing lines.';

  // Cross-cell bleed backstop. A cell description that declares lettering on
  // its own element ("the name painted on the hull") made the model render
  // legible words in a NEIGHBOURING cell too — a map cell whose own description
  // says its script is illegible came back carrying readable handwriting copied
  // from the sibling's clause. Lettering elements are quarantined into solo
  // calls upstream (buildReferenceSheetBatches), so a multi-cell prompt should
  // no longer contain such a clause; this line is the backstop for the case
  // where one slips through. Solo calls omit it so an element whose own bible
  // entry declares lettering can still render it.
  // The value carries its own leading newline so the empty case leaves no gap.
  const batchGuard = count > 1
    ? '\n- Each cell shows only its own element, never anything described for another cell, and no lettering or readable words anywhere'
    : '';

  const prompt = fillTemplate(PROMPT_TEMPLATES.referenceSheet, {
    STYLE_DESCRIPTION: styleDescription,
    GRID_SHAPE_PHRASE: gridShapePhrase,
    GRID_LAYOUT: gridLayoutLines.join('\n'),
    BATCH_GUARD: batchGuard,
    GRID_SEPARATION: gridSeparation,
    CELL_LAYOUT_REQ: cellLayoutReq,
    CLOSING: closing,
  });

  // VB descriptions cross-reference each other by id ("shimmer matching
  // ART001"), and those ids land in the cell line verbatim. An unsanitized id
  // reaching an image model gets painted as lettering — the same setup on the
  // empty-scene path lettered "ART008" onto a stone in a shipped story. Lazy
  // require: promptBuilders pulls in services/prompts at load.
  if (!visualBible) return prompt;
  const { sanitizeVbIdsInPrompt } = require('./promptBuilders');
  return sanitizeVbIdsInPrompt(prompt, visualBible, null);
}

// ── Character-cell render gate ──────────────────────────────────────────────
// VB reference cells are generated with the quality evaluator deliberately
// skipped (avatar path in images.js), yet each CHARACTER cell then feeds every
// page its character appears on — one bad render poisons them all (a
// green-skinned comic-style cell reached 4 pages of job_1788123310558 before
// anyone looked). Minimal gate (owner, 2026-08-31): ONE yes/no question on the
// cheapest vision-capable TEXT_MODELS entry, one re-render on NO, then accept
// whatever came back. No scores, no thresholds, no loops; fail-open on any API
// error — the gate may never block a story.
async function checkCharacterCellRender(cellBase64, styleDescription = '', age = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured (GEMINI_API_KEY)');
  const { TEXT_MODELS } = require('../config/models');
  const cfg = TEXT_MODELS['gemini-2.5-flash-lite'];
  // The style anchor is load-bearing: without it flash-lite judged the known-bad
  // green-skinned comic cell "natural" (validated 2026-08-31 against the stored
  // job_1788123310558 cell — NO with the anchor, YES without).
  const ageClause = age ? ` (3) Apparent age: does the figure look about ${age}? A visibly older or younger rendering fails.` : '';
  const prompt = `You are checking one cell cut from a character reference sheet for an illustrated children's book. The book's declared art style: "${styleDescription}". Judge strictly: (1) Is the figure's skin a plausible human skin color — not green-, gray- or blue-tinted? (2) Is the cell actually rendered in the declared art style, not a different one (for example flat comic-book or graphic-novel shading when the declared style is painterly watercolor)?${ageClause} If any check fails, natural is false. Reply as JSON: {"natural": true or false, "reason": "one short sentence"}`;
  const body = {
    contents: [{ parts: [
      { inlineData: { mimeType: 'image/png', data: cellBase64 } },
      { text: prompt },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: 'application/json' },
  };
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.modelId}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }
  );
  if (!resp.ok) throw new Error(`cell render gate HTTP ${resp.status}`);
  const j = await resp.json();
  const usage = j?.usageMetadata;
  if (usage) {
    const { recordTextUsage } = require('./usageContext');
    recordTextUsage('gemini_text', { input_tokens: usage.promptTokenCount || 0, output_tokens: usage.candidatesTokenCount || 0 }, 'vb_cell_gate', cfg.modelId);
  }
  const raw = String(j?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  // flash-lite occasionally emits two JSON objects back-to-back despite
  // responseMimeType — strict parse first, then the first {…} span.
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*?\}/);
    parsed = JSON.parse(m ? m[0] : raw);
  }
  return { natural: parsed.natural !== false, reason: String(parsed.reason || '') };
}

/**
 * Group elements into generation batches.
 *
 * Every cell of a batch is described in ONE prompt to ONE generation call, so a
 * clause belonging to one cell can bleed into another. Measured on staging
 * job_1788295892348_l028ggiq7a: a vehicle entry declaring its name as painted
 * stern lettering shared a sheet with a map entry whose own description says its
 * script is illegible — and the stored map reference came back carrying legible
 * handwriting lifted from the vehicle's clause. Every page using that map
 * inherited the text.
 *
 * So entries whose OWN description declares their name as lettering on the
 * element (vbDeclaredLetteringNames — typically 0-2 per story) are quarantined:
 * each gets its own single-cell call, where its lettering can only land on
 * itself. Everything else batches exactly as before, balanced so no batch is
 * left with a lone element:
 *   N=5, M=4 → 3,2   N=6, M=4 → 3,3   N=9, M=4 → 3,3,3
 *
 * @param {Array} needsReference - Elements from getElementsNeedingReferenceImages
 * @param {Object|null} visualBible - Story visual bible (source of the lettering declarations)
 * @param {number} maxPerBatch - Maximum elements per grid
 * @returns {Array<Array>} Batches, in generation order (batched groups, then solo cells)
 */
function buildReferenceSheetBatches(needsReference, visualBible, maxPerBatch = 4) {
  const { vbDeclaredLetteringNames } = require('./promptBuilders');
  const letteringNames = vbDeclaredLetteringNames(visualBible);

  const solo = [];
  // Characters and non-characters (locations/vehicles/artifacts/animals) never
  // share a batch: a batch renders as ONE grid image at ONE aspect ratio, and
  // characters want the tall avatarAspect portrait while everything else wants
  // to match the page/plate aspect (see the elementAspect option below) — a
  // mixed batch couldn't honour both.
  const batchableChars = [];
  const batchableOther = [];
  for (const el of needsReference) {
    const name = String((el && el.name) || '').trim().toLowerCase();
    if (name && letteringNames.has(name)) { solo.push(el); continue; }
    (el.type === 'character' ? batchableChars : batchableOther).push(el);
  }

  const chunk = (list) => {
    const chunks = [];
    const N = list.length;
    if (N === 0) return chunks;
    const batchCount = Math.max(1, Math.ceil(N / maxPerBatch));
    const basePer = Math.floor(N / batchCount);
    const remainder = N - basePer * batchCount; // first `remainder` batches get +1
    let cursor = 0;
    for (let b = 0; b < batchCount; b++) {
      const size = basePer + (b < remainder ? 1 : 0);
      chunks.push(list.slice(cursor, cursor + size));
      cursor += size;
    }
    return chunks;
  };

  const batches = [...chunk(batchableChars), ...chunk(batchableOther)];
  for (const el of solo) batches.push([el]);

  return batches;
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
    // Artifacts qualify on a single page too (owner, 2026-08-20). A prop with
    // no reference is drawn from prose alone, so two renders of the same object
    // have nothing anchoring them to each other.
    artifactMinAppearances = 1,
    maxPerBatch = 4,
    imageModel = null,
    maxElements = null,
    storyId = null,    // when present, each generated reference image is
                       // uploaded to R2 and the URL is stored on the VB entry.
    // Aspect ratio for non-character element grids (locations/vehicles/
    // artifacts/animals) — should be the story's actual page/plate aspect
    // (e.g. MODEL_DEFAULTS.pageAspect, or square for a square-format book).
    // Character batches are unaffected and keep the avatarAspect portrait.
    // Falls back to MODEL_DEFAULTS.pageAspect (via resolveOutputAspect) if
    // the caller doesn't pass one.
    //
    // Why this exists: every element used to render at avatarAspect (9:16),
    // including locations and vehicles, because the whole grid call used
    // evaluationType='avatar'. A location/vehicle element that's the ONLY
    // reference for an empty-scene plate then gets fit into composeVbSlot's
    // single-cell slot with `fit:'contain'` — a 9:16 source can't fill a
    // squarer target without white pillar bars, and Grok's edit echoes that
    // padded composition straight into the plate (and from there into the
    // page). Reproduced live on staging job_1788471969309_9cg9dqyirre p12:
    // its sole location element rendered at 365x641 (9:16), producing a
    // plate whose painted content filled only ~59% of a 1024x1024 canvas.
    elementAspect = null,
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
  let needsReference = getElementsNeedingReferenceImages(visualBible, minAppearances, characterMinAppearances, artifactMinAppearances);

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

  // Batch elements into grids — balanced, with declared-lettering elements
  // quarantined into solo calls (see buildReferenceSheetBatches).
  const batches = buildReferenceSheetBatches(needsReference, visualBible, maxPerBatch);
  const letteringNames = require('./promptBuilders').vbDeclaredLetteringNames(visualBible);
  const soloNames = needsReference
    .map(e => e.name)
    .filter(n => letteringNames.has(String(n || '').trim().toLowerCase()));
  if (soloNames.length > 0) {
    log.info(`[REF-SHEET] ✍️ Solo cell(s) — the bible declares lettering on these, so they never share a prompt: ${soloNames.join(', ')}`);
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
      const prompt = buildReferenceSheetPrompt(batch, styleDescription, visualBible);

      // Generate the grid image using the configured image model (Gemini, Grok, etc.)
      const imageModelOverride = imageModel || null;
      // Batches are type-homogeneous (buildReferenceSheetBatches never mixes
      // characters with locations/vehicles/artifacts/animals), so one check
      // on the first element decides the whole batch. evaluationType stays
      // 'avatar' for every batch (preserves the existing eval-skip / no-retry
      // behaviour for one-shot reference grids) — only the aspect changes.
      const isCharacterBatch = batch[0]?.type === 'character';
      const batchAspectOverride = isCharacterBatch ? null : elementAspect;
      const result = await callGeminiAPIForImage(
        prompt, [], null, 'avatar', null, imageModelOverride, null, '',
        null, [], 0, null, null, null, null, batchAspectOverride
      );

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

      // Gate CHARACTER cells only (not artifacts/locations/animals) — see
      // checkCharacterCellRender above. One check, one re-render on NO, one
      // re-check for the log, then accept whatever came back.
      const genLog = require('./generationLogger').getCurrentLogger();
      for (let i = 0; i < batch.length; i++) {
        const element = batch[i];
        if (element.type !== 'character' || !references[i]) continue;
        let verdict;
        try {
          verdict = await checkCharacterCellRender(references[i], styleDescription, element.age || null);
        } catch (err) {
          log.warn(`⚠️ [REF-SHEET] Cell render gate errored for "${element.name}" (${err.message}) — accepting cell unchecked`);
          continue;
        }
        if (verdict.natural) continue;
        log.warn(`⚠️ [REF-SHEET] Character cell "${element.name}" failed render gate: ${verdict.reason} — re-rendering once`);
        genLog?.warn('vb_character_cell_rerender', `VB reference cell failed render gate: ${verdict.reason}`, element.name);
        try {
          const rePrompt = buildReferenceSheetPrompt([element], styleDescription, visualBible);
          const reResult = await callGeminiAPIForImage(rePrompt, [], null, 'avatar', null, imageModelOverride, null, '');
          if (!reResult?.imageData) throw new Error('re-render returned no image');
          const reCell = (await splitGridIntoReferences(r2Lib.stripDataUriPrefix(reResult.imageData), 1))[0];
          if (!reCell) throw new Error('re-rendered cell extraction failed');
          references[i] = reCell;
          try {
            const recheck = await checkCharacterCellRender(reCell, styleDescription, element.age || null);
            if (!recheck.natural) {
              log.warn(`⚠️ [REF-SHEET] Re-rendered cell for "${element.name}" still fails gate (${recheck.reason}) — accepting it anyway`);
              genLog?.warn('vb_character_cell_still_bad', `Re-rendered cell still fails render gate (${recheck.reason}) — accepted anyway`, element.name);
            } else {
              log.info(`✓ [REF-SHEET] Re-rendered cell for "${element.name}" passes render gate`);
            }
          } catch { /* re-check is informational only — accept */ }
        } catch (err) {
          log.warn(`⚠️ [REF-SHEET] Re-render failed for "${element.name}" (${err.message}) — keeping original cell`);
        }
      }

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
 * @param {string|null} aboardId - VB id of the element the camera stands on/inside;
 *   its render is dropped from the grid (an exterior view corrupts an aboard plate)
 * @param {Array|null} sceneObjects - The scene's AD metadata objects[] list. When
 *   supplied, a VEHICLE enters the grid only if this list names its VEH id — the
 *   AD brief, not the VB pages array, decides what is in frame (owner, 2026-09-04).
 *   Must be the same list the caller passes to buildEmptyScenePrompt so the prompt
 *   text and the attached reference agree.
 * @returns {Promise<Buffer|null>} VB grid buffer (with rawElements property), or null if empty
 */
async function buildEmptySceneVbGrid(visualBible, pageNumber, pageLandmarkPhotos = [], aboardId = null, sceneObjects = null) {
  if (!visualBible) return null;
  // ONE reference family per plate (owner, 2026-08-29): a landmark photo when
  // the plate's location is a real landmark, otherwise the VB element
  // render(s). Never both — two competing "this is the place" references on the
  // same call make the model average them, and the photographic one wins on
  // colour while the render wins on construction. The landmark photo is the
  // stronger anchor, so it takes the slot and the grid is dropped.
  if ((pageLandmarkPhotos || []).length > 0) {
    log.debug(`🔲 [EMPTY-SCENE-GRID] Page ${pageNumber}: landmark photo attached — VB element grid dropped (one reference family per plate)`);
    return null;
  }
  const { getEmptySceneElementReferences } = require('./visualBible');
  const vehicleAndLocationRefs = getEmptySceneElementReferences(visualBible, pageNumber, 9, aboardId, sceneObjects);
  // A landmark photo NEVER enters the grid (owner, 2026-08-18). The grid is a
  // composite of style-rendered element cells; pasting a real photograph among
  // them feeds photographic pixels into a stylised render and corrupts it —
  // worst in realistic/concept styles, where the model cannot tell the cell
  // from the target style. Every landmark travels as its own reference photo
  // on the empty-scene call, which is the one place a real photo belongs.
  if (vehicleAndLocationRefs.length === 0) return null;
  return buildVisualBibleGrid(vehicleAndLocationRefs, []);
}

/**
 * Composite references for a PAGE render: which VB elements + landmarks go
 * into the grid, with the canonical filter rules (single source of truth —
 * the iterate path and the Test Lab image stage both call this):
 *   - background plate set → vehicles/locations/landmarks are already painted
 *     into the plate; drop them all.
 *   - other refs present (original image, landmark photos) → drop locations
 *     only (the location anchor is covered), keep the rest.
 *   - `aboardId` set → the element the camera stands on/inside never enters the
 *     grid, plate or no plate. Its render is an exterior three-quarter view and
 *     an exterior image on a deck-level page paints a second copy of the vessel
 *     (decisions.md 2026-09-02). The prompt still names it.
 * Returns { visualBibleGrid, landmarkPhotos } — landmarkPhotos is what the
 * caller should pass to image generation (emptied when the plate covers it).
 */
async function buildPageCompositeRefs(visualBible, pageNumber, landmarkPhotos = [], { hasBackground = false, hasOtherRefs = false, logTag = 'PAGE-REFS', sceneObjectIds = null, aboardId = null } = {}) {
  const { getElementReferenceImagesForPage } = require('./visualBible');
  // Cap 4, not 6 (owner, 2026-08-29). The whole grid shares ONE of Grok's three
  // reference slots, so cell size scales as 1/n — a 6-cell grid renders each
  // element too small to carry identity. Census of staging
  // job_1787959478282_bz19gm36h: 10 of 14 pages selected 5-6 elements, and
  // every page spent cells on the vehicle and the locations its plate already
  // painted. The empty-scene grid keeps its own cap of 9
  // (buildEmptySceneVbGrid) — it is a different grid, sent to a call with no
  // character slots competing for space.
  let elementReferences = getElementReferenceImagesForPage(visualBible, pageNumber, 4, sceneObjectIds);
  // Landmarks never ride in the grid — a real photograph composited among
  // style-rendered cells corrupts a stylised render (owner, 2026-08-18). A
  // landmark reaches the image only as its own reference photo, and when a
  // plate is set it is already painted into the plate.
  let finalLandmarkPhotos = landmarkPhotos || [];
  if (hasBackground) {
    elementReferences = elementReferences.filter(e => e.type !== 'vehicle' && e.type !== 'location');
    finalLandmarkPhotos = [];
    log.debug(`🔲 [${logTag}] Page ${pageNumber}: sceneBackground set — dropping vehicles/locations/landmarks from composite refs`);
  } else if (hasOtherRefs || (landmarkPhotos || []).length > 0) {
    elementReferences = elementReferences.filter(e => e.type !== 'location');
  }
  if (aboardId) {
    const before = elementReferences.length;
    elementReferences = elementReferences.filter(e => e.id !== aboardId);
    if (elementReferences.length < before) {
      log.debug(`🔲 [${logTag}] Page ${pageNumber}: aboard ${aboardId} withheld from the grid (exterior render, deck-level page)`);
    }
  }
  let visualBibleGrid = null;
  if (elementReferences.length > 0) {
    visualBibleGrid = await buildVisualBibleGrid(elementReferences, []);
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
    // `recurring` rides through to packReferences, which guarantees a recurring
    // creature a minimum cell size in whatever slot it lands in.
    allElements.push({ id: el.id || null, name: el.name, type: el.type, imageData, recurring: !!el.recurring });
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
  checkCharacterCellRender,
  splitGridIntoReferences,
  buildReferenceSheetPrompt,
  buildReferenceSheetBatches,
  generateReferenceSheet,
  buildEmptySceneVbGrid,
  buildPageCompositeRefs,
  buildVisualBibleGrid,
};

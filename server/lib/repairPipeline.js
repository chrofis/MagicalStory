/**
 * The repair pipeline — the loop this whole subsystem exists to run.
 *
 * Split out of images.js 2026-08-09, unchanged. In the owner's words:
 *
 *     We generate an image, we score it. If bad we redo. We score the new one
 *     and take the better one.
 *
 * That is what runUnifiedRepairPipeline does, in five steps:
 *   1  evaluate every page (4 evaluators -> defects -> applyScore -> finalScore)
 *   1b mechanical garment-colour repair
 *   2  round loop: decideRepairMethod per bad page -> iterate | inpaint | char-fix,
 *      re-evaluate, push a new version
 *   3  pick the best version per page (highest finalScore; unscored cannot win)
 *   3b score anything still unscored, so every candidate has a number
 *   4  calm-zone / text-space recovery
 *   5  style-consistency audit
 *
 * ONE caller: server.js. Everything else here is internal.
 *
 * The generation and evaluation entry points it drives (generateImageOnly,
 * evaluateImageBatch, iteratePageCore, inpaintPage, the bbox detectors) are
 * required LAZILY from images.js — images.js does not import this module, so
 * the dependency runs one way, but a top-level require would still be a cycle
 * through the modules images.js itself pulls in.
 */

const { log } = require('../utils/logger');
const { MODEL_DEFAULTS, IMAGE_MODELS, REPAIR_DEFAULTS } = require('../config/models');
const { pickBestVersionIndex, applyScore, computeFinalScore } = require('./scoring');
const { decideRepairMethod, findBadPages } = require('./repairLogic');
const { sanitizeIssueForInpaint } = require('./imageCompositing');
const pLimit = require('p-limit');
const { getFacePhoto } = require('./characterPhotos');

const getStoryHelpers = () => require('./storyHelpers');
const images = () => require('./images');

function selectBestVersion(versions) {
  if (!versions || versions.length === 0) return null;
  if (versions.length === 1) return versions[0];

  // Same canonical loop as scoring.js pickBestVersionIndex, with the
  // pipeline-specific 'earliest' tie-break: when scores AND deduction totals
  // fully tie — typically all pinned at 0 on safety-fought stories — the
  // LAST repair round is the most content-mangled image, while the original
  // is the least-mangled (observed job_1781289599516: page 2 shipped
  // inpaint-round-3 score 0 instead of the original score 0). Interactive
  // flows use the default 'latest' (a user who just regenerated expects
  // their new version to show on a tie).
  const { pickBestVersionIndex } = require('./scoring');
  const bestIdx = pickBestVersionIndex(versions, { tieBreak: 'earliest' });
  return bestIdx >= 0 ? versions[bestIdx] : versions[0];
}

/**
 * Build a feedback suffix from evaluation results to inject into regen prompts.
 * Tells the image model what quality issues to fix in the next attempt.
 */
function buildRegenFeedback(evaluation) {
  if (!evaluation?.evaluated) return '';
  const parts = [];
  // Only include fixable issues (concise) — skip verbose reasoning (can be 5000+ chars)
  if (evaluation.fixableIssues?.length > 0) {
    // sanitizeIssueForInpaint: entity-grid vocabulary ("cells A, D, F") in an
    // issue description would otherwise reach the regeneration prompt.
    parts.push('IMPORTANT — Fix these issues from the previous attempt:\n' +
      evaluation.fixableIssues.map(i => `- ${sanitizeIssueForInpaint(i.description || i.issue || i)}`).join('\n'));
  }
  // Cap total feedback to 2000 chars to stay within prompt limits
  const feedback = parts.join('\n\n');
  return feedback.length > 2000 ? feedback.substring(0, 2000) + '\n...(truncated)' : feedback;
}

/**
 * Choose whether to inpaint or iterate a bad page.
 *
 * Philosophy: **default = repair** (inpaint). Iterate ONLY when the image is
 * total crap (fundamentally broken visual/semantic) or when repair has nothing
 * to act on. Repair is cheaper, preserves rendering, and is smarter for most
 * issues (extra hand, wrong framing, character pose nudge, etc.).
 *
 * Decision logic:
 *   1. Visual score < VISUAL_BROKEN_FLOOR → iterate (image is visually broken)
 *   2. Semantic score < SEMANTIC_BROKEN_FLOOR → iterate (image shows wrong scene)
 *   3. No inpaintable content (no quality/semantic issues, no fix targets) → iterate
 *   4. Otherwise → inpaint (default)
 *
 * @param {Object} evaluation - { qualityScore, semanticScore, fixableIssues, fixTargets, enrichedFixTargets, semanticResult }
 * @returns {{ strategy: 'inpaint'|'iterate', reason: string }}
 */
// DEAD CODE (audit 2026-07-09): never called — the real per-page router is
// decideRepairMethod() in repairLogic.js. Kept per user decision (mark, not
// delete). The frontend has a third, different chooseRepairStrategy of its own.
function chooseRepairStrategy(evaluation) {
  // Severity-driven repair routing:
  //   ≥1 CRITICAL  → iterate  (structural defect — missing character/object,
  //                            inverted leap direction, wrong setting; full
  //                            regen with fresh context has a real shot.
  //                            Inpaint chains 3 atomic-action instructions and
  //                            Grok regenerates the masked region from scratch,
  //                            usually losing other elements of the scene.)
  //   No CRITICAL  → inpaint  (cosmetic only — hair colour, ponytail, armor
  //                            material, facing direction. Targeted region
  //                            edits with explicit visual identifiers land
  //                            far more reliably than re-rolling the whole
  //                            scene and hoping the cosmetic drift goes away.)
  //
  // Counts CRITICALs across every source on the version: quality eval,
  // three-stage compliance, semantic. Severity casing varies by source
  // ('CRITICAL' / 'critical') so the match is case-insensitive. CATASTROPHIC
  // counts as critical-or-stronger — an exact 'critical' match let a lone
  // catastrophic issue fall through to inpaint.
  const isCritical = (s) => /catastrophic|critical/i.test(String(s || ''));
  const fixable = evaluation.fixableIssues || [];
  const semIssues = evaluation.semanticResult?.semanticIssues
    || evaluation.semanticResult?.issues
    || [];
  const criticalCount = fixable.filter(i => isCritical(i.severity)).length
    + semIssues.filter(i => isCritical(i.severity)).length;

  // Inpaint needs SOMETHING to act on — fixable issues, enriched targets,
  // raw fix targets, or semantic issues. If the version has none of these,
  // there's nothing to inpaint and we fall back to a full regen.
  const fixableCount = fixable.length;
  const enrichedCount = evaluation.enrichedFixTargets?.length || 0;
  const fixTargetCount = evaluation.fixTargets?.length || 0;
  const semanticIssueCount = semIssues.length;
  const hasInpaintableContent = fixableCount + enrichedCount + fixTargetCount + semanticIssueCount > 0;

  if (criticalCount > 0) {
    return { strategy: 'iterate', reason: `${criticalCount} CRITICAL — full regen` };
  }
  if (!hasInpaintableContent) {
    return { strategy: 'iterate', reason: 'no inpaintable content' };
  }

  const parts = [];
  if (fixableCount) parts.push(`${fixableCount} quality`);
  if (semanticIssueCount) parts.push(`${semanticIssueCount} semantic`);
  if (enrichedCount || fixTargetCount) parts.push(`${enrichedCount + fixTargetCount} targets`);
  return { strategy: 'inpaint', reason: `no CRITICAL — ${parts.join(', ') || 'cosmetic'}` };
}

/**
 * Force strategy switch when two consecutive repairs of the same kind have
 * already failed on this page. If the page is entering a new repair round
 * (meaning it's still bad) and the two previous rounds both used 'inpaint'
 * (or both used 'iterate'), flip to the other approach. A third attempt of
 * the same kind rarely succeeds where the first two didn't; swapping gives
 * the alternative strategy a real chance before we spend the round budget.
 *
 * Returns 'inpaint' | 'iterate' | null. null means don't force anything.
 */
function forcedStrategyAfterFailures(versions) {
  if (!Array.isArray(versions)) return null;
  const repairs = versions.filter(v =>
    v?.source && (v.source.startsWith('inpaint-') || v.source.startsWith('iterate-'))
  );
  if (repairs.length < 2) return null;
  const last = repairs.slice(-2);
  const strat = (v) => v.source.startsWith('inpaint-') ? 'inpaint' : 'iterate';
  if (strat(last[0]) !== strat(last[1])) return null;
  return strat(last[0]) === 'inpaint' ? 'iterate' : 'inpaint';
}

/**
 * If the most recent repair regressed the score (final image is worse than the
 * best version that existed BEFORE the repair), flip strategy. A regression
 * means the chosen approach actively damaged the image — repeating it is much
 * more likely to keep damaging it than to recover. Switch to the other approach
 * for the next round instead of waiting for two failures.
 *
 * Returns 'inpaint' | 'iterate' | null. null = no regression, no forced flip.
 */
function lastRepairRegressed(versions) {
  if (!Array.isArray(versions) || versions.length < 2) return null;
  const scoreOf = (v) => v?.evaluation?.score ?? v?.score ?? v?.qualityScore ?? null;
  // Find the most recent repair version and its index.
  let lastIdx = -1;
  for (let i = versions.length - 1; i >= 0; i--) {
    const src = versions[i]?.source || '';
    if (src.startsWith('inpaint-') || src.startsWith('iterate-')) { lastIdx = i; break; }
  }
  if (lastIdx <= 0) return null;
  const last = versions[lastIdx];
  const lastScore = scoreOf(last);
  if (lastScore == null) return null;
  let priorBest = -Infinity;
  for (let i = 0; i < lastIdx; i++) {
    const s = scoreOf(versions[i]);
    if (s != null && s > priorBest) priorBest = s;
  }
  if (!isFinite(priorBest)) return null;
  if (lastScore >= priorBest) return null;
  return last.source.startsWith('inpaint-') ? 'iterate' : 'inpaint';
}

/**
 * True when the page has already been through at least one inpaint AND at least
 * one iterate, and neither produced a better score than the pre-repair best.
 * Once both strategies have failed to improve, a third round is almost certain
 * to reproduce an earlier attempt — bail instead of spending the round budget.
 */
function bothStrategiesTriedAndRegressed(versions) {
  if (!Array.isArray(versions) || versions.length < 3) return false;
  const scoreOf = (v) => v?.evaluation?.score ?? v?.score ?? v?.qualityScore ?? null;
  let hasInpaint = false;
  let hasIterate = false;
  let repairBest = -Infinity;
  let preRepairBest = -Infinity;
  for (const v of versions) {
    const src = v?.source || '';
    const s = scoreOf(v);
    if (src.startsWith('inpaint-')) { hasInpaint = true; if (s != null && s > repairBest) repairBest = s; }
    else if (src.startsWith('iterate-')) { hasIterate = true; if (s != null && s > repairBest) repairBest = s; }
    else if (s != null && s > preRepairBest) preRepairBest = s;
  }
  if (!hasInpaint || !hasIterate) return false;
  if (!isFinite(preRepairBest)) return false;
  return repairBest <= preRepairBest;
}

function resolveCharBbox(charName, { bestEval, entityReport, pageNumber, imageData = null } = {}) {
  if (!charName || charName === 'UNKNOWN') {
    return { faceBbox: null, bodyBbox: null, source: null };
  }
  // When the caller says which bytes the box will be applied to, skip any
  // stored box stamped for different bytes (bboxPairsWith) — the entity
  // report can predate a repair and its boxes then point at the wrong spot
  // on the repaired pixels.
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
          return { faceBbox, bodyBbox, source: 'entity' };
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

  return { faceBbox: null, bodyBbox: null, source: null };
}

/**
 * Merge a per-round entity report (repaired pages only) into the working
 * report: issues on repaired pages are replaced by the fresh findings (absence
 * of a finding on a re-checked page means the new image is clean), untouched
 * pages keep their evidence. byClothing/garment channels stay from the base —
 * they are only consumed by the Step-1b garment fix, which runs before any
 * round. The merged view feeds decideRepairMethod; scores use era stamps.
 */
function mergeEntityIssues(base, fresh, repairedPages) {
  if (!base) return fresh;
  if (!fresh) return base;
  const pages = new Set(repairedPages);
  const merged = { ...base, characters: {}, timestamp: fresh.timestamp || base.timestamp };
  const names = new Set([...Object.keys(base.characters || {}), ...Object.keys(fresh.characters || {})]);
  let total = 0;
  for (const name of names) {
    const b = base.characters?.[name] || { issues: [] };
    const f = fresh.characters?.[name];
    const issues = [
      ...(b.issues || []).filter(i => !pages.has(i.pageNumber)),
      ...((f?.issues) || []),
    ];
    merged.characters[name] = { ...b, issues, totalIssues: issues.length, overallConsistent: issues.length === 0 };
    total += issues.length;
  }
  merged.totalIssues = total;
  merged.overallConsistent = total === 0;
  merged.summary = `${names.size} entities checked: ${total} consistency issue(s) (merged after round update)`;
  return merged;
}

async function runUnifiedRepairPipeline(rawImages, context, options = {}) {
  const {
    characters = [],
    modelOverrides = {},
    usageTracker,
    visualBible,
    artStyle,
    jobId,
    dbPool,
    storyData
  } = context;

  const {
    regenThreshold = REPAIR_DEFAULTS.scoreThreshold,
    maxRegenAttempts = REPAIR_DEFAULTS.maxPasses,
    evalConcurrency = 100,
    qualityModelOverride = null,
    useIteratePage = false,
    inpaintMaxPasses = REPAIR_DEFAULTS.inpaintMaxPasses,
  } = options;

  const { runEntityConsistencyChecks, getStyledAvatarForClothing } = require('./entityConsistency');
  const { extractSceneMetadata } = getStoryHelpers();

  const imagesWithData = rawImages.filter(r => r.imageData);
  const effectiveUseIteratePage = useIteratePage && !!storyData;
  if (useIteratePage && !storyData) {
    log.warn('[UNIFIED PIPELINE] useIteratePage=true but storyData not provided; falling back to generateImageOnly');
  }
  log.info(`🔧 [UNIFIED PIPELINE] Starting: ${imagesWithData.length} images, threshold=${regenThreshold}, maxPasses=${maxRegenAttempts}, mode=${effectiveUseIteratePage ? 'iteratePage' : 'generateImageOnly'}`);

  // Helper for progress updates
  const updateProgress = async (percent, message) => {
    if (jobId && dbPool) {
      try {
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [percent, message, jobId]
        );
      } catch (e) {
        log.warn(`⚠️ [UNIFIED PIPELINE] Progress update failed: ${e.message}`);
      }
    }
  };

  // Heartbeat ping — lighter than updateProgress: only bumps updated_at,
  // doesn't change percent or message. Passed to runEntityConsistencyChecks
  // so the long object loop (Wilhelm Tell stories accumulate ~30 distinct
  // objects to check; ~4s each = 2 min sequential) doesn't trip the
  // front-end stall watcher (5-min no-progress timeout).
  const pingHeartbeat = async () => {
    if (jobId && dbPool) {
      try {
        await dbPool.query(
          'UPDATE story_jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
          [jobId]
        );
      } catch (e) { /* never let heartbeat break the loop */ }
    }
  };

  // =========================================================================
  // Step 1: Evaluate all images + entity consistency (parallel)
  // =========================================================================
  await updateProgress(64, 'Evaluating image quality...');  // 64 = eval start (repair phase = ~36% of wall clock, 64-95)
  log.info(`🔍 [UNIFIED PIPELINE] Step 1: Evaluating ${imagesWithData.length} images + entity consistency...`);
  const step1Start = Date.now();

  // Build ALL character photos for evaluation (matches re-evaluate endpoint behavior)
  const allCharacterPhotos = characters
    .filter(c => c.photoUrl || c.avatars?.styled)
    .map(c => ({
      name: c.name,
      photoUrl: c.avatars?.styled || c.photoUrl
    }));

  // Reusable helper: build eval inputs for an array of image entries
  const buildEvalInputs = (imageEntries) => imageEntries.map(entry => {
    const orig = rawImages.find(img => img.pageNumber === entry.pageNumber) || entry;
    // sharedBboxDetection is the bbox detection that ran on the ORIGINAL
    // image bytes pre-pipeline (server.js:5570). Reusing it skips a redundant
    // Gemini call when re-evaluating the same image. But it MUST NOT be
    // reused when the entry's imageData differs from the original — that
    // happens on every round-result image (iterate / inpaint / char-fix
    // produce new bytes). Page 5 of job_1778525478433_fkl0f12x4 showed v3
    // and v4 carrying v0's bbox figures even though their pixel content was
    // completely different — because every round eval got the same
    // sharedBboxDetection forwarded.
    const isOriginalImage = entry.imageData === orig.imageData;
    // A repaired version is evaluated against ITS OWN contract when it has
    // one (iterate rewrites the scene — prompt, description, characters,
    // metadata can all legitimately differ from the original plan). Falling
    // back to orig.* for entries without a rewrite (inpaint, char-fix keep
    // the original scene contract).
    return {
      imageData: entry.imageData,
      pageNumber: entry.pageNumber,
      prompt: entry.prompt || orig.prompt,
      characterPhotos: orig.characterPhotos,
      allCharacterPhotos,
      sceneDescription: entry.description || orig.sceneDescription,
      sceneCharacters: entry.sceneCharacters || orig.sceneCharacters,
      sceneMetadata: entry.sceneMetadata || orig.sceneMetadata,
      pageText: orig.text,
      sceneHint: orig.scene?.outlineExtract || orig.scene?.sceneHint || null,
      evaluationType: orig.evaluationType,
      // Structured cover text contract (replaces the old prompt-string surgery):
      // 'appOverlay' → evaluator must never flag missing/present title text;
      // 'painted' + expectedText → evaluator letter-checks the painted text.
      expectedText: orig.expectedText ?? null,
      textMode: orig.textMode ?? null,
      // Detection reuse, in pairing order: the entry's OWN detection first —
      // a round-result entry carries the detection made on its accepted new
      // bytes (iterate's internal re-detect, or the round pre-detect step) —
      // else the pre-pipeline shared detection when the bytes are still the
      // original's. Never the original's detection for repaired bytes.
      // bboxPairsWith re-verifies the fingerprint before any reuse.
      sharedBboxDetection: entry.bboxDetection
        || (isOriginalImage ? (orig.sharedBboxDetection || null) : null),
    };
  });

  // Reusable helper: build entity check data for an array of image entries
  const buildEntityCheckData = (imageEntries) => ({
    sceneImages: imageEntries.map(entry => {
      const orig = rawImages.find(r => r.pageNumber === entry.pageNumber) || entry;
      // Prefer the entry's own rewritten scene (iterate) over the original.
      const entryDescription = entry.description || orig.sceneDescription;
      const metadata = extractSceneMetadata(entryDescription) || {};
      // Build per-character clothing from multiple sources (covers don't have
      // prose metadata, so we fall back to characterPhotos / referencePhotos).
      const clothingFromPhotos = (orig.characterPhotos || []).reduce((acc, p) => {
        if (p.name && p.clothingCategory) acc[p.name] = p.clothingCategory;
        return acc;
      }, {});
      const perCharClothing = orig.perCharClothing
        || metadata.characterClothing
        || (Object.keys(clothingFromPhotos).length > 0 ? clothingFromPhotos : {});
      let sceneSummary = '';
      if (metadata.fullData?.imageSummary) {
        sceneSummary = metadata.fullData.imageSummary.substring(0, 150);
      } else if (entryDescription) {
        const beforeJson = entryDescription.split('```json')[0].trim();
        const lines = beforeJson.split('\n').filter(l => l.trim() && !l.startsWith('#'));
        sceneSummary = lines[0]?.substring(0, 150) || '';
      }
      // Same guard as buildEvalInputs: the shared bbox from the pre-step was
      // computed on the ORIGINAL bytes. Forwarding it for a repaired/iterated
      // entry made the entity check crop new pixels with old-version boxes
      // (figure crops misaligned — box of version A on pixels of version B).
      const isOriginalImage = entry.imageData === orig.imageData;
      return {
        imageData: entry.imageData,
        pageNumber: entry.pageNumber,
        characters: metadata.characters || [],
        // NO DEFAULT (owner, 2026-08-07): this is the page-level clothing label
        // the entity check falls back to per crop. null → that crop is excluded
        // from the grid rather than judged against a guessed outfit.
        clothing: metadata.clothing || null,
        characterClothing: perCharClothing,
        sceneSummary,
        referenceCharacters: (orig.characterPhotos || []).map(p => p.name).filter(Boolean),
        referenceClothing: (orig.characterPhotos || []).reduce((acc, p) => {
          if (p.name && p.clothingCategory) acc[p.name] = p.clothingCategory;
          return acc;
        }, {}),
        retryHistory: [],
        // Shared detection, in pairing order: the entry's OWN detection (made
        // on its exact bytes — round results carry one), else the pre-step
        // detection when the bytes are still the original's. The entity check
        // MUST consume the same detection the eval consumes: two independent
        // SoM passes on the same repaired image can disagree, and the entity
        // grid then crops figures under different names than the persisted
        // detection (observed: Emma↔Hans swapped in the consistency report
        // while the stored detection named them correctly).
        sharedBboxDetection: entry.bboxDetection
          || (isOriginalImage ? (orig.sharedBboxDetection || null) : null),
      };
    }),
    // Pass scene descriptions so entity-collect can determine per-page characters.
    // Without this, runEntityConsistencyChecks falls back to sending ALL story
    // characters to bbox detection — which causes false Werner/Uschi labels on
    // pages where Werner/Uschi don't appear, then triggers bogus character fixes.
    sceneDescriptions: imageEntries.map(entry => {
      const orig = rawImages.find(r => r.pageNumber === entry.pageNumber) || entry;
      return {
        pageNumber: entry.pageNumber,
        description: entry.description || orig.sceneDescription || ''
      };
    }),
    // Per-story clothing is the canonical source the entity checker resolves
    // expectedClothing from (via buildClothingDescription). Without it,
    // buildClothingDescription falls through to avatars.clothing[category] —
    // the stale base-character DEFAULT — and the evaluator flags correctly-
    // rendered story outfits as mismatches and emits fixInstructions to repaint
    // them into the default.
    clothingRequirements: storyData?.clothingRequirements || null,
    artStyle: artStyle || 'pixar'
  });

  const evalInputs = buildEvalInputs(imagesWithData);
  const imageCheckData = buildEntityCheckData(imagesWithData);

  // Run both in parallel
  const [evaluations, entityReport] = await Promise.all([
    images().evaluateImageBatch(evalInputs, { concurrency: evalConcurrency, qualityModelOverride, visualBible, clothingRequirements: storyData?.clothingRequirements || null, artStyle }),
    runEntityConsistencyChecks(imageCheckData, characters, {
      checkCharacters: true,
      // Objects (LOC/ART/VEH/ANI) are NOT cross-page identity entities — a boat
      // appears on one page, a marketplace on another, and "consistency" of a
      // single-page object is meaningless. Per-page presence/correctness is
      // already covered by quality eval + semantic eval. Leaving objects on
      // here turns "boat missing on p7" into a CRITICAL entity-consistency
      // issue that pollutes every version of every page.
      checkObjects: false,
      saveGrids: false,
      onHeartbeat: pingHeartbeat
    }).catch(err => {
      log.error(`❌ [UNIFIED PIPELINE] Entity consistency check failed: ${err.message}`);
      return { characters: {}, totalIssues: 0, overallConsistent: true, summary: 'Entity check failed', grids: [] };
    })
  ]);

  // Track usage
  for (const evalResult of evaluations) {
    if (evalResult.usage && usageTracker) {
      usageTracker('gemini_quality', evalResult.usage, 'page_quality', evalResult.modelId);
    }
  }
  if (entityReport?.tokenUsage && usageTracker) {
    usageTracker('gemini_quality', {
      input_tokens: entityReport.tokenUsage.inputTokens || 0,
      output_tokens: entityReport.tokenUsage.outputTokens || 0
    }, 'entity_consistency_check', entityReport.tokenUsage.model || 'gemini-2.5-flash');
  }

  const step1Duration = ((Date.now() - step1Start) / 1000).toFixed(1);
  const avgScore = evaluations.reduce((sum, e) => sum + (e.qualityScore || 0), 0) / Math.max(1, evaluations.length);
  log.info(`✅ [UNIFIED PIPELINE] Step 1 complete in ${step1Duration}s: avg score ${avgScore.toFixed(0)}%, entity issues: ${entityReport.totalIssues}`);

  // Build eval map for quick lookup
  const evalMap = new Map();
  for (const ev of evaluations) {
    evalMap.set(ev.pageNumber, ev);
  }

  // Evaluate the truly-original image when text-space repair picked a different
  // candidate as winner. Without this, retryHistory[0] (the original) shows no
  // score and we lose the baseline needed to judge whether text-space repair
  // helped or hurt quality. Runs in parallel via evaluateImageBatch concurrency.
  const baselineEvalInputs = [];
  for (const img of rawImages) {
    const cands = img.textSpaceCandidates;
    if (!Array.isArray(cands) || cands.length <= 1) continue;
    const original = cands.find(c => c.source === 'original');
    if (!original || original.isWinner) continue;
    baselineEvalInputs.push({
      imageData: original.imageData,
      pageNumber: img.pageNumber,
      prompt: img.prompt,
      characterPhotos: img.characterPhotos,
      allCharacterPhotos,
      sceneDescription: img.sceneDescription,
      sceneCharacters: img.sceneCharacters,
      sceneMetadata: img.sceneMetadata,
      pageText: img.text,
      sceneHint: img.scene?.outlineExtract || img.scene?.sceneHint || null,
      evaluationType: img.evaluationType,
    });
  }
  const baselineEvalsByPage = new Map();
  if (baselineEvalInputs.length > 0) {
    const baselineEvals = await images().evaluateImageBatch(baselineEvalInputs, { concurrency: evalConcurrency, qualityModelOverride, visualBible, clothingRequirements: storyData?.clothingRequirements || null, artStyle });
    for (const ev of baselineEvals) {
      baselineEvalsByPage.set(ev.pageNumber, ev);
      if (ev.usage && usageTracker) {
        usageTracker('gemini_quality', ev.usage, 'page_quality_original_baseline', ev.modelId);
      }
    }
    log.info(`📊 [UNIFIED PIPELINE] Evaluated ${baselineEvalInputs.length} non-winner originals for baseline scores`);
  }

  // =========================================================================
  // Shared helpers for the round loop
  // =========================================================================
  // Entity penalty per issue — SINGLE SCALE with the charged score (scoring
  // audit 2026-07-11): derived from SEVERITY_POINTS so the displayed/ranked
  // entity penalty (version.entityPenalty, scoreBreakdown.entity.penalty)
  // equals what computeMathFinalScore actually deducts. The old independent
  // table {30/20/10} made the dev panel show −10 where the score charged −2.
  // Client mirror: useRepairWorkflow.ts ENTITY_PENALTIES — keep in sync.
  // Use SEVERITY_POINTS wholesale rather than re-listing a subset of its keys:
  // the hand-copied {critical, major, minor} literal silently dropped
  // `moderate` and `catastrophic`, so a moderate entity issue DISPLAYED as −0
  // while computeMathFinalScore charged it −5 (normalizeIssues accepts every
  // severity in SEVERITY_POINTS). Same table, no subsetting, no drift.
  const { SEVERITY_POINTS: ENTITY_PENALTIES } = require('./scoring');
  // Returns { penalty, issues } so callers can persist BOTH the number AND the
  // source issues on each version. Without the issues, the dev panel shows a
  // mysterious "−N" deduction that the user can't drill into.
  const getEntityPenaltyAndIssues = (pageNumber, report) => {
    const out = { penalty: 0, issues: [] };
    if (!report?.characters) return out;
    for (const [charName, charData] of Object.entries(report.characters)) {
      const charIssues = charData.issues || [];
      for (const issue of charIssues) {
        if (issue.pages?.includes(pageNumber) || issue.pagesToFix?.includes(pageNumber) || issue.pageNumber === pageNumber) {
          out.penalty += ENTITY_PENALTIES[String(issue.severity || '').toLowerCase()] || 0;
          out.issues.push({
            name: charName,
            severity: issue.severity,
            description: issue.description || issue.problem || '',
            source: 'character',
          });
        }
      }
    }
    // Also include object-level issues so the panel surfaces missing/wrong props.
    for (const [objName, objData] of Object.entries(report.objects || {})) {
      const objIssues = objData.issues || [];
      for (const issue of objIssues) {
        if (issue.pages?.includes(pageNumber) || issue.pagesToFix?.includes(pageNumber) || issue.pageNumber === pageNumber) {
          out.penalty += ENTITY_PENALTIES[String(issue.severity || '').toLowerCase()] || 0;
          out.issues.push({
            name: objName,
            severity: issue.severity,
            description: issue.description || issue.problem || '',
            source: 'object',
          });
        }
      }
    }
    return out;
  };
  // Backward-compat shim — existing callers that only need the number.
  const getEntityPenalty = (pageNumber, report) => getEntityPenaltyAndIssues(pageNumber, report).penalty;

  // ---------------------------------------------------------------------
  // Eval consolidation (owner decision Jul 2026: "3-4 different evals, then
  // ONE prompt to summarize"). Every full evaluation goes through the
  // feedback consolidator, whose deduped_issues become the deductions that
  // applyScore's math runs over — the same defect flagged by quality +
  // semantic + compliance + entity counts ONCE. One Sonnet call per
  // evaluated version (zero-issue evals skip the call), parallelized.
  // The plan lands on the version as `consolidatedPlan`; the finalize
  // creation stamp reuses it — no second LLM call.
  // ---------------------------------------------------------------------
  const { consolidateEvaluation } = require('./feedbackConsolidator');
  const consolidatorStoryId = storyData?.id || jobId || null;
  const consolidateLimit = pLimit(Math.min(evalConcurrency, 20));
  const consolidatePageEval = async (ev, entityIssues, pageNumber, round, sceneDescriptionOverride = null) => {
    try {
      const orig = rawImages.find(i => i.pageNumber === pageNumber);
      const res = await consolidateEvaluation({
        evalResult: ev,
        entityIssues,
        // A repaired version is consolidated against ITS OWN contract (an
        // iterate rewrite resolves spec conflicts — checking the ORIGINAL
        // description would re-flag the fixed version and loop the repair).
        sceneDescription: sceneDescriptionOverride || orig?.sceneDescription || '',
        characters: characters || [],
        storyId: consolidatorStoryId,
        pageNumber,
        round,
      });
      if (res.usage && usageTracker) {
        usageTracker('anthropic', res.usage, 'eval_consolidation', 'claude-sonnet');
      }
      if (res.error) {
        log.warn(`🧠 [EVAL-CONSOLIDATION] P${pageNumber}: failed (${res.error}) — scoring falls back to raw issues`);
      }
      return res.plan || null;
    } catch (err) {
      log.warn(`🧠 [EVAL-CONSOLIDATION] P${pageNumber}: threw (${err.message}) — scoring falls back to raw issues`);
      return null;
    }
  };

  // Consolidate the initial-pass evaluations (winner images + the non-winner
  // original baselines) in parallel.
  const consolidatedByPage = new Map();
  const baselineConsolidatedByPage = new Map();
  await Promise.all([
    ...rawImages.map(img => consolidateLimit(async () => {
      const ev = evalMap.get(img.pageNumber);
      if (!ev) return;
      const entityResult = getEntityPenaltyAndIssues(img.pageNumber, entityReport);
      const plan = await consolidatePageEval(ev, entityResult.issues, img.pageNumber, 0);
      if (plan) consolidatedByPage.set(img.pageNumber, plan);
    })),
    ...[...baselineEvalsByPage.entries()].map(([pageNumber, ev]) => consolidateLimit(async () => {
      const entityResult = getEntityPenaltyAndIssues(pageNumber, entityReport);
      const plan = await consolidatePageEval(ev, entityResult.issues, pageNumber, 0);
      if (plan) baselineConsolidatedByPage.set(pageNumber, plan);
    })),
  ]);

  // Track all versions per page: { pageNumber -> [{ imageData, score, source, evaluation, entityPenalty, evaluatedAt }] }
  const pageVersions = new Map();
  for (const img of rawImages) {
    const ev = evalMap.get(img.pageNumber);

    // When scale-repair ran, server.js sets img.preScaleRepairImage to the
    // first Grok call's output (before scale-repair), and img.imageData to the
    // scale-repair output. Surface both as separate versions so the dev panel
    // shows the input image, the input prompt + refs, the scale-repair prompt
    // + refs, and the output. Without this, only the post-scale-repair image
    // is stored, but its grokRefImages field is the FIRST call's refs — a
    // mismatch that hides which avatar was actually attached when Grok
    // produced the visible image.
    const hasScaleRepair = !!img.preScaleRepairImage
      && img.preScaleRepairImage !== img.imageData;

    // finalScore = imageScore − entityPenalty. Single number the frontend
    // reads — replaces the per-evaluator recompute that produced two
    // disagreeing scores in the UI.
    const baseScore = ev?.score ?? ev?.qualityScore ?? null;
    const baseEntityResult = getEntityPenaltyAndIssues(img.pageNumber, entityReport);
    // Same cap setVersionScores applies to repair versions. Uncapped here,
    // originals scored −70/−90 against repairs' −40, so a visually worse
    // repair could beat a better original (and false entity flags kept
    // dragging good originals below the redo threshold). Raw kept for audit.
    const { capEntityPenalty } = require('./scoring');
    const baseEntityPenaltyRaw = baseEntityResult.penalty;
    const baseEntityPenalty = capEntityPenalty(baseEntityPenaltyRaw);
    const baseEntityIssues = baseEntityResult.issues;
    // NO INLINE RECOMPUTE. This used to be `max(0, baseScore − baseEntityPenalty)`
    // — an EVALUATOR-scale number written into the same `finalScore` field that
    // applyScore fills with the MATH-scale score a few lines below (stampAtCreation),
    // i.e. two incomparable scales in one field depending on whether the version
    // happened to carry an evaluation. Seed null; applyScore is the only writer
    // of finalScore, and an un-evaluated version legitimately has no score
    // ("no evidence of issues" is not "the image is perfect").
    const baseFinalScore = null;

    const baseVersion = hasScaleRepair
      ? {
          // v0 = original first generation (pre-scale-repair). No eval ran on
          // this image — eval ran on the scale-repair output, so we only carry
          // the inputs (prompt, refs) and the image bytes.
          imageData: img.preScaleRepairImage,
          score: null,
          finalScore: null,
          source: 'original',
          type: 'original',
          evaluation: null,
          modelId: img.preScaleRepairModelId || img.modelId,
          grokRefImages: img.grokRefImages || null,
          referencePhotos: img.referencePhotos || null,
          prompt: img.prompt || null,
          entityPenalty: 0,
          entityIssues: [],
          evaluatedAt: new Date().toISOString(),
        }
      : {
          imageData: img.imageData,
          score: baseScore,
          finalScore: baseFinalScore,
          source: 'original',
          evaluation: ev || null,
          consolidatedPlan: consolidatedByPage.get(img.pageNumber) || null,
          modelId: img.modelId,
          grokRefImages: img.grokRefImages || null,
          referencePhotos: img.referencePhotos || null,
          entityPenalty: baseEntityPenalty,
          entityPenaltyRaw: baseEntityPenaltyRaw,
          entityIssues: baseEntityIssues,
          evaluatedAt: new Date().toISOString(),
        };

    // Build the scale-repair version (v1) when scale-repair ran. Carries its
    // own prompt + refs, plus the eval that actually scored this image.
    const scaleRepairVersion = hasScaleRepair
      ? {
          imageData: img.imageData,
          score: baseScore,
          finalScore: baseFinalScore,
          source: 'scale-repair',
          type: 'repair',
          evaluation: ev || null,
          consolidatedPlan: consolidatedByPage.get(img.pageNumber) || null,
          modelId: img.modelId,
          grokRefImages: img.scaleRepairGrokRefImages || null,
          inpaintInstruction: img.scaleRepairPrompt || null,
          entityPenalty: baseEntityPenalty,
          entityPenaltyRaw: baseEntityPenaltyRaw,
          entityIssues: baseEntityIssues,
          evaluatedAt: new Date().toISOString(),
        }
      : null;

    // If the text-space repair ran, it already produced multiple candidates
    // (the truly-original image plus 1–2 repair attempts). Expand them into
    // separate versions so the viewer shows each one and the user can switch
    // between them — otherwise only the coverage-winner survives and the
    // others are lost. Eval only runs on the winner (img.imageData), so the
    // non-winner versions start without scores; that's fine — they're there
    // for inspection and manual selection.
    if (Array.isArray(img.textSpaceCandidates) && img.textSpaceCandidates.length > 1) {
      const baselineEval = baselineEvalsByPage.get(img.pageNumber);
      const allVersions = img.textSpaceCandidates.map((c) => {
        const isWinner = c.isWinner;
        const isOriginal = c.source === 'original';
        const evalForThis = isWinner ? baseVersion.evaluation : (isOriginal ? baselineEval : null);
        const scoreForThis = isWinner
          ? baseVersion.score
          : (isOriginal ? (baselineEval?.score ?? baselineEval?.qualityScore ?? null) : null);
        return {
          imageData: c.imageData,
          score: scoreForThis,
          source: c.source,
          evaluation: evalForThis,
          consolidatedPlan: isWinner
            ? (consolidatedByPage.get(img.pageNumber) || null)
            : (isOriginal ? (baselineConsolidatedByPage.get(img.pageNumber) || null) : null),
          modelId: c.modelId || baseVersion.modelId,
          // Each candidate now carries its own refs (original inherits from
          // the initial Grok call; repair attempts capture refs from their
          // own generateImageOnly call). Fall back to baseVersion only when
          // the candidate didn't capture any.
          grokRefImages: c.grokRefImages || baseVersion.grokRefImages || null,
          entityPenalty: isWinner ? baseVersion.entityPenalty : 0,
          entityPenaltyRaw: isWinner ? baseVersion.entityPenaltyRaw : 0,
          entityIssues: isWinner ? (baseVersion.entityIssues || []) : [],
          evaluatedAt: new Date().toISOString(),
          // Surface the text-space repair inputs in the viewer's repair section.
          inpaintInstruction: c.prompt || null,
          textSpaceCoveragePct: c.coveragePct,
          textSpacePosition: c.position,
        };
      });
      // Prepend pre-scale-repair version when applicable. The text-space
      // candidates ran AFTER scale-repair, so the scale-repair output is the
      // input baseline of the text-space cascade. Insert original first, then
      // scale-repair, then text-space candidates.
      const final = hasScaleRepair
        ? [baseVersion, scaleRepairVersion, ...allVersions]
        : allVersions;
      pageVersions.set(img.pageNumber, final);
    } else {
      const final = hasScaleRepair
        ? [baseVersion, scaleRepairVersion]
        : [baseVersion];
      pageVersions.set(img.pageNumber, final);
    }

    // Canonical single-scale stamp AT CREATION for every evaluated version —
    // the same applyScore math the persist path re-stamps, so every in-flight
    // decision (findBadPages, selectBestVersion, rescue) runs on the numbers
    // that actually get persisted. Un-evaluated versions (pre-scale-repair v0,
    // non-winner text-space candidates) stay unscored by design.
    {
      const { applyScore: stampAtCreation } = require('./scoring');
      for (const v of pageVersions.get(img.pageNumber) || []) {
        if (!v?.evaluation) continue;
        v.pageNumber = img.pageNumber;
        stampAtCreation(v, {
          evalResult: v.evaluation,
          entityResult: { issues: v.entityIssues || [], penalty: v.entityPenaltyRaw ?? v.entityPenalty ?? 0 },
          // Same deduped plan every other writer passes. Omitting it here was
          // the drift: originals scored RAW at creation, CONSOLIDATED at save,
          // and the pick sat between the two states (p9 −77/−65, task #15/16).
          consolidatedPlan: v.consolidatedPlan || null,
        });
      }
    }
  }

  // Helper: execute an iterate action for a page
  const executeIterateAction = async (img, latestEval) => {
    const canIterate = effectiveUseIteratePage && img.pageNumber > 0;
    let result;
    if (canIterate) {
      const evalFeedback = latestEval ? {
        score: latestEval.score ?? latestEval.qualityScore,
        reasoning: latestEval.reasoning?.substring(0, 1000),
        fixableIssues: (latestEval.fixableIssues || []).slice(0, 10),
      } : null;
      const versions = pageVersions.get(img.pageNumber) || [];
      const bestSoFar = selectBestVersion(versions);
      const inputImage = bestSoFar?.imageData || img.imageData;
      // Read the per-scene aspect from saved metadata so a 1:1 advanced page
      // doesn't get redone as 3:4. img.imageAspect (preserved in pipelineStoryData)
      // is the source of truth; null falls back to global default in iteratePageCore.
      const sceneAspect = img.imageAspect
        || storyData?.sceneImages?.find(s => s.pageNumber === img.pageNumber)?.imageAspect
        || null;
      result = await images().iteratePage(inputImage, img.pageNumber, storyData, {
        aspectRatio: sceneAspect,
        modelOverrides,
        usageTracker, // pass through so Haiku scene re-expansion + image gen are tracked
        evaluationFeedback: evalFeedback,
        sceneBackground: img.emptySceneImage || null,
        // Repair-workflow iterate must preserve identity — don't let the run-level
        // referenceMode='loose' silently drop character refs for non-close-up
        // shots (the re-expansion can flip the shot type, flipping refs on/off
        // and producing wildly different styles between V1 and V2+ of the same
        // page). Force styled-only so refs are always attached during repair.
        referenceMode: 'styled-only',
        // Reuse the saved empty-scene plate via the explicit sceneBackground
        // above; never regenerate a fresh plate during repair.
        singlePassScene: !img.emptySceneImage,
        // The round loop scores + detects this result itself (round detect
        // + batch eval) — skip the in-iterate eval so pages are evaluated
        // exactly once per version.
        skipEval: true,
      });
      // iteratePage tracks its own usage internally; nothing to add here
    } else if (img.pageNumber < 0 && storyData) {
      const { iterateCover } = require('./coverIterate');
      const coverKeys = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };
      const ck = coverKeys[String(img.pageNumber)];
      if (ck && storyData.coverImages?.[ck]?.imageData) {
        const coverFeedback = latestEval ? {
          score: latestEval.score ?? latestEval.qualityScore,
          reasoning: latestEval.reasoning?.substring(0, 1000),
          fixableIssues: (latestEval.fixableIssues || []).slice(0, 10),
        } : null;
        result = await iterateCover(ck, storyData, {
          imageModel: modelOverrides?.imageModel,
          evaluationFeedback: coverFeedback,
          usageTracker,
          // The round loop scores + detects this result itself (round detect
          // + batch eval) — skip the in-iterate eval so covers are evaluated
          // exactly once per version.
          skipEval: true,
        });
      } else if (ck) {
        log.debug(`⏭️  [UNIFIED PIPELINE] Skipping cover ${ck} iterate — no image data available yet`);
      }
    } else {
      const feedbackSuffix = buildRegenFeedback(latestEval);
      const regenPrompt = feedbackSuffix
        ? `${img.prompt}\n\n${feedbackSuffix}`
        : img.prompt;
      result = await images().generateImageOnly(regenPrompt, img.characterPhotos, {
        imageModelOverride: modelOverrides.imageModel,
        imageBackendOverride: modelOverrides.imageBackend,
        landmarkPhotos: img.landmarkPhotos,
        visualBibleGrid: img.visualBibleGrid,
        pageNumber: img.pageNumber,
        skipCache: true
      });
      if (result?.usage && usageTracker) {
        const isRunware = result.modelId && result.modelId.startsWith('runware:');
        const isGrok = result.modelId && result.modelId.startsWith('grok-imagine');
        const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
        // Route to page_images function so it shows up in the proper bucket
        usageTracker(provider, result.usage, 'page_images', result.modelId);
      }
    }
    return result;
  };

  // Helper: execute an inpaint action for a page
  const executeInpaintAction = async (img, latestEval, roundNum = null, inputOverride = null) => {
    const versions = pageVersions.get(img.pageNumber) || [];
    const bestSoFar = selectBestVersion(versions);
    // inputOverride carries the garment recolour applied moments ago — the
    // repair must work on the corrected pixels, not the drifted ones.
    let inputImage = inputOverride || bestSoFar?.imageData || img.imageData;
    // Parse per-character clothing for this page so the avatar lookup picks the
    // styled+costumed variant matching what's actually drawn on this page.
    // Without this, inpaint attaches unstyled base photos and Grok has no visual
    // reference for the current costume/style.
    const { parseCharacterClothing } = getStoryHelpers();
    const pageCharacterClothing = parseCharacterClothing(img.sceneDescription || img.description || '') || {};
    // Same aspect resolution as iteratePage above — the page's stored
    // imageAspect is the source of truth. Without this, inpaint silently
    // crops square (advanced/Jugendbuch) pages to 3:4 on round 1.
    const sceneAspect = img.imageAspect
      || storyData?.sceneImages?.find(s => s.pageNumber === img.pageNumber)?.imageAspect
      || null;
    // Look up the page's locked text-overlay corner so inpaint can warn
    // Grok not to paint high-contrast detail in that zone. textPosition is
    // only persisted on overlay layouts (gated at the persistence site in
    // server.js — see docs/calm-zone-pipeline.md), so a non-null value here
    // means the story uses overlay and the suffix is correct.
    const pageTextPosition = (storyData?.sceneImages || []).find(s => s.pageNumber === img.pageNumber)?.textPosition || null;
    // Cover text preservation. Covers render TEXTLESS; the title / dedication /
    // "magicalstory.ch" branding is composited app-side (composeCover). If the
    // post-persist bake has already run (${key}Art row exists → post-generation
    // repair), inpaint the TEXTLESS art layer and re-composite the text after,
    // so Grok can't mangle it. During INITIAL generation (${key}Art absent) the
    // cover is already textless and bakeCoverTypographyPostPersist stamps it
    // later — inpaint the served (textless) image as-is, no restamp.
    const coverKey = img.pageNumber === -1 ? 'frontCover'
      : img.pageNumber === -2 ? 'initialPage'
      : img.pageNumber === -3 ? 'backCover' : null;
    let restampCoverAfter = false;
    if (coverKey) {
      try {
        const { dbQuery } = require('../services/database');
        const sid = storyData?.id || jobId || null;
        const rows = sid ? await dbQuery(
          "SELECT image_url, image_data FROM story_images WHERE story_id=$1 AND image_type=$2 AND NOT is_test ORDER BY version_index DESC LIMIT 1",
          [sid, `${coverKey}Art`]) : [];
        if (rows.length) {
          const r2mod = require('./r2');
          const artRow = rows[0];
          const artSrc = artRow.image_url || (artRow.image_data ? 'data:image/jpeg;base64,' + artRow.image_data.toString('base64') : null);
          const artBytes = artSrc ? await r2mod.bytesFromAnyImage(artSrc) : null;
          if (artBytes) { inputImage = 'data:image/jpeg;base64,' + artBytes.toString('base64'); restampCoverAfter = true; }
        }
      } catch (e) { /* fall back: inpaint the served image, no restamp */ }
    }
    const result = await images().inpaintPage(inputImage, latestEval || {}, {
      visualBible: storyData?.visualBible || null,
      characters: storyData?.characters || characters || null,
      entityReport: currentEntityReport,
      pageNumber: img.pageNumber,
      sceneDescription: img.sceneDescription || img.description || '',
      artStyle: storyData?.artStyle || artStyle || null,
      characterClothing: pageCharacterClothing,
      clothingRequirements: storyData?.clothingRequirements || null,
      // Thread storyId + round so consolidator calls get persisted
      storyId: storyData?.id || jobId || null,
      round: roundNum,
      aspectRatio: sceneAspect,
      textPosition: pageTextPosition,
    });
    // Re-composite the cover text onto the repainted textless art (reuses
    // composeCover). The served image keeps its title; artImageData is the new
    // textless source for future no-AI title edits.
    if (restampCoverAfter && result?.imageData) {
      try {
        const { restampCover } = require('./coverTypography');
        const figures = storyData?.coverImages?.[coverKey]?.bboxDetection?.figures || [];
        const stamped = await restampCover(storyData, coverKey, result.imageData, { seed: storyData?.title, figures });
        result.artImageData = stamped.textlessData;
        result.imageData = stamped.titledData;
      } catch (e) {
        require('../utils/logger').log.warn(`⚠️ [COVER INPAINT] ${coverKey}: restamp failed (${e.message}) — serving repainted image`);
      }
    }
    if (result.usage && usageTracker) {
      // Detect actual provider from the model used
      const inpaintModel = result.usage?.model || '';
      const isRunware = inpaintModel.startsWith('runware:');
      const isGrok = inpaintModel.startsWith('grok');
      const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
      usageTracker(provider, {
        input_tokens: result.usage?.inputTokens || 0,
        output_tokens: result.usage?.outputTokens || 0,
        cost: result.usage?.cost,
        direct_cost: result.usage?.cost,  // Grok/Runware track via direct_cost
      }, 'inpaint', inpaintModel || 'grok-text-edit');
    }
    return result;
  };

  // Per-character debug Map for the dev panel — populated by char-fix
  // calls inside the round loop. Hoisted above executeCharFixAction so the
  // closure can mutate it; serialised at the end of the function.
  const charFixDetails = new Map();

  // Char-fix as a per-page round method. Same shape as executeIterate /
  // executeInpaint so the round-body parallel runner dispatches uniformly.
  // Body extracted from the (deleted) Step 5 character-repair pass; bbox
  // tier-search + avatar lookup logic preserved verbatim. Char-fix is
  // scene-only — covers fall through to iterate via decideRepairMethod.
  const executeCharFixAction = async (img, decision, roundNum, inputOverride = null) => {
    const pageNumber = img.pageNumber;
    if (pageNumber <= 0) {
      return { pageNumber, imageData: null, error: 'char-fix not applicable to covers' };
    }
    const charName = decision.charName;
    if (!charName) {
      return { pageNumber, imageData: null, error: 'no charName in decision' };
    }

    const versions = pageVersions.get(pageNumber) || [];
    const best = selectBestVersion(versions);
    // See executeInpaintAction: the recolour runs first, this consumes it.
    const currentImageData = inputOverride || best?.imageData || img.imageData;
    const bestEval = best?.evaluation;

    // Single bbox source-of-truth — same helper feeds target + protection
    // so they can't disagree. detectAllBoundingBoxes is NOT re-called on miss;
    // its internal safety+model retries already exhausted before storing the
    // result, so a re-call just burns another API hit.
    const targetResolved = resolveCharBbox(charName, {
      bestEval, entityReport: currentEntityReport, pageNumber, imageData: currentImageData,
    });
    const faceBbox = targetResolved.faceBbox;
    const bodyBbox = targetResolved.bodyBbox;
    if (!faceBbox && !bodyBbox) {
      return { pageNumber, imageData: null, error: `no bbox for ${charName}` };
    }

    const character = characters.find(c => c.name === charName);
    if (!character) {
      return { pageNumber, imageData: null, error: `character ${charName} not found` };
    }

    // Case-insensitive lookup — scene metadata can key perCharClothing with
    // different casing than the canonical character name, and an exact-key
    // miss silently degraded the repair to 'standard' clothing.
    const perCharClothingKey = Object.keys(img.perCharClothing || {})
      .find(k => k.toLowerCase() === charName.toLowerCase());
    const { normalizeClothingCategory: normCat, resolvePageClothingCategory: pageCat } = require('./clothingCategories');
    const rawCharClothing = perCharClothingKey && img.perCharClothing[perCharClothingKey];
    // NO DEFAULT (owner, 2026-08-07): the resolved category picks the styled
    // avatar this repair paints the character to match, so a guessed 'standard'
    // repaints the story outfit into a wardrobe from an unrelated story.
    const clothingCategory = rawCharClothing
      ? normCat(rawCharClothing)
      : pageCat(storyData, pageNumber, charName);
    if (!clothingCategory) {
      return { pageNumber, imageData: null, error: `no clothing category for ${charName} (perCharClothing and pageClothing both empty) — refusing to repair into a guessed outfit` };
    }
    if (!rawCharClothing) {
      log.warn(`⚠️ [UNIFIED PIPELINE] Char-fix ${charName} p${pageNumber}: no perCharClothing entry — resolved "${clothingCategory}" from pageClothing`);
    }
    const styledAvatar = await getStyledAvatarForClothing(character, artStyle, clothingCategory);
    const avatarPhoto = styledAvatar || getFacePhoto(character);
    const avatarPhotoType = styledAvatar
      ? (clothingCategory.startsWith('costumed') ? `costumed-${clothingCategory.split(':')[1] || 'default'}` : `styled-${clothingCategory}`)
      : 'face';
    if (!avatarPhoto) {
      return { pageNumber, imageData: null, error: `no avatar photo for ${charName}` };
    }

    // Repair axes resolved by the ONE central rule (resolveRepairAxes) against
    // the ACTUAL detected face box — replaces the old inline useFaceOnly
    // derivation. Prefer the intent the decision already emitted (repairParams),
    // but finalise faceOnly here since only now do we know a face box exists.
    const { resolveRepairAxes } = require('./faceRepair');
    const repairAxes = resolveRepairAxes(decision.issueDescription, { hasFaceBbox: !!faceBbox });
    const useFaceOnly = repairAxes.faceOnly;
    const repairBbox = useFaceOnly ? faceBbox : (bodyBbox || faceBbox);

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
        bestEval, entityReport: currentEntityReport, pageNumber, imageData: currentImageData,
      });
      if (r.faceBbox) protectedFaces.push(r.faceBbox);
      if (r.bodyBbox) protectedBodies.push(r.bodyBbox);
      if (r.faceBbox || r.bodyBbox) protectedNames.push(otherChar.name);
    }
    log.info(`🛡️ [CHAR-FIX] Round ${roundNum} char-fix ${charName} on p${pageNumber}: target bbox source=${targetResolved.source}, protection bboxes for: ${protectedNames.length ? protectedNames.join(', ') : '(none)'}`);

    // Per-story clothingRequirements is the source of truth (correct for THIS
    // story); avatars.clothing is character-level metadata that persists
    // across stories and can carry stale colours from a previous run. Without
    // this preference, the repair Grok prompt sends stale clothing text while
    // the eval (driven by the new story's requirements) keeps flagging the
    // colour mismatch — repair runs N times for nothing. Same priority as
    // storyHelpers.resolveClothingDescription.
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
    const pageTextPosition = (storyData?.sceneImages || []).find(s => s.pageNumber === pageNumber)?.textPosition || null;
    // Appearance text for the repair prompt (face/hair/build). The Lab passed
    // this; PRODUCTION did not, so every live repair rendered the appearance
    // slot empty and identity rested on the avatar alone (found while auditing
    // story job_1786024729214_zrjgzqiey, 4 char-fix rounds).
    const charDescForPrompt = (() => {
      const d = img.bboxDetection?.characterDescriptions?.[charName]
        ?? (storyData?.sceneImages || []).find(s => s.pageNumber === pageNumber)?.bboxDetection?.characterDescriptions?.[charName];
      const txt = (typeof d === 'string' ? d : d?.richDescription) || '';
      return txt || (character?.description || '');
    })();

    log.info(`👤 [UNIFIED PIPELINE] Round ${roundNum} char-fix ${charName} on p${pageNumber}: ${useFaceOnly ? 'FACE' : 'BODY'} bbox=[${repairBbox.map(v => Math.round(v * 100) + '%').join(', ')}] (${decision.severity})`);
    require('./runMetrics').forJob(storyData?.id || jobId).count('consistency_regen');
    let repairResult;
    try {
      repairResult = await images().repairCharacterMismatch(currentImageData, avatarPhoto, repairBbox, charName, {
        imageBackend: 'grok',
        issueDescription: decision.issueDescription,
        clothingDescription: clothingDesc,
        characterDescription: charDescForPrompt,
        photoType: avatarPhotoType,
        sceneDescription: sceneDesc,
        faceBbox,
        protectedFaces,
        protectedBodies,
        whiteoutTarget: useFaceOnly ? 'face' : 'body',
        // Detection SAM silhouette (page-res) for the ORIGINAL figure so the
        // blend gate reuses it instead of re-running SAM on the same pixels.
        // Body mode only — the detection mask is a full-figure silhouette, not
        // a head mask; null → gate falls back to a fresh /figure-mask call.
        detectionBodyMask: useFaceOnly ? null : (targetResolved.bodyMask || null),
        textPosition: pageTextPosition,
        includeDebug: true,
      });
    } catch (err) {
      // Literal, not a bare `method`: this closure has no such binding (the
      // round runner destructures one from pageStrategies, a different scope),
      // so the reference threw a ReferenceError from inside the catch that was
      // meant to REPORT the failure — turning a handled repair error into an
      // unhandled one. executeCharFixAction is always the char-fix method.
      return { pageNumber, imageData: null, method: 'char-fix', error: err.message };
    }

    if (!repairResult?.imageData || repairResult.imageData.length < 1000) {
      return { pageNumber, imageData: null, error: 'char-fix produced no usable image' };
    }

    if (repairResult.usage && usageTracker) {
      // Provider is Grok for char-repair (repairCharacterMismatchWithGrok);
      // the prior 'gemini_image' label was a copy-paste miscategorisation
      // that inflated the Gemini column and hid Grok char-repair spend.
      usageTracker('grok', {
        input_tokens: repairResult.usage.inputTokens || 0,
        output_tokens: repairResult.usage.outputTokens || 0,
        cost: repairResult.usage.cost,
        direct_cost: repairResult.usage.direct_cost ?? repairResult.usage.cost,
      }, 'unified_pipeline_char_fix', repairResult.usage.model);
    }

    // Stash dev-panel debug data on charFixDetails so the dev panel still
    // shows the per-character before/after/blackout/cutout/grok-raw thumbnails.
    if (!charFixDetails.has(charName)) charFixDetails.set(charName, new Map());
    charFixDetails.get(charName).set(pageNumber, {
      before: currentImageData,
      after: repairResult.imageData,
      blackoutImage: repairResult.blackoutImage || repairResult.comparison?.blackoutImage || null,
      cutoutSent: repairResult.cutoutSent || repairResult.comparison?.cutoutSent || null,
      grokRawResult: repairResult.grokRawResult || repairResult.comparison?.grokRawResult || null,
      blendMask: repairResult.blendMask || repairResult.comparison?.blendMask || null,
      croppedAvatar: repairResult.croppedAvatar || repairResult.comparison?.croppedAvatar || null,
      method: repairResult.method || 'grok_blended',
      // WHAT THE TREATMENT ACTUALLY DID (face blur applied? hatch clipped to the
      // silhouette?). Without this a silent degradation - rectangular hatch, no
      // blur - is invisible after the fact: it only ever logged a warning that
      // production does not store (story job_1786024729214_zrjgzqiey p5).
      treatmentInfo: repairResult.treatmentInfo || null,
      // promptSent is always returned; debug.prompt only when includeDebug.
      prompt: repairResult.promptSent || repairResult.debug?.prompt || null,
      avatarSent: repairResult.debug?.avatarSent || repairResult.croppedAvatar || null,
      bbox: repairResult.debug?.bbox || null,
    });

    return {
      pageNumber,
      imageData: repairResult.imageData,
      source: `char-fix-round-${roundNum}`,
      modelId: `grok-imagine (${repairResult.method || 'grok_blended'})`,
      grokRefImages: null,
      inpaintInstruction: repairResult.debug?.prompt || null,
      inpaintReferenceImages: [
        repairResult.debug?.avatarSent || repairResult.croppedAvatar || null,
        repairResult.debug?.sceneSent || repairResult.blackoutImage || null,
      ].filter(Boolean),
      // Char-repair pipeline outputs for the dev-panel "Char-repair pipeline"
      // section (whiteout input → Grok raw output → feather blend mask). The
      // manual repair endpoint already persists these; the auto/pipeline path
      // dropped them (they only went into charFixDetails, not the version), so
      // the panel showed avatar+crosshatch inputs but no raw/feather.
      charRepairGrokRaw: repairResult.grokRawResult || repairResult.comparison?.grokRawResult || null,
      charRepairBlendMask: repairResult.blendMask || repairResult.comparison?.blendMask || null,
      charRepairWhiteout: repairResult.blackoutImage || repairResult.comparison?.blackoutImage || null,
      // Telemetry: which character char-fix actually targeted, which bbox it
      // crosshatched, where the bbox came from, and which body part. Without
      // these the post-hoc data (stories.data + retryHistory) shows source=
      // 'char-fix-round-N' but you can't tell who was targeted or where the
      // hatch landed — observed on prod page 5 v2 where inpaintInstruction
      // named Emma but the whiteout placed crosshatch on Sarah's bbox. Now
      // visible on the row + bubbled into retryHistory.
      charName,
      targetBbox: repairBbox,
      targetBboxSource: targetResolved.source,
      whiteoutTarget: useFaceOnly ? 'face' : 'body',
    };
  };

  // =========================================================================
  // Step 2: Round loop (1 to maxPasses) — per-page repair-method decision
  //         (skip / inpaint / iterate / char-fix) via decideRepairMethod
  // =========================================================================
  // Score terminology (THREE dimensions feed the round-loop decisions):
  //   visual    = raw vision-model quality score (qualityScore in evaluation)
  //               "is the image well rendered?"
  //   semantic  = semantic fidelity penalty already folded into evaluation.score
  //               BEFORE this loop runs. semanticPenalty = visual - evaluation.score
  //               "does the image match what the scene description says?"
  //   image     = visual - semantic = evaluation.score
  //               combined "how good is the image itself" score (no entity yet)
  //   entity    = entity consistency penalty (computed in this loop from entity report)
  //               "do characters look consistent across pages?"
  //   final     = image - entity
  //               the score findBadPages compares to regenThreshold
  //
  // Per-round per-page method (decideRepairMethod):
  //   final >= regenThreshold                          → ok            (no action)
  //   visual < 50 OR semantic < 30                     → iterate       (catastrophic)
  //   major/critical entity issue on this page         → char-fix
  //   has fixable quality/semantic content             → inpaint
  //   otherwise                                        → skip
  //
  // The flip logic below (lastRepairRegressed / forcedStrategyAfterFailures /
  // bothStrategiesTriedAndRegressed) only flips inpaint↔iterate. char-fix is
  // not flipped — if it failed last round, the next round's decideRepairMethod
  // sees the still-failing entity report and re-picks char-fix anyway.

  let currentEntityReport = entityReport;

  // Per-pipeline-round entity history. Same shape as the manual
  // /repair-workflow/consistency-check pushes (regeneration.js:4248) so the
  // round selector in the UI can browse generation-time rounds the same way.
  // Round 0 = initial check; subsequent rounds appended after each repair.
  const entityHistory = [];
  if (entityReport) {
    entityHistory.push({
      runIndex: 0,
      timestamp: entityReport.timestamp || new Date().toISOString(),
      triggeredBy: 'pipeline-initial',
      report: entityReport
    });
  }

  // ── Garment colour as a repair action ────────────────────────────────────
  // The entity grid reports a garment of the right shape in the wrong colour on
  // its own channel, carrying no severity and triggering no redraw, because the
  // fix is deterministic: DINO garment box → SAM mask → L*a*b* match toward the
  // styled avatar, scaled by a skin-probed lighting factor.
  //
  // WHERE IT RUNS (owner, 2026-08-10). It used to run once, before the repair
  // loop, against the first entity report. That was wrong twice over:
  //   - its work could be destroyed. On job_1786287569165_7f75jspcz p8 the hat
  //     and breeches were recoloured and the page was then iterated — v0 is
  //     photoreal, v2 is the shipped illustration, and the recolour went in the
  //     bin with the rest of v0;
  //   - it only ever saw the FIRST report. The per-round check found further
  //     drift that nothing consumed: on job_1786309527338_4zwhrn08y its 8
  //     mismatches carry no fixOutcome at all.
  //
  // The rule, in the owner's words: if we iterate there is no point recolouring
  // first, because the pixels are about to be replaced; if we inpaint or fix a
  // character we should recolour FIRST, so the repair works on corrected pixels
  // — and a wrong garment colour is one of the things that triggers char-fix, so
  // fixing it mechanically can remove the need for that Grok call entirely.
  //
  // It is a repair METHOD, not a side effect: a page whose only fault is colour
  // gets method 'recolour'. Its output ALWAYS becomes its own separately-graded
  // version (the recolour phase in the round loop below, with its own
  // evaluateImageBatch), even when an inpaint or char-fix follows on the same
  // page — otherwise one combined version means a failed inpaint drags the good
  // recolour down with it. COMPETE, DO NOT APPOINT — a recolour that made the
  // page worse loses pick-best on its own score. That is also what keeps it
  // checked; nothing recoloured ships unseen.
  const collectGarmentWork = (report) => {
    const { garmentQueryFor, GARMENT_VALUES } = require('./garmentColourFix');
    const byPage = new Map();
    for (const [charName, charData] of Object.entries(report?.characters || {})) {
      for (const m of (charData.garmentColourMismatches || [])) {
        // Already handled in an earlier round — do not recolour twice.
        if (m.fixOutcome) continue;
        // OFF-ENUM IS DROPPED, LOUDLY (owner, 2026-08-12). `garment` is a closed
        // vocabulary the evaluator fills; anything else is a word the detector
        // cannot ground, and asking anyway is how "hatband" repainted the whole
        // hat a second time and "robe" repainted the map on
        // job_1786484554633_crojok432 p3. Stamping fixOutcome retires it: the
        // word will not become valid on a later round.
        const q = garmentQueryFor(m.garment);
        if (!q.key) {
          const what = q.offEnum ? `"${q.raw}" is not in the garment enum` : 'no garment word at all';
          log.error(`❌ [GARMENT-COLOUR] ${charName}: ${what} (allowed: ${GARMENT_VALUES.join(', ')}) — dropping this mismatch rather than searching for something the detector cannot ground.`);
          m.fixOutcome = { garment: q.raw || null, skipped: `off-enum garment: ${what}`, at: new Date().toISOString() };
          continue;
        }
        for (const pageNumber of (m.pagesToFix || [])) {
          if (!byPage.has(pageNumber)) byPage.set(pageNumber, new Map());
          // Dedupe on the garment WORD: two entries naming the same garment on
          // the same page would otherwise segment and recolour it twice, the
          // second pass measuring bytes the first already changed.
          const k = `${charName.toLowerCase()}|${q.key}`;
          if (!byPage.get(pageNumber).has(k)) byPage.get(pageNumber).set(k, { charName, garmentKey: q.key, m });
        }
      }
    }
    return byPage;
  };

  /**
   * Recolour every flagged garment on one page. Returns the new bytes, or null
   * when nothing was changed. Every attempt writes its outcome onto the
   * mismatch entry so the record survives a container restart.
   */
  // FRESH DINO+SoM FOR A VERSION'S OWN BYTES (owner, 2026-08-19).
  //
  // Every path that creates a new image version must re-detect on the new
  // bytes. The recolour path did NOT: runGarmentRecolour returned the OLD
  // detection with sourceImageFp nulled -- the comment said "stale" and passed
  // it along anyway -- so the recolour version inherited its parent's boxes and
  // names verbatim. Measured on job_1787120984020_pg71z58ba9 p7: v1's stored
  // detection is IDENTICAL to v0's to the last decimal, fp missing, while the
  // recolour had just swapped two boys' shirt colours -- so every consumer of
  // v1 (entity grids, cutouts, the next round's decisions) read pre-recolour
  // identity against post-recolour pixels.
  //
  // Shared by the round-repair results and the recolour results so the two
  // paths cannot drift apart again. Builds the SAME dressed identity lines the
  // first detection gets (buildIdentityClothingText -- covers included), plus
  // the Visual-Bible secondaries.
  const redetectVersionImage = async (r, roundLabel) => {
    const orig = rawImages.find(i => i.pageNumber === r.pageNumber);
    const sceneChars = r.sceneCharacters || orig?.sceneCharacters || [];
    const meta = r.sceneMetadata || orig?.sceneMetadata || {};
    const clothingByName = r.sceneCharacterClothing || orig?.sceneCharacterClothing || meta.characterClothing || {};
    const sh = getStoryHelpers();
    const expectedCharacters = sceneChars.map(c => {
      const name = c.name || c;
      if (typeof c !== 'object') return { name, description: '' };
      const clothingText = sh.buildIdentityClothingText(
        c, clothingByName[name], artStyle, storyData?.clothingRequirements || null,
        { label: `p${r.pageNumber} ${roundLabel} ` });
      return { name, description: sh.buildIdentityLine(c, clothingText) };
    });
    expectedCharacters.push(...sh.buildSecondaryExpectedCharacters(
      visualBible, meta, expectedCharacters.map(c => c.name),
      { pageLabel: `PAGE ${r.pageNumber} ${roundLabel} `, extraNames: r.outlineCharacters || orig?.outlineCharacters || [] }
    ));
    return images().detectAllBoundingBoxes(r.imageData, {
      expectedCharacters,
      expectedObjects: Array.isArray(meta.objects) ? meta.objects.filter(x => typeof x === 'string') : [],
      sceneContext: r.description || orig?.sceneDescription || null,
      pageContext: `PAGE ${r.pageNumber} ${roundLabel}`,
      artStyle,
    });
  };

  const runGarmentRecolour = async (img, entries, roundNum) => {
    const { fixFigureGarmentColour } = require('./garmentColourFix');
    const { crossCheckFigureIdentity, isIdentityDisputed, resolveIdentityTiebreak } = require('./figureIdentityCheck');
    const pageNumber = img.pageNumber;
    // Same source and same selection the other repair actions use — the
    // highest-scoring version so far, not merely the newest.
    const bestSoFar = selectBestVersion(pageVersions.get(pageNumber) || []);
    let current = bestSoFar?.imageData || img.imageData;
    if (!current) return null;

    // One detection per bytes: prefer the version's own stamped detection.
    const detection = (bestSoFar && images().detectionForVersion(bestSoFar))
      || img.bboxDetection
      || (storyData?.sceneImages || []).find(s => s.pageNumber === pageNumber)?.bboxDetection
      || null;

    // SECOND OPINION before repainting anyone's clothes. The names on the
    // detection boxes come from the Set-of-Mark call in figureDetection.js,
    // whose prompt forces a complete assignment — it cannot answer "I don't
    // know", only right or confidently wrong. The quality eval identified the
    // same pixels independently (matches[] on the version, persisted since
    // 898e4f2f2). On staging job_1786397108357_q1fjbdzbx p14 the two disagreed:
    // SoM put "Hans" on the far-left man (actually Daniel), the eval called
    // that figure UNMATCHED and named the centre figure Hans at 80% — and the
    // recolour repainted the wrong man's coat (that version scored -80 and lost
    // pick-best, so the damage was caught only because it was visible).
    // Disputed → skip. A MISSING second opinion (verdict `unverified`) proceeds
    // exactly as before: an absent second opinion must never block the pipeline.
    const bestEvalObj = bestSoFar?.evaluation || bestSoFar || null;
    const identityCheck = crossCheckFigureIdentity(
      detection?.figures || [],
      bestEvalObj?.matches ?? bestSoFar?.matches ?? [],
      bestEvalObj?.figures ?? bestSoFar?.figures ?? [],
    );
    if (identityCheck.disputed.length) {
      const why = identityCheck.perFigure.filter(f => f.verdict === 'disputed').map(f => f.reason).join('; ');
      log.warn(`⚠️ [GARMENT-COLOUR] p${pageNumber}: identity disputed for ${identityCheck.disputed.join(', ')} — ${why}`);
    }

    let changed = 0, attempted = 0;
    for (const { charName, garmentKey, m } of entries) {
      const audit = { garment: garmentKey, round: roundNum, at: new Date().toISOString() };
      m.fixOutcome = audit;

      const fig = (detection?.figures || [])
        .find(f => (f?.name || '').toLowerCase() === charName.toLowerCase());
      if (!fig?.bodyBox) {
        audit.skipped = 'no detected figure on the page';
        log.warn(`⚠️ [GARMENT-COLOUR] ${charName} p${pageNumber} ${garmentKey}: no detected figure — skipped`);
        continue;
      }
      if (isIdentityDisputed(identityCheck, charName)) {
        const row = identityCheck.perFigure.find(f => f.verdict === 'disputed'
          && ((f.name || '').toLowerCase() === charName.toLowerCase() || (f.evalName || '').toLowerCase() === charName.toLowerCase()));
        // TIEBREAKER, DEFAULT OFF (MODEL_DEFAULTS.identityTiebreak, env
        // IDENTITY_TIEBREAK=true) and NOT IMPLEMENTED — resolveIdentityTiebreak
        // is a stub that returns null, so behaviour here is identical whether
        // the flag is on or off. TODO, the intended design:
        //   send the SAM cutout of the disputed figure plus the candidate
        //   styled avatars and ask which avatar it is. If it genuinely cannot
        //   be distinguished, assign one arbitrarily but STABLY (e.g.
        //   left-to-right order) and flag the page for character repair —
        //   because if a reader cannot tell them apart either, who becomes who
        //   is irrelevant; what matters is that each figure consistently
        //   matches some character, and character repair then enforces it.
        let resolved = null;
        if (MODEL_DEFAULTS.identityTiebreak) {
          resolved = await resolveIdentityTiebreak({ imageData: current, figure: fig, charName, artStyle, pageLabel: `p${pageNumber}` });
        }
        if (!resolved) {
          audit.skipped = `identity disputed: ${row?.reason || `detection and quality eval disagree about who ${charName} is`}`;
          audit.identityVerdicts = identityCheck.perFigure;
          log.warn(`⚠️ [GARMENT-COLOUR] ${charName} p${pageNumber} ${garmentKey}: ${audit.skipped} — not recolouring`);
          continue;
        }
      }
      const character = characters.find(c => (c.name || '').toLowerCase() === charName.toLowerCase());
      if (!character) { audit.skipped = 'character not in the story'; continue; }
      // NO DEFAULT (owner, 2026-08-07): the avatar is the colour target.
      if (!m.clothingCategory) {
        audit.skipped = 'mismatch carries no clothing category';
        log.error(`❌ [GARMENT-COLOUR] ${charName} p${pageNumber}: no clothing category — refusing to recolour toward a guessed outfit.`);
        continue;
      }
      // EXACT category only: the avatar's pixels ARE the target, so a
      // cross-category substitute repaints toward a different outfit's colour
      // while looking like a confident correction.
      const avatarUri = await getStyledAvatarForClothing(character, artStyle, m.clothingCategory, { exactCategory: true });
      if (!avatarUri) {
        audit.skipped = `no styled avatar for category ${m.clothingCategory}`;
        log.warn(`⚠️ [GARMENT-COLOUR] ${charName} p${pageNumber}: no styled avatar for category ${m.clothingCategory} — skipped (refusing a cross-category colour target)`);
        continue;
      }

      attempted++;
      const before = current;
      // observedColour is what the evaluator says the garment IS right now. It
      // steers SAM's point prompts and gates the mask: a mask that is not that
      // colour is not that garment, so nothing is repainted.
      const res = await fixFigureGarmentColour(before, fig, avatarUri, {
        garment: m.garment, observedColour: m.observedColour || null,
      });
      Object.assign(audit, {
        applied: !!res.changed,
        reason: res.report?.reason || null,
        dinoScore: res.report?.dinoScore ?? null,
        dinoBox: res.report?.dinoBox ?? null,
        current: res.report?.current ?? null,
        target: res.report?.target ?? null,
        delta: res.report?.delta ?? null,
        observedColour: res.report?.observedColour ?? null,
        observedMatch: res.report?.observedMatch ?? null,
        colourPoints: res.report?.colourPoints ?? null,
      });
      if (!res.changed) {
        log.info(`🎨 [GARMENT-COLOUR] ${charName} p${pageNumber} ${garmentKey}: no-op (${res.report?.reason || 'unknown'})`);
        continue;
      }
      // NO SEPARATE 'BEFORE' IMAGE (owner, 2026-08-15). This used to save the
      // pre-recolour page as image_type 'garment_before'. It never once
      // succeeded — zero such rows have ever existed — because story_images
      // .story_id references stories.id and the story row is not inserted until
      // the end of generation: on job_1786780194082_s980g4s9a the recolour ran
      // at 08:04:40 and the row appeared at 08:09:43, five minutes later. Every
      // attempt failed the foreign key and left a beforeSaveError that reads
      // like a broken repair.
      //
      // It was redundant anyway: the version chain already holds before and
      // after as full images — v0 'original' and v1 'garment-recolour-round-N'
      // — because a recolour is graded as its own version. A third copy adds
      // nothing.
      current = res.imageData;
      changed++;
    }
    if (!changed) return null;
    log.info(`🎨 [GARMENT-COLOUR] p${pageNumber} round ${roundNum}: ${changed}/${attempted} garment(s) recoloured`);
    // CARRY THE GEOMETRY, RE-STAMP THE FP (owner, 2026-08-19). A recolour
    // repaints pixels INSIDE existing silhouettes — it cannot move a box or a
    // mask, so the parent's geometry is valid for the new bytes by
    // construction and a fresh DINO+SAM here is pure same-bytes waste. What a
    // recolour CAN get wrong is colour, and the fresh EVAL catches that.
    // The carry is explicit: shallow copy (never mutate the parent's record),
    // masks re-attached, sourceImageFp re-stamped to the NEW bytes, and
    // recolourCarried on the diag so this is data — the previous version of
    // this carry nulled the fp and said nothing, which is how a swap went
    // undiagnosable for a day.
    let carried = null;
    if (detection) {
      carried = { ...detection };
      if (detection._gdinoMasks) {
        Object.defineProperty(carried, '_gdinoMasks', { value: detection._gdinoMasks, enumerable: false });
      }
      // Same fingerprint function the stamping wrapper uses (imageFingerprint)
      // — hashImageData is a different keyspace and would never match a verify.
      try { carried.sourceImageFp = images().imageFingerprint(current); } catch { carried.sourceImageFp = null; }
      carried.gdinoDiag = {
        ...(detection.gdinoDiag || {}),
        recolourCarried: { fromFp: detection.sourceImageFp || null, round: roundNum },
      };
    }
    return { imageData: current, detection: carried, changed };
  };

  const { decideRepairMethod } = require('./repairLogic');

  for (let round = 1; round <= maxRegenAttempts; round++) {
    // Build eval map for this round using best versions so far. Each entry now
    // carries explicit visualScore / semanticPenalty / imageScore / entityPenalty /
    // finalScore so bad-page detection and the per-page method decision can
    // read each dimension directly without mutating the existing qualityScore
    // field (300+ call sites).
    //
    // Entity-only pages — images with strong visual+semantic but a character
    // drift — are NOT skipped. They fall through to decideRepairMethod which
    // returns char-fix as the per-page method. This collapses the old Step 5
    // separate character-repair pass into the round loop itself.
    const roundEvalPages = {};
    for (const img of rawImages) {
      if (!img.imageData) continue;
      const versions = pageVersions.get(img.pageNumber) || [];
      const bestSoFar = selectBestVersion(versions);
      if (!bestSoFar) {
        // A page with image bytes but no version object at all can never be
        // repaired — it is not in pageVersions, so no round will ever act on
        // it. Loud, because the symptom (a bad page shipping untouched) is
        // otherwise indistinguishable from "the page was fine".
        log.error(`❌ [PIPELINE] Round ${round} page ${img.pageNumber}: no version object — page cannot be scored or repaired`);
        continue;
      }
      // GATE ON THE CANONICAL SCORE, not the legacy `.score` mirror. `.score`
      // is the evaluator's merged number (ev.score ?? ev.qualityScore); it is
      // null whenever the eval failed or returned an unexpected shape, and the
      // old `if (bestSoFar.score != null)` guard then dropped the page out of
      // roundEvalPages entirely — before findBadPages could see it. That made
      // findBadPages' own `evaluated === false → redo` branch (repairLogic.js)
      // unreachable from the pipeline: a page whose evaluation errored was
      // silently shipped instead of redone.
      const { computeFinalScore: roundScoreOf } = require('./scoring');
      const finalScore = roundScoreOf(bestSoFar);
      const entityPenalty = bestSoFar.entityPenalty || 0;
      // Single-scale visual read — the SAME chain decideRepairMethod uses, so
      // the number logged here is the number the <50 catastrophic gate sees.
      const visualScore =
        bestSoFar.scoreBreakdown?.visual?.score
        ?? bestSoFar.evaluation?.qualityScore
        ?? null;

      if (finalScore == null) {
        // No readable score anywhere on the best version. Never skip silently:
        // mark it evaluated:false so findBadPages redoes it, and say so at
        // ERROR level naming the page.
        log.error(`❌ [PIPELINE] Round ${round} page ${img.pageNumber}: no readable score on best version (source=${bestSoFar.source || '?'}, evaluated=${bestSoFar.evaluation?.evaluated}) — treating as bad so it is not silently skipped`);
        roundEvalPages[img.pageNumber] = {
          ...bestSoFar.evaluation,
          evaluated: false,
          evalError: bestSoFar.evaluation?.evalError || 'no readable score on best version',
        };
        continue;
      }

      const imageScore = bestSoFar.score ?? null;
      const semanticPenalty = (visualScore != null && imageScore != null)
        ? Math.max(0, visualScore - imageScore)
        : 0;

      log.debug(`📊 [PIPELINE] Round ${round} Page ${img.pageNumber}: vis=${visualScore} sem=-${semanticPenalty} img=${imageScore} ent=-${entityPenalty} final=${finalScore}`);

      roundEvalPages[img.pageNumber] = {
          ...bestSoFar.evaluation,
          // scoreBreakdown travels with the eval object so decideRepairMethod
          // reads the version's canonical per-evaluator scores instead of
          // falling back to the legacy evaluator-scale qualityScore.
          scoreBreakdown: bestSoFar.scoreBreakdown || bestSoFar.evaluation?.scoreBreakdown || null,
          consolidatedPlan: bestSoFar.consolidatedPlan || bestSoFar.evaluation?.consolidatedPlan || null,
          visualScore,
          semanticPenalty,
          imageScore,
          entityPenalty,
          finalScore,
        };
    }

    const badPageNums = findBadPages(roundEvalPages, { scoreThreshold: regenThreshold });
    // A page whose ONLY fault is garment colour scores fine — colour carries no
    // severity by design — so findBadPages never returns it and it would never
    // be touched. A flagged garment is a reason to work on a page.
    const garmentWork = MODEL_DEFAULTS.garmentColourFix
      ? collectGarmentWork(currentEntityReport) : new Map();
    const colourOnlyNums = [...garmentWork.keys()].filter(pn => !badPageNums.includes(pn));
    const badPages = rawImages.filter(img =>
      badPageNums.includes(img.pageNumber) || colourOnlyNums.includes(img.pageNumber));
    if (colourOnlyNums.length) {
      log.info(`🎨 [GARMENT-COLOUR] Round ${round}: ${colourOnlyNums.length} colour-only page(s) pulled in: ${colourOnlyNums.join(', ')}`);
    }

    if (badPages.length === 0) {
      log.info(`✅ [UNIFIED PIPELINE] Round ${round}: No bad pages, stopping repair loop`);
      break;
    }
    require('./runMetrics').forJob(storyData?.id || jobId).add('redo_trigger', badPages.length);

    // Progress: spread rounds across 35-60% range
    const progressBase = 68 + Math.floor((round - 1) / maxRegenAttempts * 20);
    await updateProgress(progressBase, `Round ${round}/${maxRegenAttempts}: Repairing ${badPages.length} pages...`);

    // Per-page decision: ONE method per page per round.
    //   1. catastrophic visual/semantic → iterate
    //   2. major/critical entity issue → char-fix
    //   3. otherwise inpaintable → inpaint
    //   4. nothing actionable → skip
    // The flip logic (inpaint↔iterate) below overrides #3 when the last
    // repair regressed or both have been tried — that's still useful for
    // inpaint/iterate. char-fix decisions are NOT flipped — if char-fix
    // didn't help in round N, the next round's decideRepairMethod sees
    // the still-failing entity report and picks char-fix again, potentially
    // on the iterated/inpainted result of a prior round.
    const pageStrategies = badPages.map(img => {
      const versions = pageVersions.get(img.pageNumber) || [];
      const bestSoFar = selectBestVersion(versions);
      // Use the SAME enriched entry findBadPages just judged — it carries the
      // version's canonical scoreBreakdown + finalScore on top of the raw
      // evaluation. Reading bestSoFar.evaluation directly instead made the
      // bad-page gate and the method decision run on two different score
      // scales (canonical math vs legacy evaluator qualityScore).
      const latestEval = roundEvalPages[img.pageNumber]
        || bestSoFar?.evaluation
        || evalMap.get(img.pageNumber);

      if (bothStrategiesTriedAndRegressed(versions)) {
        // Never silently drop unaddressed high-severity issues. When a page is
        // given up on, surface any CRITICAL/CATASTROPHIC issues still present
        // in its latest eval (these include fixes deferred by the per-round
        // cap-at-3 that never got attempted) so they're visible in logs and can
        // be manually repaired — instead of shipping a defect without a trace.
        const outstanding = [
          ...(latestEval?.fixableIssues || []),
          ...(latestEval?.semanticResult?.semanticIssues || latestEval?.semanticResult?.issues || []),
        ].filter(i => /catastrophic|critical/i.test(String(i?.severity || '')));
        if (outstanding.length > 0) {
          log.warn(`  ⚠️  [UNIFIED PIPELINE] Round ${round} page ${img.pageNumber}: giving up with ${outstanding.length} unaddressed ${outstanding.length === 1 ? 'issue' : 'issues'} — ${outstanding.map(i => `[${i.severity}] ${String(i.description || i.problem || '').substring(0, 60)}`).join(' | ')}`);
        } else {
          log.info(`  ⏭️  [UNIFIED PIPELINE] Round ${round} page ${img.pageNumber}: skipped — both inpaint and iterate already tried, neither improved the original`);
        }
        return { img, method: null, latestEval, skipped: true };
      }

      // NEVER REPAIR BLIND (owner, 2026-08-09). This passed `latestEval || {}`,
      // so a page whose evaluation was missing still got a repair method: every
      // gate in decideRepairMethod compares a number (visualScore < 50,
      // semanticScore < 30) and `undefined < 50` is false, so all of them fall
      // through and a method is chosen from nothing. Repairing an image before
      // we know what is wrong with it is how a good page gets replaced by a
      // worse one. No score, no repair — skip the page and say why.
      if (!latestEval || latestEval.qualityScore == null) {
        log.warn(`  ⏭️  [UNIFIED PIPELINE] Round ${round} page ${img.pageNumber}: skipped — no evaluation to repair from (qualityScore is ${latestEval ? 'null' : 'absent'})`);
        return { img, method: null, latestEval, skipped: true };
      }

      const decision = decideRepairMethod(img.pageNumber, latestEval, currentEntityReport);
      let method = decision.method;
      let reason = decision.reason;

      // Inpaint↔iterate flip logic — only applies when the chosen method
      // is one of those two AND prior rounds with the same method failed.
      if (method === 'inpaint' || method === 'iterate') {
        const regressedFlip = lastRepairRegressed(versions);
        const forced = forcedStrategyAfterFailures(versions);
        if (regressedFlip) {
          method = regressedFlip;
          const prevStrat = regressedFlip === 'inpaint' ? 'iterate' : 'inpaint';
          reason = `forced ${regressedFlip} — last ${prevStrat} regressed, flipping`;
        } else if (forced) {
          method = forced;
          reason = `forced ${forced} — last two rounds both used ${forced === 'inpaint' ? 'iterate' : 'inpaint'} without fixing it`;
        }
      }

      // Nothing else wrong with the page, but a garment drifted → the recolour
      // IS the repair for this round rather than a no-op.
      if ((method === 'skip' || method == null) && garmentWork.has(img.pageNumber)) {
        method = 'recolour';
        reason = `garment colour drift (${[...garmentWork.get(img.pageNumber).values()].map(e => `${e.charName} ${e.garmentKey}`).join(', ')})`;
      }

      log.info(`  📋 [UNIFIED PIPELINE] Round ${round} page ${img.pageNumber}: ${method} (${reason})${decision.charName ? ` [${decision.charName}]` : ''}`);
      return { img, method, latestEval, decision };
    });

    const counts = pageStrategies.reduce((acc, p) => {
      const k = p.skipped ? 'skipped' : (p.method || 'skip');
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    log.info(`🔄 [UNIFIED PIPELINE] Round ${round}: ${badPages.length} bad pages → ${counts.iterate || 0} iterate, ${counts.inpaint || 0} inpaint, ${counts['char-fix'] || 0} char-fix, ${counts.recolour || 0} recolour${counts.skipped ? `, ${counts.skipped} skipped` : ''}${counts.skip ? `, ${counts.skip} no-op` : ''}`);

    const repairableCount = (counts.iterate || 0) + (counts.inpaint || 0) + (counts['char-fix'] || 0) + (counts.recolour || 0);
    if (repairableCount === 0) {
      log.info(`✅ [UNIFIED PIPELINE] Round ${round}: nothing actionable, stopping repair loop`);
      break;
    }

    // ── RECOLOUR PHASE (owner, 2026-08-10) ─────────────────────────────────
    // The mechanical garment recolour runs BEFORE the repairs and produces its
    // OWN separately-graded version. Why its own version rather than folding
    // the corrected pixels into whatever the repair returns: when a page gets
    // recolour + inpaint, one combined version means a failed or regressing
    // inpaint takes the good recolour down with it. Graded on its own, the
    // recolour competes in pick-best by itself and can ship alone.
    //
    // It still ALSO feeds the repair through inputOverride. Pick-best cannot be
    // the transport: garment colour carries no severity, so the recolour
    // version's score ties with the original and eval noise decides which one
    // the repair would read. The override guarantees corrected pixels.
    //
    // One result per page per batch: the round machinery is keyed by
    // pageNumber throughout (roundImageMap, eval lookups, pageVersions.get),
    // so this phase runs its own evaluateImageBatch rather than pushing a
    // second entry for the same page into the round's batch.
    //
    // iterate is never recoloured — the pixels are about to be replaced.
    const recolourBytes = new Map();      // pageNumber -> corrected bytes (inputOverride)
    const recolourVersioned = new Set();  // pages that got a graded version here
    const recolourTargets = pageStrategies.filter(pStrat =>
      !pStrat.skipped
      && pStrat.method
      && pStrat.method !== 'skip'
      && pStrat.method !== 'iterate'
      && garmentWork.has(pStrat.img.pageNumber));

    if (recolourTargets.length > 0) {
      const recolourHeartbeat = setInterval(() => { pingHeartbeat().catch(() => {}); }, 30000);
      try {
        const recolourLimit = pLimit(8);
        const recolourResults = (await Promise.all(recolourTargets.map(({ img }) => recolourLimit(async () => {
          const pageNumber = img.pageNumber;
          try {
            const res = await runGarmentRecolour(img, [...garmentWork.get(pageNumber).values()], round);
            if (!res?.imageData) return null;
            return { pageNumber, imageData: res.imageData, bboxDetection: res.detection || null };
          } catch (err) {
            log.error(`❌ [GARMENT-COLOUR] Round ${round} p${pageNumber}: recolour failed — ${err.message}`);
            return null;
          }
        })))).filter(Boolean);

        for (const rc of recolourResults) recolourBytes.set(rc.pageNumber, rc.imageData);

        // No re-detect for recolours (owner, 2026-08-19): a recolour cannot move
        // geometry, so runGarmentRecolour carries the parent's boxes/masks with
        // the fp re-stamped to the new bytes. Only the EVAL re-runs.

        if (recolourResults.length > 0) {
          log.info(`🎨 [GARMENT-COLOUR] Round ${round}: ${recolourResults.length} page(s) recoloured — evaluating as their own version(s)`);
          let recolourEvals = [];
          try {
            recolourEvals = await images().evaluateImageBatch(
              buildEvalInputs(recolourResults),
              { concurrency: evalConcurrency, qualityModelOverride, visualBible, clothingRequirements: storyData?.clothingRequirements || null, artStyle }
            );
          } catch (err) {
            // No score → no version. The bytes still go to the repair via
            // inputOverride, and the failed() path below keeps them as a
            // round result so they are not lost.
            log.warn(`⚠️ [GARMENT-COLOUR] Round ${round}: recolour eval failed (${err.message}) — no recolour version this round`);
            recolourEvals = [];
          }

          const recolourMap = new Map(recolourResults.map(rc => [rc.pageNumber, rc]));
          const recolourConsolidated = new Map();
          await Promise.all(recolourEvals.map(ev => consolidateLimit(async () => {
            const entityResult = getEntityPenaltyAndIssues(ev.pageNumber, currentEntityReport);
            // No scene rewrite here — the recolour repaints pixels inside an
            // existing figure, so the page's own contract still applies.
            const plan = await consolidatePageEval(ev, entityResult.issues, ev.pageNumber, round, null);
            if (plan) recolourConsolidated.set(ev.pageNumber, plan);
          })));

          for (const ev of recolourEvals) {
            if (ev.usage && usageTracker) {
              usageTracker('gemini_quality', ev.usage, `unified_pipeline_recolour_r${round}`, ev.modelId);
            }
            const versions = pageVersions.get(ev.pageNumber);
            const rc = recolourMap.get(ev.pageNumber);
            if (!versions || !rc) continue;
            const evEntityResult = getEntityPenaltyAndIssues(ev.pageNumber, currentEntityReport);
            const { applyScore } = require('./scoring');
            const recolourVersion = {
              imageData: rc.imageData,
              score: ev.score ?? ev.qualityScore ?? null,
              source: `garment-recolour-round-${round}`,
              method: 'recolour',
              evaluation: ev,
              modelId: ev.modelId || null,
              prompt: null,
              bboxDetection: rc.bboxDetection || null,
              entityIssues: evEntityResult.issues,
              evaluatedAt: new Date().toISOString(),
              pageNumber: ev.pageNumber,
            };
            // COMPETE, DO NOT APPOINT — the same applyScore stamp every other
            // version gets, from this version's own evaluation.
            applyScore(recolourVersion, {
              evalResult: ev,
              entityResult: evEntityResult,
              consolidatedPlan: recolourConsolidated.get(ev.pageNumber) || null,
            });
            // Creation-time integrity tripwire: the bytes this version stores
            // must be the bytes its eval graded (job_1786571353564 p4 shipped
            // red bytes carrying the eval of their yellow predecessor; the
            // decoupling point was never pinned). pickBestVersionIndex refuses
            // the score later regardless — this log names the spot at creation.
            if (ev.evalImageFp && images().hashImageData(rc.imageData) !== ev.evalImageFp) {
              log.error(`❌ [GARMENT-COLOUR] p${ev.pageNumber} round ${round}: version bytes do not match the bytes the eval graded (eval fp ${ev.evalImageFp}) — eval/bytes decoupled at creation`);
            }
            versions.push(recolourVersion);
            recolourVersioned.add(ev.pageNumber);
          }
        }
      } finally {
        clearInterval(recolourHeartbeat);
      }
    }

    const roundStart = Date.now();
    const repairLimit = pLimit(50);

    // Periodic heartbeat while parallel repairs are in flight. Iterate's
    // internal stages (Stage 1 vision, Stage 2 compliance Sonnet call,
    // image gen, bbox detect) can each take 60-120s and don't ping the
    // job heartbeat themselves. With 7 pages running in parallel, the
    // slowest one drives the round duration; any single page stalled in
    // a Sonnet call past 5 min trips the front-end stall watcher and
    // kills the whole job. A 30s ticker keeps the row's updated_at
    // fresh until Promise.all resolves.
    const repairHeartbeatInterval = setInterval(() => {
      pingHeartbeat().catch(() => {});
    }, 30000);

    // Execute all repairs in parallel
    let roundResults;
    try {
      roundResults = await Promise.all(
      pageStrategies.map(({ img, method, latestEval, decision, skipped }) => repairLimit(async () => {
        const pageNumber = img.pageNumber;
        if (skipped || method === 'skip' || method == null) {
          return { pageNumber, imageData: null, skipped: true };
        }
        try {
          // The recolour already ran in the recolour phase above and became its
          // own scored version. Its bytes are handed to the repair here so the
          // repair works on corrected pixels — never via pick-best, which
          // garment colour (no severity) cannot reliably win.
          const recolourInput = recolourBytes.get(pageNumber) || null;

          // A repair that fails must not throw away a successful recolour. It
          // normally cannot: the recolour is already a graded version. The one
          // hole is a page whose recolour eval failed (no version) — there the
          // corrected bytes are returned as the round result so the round eval
          // grades them instead.
          const failed = (error) => ((recolourInput && !recolourVersioned.has(pageNumber))
            ? { pageNumber, imageData: recolourInput, method: 'recolour',
                source: `garment-recolour-round-${round}`, repairError: error }
            : { pageNumber, imageData: null, method, error });

          // 'recolour' as a METHOD means the recolour IS the repair for this
          // page. Phase (c) already produced and graded that version, so the
          // round dispatch has nothing left to do — one result per page.
          if (method === 'recolour') {
            return { pageNumber, imageData: null, skipped: true };
          }

          if (method === 'inpaint') {
            const inpaintResult = await executeInpaintAction(img, latestEval, round, recolourInput);
            if (inpaintResult.repaired && inpaintResult.imageData) {
              return {
                pageNumber,
                imageData: inpaintResult.imageData,
                source: `inpaint-round-${round}`,
                modelId: inpaintResult.usage?.model || 'grok-text-edit',
                inpaintInstruction: inpaintResult.instruction,
                inpaintReferenceImages: inpaintResult.referenceImages || null,
                inpaintReferenceSources: inpaintResult.referenceImageSources || null,
                consolidatedPlan: inpaintResult.consolidatedPlan || null,
                grokRefImages: null,
              };
            }
            return failed('inpaint produced no result');
          }
          if (method === 'iterate') {
            const result = await executeIterateAction(img, latestEval);
            if (result?.imageData) {
              // For composite-cover iterate the bottom-line "result" hides a
              // 2-pass workflow with 4 intermediate buffers and 2 distinct
              // prompts. Carry that detail forward so the version row records
              // exactly what went to the image model on each pass — without
              // this the dev panel can't distinguish a composite iterate from
              // a legacy iterate, and there's no way to inspect why pass 1
              // produced the wrong arms or why pass 2 lost the gaze.
              // Single source of truth for composite-debug → version shape.
              // Defined once in coverComposite; both this unified-pipeline
              // call site and the user-triggered iterate endpoint use it.
              const { buildCompositeAttemptsFromDebug } = require('./coverComposite');
              const compositeAttempts = buildCompositeAttemptsFromDebug(result.compositeDebug);
              return {
                pageNumber,
                imageData: result.imageData,
                source: compositeAttempts ? `composite-iterate-round-${round}` : `iterate-round-${round}`,
                method: compositeAttempts ? 'composite' : undefined,
                modelId: result.modelId,
                grokRefImages: result.grokRefImages || null,
                referencePhotos: result.referencePhotos || null,
                // O6: direct-path covers — iterateCover returns these; they
                // were dropped here, leaving the landmark/VB-grid refs
                // unviewable after reload.
                landmarkPhotos: result.landmarkPhotos || null,
                visualBibleGrid: result.visualBibleGrid || null,
                // Capture the iterate's actual image prompt — this is the
                // feedback-augmented prompt that was sent to Grok (built in
                // iteratePageCore line ~7250 + appended evaluation feedback at
                // line ~7253). Without this, the persisted version at
                // buildVersionEntry falls back to img.prompt (the ORIGINAL
                // page prompt), which makes the dev panel + audit trail show
                // the wrong text and hides whether feedback was actually
                // appended.
                prompt: result.imagePrompt || null,
                description: result.newScene || null,
                // The iterate's rewritten scene contract — evaluation of this
                // version MUST use these, not the original page metadata (a
                // rewrite that re-includes a character the plan dropped was
                // evaluated against the old plan, flagged as "extra character",
                // and inpaint-removed; see docs/decisions.md).
                sceneMetadata: result.newSceneMetadata || null,
                sceneCharacters: result.newSceneCharacters || null,
                compositeAttempts,
                // Fresh detection of THIS redraw (iterate re-detects internally
                // on its accepted image). Carried so the per-round garment-hue
                // pass can normalize the redraw BEFORE it is scored, reusing this
                // detection's mask (no extra detect). inpaint/char-fix don't
                // produce a full-image detection → those redraws are skipped.
                bboxDetection: result.bboxDetection || null,
              };
            }
            return { pageNumber, imageData: null, method, error: 'iterate produced no result' };
          }
          if (method === 'char-fix') {
            const result = await executeCharFixAction(img, decision, round, recolourInput);
            if (result?.imageData) {
              return result;
            }
            return failed(result?.error || 'char-fix produced no result');
          }
          return { pageNumber, imageData: null, method, error: `unknown method ${method}` };
        } catch (err) {
          log.error(`❌ [UNIFIED PIPELINE] Round ${round} ${method} failed for page ${pageNumber}: ${err.message}`);
          return { pageNumber, imageData: null, method, error: err.message };
        }
      }))
      );
    } finally {
      clearInterval(repairHeartbeatInterval);
    }

    const roundSuccess = roundResults.filter(r => r.imageData);
    const roundDuration = ((Date.now() - roundStart) / 1000).toFixed(1);
    log.info(`✅ [UNIFIED PIPELINE] Round ${round}: ${roundSuccess.length}/${badPages.length} repaired in ${roundDuration}s`);

    // Failed round attempts used to vanish (filtered out above, log-only) —
    // "why didn't round 2 fix this page" was undiagnosable afterwards.
    // Record each failure on the page's retryHistory so it persists.
    for (const f of roundResults.filter(r => r && !r.imageData)) {
      const img = rawImages.find(i => i.pageNumber === f.pageNumber);
      if (!img) continue;
      img.retryHistory = img.retryHistory || [];
      img.retryHistory.push({
        attempt: img.retryHistory.length + 1,
        type: 'round_repair_failed',
        round,
        method: f.method || null,
        error: f.error || 'no result',
        timestamp: new Date().toISOString(),
      });
    }

    // Run fresh entity consistency AND quality eval in parallel. They're
    // independent — `evaluateImageBatch` doesn't consume the entity report
    // (entity penalties are applied later when scores are combined). Running
    // them sequentially used to add ~90-120s per round; on a 3-round repair
    // pipeline that was ~5 min of dead serialisation. Step 1 already does the
    // same Promise.all for the initial pass.
    let roundEvals = [];
    if (roundSuccess.length > 0) {
      // Build entity check inputs (snapshot of latest images: repaired pages
      // from this round + best-so-far for pages not touched this round).
      const roundImageMap = new Map(roundSuccess.map(r => [r.pageNumber, r]));

      // ONE detection per repaired image, consumed by BOTH the entity check
      // and the eval below — the round-loop mirror of Phase 5b-pre. iterate
      // results already carry the detection made on their accepted redraw;
      // inpaint / char-fix results don't, so detect those here. Without this,
      // eval and entity each ran their own detection on the same new bytes,
      // and the two SoM identity calls could disagree.
      const roundDetectLimit = pLimit(8);
      // Same identity line the first detection gets (Phase 5b-pre) -- the shared
      // redetectVersionImage builds it (dressed lines + VB secondaries). Without
      // it this re-detect OVERWRITES a good detection with one made from bare
      // names (job_1786737619634_d66c7bg9g p4: expectedCharacters came back
      // with empty descriptions).
      await Promise.all(roundSuccess.filter(r => !r.bboxDetection).map(r => roundDetectLimit(async () => {
        try {
          r.bboxDetection = await redetectVersionImage(r, `r${round}`);
        } catch (err) {
          log.warn(`⚠️ [UNIFIED PIPELINE] Round ${round} P${r.pageNumber}: shared detection failed (${err.message}) -- eval and entity will detect independently`);
          r.bboxDetection = null;
        }
      })));

      // Entity check ONLY the round's repaired images (owner, 2026-08-09):
      // a version's entity punishment is computed ONCE, on its own bytes, at
      // creation — judged against the character reference sheet (the
      // canonical), with single appearances allowed. Untouched pages keep
      // their existing stamps; no whole-story re-run per round.
      const repairedEntries = roundSuccess.map(re => ({
        imageData: re.imageData,
        pageNumber: re.pageNumber,
        // The round entry's own scene contract (iterate rewrites it) so the
        // entity check judges the repaired image against what was actually
        // asked of it — and its detection, so the entity crops use the same
        // figure names every other consumer of this version sees.
        description: re.description || null,
        bboxDetection: re.bboxDetection || null,
      }));
      const freshEntityCheckData = buildEntityCheckData(repairedEntries);
      const roundEvalInputs = buildEvalInputs(roundSuccess);

      const evalProgressPct = progressBase + 6;
      await updateProgress(evalProgressPct, `Round ${round}: Evaluating + entity check ${roundSuccess.length} repaired images...`);
      log.info(`🔍 [UNIFIED PIPELINE] Round ${round}: Running entity consistency + eval in parallel on ${roundSuccess.length} images...`);

      const [freshEntityResult, evalsResult] = await Promise.allSettled([
        runEntityConsistencyChecks(freshEntityCheckData, characters, {
          checkCharacters: true,
          // Objects intentionally off — see comment at the initial-pass call
          // site above. Per-page presence is the quality/semantic eval's job.
          checkObjects: false,
          saveGrids: false,
          // Repaired pages are judged alone against the reference sheet — a
          // single appearance must still be checked (no cross-page minimum).
          minAppearances: 1,
          onHeartbeat: pingHeartbeat
        }),
        images().evaluateImageBatch(roundEvalInputs, { concurrency: evalConcurrency, qualityModelOverride, visualBible, clothingRequirements: storyData?.clothingRequirements || null, artStyle }),
      ]);

      if (freshEntityResult.status === 'fulfilled') {
        const freshEntity = freshEntityResult.value;
        if (freshEntity?.tokenUsage && usageTracker) {
          usageTracker('gemini_quality', {
            input_tokens: freshEntity.tokenUsage.inputTokens || 0,
            output_tokens: freshEntity.tokenUsage.outputTokens || 0
          }, `entity_consistency_r${round}`, freshEntity.tokenUsage.model || 'gemini-2.5-flash');
        }
        // Merge: repaired pages' issues are REPLACED by the fresh (per-image)
        // findings; untouched pages keep their existing evidence. The merged
        // view only feeds next-round repair decisions — per-version scores
        // come from the era-matched stamps below.
        const repairedPageNums = roundSuccess.map(r => r.pageNumber);
        currentEntityReport = mergeEntityIssues(currentEntityReport, freshEntity, repairedPageNums);
        entityHistory.push({
          runIndex: round,
          timestamp: freshEntity.timestamp || new Date().toISOString(),
          triggeredBy: `pipeline-round-${round}`,
          // The per-round report (repaired pages only) — the UI browses these.
          report: freshEntity
        });
        log.info(`✅ [UNIFIED PIPELINE] Round ${round}: Entity consistency on ${repairedPageNums.length} repaired page(s): ${freshEntity.totalIssues} issue(s) (merged view: ${currentEntityReport.totalIssues})`);
      } else {
        log.warn(`⚠️ [UNIFIED PIPELINE] Round ${round}: Entity consistency failed: ${freshEntityResult.reason?.message || freshEntityResult.reason}`);
      }

      if (evalsResult.status === 'fulfilled') {
        roundEvals = evalsResult.value;
      } else {
        log.warn(`⚠️ [UNIFIED PIPELINE] Round ${round}: Quality eval failed: ${evalsResult.reason?.message || evalsResult.reason}`);
        roundEvals = [];
      }

      // Consolidate each round evaluation before scoring — same dedupe step
      // as the initial pass (one Sonnet call per repaired page, parallel).
      const roundConsolidated = new Map();
      await Promise.all(roundEvals.map(ev => consolidateLimit(async () => {
        const entityResult = getEntityPenaltyAndIssues(ev.pageNumber, currentEntityReport);
        // Consolidate against the round entry's OWN scene contract when the
        // repair rewrote it (iterate) — the original description would
        // re-flag spec conflicts the rewrite just resolved.
        const roundEntry = roundImageMap.get(ev.pageNumber);
        const plan = await consolidatePageEval(ev, entityResult.issues, ev.pageNumber, round, roundEntry?.description || null);
        if (plan) roundConsolidated.set(ev.pageNumber, plan);
      })));

      // pageVersions append is intentionally sequential here. Earlier audits
      // raised a concern about parallel .set() races — that concern was based
      // on a different code shape. Today each page picks ONE repair method
      // (executeIterateAction OR executeInpaintAction OR executeCharFixAction)
      // and returns ONE result. The for-loop reads pageVersions.get(n) — the
      // returned array reference is mutated by .push() — so no .set() race
      // is possible and no per-page lock is needed.
      for (const ev of roundEvals) {
        if (ev.usage && usageTracker) {
          usageTracker('gemini_quality', ev.usage, `unified_pipeline_quality_r${round}`, ev.modelId);
        }
        const versions = pageVersions.get(ev.pageNumber);
        const repairResult = roundSuccess.find(r => r.pageNumber === ev.pageNumber);
        if (versions && repairResult) {
          const evScore = ev.score ?? ev.qualityScore ?? null;
          const evEntityResult = getEntityPenaltyAndIssues(ev.pageNumber, currentEntityReport);
          const { applyScore } = require('./scoring');
          const newVersion = {
            imageData: repairResult.imageData,
            score: evScore,
            source: repairResult.source,
            evaluation: ev,
            modelId: repairResult.modelId,
            grokRefImages: repairResult.grokRefImages || null,
            referencePhotos: repairResult.referencePhotos || null,
            inpaintInstruction: repairResult.inpaintInstruction || null,
            inpaintReferenceImages: repairResult.inpaintReferenceImages || null,
            // Per-version prompt/description for iterate results — passes
            // through to buildVersionEntry so dev panel shows what was
            // actually sent to Grok, not the stale original page prompt.
            prompt: repairResult.prompt || null,
            description: repairResult.description || null,
            // Detection is part of every image version (owner decision
            // 2026-07-31): the ONE detection made on this result's bytes
            // (iterate's internal or the round pre-detect), stamped directly
            // so detectionForVersion resolves it even if the eval failed.
            bboxDetection: repairResult.bboxDetection || null,
            entityIssues: evEntityResult.issues,
            evaluatedAt: new Date().toISOString(),
            // Composite-cover 2-pass debug bundle from executeIterateAction
            // (cover iterates only). buildVersionEntry reads v.compositeAttempts
            // and v.method to populate the version row so the modal can render
            // the pass-1/pass-2 plates. Without these two lines the source
            // label still says 'composite-iterate-round-N' but the version
            // has compositeAttempts:null → modal shows score+prompt but no
            // intermediate thumbnails. Verified missing on staging job
            // job_1779382004213_idu0axofe initialPage v1.
            compositeAttempts: repairResult.compositeAttempts || null,
            method: repairResult.method || null,
            charRepairGrokRaw: repairResult.charRepairGrokRaw || null,
            charRepairBlendMask: repairResult.charRepairBlendMask || null,
            charRepairWhiteout: repairResult.charRepairWhiteout || null,
          };
          // Canonical stamp AT CREATION (single scale): the same applyScore
          // math the persist path uses, so Step-3 selectBestVersion and
          // findBadPages decide on the SAME numbers that get persisted and
          // re-picked by recomputeAllActiveVersions. Previously this used
          // setVersionScores (signed merged-eval scale) and a persist-time re-stamp
          // rewrote finalScore with math at persist — the Step-3 winner and
          // the saved activeVersion could disagree.
          newVersion.pageNumber = ev.pageNumber;
          applyScore(newVersion, {
            evalResult: ev,
            entityResult: evEntityResult,
            // Deduped issue list drives the math score; also persisted on
            // the version (consolidatedPlan) for the dev panel + finalize
            // re-stamp.
            consolidatedPlan: roundConsolidated.get(ev.pageNumber) || null,
          });
          versions.push(newVersion);
        }
      }
    }
  }

  // =========================================================================
  // Step 3: Pick best version per page across all rounds + original
  // =========================================================================
  // Single pick-best pass. Sees every version produced by the round loop
  // (originals, inpaint/iterate/char-fix per round). Replaces the former
  // two-stage Step 3 → Step 7 picks; the round loop now handles char-fix
  // inline so there's no need for a second pick after a separate
  // character-repair stage.
  await updateProgress(89, 'Selecting best versions...');
  log.info(`📊 [UNIFIED PIPELINE] Step 3: Selecting best version per page...`);

  const finalBestPerPage = new Map();
  let finalUpgradedCount = 0;
  for (const [pageNumber, versions] of pageVersions) {
    const best = selectBestVersion(versions);
    finalBestPerPage.set(pageNumber, best);
    if (best.source !== 'original') {
      finalUpgradedCount++;
      log.debug(`📊 [UNIFIED PIPELINE] Page ${pageNumber}: selected ${best.source} (score ${best.score}) over original (score ${versions[0].score})`);
    }
  }
  log.info(`✅ [UNIFIED PIPELINE] Step 3: ${finalUpgradedCount} pages upgraded total`);

  // Step 3b: EVERY VERSION GETS A SCORE (owner, 2026-08-09).
  //
  // One image, one score, highest wins. A version with no score cannot take
  // part in that, and until now some could not: the pre-scale-repair original
  // is stored with score:null because the eval only ran on the promoted image.
  // pickBestVersionIndex skipped nulls, so a repair beat the image it replaced
  // by walkover rather than on merit.
  //
  // This used to run only when the best score was already below 60 — a
  // "rescue". That conditional was the bug's hiding place: above the threshold
  // the unscored original stayed unscored and silently unbeatable. There is no
  // threshold now. If an image is a candidate, it is scored; if it is not
  // scored, it is not a candidate.
  try {
    const { computeFinalScore: rescueScoreOf, applyScore: rescueApplyScore } = require('./scoring');
    const rescueEntries = [];
    for (const [pageNumber, versions] of pageVersions) {
      const unscored = versions.find(v => v.imageData && rescueScoreOf(v) == null);
      if (!unscored) continue;
      // Forward the version's own stamped detection (iterate stamps one on its
      // accepted bytes) so the rescue eval reuses it instead of re-detecting.
      rescueEntries.push({ pageNumber, imageData: unscored.imageData, version: unscored, bboxDetection: images().detectionForVersion(unscored) });
    }
    if (rescueEntries.length > 0) {
      log.info(`📊 [UNIFIED PIPELINE] Step 3b: scoring ${rescueEntries.length} unscored version(s) so every candidate has a score: page(s) ${rescueEntries.map(r => r.pageNumber).join(', ')}`);
      const rescueEvals = await images().evaluateImageBatch(buildEvalInputs(rescueEntries), { concurrency: evalConcurrency, qualityModelOverride, visualBible, clothingRequirements: storyData?.clothingRequirements || null, artStyle });
      for (const ev of rescueEvals) {
        const entry = rescueEntries.find(r => r.pageNumber === ev.pageNumber);
        if (!entry) continue;
        if (ev.usage && usageTracker) {
          usageTracker('gemini_quality', ev.usage, 'unified_pipeline_quality_rescue', ev.modelId);
        }
        const evScore = ev.score ?? ev.qualityScore ?? null;
        if (evScore == null) continue;
        // ENTITY EVIDENCE MUST FOLLOW THE PIXELS. `currentEntityReport` is the
        // LAST round's report, and the round loop runs the entity check on the
        // round OUTPUT (see `latestImages` above) — not on this version. The
        // version rescued here is the unscored ORIGINAL, so charging it the
        // round's findings blames it for defects that exist only in an image
        // that was then discarded. Observed on job_1786053708336_8cdsca519 p10:
        // the original shipped at 15/100 after a −40 entity penalty for a teal
        // hoodie and a child-aged Daniel that appear only in iterate-round-1,
        // while its own evaluator recorded Noah in the correct polo and
        // clothing_match:true for both characters. The originals' entity
        // evidence is the STEP-1 report, which was computed on their pixels.
        const isOriginalVersion = !entry.version.source || entry.version.source === 'original';
        const rescueEntityReport = isOriginalVersion ? (entityReport || null) : currentEntityReport;
        if (isOriginalVersion && !entityReport) {
          log.warn(`⚠️ [UNIFIED PIPELINE] Page ${ev.pageNumber}: rescue-eval has no Step-1 entity report for the original — scoring it with no entity penalty rather than charging it the round's findings`);
        }
        const entityResult = getEntityPenaltyAndIssues(ev.pageNumber, rescueEntityReport);
        entry.version.evaluation = ev;
        entry.version.entityIssues = entityResult.issues;
        entry.version.evaluatedAt = new Date().toISOString();
        entry.version.pageNumber = ev.pageNumber;
        // Consolidate the rescue evaluation (same dedupe step as every other
        // eval), then canonical stamp — same single-scale math as every
        // other writer. Same contract rule as round evals: an unscored
        // version with its own rewritten description is consolidated against
        // THAT, not the original.
        const rescuePlan = await consolidatePageEval(ev, entityResult.issues, ev.pageNumber, null, entry.version?.description || null);
        rescueApplyScore(entry.version, { evalResult: ev, entityResult, consolidatedPlan: rescuePlan });
        const repicked = selectBestVersion(pageVersions.get(ev.pageNumber));
        const prevBest = finalBestPerPage.get(ev.pageNumber);
        finalBestPerPage.set(ev.pageNumber, repicked);
        if (repicked !== prevBest) {
          log.info(`🛟 [UNIFIED PIPELINE] Page ${ev.pageNumber}: original scored ${rescueScoreOf(entry.version)} — replaces ${prevBest?.source || '?'} (score ${rescueScoreOf(prevBest)}) as best version`);
        }
      }
    }
  } catch (rescueErr) {
    log.warn(`⚠️ [UNIFIED PIPELINE] Step 3b rescue-eval failed: ${rescueErr.message}`);
  }

  // Provisional final entity verdict — Step 4b below recomputes it on the
  // PICKED versions and reassigns (the round-loop report judged round output
  // that pick-best may have discarded).
  let finalEntityReport = currentEntityReport;

  // =========================================================================
  // Step 4: Post-repair calm-zone recovery
  // =========================================================================
  // Iterate / inpaint / character-fix can shift content into the text-overlay
  // polygon, undoing the calm zone established at initial generation. Re-run
  // ensureCalmZone (the same helper used at initial gen) on the active
  // version of each repaired page. If the recovery produces a better
  // candidate, push it as a new version and re-point finalBestPerPage.
  try {
    const { ensureCalmZone } = require('./textSpaceRepair');
    const langLevel = storyData?.languageLevel || 'standard';

    const postRepairTextPages = rawImages.filter(img => {
      if (img.pageNumber <= 0 || !img.imageData) return false;
      if (!img.textAreaMask || !img.text) return false;            // textInImage + actual text required
      if (!pageVersions.has(img.pageNumber)) return false;          // unknown page → silently dropped versions
      const src = finalBestPerPage.get(img.pageNumber)?.source || '';
      // Skip pages that didn't change (untouched original) or whose active
      // version was already validated by ensureCalmZone at initial gen.
      if (src === 'original' || src.startsWith('text-space-repair')) return false;
      return true;
    });
    if (postRepairTextPages.length > 0) {
      log.info(`📝 [POST-REPAIR-TEXT] Re-checking calm zone on ${postRepairTextPages.length} repaired pages`);
    }

    await Promise.all(postRepairTextPages.map(async (img) => {
      const pageNumber = img.pageNumber;
      const versions = pageVersions.get(pageNumber);
      const best = finalBestPerPage.get(pageNumber);
      if (!best?.imageData) return;

      const preferred = (storyData?.sceneImages || []).find(s => s.pageNumber === pageNumber)?.textPosition
        || img.sceneMetadata?.textPosition
        || 'top-left';
      const aspectRatio = img.imageAspect
        || (storyData?.sceneImages || []).find(s => s.pageNumber === pageNumber)?.imageAspect
        || null;

      const generateImage = (repairPrompt, opts) => images().generateImageOnly(repairPrompt, img.characterPhotos || [], {
        imageModelOverride: img.sceneMetadata?.pageImageModel || null,
        imageBackendOverride: img.sceneMetadata?.pageImageBackend || null,
        landmarkPhotos: img.landmarkPhotos || [],
        visualBibleGrid: img.visualBibleGrid || null,
        previousImage: opts.previousImage,
        textAreaMask: opts.textAreaMask,
        pageNumber,
        skipCache: true,
        aspectRatio,
      });

      const onUsage = (result) => {
        if (!result.usage || !usageTracker) return;
        const isRunware = result.modelId?.startsWith('runware:');
        const isGrok = result.modelId?.startsWith('grok-imagine');
        const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
        usageTracker(provider, result.usage, 'post_repair_text_recovery', result.modelId);
      };

      let result;
      try {
        result = await ensureCalmZone({
          imageData: best.imageData,
          text: img.text,
          textPosition: preferred,
          pageNumber,
          languageLevel: langLevel,
          textAreaMask: img.textAreaMask,
          sceneDescription: img.sceneDescription || '',
          generateImage,
          onUsage,
          label: 'POST-REPAIR-TEXT',
        });
      } catch (err) {
        log.warn(`⚠️ [POST-REPAIR-TEXT] P${pageNumber}: ${err.message} — keeping current best`);
        return;
      }

      // If the winner is the original (no improvement), just refresh the
      // report. Otherwise push the recovery winner as a new version and
      // re-point finalBestPerPage so the build-final-results loop sees it.
      if (result.winnerIndex > 0) {
        const w = result.winnerCandidate;
        const newVersion = {
          imageData: w.imageData,
          score: best.score,
          source: 'post-repair-text-space',
          evaluation: best.evaluation || null,
          modelId: w.modelId || best.modelId,
          grokRefImages: w.grokRefImages,
          entityIssues: best.entityIssues || [],
          evaluatedAt: new Date().toISOString(),
          prompt: w.prompt,
          pageNumber,
        };
        // Canonical stamp (inherits the pre-recovery best's evaluation).
        // Previously this copied finalScore inline WITHOUT an .evaluation-aware
        // stamp, so the (since-deleted) persist-time re-stamp nulled its finalScore and the
        // chosen text-space winner could never win pickBestVersionIndex —
        // activeVersion then pointed at a different version than the flattened
        // root imageData.
        const { applyScore: stampTextSpace } = require('./scoring');
        newVersion.consolidatedPlan = best.consolidatedPlan || null;
        stampTextSpace(newVersion, {
          evalResult: newVersion.evaluation,
          entityResult: { issues: newVersion.entityIssues, penalty: best.entityPenaltyRaw ?? best.entityPenalty ?? 0 },
          consolidatedPlan: newVersion.consolidatedPlan,
        });
        versions.push(newVersion);
        // COMPETE, DO NOT APPOINT (owner, 2026-08-09). This used to force
        // itself in as the best version regardless of score, so a repair that
        // scored WORSE than what it replaced still shipped. One image, one
        // score, highest wins — no exceptions and no side doors.
        finalBestPerPage.set(pageNumber, selectBestVersion(versions));
      }
      img.textCoverageReport = { ...result.report, postRepairChecked: true };
    }));
  } catch (postRepairErr) {
    log.warn(`⚠️ [POST-REPAIR-TEXT] Recovery phase failed: ${postRepairErr.message} — keeping pre-recovery best versions`);
  }

  // =========================================================================
  // Step 4b: FINAL entity report ASSEMBLED from the picked versions' stamps
  // (owner redesign, 2026-08-09)
  // =========================================================================
  // Every version's entity punishment was computed ONCE, at creation, on its
  // own bytes (round 0: full check on originals; round N: per-image check of
  // the repaired pages vs the reference sheet). Scores are therefore final —
  // no recompute, no re-score, no re-pick. The displayed report is assembled:
  // issue list = the PICKED versions' stamped entityIssues (exactly what the
  // scores charged), grid images = a grids-only rebuild of the picked crops
  // (pure compositing, no model call).
  try {
    await updateProgress(92, 'Assembling final entity report from picked versions...');
    const pickedEntries = rawImages.filter(img => img.imageData && img.pageNumber != null).map(img => {
      const best = finalBestPerPage.get(img.pageNumber);
      if (!best?.imageData) return null;
      return {
        imageData: best.imageData,
        pageNumber: img.pageNumber,
        description: best.description || null,
        // The version's own stamped detection — one detection per bytes.
        bboxDetection: images().detectionForVersion(best),
      };
    }).filter(Boolean);

    // Grids-only rebuild (no Gemini): crops of the shipped images.
    let assembled = null;
    if (pickedEntries.length > 0) {
      assembled = await runEntityConsistencyChecks(buildEntityCheckData(pickedEntries), characters, {
        checkCharacters: true, checkObjects: false, saveGrids: false,
        gridsOnly: true, minAppearances: 1, onHeartbeat: pingHeartbeat,
      });
    }
    if (!assembled) assembled = { characters: {}, grids: [], totalIssues: 0 };

    // Issue list from the era-matched stamps of the shipped versions.
    // Stamped entries are {name, severity, description, source} (see
    // getEntityPenaltyAndIssues) and a cross-page issue is stamped once PER
    // page — dedupe on (name, severity, description) and collect the pages,
    // or the union over 14 pages multiplies one finding many times over
    // (observed: 39-issue base assembled into 156 under 'UNKNOWN').
    const dedup = new Map();
    for (const img of rawImages) {
      if (!img.imageData || img.pageNumber == null) continue;
      const best = finalBestPerPage.get(img.pageNumber);
      for (const iss of (best?.entityIssues || [])) {
        const name = iss.name || iss.affectedCharacter || iss.character || 'UNKNOWN';
        const key = `${name}|${iss.severity}|${iss.description}`;
        let entry = dedup.get(key);
        if (!entry) {
          entry = { name, issue: { ...iss, affectedCharacter: name, pageNumbers: [] } };
          dedup.set(key, entry);
        }
        if (!entry.issue.pageNumbers.includes(img.pageNumber)) entry.issue.pageNumbers.push(img.pageNumber);
      }
    }
    let total = 0;
    for (const { name, issue } of dedup.values()) {
      issue.pageNumber = issue.pageNumbers[0];
      if (!assembled.characters[name]) assembled.characters[name] = { byClothing: {}, issues: [] };
      if (!Array.isArray(assembled.characters[name].issues)) assembled.characters[name].issues = [];
      assembled.characters[name].issues.push(issue);
      total++;
    }
    for (const c of Object.values(assembled.characters)) {
      c.totalIssues = (c.issues || []).length;
      c.overallConsistent = c.totalIssues === 0;
    }
    assembled.totalIssues = total;
    assembled.overallConsistent = total === 0;
    assembled.timestamp = new Date().toISOString();
    assembled.assembledFromPicks = true;
    assembled.summary = `${Object.keys(assembled.characters).length} entities checked: ${total} consistency issue(s) (assembled from shipped versions)`;

    finalEntityReport = assembled;
    entityHistory.push({ runIndex: entityHistory.length, timestamp: assembled.timestamp, triggeredBy: 'final-assembled', report: assembled });
    log.info(`🧾 [UNIFIED PIPELINE] Step 4b: final entity report assembled from picks — ${total} issue(s), ${assembled.grids?.length || 0} grid(s), zero eval calls`);
  } catch (finalEntityErr) {
    log.warn(`⚠️ [UNIFIED PIPELINE] Step 4b final report assembly failed: ${finalEntityErr.message} — keeping the merged round-loop report`);
    finalEntityReport = currentEntityReport;
  }

  // =========================================================================
  // Step 5: Style consistency audit on the picked images
  // =========================================================================
  // Cross-page style check: builds a thumbnail grid of every picked image
  // (front cover + all pages) and asks Gemini whether they cluster into one
  // visual style. Returns a verdict + the outliers; we surface it on the
  // response so the UI can flag inconsistent stories for manual repair.
  // The dedicated /api/stories/:id/style-check endpoint still exists for
  // ad-hoc reruns, but auto-running it here avoids the user having to click
  // a button to discover that page 4 is in a different art style.
  await updateProgress(94, 'Style consistency audit...');
  let styleConsistency = null;
  try {
    const { checkStoryStyleConsistency } = require('./styleConsistency');
    const { COVER_PAGE_NUMBERS } = require('./coverKeys');
    // Build a minimal storyData-shaped object from finalBestPerPage so we
    // never accidentally feed pre-repair pixels to the audit.
    const stylePages = [...finalBestPerPage.entries()]
      .filter(([pn]) => pn > 0)
      .sort((a, b) => a[0] - b[0])
      .map(([pageNumber, best]) => ({ pageNumber, imageData: best?.imageData }));
    // Covers = pages (owner directive): all three covers join the audit at
    // their negative page numbers. Prefer the pipeline's picked-best pixels
    // (covers run through the repair rounds as pages -1/-2/-3); fall back to
    // the input storyData covers for any cover not in this pipeline run.
    const styleCovers = {};
    for (const [coverKey, coverPage] of Object.entries(COVER_PAGE_NUMBERS)) {
      const pipelineBest = finalBestPerPage.get(coverPage);
      const imageData = pipelineBest?.imageData
        || storyData?.coverImages?.[coverKey]?.imageData
        || null;
      if (imageData) styleCovers[coverKey] = { imageData };
    }
    const styleInput = {
      sceneImages: stylePages,
      coverImages: styleCovers,
      // Commissioned style — lets the audit judge the dominant cluster against
      // what was actually ordered, not just against itself.
      artStyle: storyData?.artStyle,
    };
    if (stylePages.filter(p => p.imageData).length >= 2) {
      styleConsistency = await checkStoryStyleConsistency(styleInput, { usageTracker });
      log.info(`🎨 [UNIFIED PIPELINE] Step 5: style verdict=${styleConsistency.verdict} (cluster=${styleConsistency.dominantCluster?.length || 0}, outliers=${styleConsistency.outliers?.length || 0})`);

      // PRODUCTION WIRING (live 2026-07-31, owner directive — supersedes the
      // deferred Pt 10 note): repaint each style outlier — pages AND covers —
      // toward the dominant cluster, one attempt per outlier, gated by
      // checkStyleMatch inside repairPageStyle. Flag-gated by
      // MODEL_DEFAULTS.styleRepairProduction (env STYLE_REPAIR_PRODUCTION,
      // default true); model per MODEL_DEFAULTS.styleRepairModel.
      // Absolute guard (2026-08-06): style-repair repaints outliers TOWARD the
      // dominant cluster. When the dominant cluster is itself off the
      // commissioned style, that drags the few correctly-styled pages into the
      // drift — observed on a "cyber" book that rendered mostly photoreal,
      // where the two comic-styled pages were flagged as the outliers and one
      // was repainted photoreal. No anchor is better than a wrong anchor.
      // Only a wholesale medium change blocks. Gating on any style shortfall
      // was measured against 5 stored books and read "off style" on 4 of them,
      // including two the auditor called consistent — it would have disabled
      // style-repair in practice.
      const dominantOffStyle = styleConsistency.styleMatch?.verdict === 'wrong_medium';
      if (dominantOffStyle) {
        log.warn(`🎨 [UNIFIED PIPELINE] Step 5: style-repair SKIPPED — the dominant cluster is a different medium from the commissioned style ("${storyData?.artStyle}"), so its anchor page would spread the drift. ${styleConsistency.outliers?.length || 0} outlier(s) surfaced only.`);
      }
      if (!dominantOffStyle && MODEL_DEFAULTS.styleRepairProduction && (styleConsistency.outliers?.length || 0) > 0) {
        const { planStyleRepair, repairPageStyle } = require('./styleRepair');
        const styleRepairModel = MODEL_DEFAULTS.styleRepairModel === 'grok' ? 'grok' : 'gemini';
        const plan = planStyleRepair(styleConsistency, styleInput);
        for (const s of plan.skipped) {
          log.info(`🎨 [UNIFIED PIPELINE] Step 5: style-repair skip ${s.page}: ${s.reason}`);
        }
        for (const target of plan.targets) {
          const pageLabel = target.page < 0 ? `cover ${target.page}` : `page ${target.page}`;
          try {
            require('./runMetrics').forJob(storyData?.id || jobId).count('style_repair_run');
            const rep = await repairPageStyle(target.image, target.targetRefImage, {
              model: styleRepairModel,
              artStyle,
            });
            if (rep.usage && usageTracker) {
              const provider = rep.modelId?.startsWith('grok') ? 'grok' : 'gemini_image';
              usageTracker(provider, rep.usage, 'style_repair', rep.modelId);
            }
            if (rep.passedGate === false) {
              log.warn(`🎨 [UNIFIED PIPELINE] Step 5: style-repair for ${pageLabel} failed the style gate — repaint discarded, original kept`);
              continue;
            }
            const versions = pageVersions.get(target.page);
            const prevBest = finalBestPerPage.get(target.page);
            if (!versions || !prevBest) {
              log.warn(`🎨 [UNIFIED PIPELINE] Step 5: style-repair for ${pageLabel} has no version array — repaint discarded`);
              continue;
            }
            // New version through the normal plumbing — inherits the picked
            // best's evaluation/entity record (a style transfer preserves
            // content; no re-eval here), canonical applyScore stamp, then
            // re-point finalBestPerPage so the final assembly ships it.
            const { applyScore: stampStyleRepair } = require('./scoring');
            const newVersion = {
              imageData: rep.imageData,
              score: prevBest.score ?? null,
              source: `style-repair-${styleRepairModel}`,
              evaluation: prevBest.evaluation || null,
              modelId: rep.modelId,
              entityIssues: prevBest.entityIssues || [],
              evaluatedAt: new Date().toISOString(),
              prompt: null,
              description: prevBest.description || null,
              styleRepair: {
                targetRefPage: target.targetRefPage,
                severity: target.severity,
                differences: target.differences,
                beforeStyleMatch: rep.beforeStyleMatch || null,
                afterStyleMatch: rep.afterStyleMatch || null,
                passedGate: rep.passedGate,
              },
              pageNumber: target.page,
            };
            newVersion.consolidatedPlan = prevBest.consolidatedPlan || null;
            stampStyleRepair(newVersion, {
              evalResult: newVersion.evaluation,
              entityResult: { issues: newVersion.entityIssues, penalty: prevBest.entityPenaltyRaw ?? prevBest.entityPenalty ?? 0 },
              consolidatedPlan: newVersion.consolidatedPlan,
            });
            versions.push(newVersion);
            // COMPETE, DO NOT APPOINT — see the text-space note above.
            finalBestPerPage.set(target.page, selectBestVersion(versions));
            log.info(`🎨 [UNIFIED PIPELINE] Step 5: style-repair applied on ${pageLabel} (${styleRepairModel}, gate=${rep.passedGate === null ? 'unavailable' : 'pass'}, ref=Page ${target.targetRefPage})`);
          } catch (repErr) {
            log.warn(`⚠️ [UNIFIED PIPELINE] Step 5: style-repair for ${pageLabel} failed: ${repErr.message} — original kept`);
          }
        }
      } else if ((styleConsistency.outliers?.length || 0) > 0) {
        log.info(`🎨 [UNIFIED PIPELINE] Step 5: style-repair disabled (STYLE_REPAIR_PRODUCTION=false) — ${styleConsistency.outliers.length} outlier(s) surfaced only`);
      }
    } else {
      log.info(`🎨 [UNIFIED PIPELINE] Step 5: skipped (need ≥2 images, got ${stylePages.length})`);
    }
  } catch (styleErr) {
    log.warn(`⚠️ [UNIFIED PIPELINE] Step 5: style consistency check failed: ${styleErr.message}`);
    styleConsistency = null;
  }

  await updateProgress(96, 'Finalizing repair results...');

  // =========================================================================
  // Build final results
  // =========================================================================
  log.info(`📦 [UNIFIED PIPELINE] Building final results...`);

  // Repair rounds' eval can leave bboxDetection.figures empty for iterate/inpaint
  // outputs, which makes the UI show all expected characters as "missing" even
  // when they ARE in the image. Re-run bbox detection on the picked best image
  // for any page where figures is empty.
  const freshBboxMap = new Map();
  await Promise.all(rawImages.map(async img => {
    const pageNumber = img.pageNumber;
    const versions = pageVersions.get(pageNumber) || [];
    const best = finalBestPerPage.get(pageNumber) || versions[0];
    // Canonical version-detection resolution (v.bboxDetection first — the
    // round loop stamps the shared detection there), not only the eval's copy.
    const bestBbox = images().detectionForVersion(best);
    // Figures only count when the detection was computed on this version's
    // bytes — a stale stamp means the boxes belong to another version.
    const hasFigures = Array.isArray(bestBbox?.figures) && bestBbox.figures.length > 0
      && images().bboxPairsWith(bestBbox, best?.imageData);
    if (best?.imageData && !hasFigures && best.source !== 'original') {
      try {
        const fresh = await images().detectAllBoundingBoxes(best.imageData, {
          pageContext: `P${pageNumber}-final-bbox`,
          artStyle,
        });
        if (fresh && Array.isArray(fresh.figures) && fresh.figures.length > 0) {
          freshBboxMap.set(pageNumber, fresh);
          // Detection is part of every image version (owner decision): stamp
          // the refreshed detection onto the picked version itself, so the
          // per-version record (buildVersionEntry reads v.bboxDetection
          // first) matches the bytes it describes — previously the refresh
          // landed only on the scene root and the active version's own
          // detection stayed stale/empty.
          best.bboxDetection = fresh;
          log.info(`📦 [UNIFIED PIPELINE] P${pageNumber}: refreshed bbox (${fresh.figures.length} figures, ${fresh.objects?.length || 0} objects) for ${best.source}`);
        }
      } catch (err) {
        log.warn(`📦 [UNIFIED PIPELINE] P${pageNumber}: bbox refresh failed: ${err.message}`);
      }
    }
  }));

  const results = rawImages.map(img => {
    const pageNumber = img.pageNumber;
    const versions = pageVersions.get(pageNumber) || [];
    // The pick happens below over numbers that are ALREADY final — every
    // writer stamps at input-change time (SCORE ONCE, task #16); there is no
    // save-time re-stamp. Declarations only here.
    let best, wasCharFixed, finalImageData, finalEval;

    // Build imageVersions array — ALL versions in chronological order
    const imageVersions = [];
    const typeFor = (source) => {
      if (source === 'original') return 'original';
      if (source === 'character-fix') return 'entity-repair';
      if (typeof source === 'string' && source.startsWith('text-space-repair')) return 'text-space-repair';
      return 'repair';
    };
    // Single canonical writer. Stamps finalScore + deductions + scoreBreakdown
    // + evalScore +
    // entityPenalty on the version. Legacy fields (qualityScore, semanticScore,
    // threeStageScore, rawQualityScore) are no longer written — readers go
    // through computeFinalScore or version.finalScore, and per-evaluator
    // sub-scores live under version.scoreBreakdown.<evaluator>.score.

    // SCORE ONCE (task #16). Every writer stamps a version the moment its
    // inputs change — creation, rescue, text-space, style repair — all with
    // the same applyScore and the same consolidatedPlan handling. There is no
    // save-time re-stamp any more, so the numbers the pick sees ARE the
    // numbers the story stores, by construction rather than by ordering.
    best = selectBestVersion(versions) || finalBestPerPage.get(pageNumber) || versions[0];
    // Char-fix used to be a separate Map; the round loop now writes char-fix
    // versions into pageVersions like every other repair, so we derive the
    // "was character fixed" flag from the picked version's source.
    wasCharFixed = typeof best?.source === 'string'
      && (best.source.startsWith('char-fix-') || best.source === 'character-fix' || best.source.startsWith('character-fix:'));
    // Final image: best version (original, inpaint, iterate, or character-fix)
    finalImageData = best?.imageData || img.imageData;
    finalEval = best?.evaluation;

    const buildVersionEntry = (v) => {
      return {
      imageData: v.imageData,
      // Canonical scoring fields written by applyScore. finalScore is the
      // single number the frontend + picker read. scoreBreakdown is the
      // per-evaluator detail for the dev panel. deductions are audit-only.
      finalScore: v.finalScore,
      scoreBreakdown: v.scoreBreakdown || null,
      deductions: v.deductions || null,
      // Eval-time consolidation: deduped issue list that fed the math score
      // (dev panel shows the dedupe) + which issue set was scored.
      consolidatedPlan: v.consolidatedPlan || null,
      scoreSource: v.scoreSource || null,
      evalScore: v.evalScore ?? null,
      // Eval↔bytes fingerprint (applyScore stamp). Without this whitelist line
      // the guard exists only in-memory — post-persist re-picks (regeneration
      // routes) would silently lose the integrity check.
      evalImageFp: v.evalImageFp ?? null,
      entityPenalty: v.entityPenalty ?? 0,
      // entityPenaltyRaw says how much entity penalty was capped away.
      entityPenaltyRaw: v.entityPenaltyRaw ?? null,
      // Per-image entity stamps (2026-08-09 design). Without this whitelist
      // line the stamps existed only in-memory: every persisted version showed
      // undefined, so the offline assembled report and any post-run audit read
      // zero findings regardless of what the round-0 judge saw.
      // null = never checked; [] = checked and clean.
      entityIssues: v.entityIssues ?? null,
      // Detailed evaluator outputs — kept verbatim because the dev panel uses
      // the structured detail (visible/expected character lists from semantic,
      // visionInventory from three-stage) that doesn't fit in scoreBreakdown.
      // These are NOT score fields; no duplication with finalScore.
      semanticResult: v.evaluation?.semanticResult || null,
      threeStageResult: v.evaluation?.threeStageResult || null,
      evaluatedAt: v.evaluatedAt || null,
      issuesSummary: v.evaluation?.issuesSummary || null,
      fixableIssues: v.evaluation?.fixableIssues || [],
      // STEP 0 verdict, persisted so "why was this page redone / not redone"
      // is answerable from the stored story instead of only from live logs.
      coherenceGate: v.evaluation?.coherenceGate || null,
      styleGate: v.evaluation?.styleGate || null,
      source: v.source,
      type: typeFor(v.source),
      modelId: v.modelId,
      generatedAt: new Date().toISOString(),
      qualityReasoning: v.evaluation?.reasoning || null,
      fixTargets: v.evaluation?.enrichedFixTargets || v.evaluation?.fixTargets || [],
      // Detection is part of every image version (owner decision): the
      // version's own stamped detection wins over its eval-time detection
      // (see detectionForVersion). hasBboxOverlay tells the viewer an
      // overlay can be rendered for this version (the dev endpoint draws it
      // on the fly from the version's detection + bytes).
      bboxDetection: images().detectionForVersion(v),
      hasBboxOverlay: !!images().detectionForVersion(v),
      // The quality eval's own identification of every figure in the image
      // (figures[] = what it sees, matches[] = figure → reference character +
      // confidence + face_bbox). This is a SECOND, INDEPENDENT opinion on who
      // is who, separate from the Set-of-Mark naming in figureDetection.js
      // that labels the detection boxes above — the two demonstrably disagree,
      // and until now the eval's opinion was logged to stdout and dropped, so
      // the disagreement rate was unmeasurable. Stored per VERSION (not per
      // page) because, exactly like bboxDetection, it describes one specific
      // set of image bytes. Text/numbers/bbox arrays only — never image bytes.
      // null (not []) when the eval produced none: absent evidence is not
      // "zero figures".
      figures: v.evaluation?.figures ?? null,
      matches: v.evaluation?.matches ?? null,
      objectMatches: v.evaluation?.objectMatches ?? null,
      // Prefer per-version prompt/description (iterate stores its own
      // feedback-augmented prompt + new scene). Original generations and
      // inpaints fall back to the page's prompt/description. sceneMetadata /
      // sceneCharacters follow the same rule — an iterate's rewritten scene
      // is a new contract, and the picked version's contract is promoted to
      // the scene level at final assembly.
      description: v.description || img.sceneDescription || null,
      prompt: v.prompt || img.prompt || null,
      sceneMetadata: v.sceneMetadata || null,
      sceneCharacters: v.sceneCharacters || null,
      grokRefImages: v.grokRefImages || null,
      referencePhotos: v.referencePhotos || null,
      // O6: direct-path cover refs (landmark photo, VB grid) — captured by
      // the iterate action, previously dropped at this conversion.
      landmarkPhotos: v.landmarkPhotos || null,
      visualBibleGrid: v.visualBibleGrid || null,
      inpaintInstruction: v.inpaintInstruction || null,
      inpaintReferenceImages: v.inpaintReferenceImages || null,
      textSpaceCoveragePct: v.textSpaceCoveragePct ?? null,
      textSpacePosition: v.textSpacePosition || null,
      // Composite-cover 2-pass debug — pass1Input (figures-on-white),
      // pass1Output (Grok repose), pass2Input (figures composited onto
      // landmark), pass2Output (final), prompts + modelIds. Without this
      // the dev-panel version detail can't show ANY composite intermediate
      // even though source='composite-iterate-round-N' says composite ran.
      // method='composite' lets the UI badge the version as such instead
      // of just inferring from source string.
      method: v.method || null,
      compositeAttempts: v.compositeAttempts || null,
      charRepairGrokRaw: v.charRepairGrokRaw || null,
      charRepairBlendMask: v.charRepairBlendMask || null,
      charRepairWhiteout: v.charRepairWhiteout || null,
      };
    };
    for (const v of versions) {
      imageVersions.push(buildVersionEntry(v));
    }

    // Build retryHistory — forward char-fix telemetry so post-hoc debugging
    // can see who was targeted, what bbox was crosshatched, and where the
    // bbox came from. Without these the dev panel showed source=char-fix-N
    // for both v2 and v3 of a page with no way to tell them apart.
    const retryHistory = versions.map((v, idx) => ({
      attempt: idx + 1,
      type: 'unified_pipeline',
      source: v.source,
      score: v.score,
      bboxDetection: images().detectionForVersion(v),
      bboxOverlayImage: v.evaluation?.bboxOverlayImage,
      charName: v.charName || null,
      targetBbox: v.targetBbox || null,
      targetBboxSource: v.targetBboxSource || null,
      whiteoutTarget: v.whiteoutTarget || null,
      inpaintInstruction: v.inpaintInstruction || null,
      timestamp: new Date().toISOString()
    }));

    return {
      pageNumber,
      imageData: finalImageData,
      text: img.text,
      // Scene contract follows the PICKED version: an iterate rewrite carries
      // its own description/prompt/characters/metadata, and every later
      // consumer (repairs, entity checks, detection, dev panel) must judge the
      // picked image against what was actually asked of it — not the original
      // plan it superseded.
      sceneDescription: best?.description || img.sceneDescription,
      scene: img.scene,
      prompt: best?.prompt || img.prompt,
      characterPhotos: img.characterPhotos,
      landmarkPhotos: img.landmarkPhotos,
      visualBibleGrid: img.visualBibleGrid,
      grokRefImages: best?.grokRefImages || img.grokRefImages || null,
      emptySceneImage: img.emptySceneImage || null,
      emptyScenePrompt: img.emptyScenePrompt || null,
      emptySceneQc: img.emptySceneQc || null,
      textAreaMask: img.textAreaMask || null,
      emptySceneVbGrid: img.emptySceneVbGrid || null,
      textCoverageReport: img.textCoverageReport || null,
      sceneCharacters: best?.sceneCharacters || img.sceneCharacters,
      sceneMetadata: best?.sceneMetadata || img.sceneMetadata,
      perCharClothing: img.perCharClothing,
      modelId: best?.modelId || img.modelId,
      thinkingText: img.thinkingText || null,
      // Scene-level scores are MIRRORS of the picked version's canonical
      // record — never independently computed. qualityScore = the picked
      // version's evalScore (visual − semantic/compliance penalties, stamped
      // by applyScore); finalScore = the one number everything reads
      // (evalScore − entityPenalty via the canonical reader). The old code
      // used best.score — a generation-time retry score on a different
      // scale — which wrote junk like qualityScore:0 next to a picked
      // version scoring 50.
      qualityScore: best?.evalScore ?? finalEval?.qualityScore ?? null,
      finalScore: best ? require('./scoring').computeFinalScore(best) : null,
      qualityReasoning: finalEval?.reasoning ?? null,
      semanticScore: finalEval?.semanticResult?.score ?? finalEval?.semanticScore ?? null,
      semanticResult: finalEval?.semanticResult ?? null,
      // O7: verbatim eval model output (quality JSON + three-stage) and the
      // template hash — evaluateImageQuality returns rawOutput, but this
      // mapping dropped it, so historical scores couldn't be re-derived.
      qualityRawOutput: finalEval?.rawOutput ?? null,
      threeStageResult: finalEval?.threeStageResult ?? null,
      evalTemplateHash: finalEval?.evalTemplateHash ?? null,
      issuesSummary: finalEval?.issuesSummary ?? null,
      // No scene-level verdict: the evaluator's self-assessed PASS/FAIL word
      // routinely contradicted the canonical finalScore ("PASS" at 5/100) and
      // nothing branches on it. It survives only inside version eval records
      // as verbatim model output (audit).
      fixTargets: finalEval?.enrichedFixTargets || finalEval?.fixTargets || [],
      fixableIssues: finalEval?.fixableIssues || [],
      bboxDetection: freshBboxMap.get(pageNumber) || finalEval?.bboxDetection || null,
      bboxOverlayImage: finalEval?.bboxOverlayImage ?? null,
      figures: finalEval?.figures || [],
      matches: finalEval?.matches || [],
      imageVersions,
      retryHistory,
      entityReport: finalEntityReport || null,
      entityHistory,
      wasRegenerated: best?.source !== 'original',
      wasCharacterFixed: wasCharFixed,
      wasInpainted: best?.source?.startsWith('inpaint') || false,
      bestSource: best?.source || 'original'
    };
  });

  const charFixedCount = results.filter(r => r.wasCharacterFixed).length;
  log.info(`✅ [UNIFIED PIPELINE] Complete: ${results.length} pages, ${finalUpgradedCount} upgraded, ${charFixedCount} character-fixed`);

  // Convert charFixDetails Map to plain object for serialization.
  // Image fields can arrive in three shapes after R2 migration:
  //   - data:image/...;base64,XXX  → pass through
  //   - https://r2-bucket/key.png  → pass through (browser fetches it)
  //   - raw base64 string          → wrap as data: URL
  // The previous code only checked `startsWith('data:')` and wrapped the
  // R2 URL into `data:image/png;base64,https://...` which broke the
  // <img> tag entirely. Centralised helper guards every field.
  const toImgSrc = (v) => {
    if (!v || typeof v !== 'string') return v;
    if (v.startsWith('data:') || /^https?:\/\//i.test(v)) return v;
    return `data:image/png;base64,${v}`;
  };
  const charFixDetailsObj = {};
  for (const [charName, pages] of charFixDetails) {
    charFixDetailsObj[charName] = { pages: {} };
    for (const [pageNum, data] of pages) {
      charFixDetailsObj[charName].pages[pageNum] = {
        comparison: {
          before: toImgSrc(data.before),
          after: toImgSrc(data.after),
          blackoutImage: toImgSrc(data.blackoutImage) || null,
          cutoutSent: toImgSrc(data.cutoutSent) || null,
          grokRawResult: toImgSrc(data.grokRawResult) || null,
          blendMask: toImgSrc(data.blendMask) || null,
          croppedAvatar: toImgSrc(data.croppedAvatar) || null,
        },
        method: data.method || 'grok_blended',
      };
    }
  }

  return { results, charFixDetails: charFixDetailsObj, styleConsistency };
}

module.exports = {
  runUnifiedRepairPipeline,
  // Version selection + the repair-strategy helpers. Small, pure, and only
  // meaningful next to the loop that uses them.
  selectBestVersion,
  chooseRepairStrategy,
  buildRegenFeedback,
  forcedStrategyAfterFailures,
  lastRepairRegressed,
  bothStrategiesTriedAndRegressed,
  resolveCharBbox,
};

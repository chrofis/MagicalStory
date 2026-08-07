/**
 * Beats-first story generation (pipelineMode: 'beats').
 *
 * Replaces the single unified Sonnet call + outline review with five staged
 * calls, so every stage is reviewable and only the faulted pages get rewritten:
 *
 *   1. beats_plan            Sonnet    per-page BEAT + one-line SCENE
 *   2. beats_review          DeepSeek  structural review, rewrites faulted pages
 *   3. beats_scene_expansion Sonnet    one call PER PAGE, in parallel
 *   4. beats_scene_review    DeepSeek  ONE call over ALL briefs, rewrites faulted
 *   5. beats_story_text      Sonnet    page text written from the locked beats
 *
 * Step 6 (text_refine) already runs downstream in server.js and is untouched.
 *
 * Every builder/parser here is the same one the Test Lab's `beats_scenes` stage
 * uses (server/lib/testlab.js → runBeatsScenesStage); that stage stays the
 * measurement harness, this module is the production wiring.
 *
 * KNOWN GAP (see docs/decisions.md): the unified call also produced the Visual
 * Bible, clothing requirements and cover hints. No beats-stage prompt produces
 * those yet, so a beats run ships with an empty VB, no clothingRequirements and
 * only the default front-cover hint. Beats mode is therefore a staging
 * experiment, not a production default.
 */

const textModels = require('./textModels');
const { MODEL_DEFAULTS, IMAGE_MODELS } = require('../config/models');
const {
  buildBeatsPrompt,
  buildBeatsReviewPrompt,
  parseBeats,
  buildSceneExpansionPrompt,
  buildSceneReviewPrompt,
  buildStoryTextFromBeatsPrompt,
  parseRefinedText,
  buildAvailableAvatarsForPrompt,
  extractSceneMetadata,
} = require('./storyHelpers');
const { log } = require('../utils/logger');

const PIPELINE_MODES = ['unified', 'beats'];

/**
 * Which generation pipeline a job runs. inputData wins over the PIPELINE_MODE
 * env default; anything unrecognised (including unset) falls back to 'unified',
 * so the default behaviour is never changed by accident.
 */
function resolvePipelineMode(inputData = {}) {
  const raw = inputData?.pipelineMode || process.env.PIPELINE_MODE || 'unified';
  const mode = String(raw).trim().toLowerCase();
  if (!PIPELINE_MODES.includes(mode)) {
    log.warn(`[BEATS] Unknown pipelineMode "${raw}" — falling back to 'unified'`);
    return 'unified';
  }
  return mode;
}

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {}, setStage: () => {} };

/** Merge a reviewer's partial rewrite onto a base list keyed by pageNumber. */
function mergeByPage(base, fixes, apply) {
  const byPage = new Map(fixes.map(f => [f.pageNumber, f]));
  const changed = [];
  const merged = base.map(item => {
    const fix = byPage.get(item.pageNumber);
    if (!fix) return item;
    const next = apply(item, fix);
    if (next !== item) changed.push(item.pageNumber);
    return next;
  });
  return { merged, changed, stray: fixes.map(f => f.pageNumber).filter(n => !base.some(b => b.pageNumber === n)) };
}

/**
 * Run the beats-first pipeline.
 *
 * @param {Object} inputData - the job's input data (same object the unified path gets)
 * @param {Object} opts
 * @param {string|number} opts.jobId
 * @param {Object} [opts.genLog]           - generation log (info/warn), same style as the unified path
 * @param {Function} [opts.checkCancellation]
 * @param {number} [opts.pageCount]        - defaults to inputData.pages
 * @param {Object} [opts.modelOverrides]   - admin dev-mode model overrides
 * @param {Function} [opts.heartbeat]      - called during streaming to keep story_jobs fresh
 * @returns {Promise<{title, beats, pages, scenes, rawOutline, meta}>}
 *   pages[]  mirrors UnifiedStoryParser.extractPages() output consumed by server.js
 *   scenes[] mirrors the resolved value of startSceneExpansion() (expandedScenes)
 */
async function generateStoryViaBeats(inputData, opts = {}) {
  const {
    jobId = null,
    genLog = NOOP_LOG,
    checkCancellation = async () => {},
    modelOverrides = {},
    heartbeat = null,
  } = opts;
  const gl = genLog || NOOP_LOG;
  const onChunk = heartbeat ? () => heartbeat() : null;

  const pageCount = parseInt(opts.pageCount, 10) || parseInt(inputData?.pages, 10) || 10;
  const expected = Array.from({ length: pageCount }, (_, i) => i + 1);

  const planModel = modelOverrides.outlineModel || MODEL_DEFAULTS.outline;
  const reviewModel = modelOverrides.outlineReviewModel || MODEL_DEFAULTS.outlineReviewModel;
  const sceneModel = modelOverrides.sceneDescriptionModel || MODEL_DEFAULTS.sceneDescription;
  const textModel = modelOverrides.textModel || MODEL_DEFAULTS.storyText;

  const meta = { pageCount, models: { planModel, reviewModel, sceneModel, textModel }, timings: {} };
  const started = Date.now();
  log.info(`🪜 [BEATS] job=${jobId} pages=${pageCount} plan=${planModel} review=${reviewModel} scenes=${sceneModel} text=${textModel}`);

  // ── Step 1: beats plan ────────────────────────────────────────────────────
  await checkCancellation();
  const planPrompt = buildBeatsPrompt(inputData, pageCount);
  if (!planPrompt) throw new Error('story-beats template unavailable — beats pipeline cannot run');
  let t = Date.now();
  const planRes = await textModels.callTextModelStreaming(planPrompt, 8000, onChunk, planModel, { usageLabel: 'beats_plan' });
  meta.timings.planMs = Date.now() - t;
  const plan = parseBeats(planRes.text || '', expected);
  if (plan.pages.length === 0) throw new Error('Beats planner returned no parseable beats');
  if (plan.missing.length > 0) {
    log.warn(`⚠️ [BEATS] Planner omitted page(s) ${plan.missing.join(', ')} — story will be ${plan.pages.length} pages`);
    gl.warn('beats_plan_incomplete', `Planner omitted page(s) ${plan.missing.join(', ')}`);
  }
  gl.info('beats_plan', `Beat plan: ${plan.pages.length}/${pageCount} pages by ${planRes.modelId || planModel} (${(meta.timings.planMs / 1000).toFixed(1)}s)`, null, {
    pages: plan.pages.length, model: planRes.modelId || planModel,
  });

  // ── Step 2: beats review (rewrites only faulted pages) ────────────────────
  await checkCancellation();
  let beats = plan.pages;
  let beatsReviewAnalysis = '';
  const reviewPrompt = buildBeatsReviewPrompt(inputData, plan.pages);
  if (!reviewPrompt) {
    log.warn('⚠️ [BEATS] story-beats-review template unavailable — beats shipped unreviewed');
    gl.warn('beats_review_failed', 'Review template unavailable — beats shipped unreviewed');
  } else {
    t = Date.now();
    try {
      const revRes = await textModels.callTextModelStreaming(reviewPrompt, 12000, onChunk, reviewModel, { usageLabel: 'beats_review' });
      const parsed = parseBeats(revRes.text || '', []);
      beatsReviewAnalysis = parsed.analysis || '';
      const { merged, changed, stray } = mergeByPage(plan.pages, parsed.pages, (p, fix) => ({
        ...p,
        beat: fix.beat || p.beat,
        scene: fix.scene || p.scene,
      }));
      beats = merged;
      meta.timings.beatsReviewMs = Date.now() - t;
      if (stray.length > 0) log.warn(`⚠️ [BEATS] Review returned page(s) ${stray.join(', ')} that are not in the plan — ignored`);
      gl.info('beats_review', `Beat review by ${revRes.modelId || reviewModel}: ${changed.length} page(s) rewritten (${(meta.timings.beatsReviewMs / 1000).toFixed(1)}s)`, null, {
        changedPages: changed, model: revRes.modelId || reviewModel,
      });
    } catch (err) {
      // Same containment as the unified path's outline review: never block.
      log.warn(`🚨 [BEATS] Beat review failed (${err.message}) — proceeding with the unreviewed plan`);
      gl.warn('beats_review_failed', `Reviewer ${reviewModel} failed: ${err.message} — plan shipped unreviewed`);
    }
  }

  // ── Step 3: scene expansion, one call per page, in parallel ───────────────
  await checkCancellation();
  const lang = inputData.language || 'en';
  const imgModelConfig = IMAGE_MODELS[modelOverrides.imageModel || inputData.modelOverrides?.imageModel || MODEL_DEFAULTS.pageImage];
  const availableAvatars = buildAvailableAvatarsForPrompt(inputData.characters || [], inputData.clothingRequirements || null);

  t = Date.now();
  const expansions = await Promise.all(beats.map(async b => {
    // BEAT + SCENE stands in for page.text: in a beats-first run the text does
    // not exist yet, so the Art Director works from the locked plan.
    const pageContent = `BEAT: ${b.beat}\nSCENE: ${b.scene}`;
    const prompt = buildSceneExpansionPrompt(
      b.pageNumber, pageContent, inputData.characters || [], lang,
      null, availableAvatars, null,
      {
        maxCharactersPerScene: imgModelConfig?.maxCharactersPerScene || 3,
        artStyleId: inputData.artStyle,
        imageBackend: imgModelConfig?.backend,
      }
    );
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await textModels.callTextModelStreaming(prompt, 10000, onChunk, sceneModel, { usageLabel: 'beats_scene_expansion' });
        if (!res || !res.text || !res.text.trim()) throw new Error('empty scene brief');
        return { pageNumber: b.pageNumber, brief: res.text, prompt, modelId: res.modelId || sceneModel };
      } catch (err) {
        lastErr = err;
        log.warn(`⚠️ [BEATS] Scene expansion page ${b.pageNumber} attempt ${attempt} failed: ${err.message}`);
      }
    }
    throw new Error(`Scene expansion failed for page ${b.pageNumber}: ${lastErr?.message || 'unknown error'}`);
  }));
  meta.timings.sceneExpansionMs = Date.now() - t;
  gl.info('beats_scenes', `${expansions.length} scene briefs expanded by ${sceneModel} (${(meta.timings.sceneExpansionMs / 1000).toFixed(1)}s)`, null, {
    pages: expansions.length, model: sceneModel,
  });

  // ── Step 4: ONE review over ALL scene briefs ──────────────────────────────
  await checkCancellation();
  let sceneReviewAnalysis = '';
  const srPrompt = buildSceneReviewPrompt(inputData, expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief })));
  if (!srPrompt) {
    log.warn('⚠️ [BEATS] scene-review template unavailable — scene briefs shipped unreviewed');
    gl.warn('beats_scene_review_failed', 'Scene review template unavailable — briefs shipped unreviewed');
  } else {
    t = Date.now();
    try {
      const srRes = await textModels.callTextModelStreaming(srPrompt, 16000, onChunk, reviewModel, { usageLabel: 'beats_scene_review' });
      const parsed = parseRefinedText(srRes.text || '', expansions.map(x => x.pageNumber), 'SCENES');
      sceneReviewAnalysis = parsed.analysis || '';
      const byPage = new Map(parsed.pages.map(p => [p.pageNumber, p.text]));
      const changed = [];
      for (const x of expansions) {
        const fixed = byPage.get(x.pageNumber);
        if (fixed && fixed.trim()) {
          x.brief = fixed;
          x.reviewRewrote = true;
          changed.push(x.pageNumber);
        }
      }
      meta.timings.sceneReviewMs = Date.now() - t;
      gl.info('beats_scene_review', `Scene review by ${srRes.modelId || reviewModel}: ${changed.length} brief(s) rewritten (${(meta.timings.sceneReviewMs / 1000).toFixed(1)}s)`, null, {
        changedPages: changed, model: srRes.modelId || reviewModel,
      });
    } catch (err) {
      log.warn(`🚨 [BEATS] Scene review failed (${err.message}) — proceeding with unreviewed briefs`);
      gl.warn('beats_scene_review_failed', `Reviewer ${reviewModel} failed: ${err.message} — briefs shipped unreviewed`);
    }
  }

  // ── Step 5: page text from the locked beats ───────────────────────────────
  await checkCancellation();
  const textPrompt = buildStoryTextFromBeatsPrompt(inputData, beats);
  if (!textPrompt) throw new Error('story-text-from-beats template unavailable — beats pipeline cannot run');
  const beatPages = beats.map(b => b.pageNumber);
  let textRaw = '';
  let textModelId = textModel;
  let parsedText = null;
  t = Date.now();
  for (let attempt = 1; attempt <= 2 && !parsedText; attempt++) {
    try {
      const res = await textModels.callTextModelStreaming(textPrompt, 24000, onChunk, textModel, { usageLabel: 'beats_story_text' });
      const candidate = parseRefinedText(res.text || '', beatPages);
      if (candidate.pages.length === 0 || candidate.missing.length > 0) {
        log.warn(`⚠️ [BEATS] Text attempt ${attempt}: ${candidate.pages.length} page(s) parsed, missing ${candidate.missing.join(', ') || 'none'}`);
        if (attempt < 2) continue;
      }
      textRaw = res.text || '';
      textModelId = res.modelId || textModel;
      parsedText = candidate;
    } catch (err) {
      log.warn(`⚠️ [BEATS] Story text attempt ${attempt} failed: ${err.message}`);
      if (attempt >= 2) throw err;
    }
  }
  meta.timings.storyTextMs = Date.now() - t;
  if (!parsedText || parsedText.pages.length === 0) throw new Error('Beats text writer returned no parseable pages');
  if (parsedText.missing.length > 0) {
    log.warn(`⚠️ [BEATS] Text writer omitted page(s) ${parsedText.missing.join(', ')} after retry — those pages are dropped`);
    gl.warn('beats_text_incomplete', `Text writer omitted page(s) ${parsedText.missing.join(', ')}`);
  }
  // The title: nothing else in a beats run produces one.
  const title = ((textRaw.match(/---\s*TITLE\s*---\s*([^\n]+)/i) || [])[1] || '')
    .replace(/^\**\s*TITLE\s*:\s*/i, '')
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    .replace(/^"|"$/g, '')
    .trim() || null;
  gl.info('beats_story_text', `Page text by ${textModelId}: ${parsedText.pages.length} page(s)${title ? ` — "${title}"` : ''} (${(meta.timings.storyTextMs / 1000).toFixed(1)}s)`, null, {
    pages: parsedText.pages.length, title, model: textModelId,
  });

  // ── Assemble the downstream contract ──────────────────────────────────────
  const textByPage = new Map(parsedText.pages.map(p => [p.pageNumber, p.text]));
  const briefByPage = new Map(expansions.map(x => [x.pageNumber, x]));

  const pages = [];
  const scenes = [];
  for (const b of beats) {
    const text = (textByPage.get(b.pageNumber) || '').trim();
    if (!text) {
      log.warn(`⚠️ [BEATS] Page ${b.pageNumber} has no text — dropped`);
      continue;
    }
    const exp = briefByPage.get(b.pageNumber);
    const sceneDescription = exp?.brief || '';
    const sm = extractSceneMetadata(sceneDescription);
    if (!sm) log.warn(`⚠️ [BEATS] Page ${b.pageNumber}: scene brief has no parseable METADATA block`);
    const characters = sm?.characters || [];
    const characterClothing = sm?.characterClothing || {};

    // Same fields UnifiedStoryParser.extractPages() hands to server.js.
    pages.push({
      pageNumber: b.pageNumber,
      text,
      sceneHint: b.scene || '',
      sceneProse: '',
      characterClothing,
      characters,
    });
    // Same fields startSceneExpansion() resolves with (expandedScenes entries).
    scenes.push({
      pageNumber: b.pageNumber,
      text,
      sceneHint: b.scene || '',
      sceneDescription,
      sceneDescriptionPrompt: exp?.prompt || null,
      sceneDescriptionModelId: exp?.modelId || sceneModel,
      characterClothing,
      characters,
      outlineCharacters: characters,
      outlineExtract: `BEAT: ${b.beat}\nSCENE: ${b.scene}`,
    });
  }
  if (pages.length === 0) throw new Error('Beats pipeline produced no usable pages');

  // Human-readable transcript, stored as data.outline so the dev outline view
  // shows what each stage produced. Uses the unified section markers so the
  // existing viewers/parsers can still find the title and the page text.
  const rawOutline = [
    '---TITLE---',
    `TITLE: ${title || '(none)'}`,
    '',
    '---BEATS---',
    beats.map(b => `## Page ${b.pageNumber}\nBEAT: ${b.beat}\nSCENE: ${b.scene}`).join('\n\n'),
    '',
    '---BEATS REVIEW---',
    beatsReviewAnalysis || '(no review)',
    '',
    '---SCENE REVIEW---',
    sceneReviewAnalysis || '(no review)',
    '',
    '---STORY PAGES---',
    pages.map(p => `## Page ${p.pageNumber}\n${p.text}`).join('\n\n'),
  ].join('\n');

  meta.totalMs = Date.now() - started;
  meta.title = title;
  meta.textModelId = textModelId;
  log.info(`🪜 [BEATS] job=${jobId} done: ${pages.length} pages in ${(meta.totalMs / 1000).toFixed(1)}s`);

  return { title, beats, pages, scenes, rawOutline, meta };
}

module.exports = { generateStoryViaBeats, resolvePipelineMode, PIPELINE_MODES };

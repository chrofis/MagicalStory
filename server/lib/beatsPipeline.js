/**
 * Beats-first story generation (pipelineMode: 'beats').
 *
 * Replaces the single unified Sonnet call + outline review with six staged
 * calls, so every stage is reviewable and only the faulted pages get rewritten:
 *
 *   1. beats_plan            Sonnet    per-page BEAT + one-line SCENE
 *   2. beats_review          DeepSeek  structural review, rewrites faulted pages
 *   3. beats_story_bible     Sonnet    clothing + Visual Bible + cover hints
 *   4. beats_scene_expansion Sonnet    ONE call over ALL pages (cross-page continuity)
 *   5. beats_scene_review    DeepSeek  ONE call over ALL briefs, rewrites faulted
 *   6. beats_story_text      Sonnet    page text written from the locked beats
 *
 * Scheduling is by data dependency, not by list order:
 *
 *   beats ─> beats review ─> bible ─┬─> styled avatars   (caller-owned, long pole)
 *                                   ├─> scene expansion ─> scene review
 *                                   └─> page text
 *
 * Step 6 reads the beats only, never a brief, so it is started before step 4
 * and awaited after step 5. Styled avatars need only clothingRequirements, so
 * they start the instant step 3 returns (via opts.onClothingRequirements) and
 * overlap everything after it — page images await briefs AND avatars, both in
 * server.js, unchanged. Step 3 is the one thing that cannot overlap: its
 * output IS step 4's input.
 *
 * Step 7 (text_refine) already runs downstream in server.js and is untouched.
 *
 * Every builder/parser here is the same one the Test Lab's `beats_scenes` stage
 * uses (server/lib/testlab.js → runBeatsScenesStage); that stage stays the
 * measurement harness, this module is the production wiring.
 *
 * Step 3 closes the gap the unified call used to cover. It serves two consumers:
 *  - IN-PIPELINE: the parsed Visual Bible becomes the Art Director's
 *    {RECURRING_ELEMENTS} and the parsed clothing requirements its
 *    {AVAILABLE_AVATARS}, so scene briefs are written with VB ids and the
 *    right per-category outfits instead of blind.
 *  - DOWNSTREAM: the raw sections are spliced into `rawOutline` — which
 *    server.js feeds to UnifiedStoryParser as `unifiedResponse` — in the SAME
 *    section format the unified writer used, so extractClothingRequirements(),
 *    extractVisualBible() and extractCoverHints() work with no parsing change.
 *
 * If that one call fails the run still completes, degraded (blind briefs, empty
 * VB, null clothing, default front-cover hint) rather than aborted.
 */

const textModels = require('./textModels');
const { MODEL_DEFAULTS, IMAGE_MODELS } = require('../config/models');
const {
  buildBeatsPrompt,
  buildBeatsReviewPrompt,
  buildClothingReviewPrompt,
  parseClothingReview,
  parseBeats,
  buildSceneExpansionPrompt,
  buildSceneExpansionAllPrompt,
  buildSceneReviewPrompt,
  buildStoryTextFromBeatsPrompt,
  buildStoryBibleFromBeatsPrompt,
  parseRefinedText,
  buildAvailableAvatarsForPrompt,
  extractSceneMetadata,
} = require('./storyHelpers');
const { UnifiedStoryParser } = require('./outlineParser/unified');
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

/**
 * The three sections the unified writer used to emit alongside the story, and
 * that UnifiedStoryParser still looks for in `unifiedResponse`:
 * extractClothingRequirements / extractVisualBible / extractCoverHints.
 * Spelling and spacing are the parser's regexes — do not "tidy" them.
 */
const BIBLE_MARKERS = ['---CLOTHING REQUIREMENTS---', '---VISUAL BIBLE---', '---COVER SCENE HINTS---'];

/**
 * Strip any preamble the bible model wrote before the first section marker and
 * any trailing ---STORY PAGES--- it invented (that marker terminates the
 * cover-hints regex, so a stray one would swallow the real cover hints once
 * this block is spliced into the transcript).
 *
 * @returns {{body: string, found: string[]}|null} null when no section marker exists at all.
 */
function extractBibleSections(raw) {
  const text = String(raw || '');
  const positions = BIBLE_MARKERS.map(m => text.indexOf(m));
  const present = positions.filter(i => i >= 0);
  if (present.length === 0) return null;

  let body = text.slice(Math.min(...present)).trim();
  const stray = body.search(/---\s*STORY PAGES\s*---/i);
  if (stray >= 0) body = body.slice(0, stray).trim();
  if (!body) return null;

  return { body, found: BIBLE_MARKERS.filter(m => body.includes(m)) };
}

/**
 * Rewrite the ---CLOTHING REQUIREMENTS--- section of a bible transcript from a
 * (reviewed) clothingRequirements object.
 *
 * Mutating the parsed object is NOT enough. `bibleSections` is spliced into
 * `rawOutline`, and server.js re-parses clothingRequirements out of that text
 * for every consumer after the pipeline returns — the later avatar passes, the
 * persisted `stories.data.clothingRequirements`, scene prompts, entity eval.
 * Leave the transcript alone and the review reaches exactly one caller (the
 * early avatar kickoff) while everything else silently reads the unreviewed
 * contract. Section markers and fence match what extractClothingRequirements
 * expects: marker, then JSON, terminated by the next ---SECTION--- marker.
 *
 * @returns {string} the transcript with the section replaced, or unchanged when
 *   there is no section to replace (the caller keeps shipping either way).
 */
function replaceClothingSection(bibleSections, clothingRequirements) {
  const text = String(bibleSections || '');
  if (!text || !clothingRequirements) return text;
  const re = /(---CLOTHING REQUIREMENTS---\s*)([\s\S]*?)(?=---[A-Z\s]+---|$)/i;
  if (!re.test(text)) return text;
  const body = '```json\n' + JSON.stringify({ clothingRequirements }, null, 2) + '\n```\n\n';
  return text.replace(re, (_m, marker) => `${marker}${body}`);
}

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
 * @param {Function} [opts.onClothingRequirements] - fired the moment the story-bible
 *   stage yields clothing requirements, so the caller can start styled-avatar
 *   generation (the long pole in front of every image) while scene expansion and
 *   page text are still running. Same callback the unified stream's progressive
 *   parser fires; it must be non-blocking and own its own error handling.
 * @returns {Promise<{title, beats, pages, scenes, rawOutline, meta, beatsReviewReport, clothingReviewReport, sceneReviewReport}>}
 *   pages[]  mirrors UnifiedStoryParser.extractPages() output consumed by server.js
 *   scenes[] mirrors the resolved value of startSceneExpansion() (expandedScenes)
 *   *ReviewReport  {model, durationMs, changedPages[], analysis, pages:[{pageNumber,before,after}]},
 *                  the same shape as textRefineReport so the dev-mode diff panels
 *                  render all three review stages identically. null = stage never ran.
 */
async function generateStoryViaBeats(inputData, opts = {}) {
  const {
    jobId = null,
    genLog = NOOP_LOG,
    checkCancellation = async () => {},
    modelOverrides = {},
    heartbeat = null,
    onClothingRequirements = null,
    // Per-stage progress reporter (percent, message). Without it the job sits
    // at 1% "Starting story generation..." for the entire ~10-minute text
    // phase — heartbeat only bumps updated_at, never the visible bar.
    onStage = null,
  } = opts;
  const gl = genLog || NOOP_LOG;
  const onChunk = heartbeat ? () => heartbeat() : null;
  const stage = async (pct, msg) => { if (onStage) { try { await onStage(pct, msg); } catch { /* progress only */ } } };

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
  await stage(2, 'Planning the story beats...');
  const planRes = await textModels.callTextModelStreaming(planPrompt, null, onChunk, planModel, { usageLabel: 'beats_plan' });
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
  // Before/after for every page the reviewer rewrote, same shape as
  // textRefineReport. Without it two of the three review stages are
  // unmeasurable: the log says "3 pages rewritten" and nothing says WHAT.
  // Stays null only when the review never ran (missing template or a throw).
  let beatsReviewReport = null;
  const reviewPrompt = buildBeatsReviewPrompt(inputData, plan.pages);
  if (!reviewPrompt) {
    log.warn('⚠️ [BEATS] story-beats-review template unavailable — beats shipped unreviewed');
    gl.warn('beats_review_failed', 'Review template unavailable — beats shipped unreviewed');
  } else {
    t = Date.now();
    try {
      await stage(3, 'Reviewing the story beats...');
      const revRes = await textModels.callTextModelStreaming(reviewPrompt, null, onChunk, reviewModel, { usageLabel: 'beats_review' });
      const parsed = parseBeats(revRes.text || '', []);
      beatsReviewAnalysis = parsed.analysis || '';
      // The apply callback is the ONLY point where both the planned and the
      // rewritten beat exist — capture the pair here or it is gone.
      const rewrites = [];
      const { merged, changed, stray } = mergeByPage(plan.pages, parsed.pages, (p, fix) => {
        const next = { ...p, beat: fix.beat || p.beat, scene: fix.scene || p.scene };
        rewrites.push({
          pageNumber: p.pageNumber,
          before: `BEAT: ${p.beat}\nSCENE: ${p.scene}`,
          after: `BEAT: ${next.beat}\nSCENE: ${next.scene}`,
        });
        return next;
      });
      beats = merged;
      meta.timings.beatsReviewMs = Date.now() - t;
      // changedPages counts only pages whose text actually moved — a reviewer
      // that echoes a page unchanged is not a rewrite.
      const beatsDiffs = rewrites.filter(r => r.before !== r.after);
      beatsReviewReport = {
        model: revRes.modelId || reviewModel,
        durationMs: meta.timings.beatsReviewMs,
        changedPages: beatsDiffs.map(r => r.pageNumber),
        analysis: beatsReviewAnalysis,
        pages: beatsDiffs,
        // Same dev-mode inspection as the scene review (owner request
        // 2026-08-09): the exact prompt, and EVERY beat as sent — not only the
        // ones that changed, which is all a diff can ever show.
        prompt: reviewPrompt,
        briefsIn: plan.pages.map(x => ({
          pageNumber: x.pageNumber,
          brief: `BEAT: ${x.beat || ''}
SCENE: ${x.scene || ''}`.trim(),
        })),
      };
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

  // ── Step 3: visual contract from the locked beats ─────────────────────────
  // MUST precede scene expansion: the Visual Bible fills the Art Director's
  // {RECURRING_ELEMENTS}. Expanding a scene before it exists produces a brief
  // with no recurring elements at all — no location, artifact, animal or
  // secondary-character continuity — and the scene review downstream then has
  // nothing to check it against. It also gates the avatar kickoff below.
  //
  // The call never throws: a beats run without a bible is degraded (blind scene
  // briefs, empty VB, null clothing, default front-cover hint) but must still
  // produce a story, exactly as it did before this stage existed.
  await checkCancellation();
  const bibleModel = planModel;
  let bibleSections = null;
  let visualBible = null;
  let clothingRequirements = null;
  const biblePrompt = buildStoryBibleFromBeatsPrompt(inputData, beats);
  if (!biblePrompt) {
    log.warn('⚠️ [BEATS] story-bible-from-beats template unavailable — no Visual Bible, clothing or cover hints');
    gl.warn('beats_story_bible_failed', 'Bible template unavailable — story ships with an empty Visual Bible');
  } else {
    t = Date.now();
    try {
      await stage(4, 'Building the visual contract...');
      const bibleRes = await textModels.callTextModelStreaming(biblePrompt, null, onChunk, bibleModel, { usageLabel: 'beats_story_bible' });
      const sections = extractBibleSections(bibleRes.text || '');
      meta.timings.storyBibleMs = Date.now() - t;
      if (!sections) {
        log.warn(`🚨 [BEATS] Bible call returned no parseable section markers (${(bibleRes.text || '').length} chars)`);
        gl.warn('beats_story_bible_failed', `${bibleRes.modelId || bibleModel} emitted no section markers — story ships with an empty Visual Bible`);
      } else {
        bibleSections = sections.body;
        // Parse with the SAME parser server.js will run over the finished
        // transcript, so what the Art Director sees here and what the story
        // stores downstream can never diverge.
        const bibleParser = new UnifiedStoryParser(bibleSections);
        visualBible = bibleParser.extractVisualBible();
        clothingRequirements = bibleParser.extractClothingRequirements();
        const missing = BIBLE_MARKERS.filter(m => !sections.found.includes(m));
        if (missing.length > 0) {
          log.warn(`⚠️ [BEATS] Bible missing section(s): ${missing.join(', ')}`);
          gl.warn('beats_story_bible_partial', `Bible missing ${missing.map(m => m.replace(/-/g, '')).join(', ')}`);
        }
        const vbCount = visualBible
          ? Object.values(visualBible).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
          : 0;
        gl.info('beats_story_bible', `Visual contract by ${bibleRes.modelId || bibleModel}: ${vbCount} VB entries, ${Object.keys(clothingRequirements || {}).length} clothing reqs (${(meta.timings.storyBibleMs / 1000).toFixed(1)}s)`, null, {
          vbEntries: vbCount, clothingChars: Object.keys(clothingRequirements || {}).length, model: bibleRes.modelId || bibleModel,
        });
      }
    } catch (err) {
      meta.timings.storyBibleMs = Date.now() - t;
      log.warn(`🚨 [BEATS] Bible call failed (${err.message}) — story ships with an empty Visual Bible`);
      gl.warn('beats_story_bible_failed', `${bibleModel} failed: ${err.message} — story ships with an empty Visual Bible`);
    }
  }

  // ── Step 3b: wardrobe review, BEFORE the avatars are kicked off ───────────
  // The bible writes clothingRequirements and nothing checked it: a costume
  // garment the costume is not actually known for (a bandana on a pirate) went
  // from this call straight into the avatar sheet and then onto every page,
  // unreviewed. This is the last moment the outfit is still only text — after
  // the kickoff below, correcting one costs a regenerated avatar.
  //
  // Contained exactly like the two sibling reviews: a failure here ships the
  // unreviewed wardrobe, it never blocks the story.
  await checkCancellation();
  let clothingReviewReport = null;
  if (clothingRequirements && Object.keys(clothingRequirements).length > 0) {
    const clothingPrompt = buildClothingReviewPrompt(inputData, clothingRequirements);
    if (!clothingPrompt) {
      gl.warn('beats_clothing_review_failed', 'Clothing review template unavailable — wardrobe shipped unreviewed');
    } else {
      t = Date.now();
      try {
        const cRes = await textModels.callTextModelStreaming(clothingPrompt, null, onChunk, reviewModel, { usageLabel: 'beats_clothing_review' });
        const parsed = parseClothingReview(cRes.text || '');
        meta.timings.clothingReviewMs = Date.now() - t;
        const rewrites = [];
        const stray = [];
        for (const fix of parsed.entries) {
          // Match the character case-insensitively — the reviewer echoes the
          // name back and case drift must not silently drop a correction.
          const name = Object.keys(clothingRequirements)
            .find(n => n.toLowerCase() === fix.name.toLowerCase());
          const entry = name ? clothingRequirements[name]?.[fix.category] : null;
          if (!entry || !entry.used) { stray.push(`${fix.name}/${fix.category}`); continue; }
          const before = entry.description || '';
          if (before === fix.description) continue;
          entry.description = fix.description;
          rewrites.push({ name, category: fix.category, before, after: fix.description });
        }
        // The transcript is the contract everything after this pipeline reads.
        // Without this line the object is corrected and the transcript is not,
        // so the review reaches only the early avatar kickoff and every later
        // consumer re-parses the unreviewed outfits out of rawOutline.
        if (rewrites.length > 0 && bibleSections) {
          const rewritten = replaceClothingSection(bibleSections, clothingRequirements);
          if (rewritten === bibleSections) {
            gl.warn('beats_clothing_review_unmerged', `${rewrites.length} outfit(s) rewritten but the transcript has no CLOTHING REQUIREMENTS section to update — downstream will read the unreviewed contract`);
          } else {
            bibleSections = rewritten;
          }
        }
        clothingReviewReport = {
          model: cRes.modelId || reviewModel,
          durationMs: meta.timings.clothingReviewMs,
          analysis: parsed.analysis || '',
          changed: rewrites,
          // Same dev-mode inspection as the other two reviews: the exact prompt
          // and every outfit as sent, not only the ones that moved.
          prompt: clothingPrompt,
          outfitsIn: Object.entries(clothingRequirements).flatMap(([n, cats]) =>
            Object.entries(cats || {})
              .filter(([, v]) => v && v.used && v.description)
              .map(([c, v]) => ({ name: n, category: c, costume: v.costume || null, description: v.description }))),
        };
        if (stray.length > 0) {
          gl.warn('beats_clothing_review_stray', `Clothing review returned ${stray.join(', ')}, which is not a used outfit in this story — ignored`);
        }
        if ((cRes.text || '').trim().length === 0) {
          gl.warn('beats_clothing_review_empty', 'Clothing review returned nothing — provider failure, wardrobe shipped unreviewed');
        } else {
          gl.info('beats_clothing_review', `Wardrobe review by ${cRes.modelId || reviewModel}: ${rewrites.length} outfit(s) rewritten (${(meta.timings.clothingReviewMs / 1000).toFixed(1)}s)`, null, {
            changed: rewrites.map(r => `${r.name}/${r.category}`), model: cRes.modelId || reviewModel,
          });
        }
      } catch (err) {
        meta.timings.clothingReviewMs = Date.now() - t;
        log.warn(`🚨 [BEATS] Clothing review failed (${err.message}) — wardrobe shipped unreviewed`);
        gl.warn('beats_clothing_review_failed', `Reviewer ${reviewModel} failed: ${err.message} — wardrobe shipped unreviewed`);
      }
    }
  }

  // ── Styled avatars start HERE, not after the pipeline ─────────────────────
  // Their only input is clothingRequirements, which now exists. They are the
  // long pole in front of every cover and page image, so they run concurrently
  // with scene expansion, scene review and page text. The caller owns the
  // promise (and its error handling) — this pipeline never awaits it, exactly
  // like the unified stream's mid-stream kickoff.
  if (clothingRequirements && Object.keys(clothingRequirements).length > 0 && typeof onClothingRequirements === 'function') {
    gl.info('beats_avatars_kickoff', `Styled avatars started early from ${Object.keys(clothingRequirements).length} clothing req(s) — overlapping scene expansion and page text`, null, {
      characters: Object.keys(clothingRequirements),
    });
    try {
      onClothingRequirements(clothingRequirements);
    } catch (err) {
      // The callback owns its async failures; a synchronous throw here would
      // otherwise abort a story over an avatar kickoff.
      log.warn(`🚨 [BEATS] Avatar kickoff threw synchronously (${err.message}) — avatars fall back to the post-pipeline pass`);
      gl.warn('beats_avatars_kickoff_failed', `Avatar kickoff failed: ${err.message} — falling back to the post-pipeline pass`);
    }
  } else if (typeof onClothingRequirements === 'function') {
    log.warn('⚠️ [BEATS] No clothing requirements — styled avatars deferred to the post-pipeline pass');
    gl.warn('beats_avatars_kickoff_skipped', 'No clothing requirements — styled avatars deferred to the post-pipeline pass');
  }

  // ── Step 6 (page text) NO LONGER RUNS HERE ────────────────────────────────
  // It used to be kicked off at this point, reading the locked beats only, so
  // it overlapped scene expansion and cost no wall clock. That parallelism made
  // the brief and the text SIBLINGS: both derived from the same beats, neither
  // reading the other, and nothing reconciling them afterwards. They drifted.
  //
  // Measured on job_1786309527338 p6: the brief had Daniel helping pull the
  // cork and Sarah unrolling the map; the page text describes a cork that is
  // still stuck and neither action happening. Reader-visible — the picture and
  // the words on the same page disagree about what occurred.
  //
  // Owner decision 2026-08-10: "the scenes come first, the text must follow."
  // Step 6 now runs AFTER the scene review and receives the FINAL briefs, so
  // the words describe the picture that will actually be drawn. This costs the
  // text call's wall clock, which is the price of the two agreeing.

  // ── Step 4: scene expansion — ALL pages in ONE call ───────────────────────
  // The fan-out this replaced expanded each page blind to its neighbours, so
  // location, time of day, clothing and composition could only drift and be
  // repaired afterwards by the scene review (a mid-story page landing in an
  // indoor interior between two riverbank pages, with no narrative transition
  // into a house). Continuity is a property of the SET, so the set is written
  // in one call. Per-page expansion survives ONLY as the shortfall fallback
  // below — never as the primary path.
  await checkCancellation();
  const lang = inputData.language || 'en';
  const imgModelConfig = IMAGE_MODELS[modelOverrides.imageModel || inputData.modelOverrides?.imageModel || MODEL_DEFAULTS.pageImage];
  const availableAvatars = buildAvailableAvatarsForPrompt(inputData.characters || [], clothingRequirements);
  const maxCharactersPerScene = imgModelConfig?.maxCharactersPerScene || 3;

  /**
   * Per-page expansion — the fallback for pages the single call omitted, and
   * the only remaining user of the per-page scene-expansion.txt template here.
   */
  async function expandOnePage(b) {
    // BEAT + SCENE stands in for page.text: in a beats-first run the text does
    // not exist yet, so the Art Director works from the locked plan.
    const pageContent = `BEAT: ${b.beat}\nSCENE: ${b.scene}`;
    const prompt = buildSceneExpansionPrompt(
      b.pageNumber, pageContent, inputData.characters || [], lang,
      visualBible, availableAvatars, null,
      {
        maxCharactersPerScene,
        artStyleId: inputData.artStyle,
        imageBackend: imgModelConfig?.backend,
        // No referencePhotos exist at this stage, so the contract is the only
        // outfit source — same reason the all-pages builder needs it.
        clothingRequirements,
      }
    );
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await textModels.callTextModelStreaming(prompt, null, onChunk, sceneModel, { usageLabel: 'beats_scene_expansion' });
        if (!res || !res.text || !res.text.trim()) throw new Error('empty scene brief');
        return { pageNumber: b.pageNumber, brief: res.text, prompt, modelId: res.modelId || sceneModel };
      } catch (err) {
        lastErr = err;
        log.warn(`⚠️ [BEATS] Scene expansion page ${b.pageNumber} attempt ${attempt} failed: ${err.message}`);
      }
    }
    throw new Error(`Scene expansion failed for page ${b.pageNumber}: ${lastErr?.message || 'unknown error'}`);
  }

  t = Date.now();
  const beatPageNumbers = beats.map(b => b.pageNumber);
  let expansions = [];
  const allPrompt = buildSceneExpansionAllPrompt(inputData, beats, {
    visualBible,
    availableAvatars,
    maxCharactersPerScene,
    // The Art Director needs the outfit TEXT, not just the category key — see
    // buildSceneExpansionAllPrompt. In beats mode the visual contract is the
    // only source, and it is resolved by the time scenes are expanded.
    clothingRequirements,
  });
  if (!allPrompt) {
    log.error('🚨 [BEATS] scene-expansion-all template unavailable — falling back to per-page expansion for every page');
    gl.warn('beats_scene_expansion_fallback', 'All-pages template unavailable — every page expanded per-page (no cross-page continuity)');
  } else {
    // Output is `## Page N` + prose + METADATA per page — the same shape the
    // scene review returns, so the review's parser reads it unchanged.
    let allRaw = '';
    let allModelId = sceneModel;
    try {
      await stage(5, 'Writing scene briefs...');
      const res = await textModels.callTextModelStreaming(allPrompt, null, onChunk, sceneModel, { usageLabel: 'beats_scene_expansion' });
      allRaw = res?.text || '';
      allModelId = res?.modelId || sceneModel;
    } catch (err) {
      log.error(`🚨 [BEATS] All-pages scene expansion failed (${err.message}) — falling back to per-page expansion`);
      gl.warn('beats_scene_expansion_failed', `All-pages call failed: ${err.message} — falling back to per-page expansion`);
    }
    const parsed = parseRefinedText(allRaw, beatPageNumbers, 'SCENES');
    const byPage = new Map(parsed.pages.filter(p => p.text && p.text.trim()).map(p => [p.pageNumber, p.text]));
    expansions = beats
      .filter(b => byPage.has(b.pageNumber))
      .map(b => ({ pageNumber: b.pageNumber, brief: byPage.get(b.pageNumber), prompt: allPrompt, modelId: allModelId }));
  }

  // Page-count guard: a short response must never ship a story with pages that
  // have no brief. Only the MISSING pages are re-expanded per-page.
  const missingBriefs = beats.filter(b => !expansions.some(x => x.pageNumber === b.pageNumber));
  if (missingBriefs.length > 0) {
    log.error(`🚨 [BEATS] All-pages expansion returned ${expansions.length}/${beats.length} briefs — re-expanding page(s) ${missingBriefs.map(b => b.pageNumber).join(', ')} per-page`);
    gl.warn('beats_scene_expansion_incomplete', `All-pages call returned ${expansions.length}/${beats.length} briefs — page(s) ${missingBriefs.map(b => b.pageNumber).join(', ')} expanded per-page`);
    const recovered = await Promise.all(missingBriefs.map(expandOnePage));
    expansions = expansions.concat(recovered).sort((a, b) => a.pageNumber - b.pageNumber);
  }
  meta.timings.sceneExpansionMs = Date.now() - t;
  gl.info('beats_scenes', `${expansions.length} scene briefs expanded by ${sceneModel} in one call${missingBriefs.length ? ` (+${missingBriefs.length} per-page fallback)` : ''} (${(meta.timings.sceneExpansionMs / 1000).toFixed(1)}s)`, null, {
    pages: expansions.length, fallbackPages: missingBriefs.map(b => b.pageNumber), model: sceneModel,
  });

  // ── Step 4: ONE review over ALL scene briefs ──────────────────────────────
  await checkCancellation();
  let sceneReviewAnalysis = '';
  // Same contract as beatsReviewReport above: null only when the review never
  // ran; an object with empty pages[] when it ran and rewrote nothing.
  let sceneReviewReport = null;
  // Mechanical clothing faults, computed here and handed to the review — the
  // ONE place they get fixed (owner decision 2026-08-08). Free: no API call, no
  // image. Only the findings measured to carry signal are rendered
  // (outfit_misattributed, removal_unstated); see clothingCheck.js.
  let clothingFindings = '';
  let clothingByPage = null;
  let clothingUnfixedList = [];
  try {
    const { checkScenes, renderFindingsBlock } = require('./clothingCheck');
    const checkPages = expansions.map(x => {
      const meta = extractSceneMetadata(x.brief) || {};
      return {
        pageNumber: x.pageNumber,
        prose: String(x.brief || '').split('---METADATA---')[0],
        cast: (meta.characters || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean),
        perCharClothing: meta.characterClothing || {},
      };
    });
    const res = checkScenes(checkPages, clothingRequirements, { artifacts: (visualBible || {}).artifacts });
    clothingByPage = res.byPage;
    clothingFindings = renderFindingsBlock(res.byPage);
    if (clothingFindings) {
      const pages = [...res.byPage.keys()].sort((a, b) => a - b).join(', ');
      log.info(`👕 [BEATS] clothing check: ${res.findings.length} finding(s) on page(s) ${pages} — sent to the scene review`);
      gl.info('beats_clothing_check', `Clothing check found ${res.findings.length} fault(s) on page(s) ${pages}`, null, { findings: res.findings });
    }
  } catch (ccErr) {
    log.warn(`⚠️ [BEATS] clothing check failed (${ccErr.message}) — review runs without findings`);
  }

  // Brief contradictions — prose vs the brief's own metadata. Same place, same
  // deal as the clothing faults above: deterministic, free, and handed to the
  // review rather than auto-repaired (owner decision 2026-08-11 — the reviewer
  // authored both halves; we must not invent a figure nobody wrote).
  let briefFindings = '';
  try {
    const { checkScenes: checkBriefs, renderFindingsBlock: renderBriefBlock } = require('./sceneBriefCheck');
    const castNames = (inputData.characters || []).map(c => c && c.name).filter(Boolean);
    const res = checkBriefs(
      expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief })),
      castNames,
      visualBible
    );
    briefFindings = renderBriefBlock(res.byPage);
    if (briefFindings) {
      // Count only what the block actually carries — diagnostic-only types stay
      // out of the log line, or it claims to have sent what it withheld.
      const { REVIEWABLE } = require('./sceneBriefCheck');
      const sent = res.findings.filter(fd => REVIEWABLE.has(fd.type));
      const pages = [...new Set(sent.map(fd => fd.pageNumber))].sort((x, y) => x - y).join(', ');
      log.info(`🧩 [BEATS] brief check: ${sent.length} contradiction(s) on page(s) ${pages} — sent to the scene review`);
      gl.info('beats_brief_check', `Brief check found ${sent.length} contradiction(s) on page(s) ${pages}`, null, { findings: sent });
    }
  } catch (bcErr) {
    log.warn(`⚠️ [BEATS] brief check failed (${bcErr.message}) — review runs without brief findings`);
  }

  const srPrompt = buildSceneReviewPrompt(
    inputData,
    expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief })),
    // Locked beats feed the review's check 5 (character in beat vs brief).
    { clothingFindings, briefFindings, beats }
  );
  if (!srPrompt) {
    log.warn('⚠️ [BEATS] scene-review template unavailable — scene briefs shipped unreviewed');
    gl.warn('beats_scene_review_failed', 'Scene review template unavailable — briefs shipped unreviewed');
  } else {
    t = Date.now();
    try {
      // Snapshot every brief as it was SENT. sceneDiffs only captures pages the
      // reviewer changed, so a run where it rewrote nothing left the dev panel
      // with nothing to show — exactly the run we needed to inspect
      // (job_1786235099497_ytd5c7eek: 3 faults handed over, 0 briefs rewritten).
      const briefsIn = expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief }));
      await stage(6, 'Reviewing scene briefs...');
      const srRes = await textModels.callTextModelStreaming(srPrompt, null, onChunk, reviewModel, { usageLabel: 'beats_scene_review' });
      // "0 briefs rewritten" has meant three different things: a reviewer that
      // genuinely found nothing, a reviewer TRUNCATED at its token cap (this
      // story: out=16000, exactly the old budget), and a provider returning
      // nothing at all (Lab #450: in=0 out=0 after 50s on an 80k prompt). Only
      // the first is success — separate them or the log reports failure as a pass.
      const srOutTok = srRes.usage?.output_tokens ?? null;
      if (!String(srRes.text || '').trim() || srOutTok === 0) {
        log.error(`❌ [BEATS] Scene review returned an EMPTY response (${srOutTok} output tokens) — briefs ship unreviewed`);
        gl.warn('beats_scene_review_empty', `Scene review returned nothing (${srOutTok} output tokens) — provider failure, briefs shipped unreviewed`);
      }
      const parsed = parseRefinedText(srRes.text || '', expansions.map(x => x.pageNumber), 'SCENES');
      sceneReviewAnalysis = parsed.analysis || '';
      const byPage = new Map(parsed.pages.map(p => [p.pageNumber, p.text]));
      const changed = [];
      // Captured at the overwrite, the only moment both briefs exist.
      const sceneDiffs = [];
      for (const x of expansions) {
        const fixed = byPage.get(x.pageNumber);
        if (fixed && fixed.trim()) {
          if (fixed !== x.brief) sceneDiffs.push({ pageNumber: x.pageNumber, before: x.brief, after: fixed });
          x.brief = fixed;
          x.reviewRewrote = true;
          changed.push(x.pageNumber);
        }
      }
      meta.timings.sceneReviewMs = Date.now() - t;

      // FAULTED-BUT-NOT-REWRITTEN (owner, 2026-08-08). The reviewer is told to
      // rewrite every page a check faulted, and it does not always comply: on
      // job_1786193650012_7baiaeftb it named defects on pages 4, 8 and 13 and
      // rewrote only 1, 2 and 3. Those defects then shipped, unremarked.
      //
      // Read the reviewer's OWN "FAULTED PAGES:" line (scene-review.txt output
      // contract), never the free prose. The first version of this check
      // regex-matched every "page N" in the analysis, so pages mentioned as
      // PRAISE ("framing peaks on page 12") were reported as unfixed faults
      // (job_1786277779744 flagged 1 and 13 that way). No line → the reviewer
      // predates the contract → skip rather than guess.
      const faultLine = sceneReviewAnalysis.match(/^\s*FAULTED PAGES?:\s*(.+)\s*$/mi);
      const namedPages = faultLine
        ? [...new Set((faultLine[1].match(/\d+/g) || [])
            .map(Number)
            .filter(n => expansions.some(x => x.pageNumber === n)))]
        : null;
      if (!faultLine) {
        log.debug('[BEATS] Scene review analysis has no FAULTED PAGES line — incompleteness check skipped');
      }
      const faultedNotFixed = (namedPages || []).filter(n => !changed.includes(n));
      if (faultedNotFixed.length > 0) {
        log.warn(`⚠️ [BEATS] Scene review named page(s) ${faultedNotFixed.join(', ')} but rewrote none of them`);
        gl.warn('beats_scene_review_incomplete',
          `Reviewer named page(s) ${faultedNotFixed.join(', ')} in its analysis but rewrote only ${changed.length ? changed.join(', ') : 'nothing'} — those findings shipped unfixed`);
      }

      // RE-CHECK. The clothing findings were handed to the reviewer above;
      // whether it acted on them is not a matter of trust. The check is free
      // and deterministic, so run it again on the rewritten briefs and say what
      // survived instead of shipping it quietly (owner rule: fail loudly).
      if (clothingByPage && clothingByPage.size > 0) {
        try {
          const { checkScenes } = require('./clothingCheck');
          const after = checkScenes(expansions.map(x => {
            const m2 = extractSceneMetadata(x.brief) || {};
            return {
              pageNumber: x.pageNumber,
              prose: String(x.brief || '').split('---METADATA---')[0],
              cast: (m2.characters || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean),
              perCharClothing: m2.characterClothing || {},
            };
          }), clothingRequirements, { artifacts: (visualBible || {}).artifacts });
          const REVIEWABLE = new Set(['outfit_misattributed', 'removal_unstated']);
          const left = after.findings.filter(f => REVIEWABLE.has(f.type));
          clothingUnfixedList = left;
          const before = [...clothingByPage.values()].flat().filter(f => REVIEWABLE.has(f.type)).length;
          if (left.length > 0) {
            const pages = [...new Set(left.map(f => f.pageNumber))].sort((a, b) => a - b).join(', ');
            log.warn(`⚠️ [BEATS] clothing check after review: ${left.length}/${before} fault(s) still present on page(s) ${pages}`);
            gl.warn('beats_clothing_unfixed',
              `Clothing faults survived the scene review on page(s) ${pages}: ${left.map(f => `p${f.pageNumber} ${f.type} (${f.character})`).join('; ')}`);
          } else {
            log.info(`👕 [BEATS] clothing check after review: all ${before} fault(s) resolved`);
          }
        } catch (rcErr) {
          log.warn(`⚠️ [BEATS] clothing re-check failed (${rcErr.message})`);
        }
      }

      sceneReviewReport = {
        model: srRes.modelId || reviewModel,
        durationMs: meta.timings.sceneReviewMs,
        changedPages: sceneDiffs.map(d => d.pageNumber),
        namedButNotRewritten: faultedNotFixed,
        analysis: sceneReviewAnalysis,
        pages: sceneDiffs,
        // Dev-mode inspection (owner request 2026-08-09): the exact prompt the
        // reviewer received, every brief as sent, and the clothing trail — so
        // "it rewrote nothing" can be diagnosed without the DB.
        prompt: srPrompt,
        briefsIn,
        clothingFindings: clothingFindings || null,
        briefFindings: briefFindings || null,
        clothingUnfixed: clothingUnfixedList,
      };
      gl.info('beats_scene_review', `Scene review by ${srRes.modelId || reviewModel}: ${changed.length} brief(s) rewritten (${(meta.timings.sceneReviewMs / 1000).toFixed(1)}s)`, null, {
        changedPages: changed, model: srRes.modelId || reviewModel,
      });
    } catch (err) {
      log.warn(`🚨 [BEATS] Scene review failed (${err.message}) — proceeding with unreviewed briefs`);
      gl.warn('beats_scene_review_failed', `Reviewer ${reviewModel} failed: ${err.message} — briefs shipped unreviewed`);
    }
  }

  // ── Step 6: page text — runs HERE, after the scene review, with the briefs ─
  await stage(7, 'Writing the page text...');
  const textResult = await runStoryText(expansions);
  const { textRaw, textModelId, parsedText } = textResult;

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

  /**
   * Page text written from the LOCKED beats. Hoisted so it can be started
   * before scene expansion (it reads no brief) and awaited after the scene
   * review. Uses its own timer — the shared `t` belongs to the stage the
   * caller is running concurrently.
   */
  async function runStoryText(finalExpansions = []) {
    await checkCancellation();
    const withBrief = (finalExpansions || []).filter(x => x && x.brief).length;
    log.info(`🪜 [BEATS] Step 6 page text: ${withBrief}/${beats.length} page(s) carry a locked scene brief`);
    if (!withBrief) {
      // Never silent: without briefs this is the OLD sibling behaviour, and the
      // text can contradict the art again.
      log.warn('⚠️ [BEATS] Step 6 has NO scene briefs — text is being written blind to the illustrations');
      gl.warn('beats_text_without_briefs', 'Page text written without scene briefs — text and art may disagree');
    }
    const textPrompt = buildStoryTextFromBeatsPrompt(inputData, beats, finalExpansions);
    if (!textPrompt) throw new Error('story-text-from-beats template unavailable — beats pipeline cannot run');
    const beatPages = beats.map(b => b.pageNumber);
    let raw = '';
    let modelId = textModel;
    let parsed = null;
    const t0 = Date.now();
    for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
      try {
        const res = await textModels.callTextModelStreaming(textPrompt, null, onChunk, textModel, { usageLabel: 'beats_story_text' });
        const candidate = parseRefinedText(res.text || '', beatPages);
        if (candidate.pages.length === 0 || candidate.missing.length > 0) {
          log.warn(`⚠️ [BEATS] Text attempt ${attempt}: ${candidate.pages.length} page(s) parsed, missing ${candidate.missing.join(', ') || 'none'}`);
          if (attempt < 2) continue;
        }
        raw = res.text || '';
        modelId = res.modelId || textModel;
        parsed = candidate;
      } catch (err) {
        log.warn(`⚠️ [BEATS] Story text attempt ${attempt} failed: ${err.message}`);
        if (attempt >= 2) throw err;
      }
    }
    meta.timings.storyTextMs = Date.now() - t0;
    if (!parsed || parsed.pages.length === 0) throw new Error('Beats text writer returned no parseable pages');
    return { textRaw: raw, textModelId: modelId, parsedText: parsed };
  }

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
  // shows what each stage produced — AND the string server.js hands to
  // UnifiedStoryParser as `unifiedResponse`. Uses the unified section markers
  // so the existing parsers find the title, the page text, and (via the step-5b
  // block spliced in ahead of ---STORY PAGES---, which terminates the
  // cover-hints regex) the clothing requirements, Visual Bible and cover hints.
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
    ...(bibleSections ? [bibleSections, ''] : []),
    '---STORY PAGES---',
    pages.map(p => `## Page ${p.pageNumber}\n${p.text}`).join('\n\n'),
  ].join('\n');

  meta.totalMs = Date.now() - started;
  meta.title = title;
  meta.textModelId = textModelId;
  log.info(`🪜 [BEATS] job=${jobId} done: ${pages.length} pages in ${(meta.totalMs / 1000).toFixed(1)}s`);

  return { title, beats, pages, scenes, rawOutline, meta, beatsReviewReport, clothingReviewReport, sceneReviewReport };
}

module.exports = { generateStoryViaBeats, resolvePipelineMode, PIPELINE_MODES };

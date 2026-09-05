

const { runPlanCounters, collectPlaceNames, highActionPageBudget } = require('./planCounters');
const { textZoneRulesActive } = require('../config/runtime');

// The beats layer no longer audits the STORY (owner, 2026-09-01). Its only
// check is arithmetic over the page division (./planCounters) plus one cheap
// model call; neither emits FAULT lines, and neither rewrites a beat.

/**
 * Beats-first story generation (pipelineMode: 'beats').
 *
 * Replaces the single unified Sonnet call + outline review with staged
 * calls, so every stage is reviewable and only the faulted pages get rewritten:
 *
 *   0. THE ARC MACHINE       create → panel → re-tell (arc_create/arc_panel/
 *      arc_retell): the creator writes two arcs + self-critiques and commits
 *      to one, a panel of outside models proposes solutions, the same creator
 *      re-tells the story whole. Replaces the old arc audit/review chain
 *      (owner, 2026-08-30 — see docs/decisions.md)
 *   1. beats_plan            Sonnet    PAGE PLAN (one plan line per page), FROM the approved arc
 *   2. plan_check            counters + one cheap call: arithmetic over the
 *      DIVISION only, then at most ONE re-plan by the planner. No story
 *      checking happens at this layer by design (owner, 2026-09-01)
 *   3. beats_story_bible     Sonnet    clothing + Visual Bible + cover hints
 *   4. beats_scene_expansion Sonnet    ONE call over ALL pages (cross-page continuity)
 *   5. beats_scene_review    DeepSeek  ONE call over ALL briefs, rewrites faulted
 *   6. beats_story_text      Sonnet    page text written from the arc + the locked plan lines
 *
 * Scheduling is by data dependency, not by list order:
 *
 *   beats ─> plan check ─> bible ─┬─> styled avatars    (caller-owned, long pole)
 *                                   └─> scene expansion ─> scene review ─> page text
 *
 * Step 6 runs AFTER the scene review and reads the FINAL briefs (owner decision
 * 2026-08-10: the scenes come first, the text must follow — see the note at the
 * old kickoff site below). Styled avatars need only clothingRequirements, so
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
const { MODEL_DEFAULTS, IMAGE_MODELS, TEXT_MODELS } = require('../config/models');
const {
  buildBeatsPrompt,
  buildChallengeIdeasSection,
  buildArcCreatePrompt,
  buildArcPanelPrompt,
  buildArcRetellPrompt,
  buildArcHintsPrompt,
  parseArcHints,
  parseArcCreate,
  parseArcRetell,
  critiqueMaxSeverity,
  buildPlanCheckPrompt,
  parsePlanCheck,
  buildReplanSection,
  buildClothingReviewPrompt,
  parseClothingReview,
  parsePlanResponse,
  buildSceneExpansionPrompt,
  buildSceneExpansionAllPrompt,
  buildSceneReviewPrompt,
  buildStoryTextFromBeatsPrompt,
  buildStoryBibleFromBeatsPrompt,
  parseRefinedText,
  buildAvailableAvatarsForPrompt,
  extractSceneMetadata,
  getHistoricalLocations,
  getHistoricalObjects,
} = require('./storyHelpers');
const { UnifiedStoryParser } = require('./outlineParser/unified');
const { stableCandidateIndex } = require('./outlineParser/shared');
const { log } = require('../utils/logger');

const PIPELINE_MODES = ['unified', 'beats'];

/**
 * True when a re-telling's "Fixing:" line addressed only MINOR faults of the
 * critique it answered. Parses the fault numbers Fixing names and looks their
 * severities up in that critique's numbered lines (untagged lines count as
 * MAJOR, matching critiqueMaxSeverity). Tolerant by design: no parseable
 * numbers, or numbers that match no critique line, return false — the caller
 * must never stop a round on a guess.
 */
function fixingBelowMajor(fixing, prevCritique) {
  const nums = [...String(fixing || '').matchAll(/\b(\d{1,2})\b/g)].map(m => parseInt(m[1], 10));
  if (!nums.length) return false;
  const severities = {};
  for (const line of String(prevCritique || '').split('\n')) {
    const m = line.match(/^\s*(\d+)[.)]/);
    if (!m) continue;
    const tag = line.match(/\[(CRITICAL|MAJOR|MINOR)\]/i);
    severities[parseInt(m[1], 10)] = tag ? tag[1].toUpperCase() : 'MAJOR';
  }
  const known = nums.filter(n => severities[n] !== undefined);
  if (!known.length) return false;
  return known.every(n => severities[n] === 'MINOR');
}

/**
 * Which generation pipeline a job runs. `inputData.pipelineMode` overrides per
 * job (Test Lab A/B and one-off reruns need that); anything unrecognised falls
 * back to DEFAULT_PIPELINE_MODE.
 */
function resolvePipelineMode(inputData = {}) {
  // TRIAL IS NEVER BEATS (owner decision 2026-08-15). The trial writes its
  // whole story in ONE call (buildTrialStoryPrompt / story-trial.txt) because
  // the funnel depends on speed: the last real production trial finished in
  // 123s end-to-end for 5 pages. The beats chain is seven sequential LLM calls
  // whose cost is mostly FIXED, not per-page — measured on staging: 326/350/382s
  // of text for a 4-page story, 520/631s for 10 pages, before any image work.
  // Beats for a trial would therefore spend ~3x the entire current trial budget
  // on text alone. Nothing excluded trial from beats before this, so promoting
  // PIPELINE_MODE=beats to production would have silently switched every trial
  // onto the slow path and made story-trial.txt dead code.
  if (inputData?.trialMode) return 'unified';
  const raw = inputData?.pipelineMode || require('../config/runtime').runtime('pipelineMode');
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

// ── Cross-story challenge memory ────────────────────────────────────────────
// A family buys several books. Nothing used to stop the planner giving them the
// same challenge twice (the lost thing found, the storm crossed, the rival
// out-argued) — every run starts from the same commission shape with no memory
// of what the account already owns. These three caps keep the injection small
// enough that it never competes with the commission itself.
const PRIOR_STORY_LIMIT = 3;
const CHALLENGE_LINE_MAX = 120;
const ARC_VARIETY_MAX = 600;

/**
 * Pull the numbered challenge lines out of a stored arc.
 *
 * The arc's shape is "Challenges of <names>:" then numbered entries, then a
 * "Moments:" (or "Blocker:") section. Tolerant on purpose: an arc written by an
 * older template, or one the arc reviewer reshaped, must degrade to [] rather
 * than throw or capture the whole arc.
 *
 * @returns {string[]} one truncated line per challenge; [] when the arc has no
 *   Challenges section at all (the injection then skips).
 */
function extractChallengeLines(arc) {
  const text = String(arc || '');
  // "Challenges of <names>:" is the old structured-arc form; "Challenges
  // taken:" is the arc machine's FINAL ARC form (2026-08-30). In old arcs the
  // widened match lands on the one-line "Challenges taken:" summary first, and
  // the numbered filter below still captures the same numbered entries.
  const start = text.search(/Challenges (?:of[^:\n]*|taken)\s*:/i);
  if (start < 0) return [];
  let block = text.slice(start);
  const end = block.search(/^\s*(?:Moments|Blocker|Used|CRITIQUE)\s*:/mi);
  if (end > 0) block = block.slice(0, end);
  return block
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^\d+[.)]\s+/.test(l))
    .map(l => l.replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean)
    .map(l => (l.length > CHALLENGE_LINE_MAX ? `${l.slice(0, CHALLENGE_LINE_MAX - 1).trimEnd()}…` : l));
}

/**
 * The challenges this account's previous books already used.
 *
 * Reads the DB directly (same lazy `require('../services/database')` every other
 * lib module uses) rather than threading a pool through the caller: the query
 * needs nothing storyJobPipeline has that jobId does not already resolve, and a
 * new parameter would have to be plumbed through server.js and the Test Lab too.
 *
 * `data->'beatsReviewReport'->>'arc'` doubles as the completeness filter — a job
 * that never reached the beats review has no approved arc to contribute, and
 * story_jobs rows are pruned, so joining on job status would silently drop the
 * older books that matter most here.
 *
 * Never throws: a failed lookup means the arc is planned with no memory, which
 * is exactly what happened before this existed.
 *
 * @returns {Promise<{lines: string[], stories: number}>}
 */
async function loadPriorChallenges(jobId, gl = NOOP_LOG) {
  if (!jobId) return { lines: [], stories: 0 };
  try {
    const { dbQuery } = require('../services/database');
    const rows = await dbQuery(
      `SELECT s.id, s.data->'beatsReviewReport'->>'arc' AS arc
         FROM stories s
        WHERE s.user_id = (SELECT user_id FROM story_jobs WHERE id = $1)
          AND s.id <> $1
          AND s.data->'beatsReviewReport'->>'arc' IS NOT NULL
          -- Same story TYPE only (2026-08-27): the smoke account mixes toddler
          -- and standard books, and cross-type exclusions injected toddler
          -- fragments ("she reaches for the parrot") into a pirate plan while
          -- excluding the race and map mechanics the new story needed.
          AND s.data->>'storyType' IS NOT DISTINCT FROM (SELECT input_data->>'storyType' FROM story_jobs WHERE id = $1)
        ORDER BY s.created_at DESC
        LIMIT ${PRIOR_STORY_LIMIT}`,
      [String(jobId)]
    );
    const lines = [];
    let stories = 0;
    let budget = ARC_VARIETY_MAX;
    for (const row of rows || []) {
      const own = extractChallengeLines(row.arc);
      if (own.length === 0) continue;
      stories += 1;
      for (const line of own) {
        if (budget - (line.length + 3) < 0) return { lines, stories };
        lines.push(line);
        budget -= line.length + 3;
      }
    }
    return { lines, stories };
  } catch (err) {
    log.warn(`⚠️ [BEATS] Prior-challenge lookup failed (${err.message}) — arc planned without cross-story memory`);
    gl.warn('arc_variety_failed', `Prior-challenge lookup failed: ${err.message}`);
    return { lines: [], stories: 0 };
  }
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
    // Fired once with the parsed Visual Bible the moment it exists (after the
    // bible stage, before wardrobe review and the avatar kickoff). The caller
    // may THROW from it to abort the run early — that is the landmark
    // guideline's retry seam: aborting here costs arc+bible only, not the
    // scene briefs and the full page-text phase (measured ~30min per attempt,
    // of which the post-bible stages are ~20min). Not called when the bible
    // stage failed (visualBible stays null — the run ships degraded by design).
    onVisualBible = null,
  } = opts;
  const gl = genLog || NOOP_LOG;
  const onChunk = heartbeat ? () => heartbeat() : null;
  // Stage checkpoints carry their measured budget so the caller can INTERPOLATE
  // between them: percent is time-proportional (medians over completed staging
  // runs), and `nextPct`/`ms` let the job's heartbeat ease the bar forward while
  // a single 200s+ LLM call is in flight. Without that the bar froze at one
  // number for minutes at a time — the text phase is ~58% of the wall clock but
  // used to own 6 points of the bar.
  const stage = async (pct, msg, hint = null) => {
    if (onStage) { try { await onStage(pct, msg, hint); } catch { /* progress only */ } }
  };

  const pageCount = parseInt(opts.pageCount, 10) || parseInt(inputData?.pages, 10) || 10;
  const expected = Array.from({ length: pageCount }, (_, i) => i + 1);

  const planModel = modelOverrides.outlineModel || MODEL_DEFAULTS.outline;
  const reviewModel = modelOverrides.outlineReviewModel || MODEL_DEFAULTS.outlineReviewModel;
  // THE ARC MACHINE (owner, 2026-08-30): creator + panel + rounds replace the
  // old arcAuditModel/arcReviewModel/childCriticModel chain here.
  const arcCreatorModel = modelOverrides.arcCreatorModel || MODEL_DEFAULTS.arcCreatorModel || planModel;
  const arcPanelModels = (Array.isArray(MODEL_DEFAULTS.arcPanelModels) ? MODEL_DEFAULTS.arcPanelModels : [])
    .filter(m => TEXT_MODELS[m]);
  // Hard cap at 3 (owner, 2026-08-30): the iteration study peaked at v3 and
  // regressed at v4. The adaptive early stop below usually ends sooner.
  const arcRoundsRequested = parseInt(modelOverrides.arcRounds, 10) || MODEL_DEFAULTS.arcRounds || 1;
  const arcRounds = Math.max(1, Math.min(3, arcRoundsRequested));
  if (arcRoundsRequested > 3) log.warn(`⚠️ [ARC] arcRounds=${arcRoundsRequested} clamped to 3 (owner cap 2026-08-30 — iteration study regressed at round 4)`);
  // Scene and wardrobe reviews are their own decisions — see models.js. They
  // deliberately do NOT follow the beats reviewer.
  const sceneReviewModel = modelOverrides.sceneReviewModel || MODEL_DEFAULTS.sceneReviewModel || reviewModel;
  const clothingReviewModel = modelOverrides.clothingReviewModel || MODEL_DEFAULTS.clothingReviewModel || reviewModel;
  const sceneModel = modelOverrides.sceneDescriptionModel || MODEL_DEFAULTS.sceneDescription;
  const textModel = modelOverrides.textModel || MODEL_DEFAULTS.storyText;

  const meta = { pageCount, models: { planModel, arcCreatorModel, arcPanelModels, arcRounds, planCheckModel: modelOverrides.planCheckModel || MODEL_DEFAULTS.planCheckModel, reviewModel, sceneReviewModel, clothingReviewModel, sceneModel, textModel }, timings: {} };
  const started = Date.now();
  log.info(`🪜 [BEATS] job=${jobId} pages=${pageCount} plan=${planModel} arcCreator=${arcCreatorModel} arcPanel=${arcPanelModels.join('+')} arcRounds=${arcRounds} planCheck=${modelOverrides.planCheckModel || MODEL_DEFAULTS.planCheckModel} review=${reviewModel} sceneReview=${sceneReviewModel} wardrobeReview=${clothingReviewModel} scenes=${sceneModel} text=${textModel}`);

  // ── Step 0: THE ARC MACHINE — create → panel → re-tell ────────────────────
  // Replaces the arc write → audit → child critic → review → re-audit chain
  // (owner, 2026-08-30). Forensics on that chain showed the patch step
  // destroying stories: a fix deleted the cause a turn depended on, or bolted
  // an alibi clause onto a sentence to satisfy a fault line (docs/decisions.md
  // 2026-08-30). The machine never patches. CREATE: the creator writes TWO
  // arcs, each with a blunt numbered self-critique, and commits to one. PANEL:
  // outside models each propose exactly one solution on the committed arc +
  // critique — advisory, in parallel, a lost voice never blocks. RE-TELL: the
  // SAME creator re-tells the story whole, from the beginning, and critiques
  // the result again. Rounds are configurable (arcRounds); the final critique
  // rides into the beats prompt as known weak points instead of being "fixed"
  // out of existence.
  await checkCancellation();
  // The random catalogue draw is an INPUT like any other — drawn ONCE, given to
  // the arc creator AND the beats planner, and persisted so "which challenges
  // was this book offered / which did it take" is answerable from the story
  // record (owner, 2026-08-29).
  const challengeIdeas = buildChallengeIdeasSection(inputData);
  const challengeDraw = challengeIdeas.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2));
  if (challengeDraw.length) gl.info('challenge_draw', `Drew ${challengeDraw.length} challenge idea(s) for the arc plan`, null, { challengeDraw });
  let approvedArc = '';
  // The FINAL ARC's own critique — handed to the beats prompt as the known
  // weak points the page division must not amplify.
  let arcWeakPoints = '';
  // The lean flow's hint pass (owner verdict 2026-09-01): the top remaining
  // ISSUE → CHANGE lines on the final arc. They ride into the beats prompt
  // (applied while dividing) and the text writer (the text supports them).
  let arcHints = '';
  // The machine's full trail. Kept under the arcReviewReport key so the
  // storyJobPipeline persistence and the dev-mode wiring stay untouched.
  let arcReviewReport = null;
  // CROSS-STORY MEMORY: the challenges this account's previous books used. Only
  // the arc-plan call sees them — that is the one call that invents challenges;
  // every later stage divides and dresses what this one decided.
  const priorChallenges = await loadPriorChallenges(jobId, gl);
  const arcVarietyExclusions = priorChallenges.lines;
  if (arcVarietyExclusions.length > 0) {
    gl.info('arc_variety', `Excluding ${arcVarietyExclusions.length} challenge(s) from ${priorChallenges.stories} earlier book(s) on this account`, null, {
      stories: priorChallenges.stories, challenges: arcVarietyExclusions,
    });
  }
  const varietyBlock = arcVarietyExclusions.length > 0
    ? `This reader's earlier books used these challenges — this story uses different ones:\n${arcVarietyExclusions.map(l => `- ${l}`).join('\n')}`
    : '';
  let t = Date.now();
  try {
    // OpenRouter/xAI take a temperature; the Anthropic path sends none.
    const tempFor = (model, temp) =>
      (temp == null || TEXT_MODELS[model]?.provider === 'anthropic') ? {} : { temperature: temp };

    /** Creator-side call: one retry, then throw — the creator is not advisory. */
    const creatorCall = async (prompt, label, temp) => {
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await textModels.callTextModelStreaming(prompt, null, onChunk, arcCreatorModel, { usageLabel: label, ...tempFor(arcCreatorModel, temp) });
          if (!String(res?.text || '').trim()) throw new Error('empty response');
          return res;
        } catch (err) {
          lastErr = err;
          log.warn(`⚠️ [ARC] ${label} attempt ${attempt} failed: ${err.message}`);
        }
      }
      throw new Error(`${label} failed after retry: ${lastErr?.message || 'unknown error'}`);
    };

    // CREATE. A parse miss (no commitment line, no ARC 2 boundary) gets one
    // full re-create, then throws into the outer containment.
    await stage(1, 'Shaping the story arc...', { next: 2, ms: 90000 });
    const createPrompt = buildArcCreatePrompt(inputData, pageCount, { challengeIdeas, priorChallenges: varietyBlock });
    if (!createPrompt) throw new Error('arc-create template unavailable');
    let createRes = null;
    let commit = null;
    for (let attempt = 1; attempt <= 2 && !commit; attempt++) {
      createRes = await creatorCall(createPrompt, 'arc_create', null);
      try {
        commit = parseArcCreate(createRes.text);
      } catch (parseErr) {
        log.warn(`⚠️ [ARC] create parse failed (${parseErr.message})${attempt === 1 ? ' — one re-create' : ''}`);
        if (attempt === 2) throw parseErr;
      }
    }
    gl.info('arc_create', `Arc creator ${createRes.modelId || arcCreatorModel} wrote two arcs and committed to Arc ${commit.n}`, null, {
      model: createRes.modelId || arcCreatorModel, committed: commit.n, stronger: commit.strongerLine,
    });
    // Defaults if every panel round comes back empty: the committed arc stands,
    // its own critique as the known weak points.
    approvedArc = commit.arc;
    arcWeakPoints = commit.critique;

    // PANEL + RE-TELL rounds. Round k>1 feeds the previous FINAL ARC + its
    // critique back to the same panel, then the same creator re-tells again.
    let currentBlock = commit.committed;
    // The critique the NEXT re-telling's Fixing line answers — the create
    // critique for round 1, then each round's fresh critique.
    let prevCritique = commit.critique;
    const roundReports = [];
    for (let round = 1; round <= arcRounds; round++) {
      await checkCancellation();
      await stage(2, 'Convening the story panel...', { next: 2, ms: 120000 });
      const panelPrompt = buildArcPanelPrompt(inputData, currentBlock);
      if (!panelPrompt) throw new Error('arc-panel template unavailable');
      const settled = await Promise.allSettled(arcPanelModels.map(async (m) => {
        const res = await textModels.callTextModelStreaming(panelPrompt, null, onChunk, m, { usageLabel: 'arc_panel', ...tempFor(m, MODEL_DEFAULTS.arcPanelTemperature) });
        const text = String(res?.text || '').trim();
        if (!text) throw new Error('empty panel response');
        return { model: res.modelId || m, text };
      }));
      const panel = [];
      const failedPanelists = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') { panel.push(r.value); return; }
        // Advisory by design: a lost voice narrows the panel, it never blocks.
        failedPanelists.push(arcPanelModels[i]);
        log.warn(`⚠️ [ARC] Panelist ${arcPanelModels[i]} failed (round ${round}): ${r.reason?.message}`);
        gl.warn('arc_panel_failed', `Panelist ${arcPanelModels[i]} failed in round ${round}: ${r.reason?.message} — panel is advisory, continuing without them`);
      });
      if (panel.length === 0) {
        // No voices at all: nothing to re-tell against. Whatever arc is current
        // (the committed one, or the previous round's re-telling) stands.
        log.warn(`⚠️ [ARC] Entire panel failed in round ${round} — arc ships without this re-telling round`);
        gl.warn('arc_panel_empty', `Entire panel failed in round ${round} — arc ships without this re-telling round`);
        break;
      }
      gl.info('arc_panel', `Round ${round}: ${panel.length}/${arcPanelModels.length} panelists proposed one solution each`, null, {
        round, panelists: panel.map(p => p.model), failed: failedPanelists,
      });

      // RE-TELL: same creator, committed arc + critique + all solutions, told
      // again from the beginning. Never a patch. A parse miss (no FINAL ARC)
      // gets one more telling, then throws.
      await stage(2, 'Re-telling the story arc...', { next: 3, ms: 90000 });
      // No model names in prompts (owner, 2026-08-31): panelists appear as
      // letters, stable in arcPanelModels order. The letter→model mapping
      // stays in the trail via each panel entry's `letter` + `model`.
      panel.forEach((p, i) => { p.letter = String.fromCharCode(65 + i); });
      const solutionsText = panel.map(p => `## PANELIST ${p.letter}\n${p.text}`).join('\n\n');
      const retellPrompt = buildArcRetellPrompt(inputData, pageCount, currentBlock, solutionsText);
      if (!retellPrompt) throw new Error('arc-retell template unavailable');
      let retellRes = null;
      let retold = null;
      for (let attempt = 1; attempt <= 2 && !retold; attempt++) {
        retellRes = await creatorCall(retellPrompt, 'arc_retell', MODEL_DEFAULTS.arcRetellTemperature);
        try {
          retold = parseArcRetell(retellRes.text);
        } catch (parseErr) {
          log.warn(`⚠️ [ARC] re-tell parse failed (${parseErr.message})${attempt === 1 ? ' — one more telling' : ''}`);
          if (attempt === 2) throw parseErr;
        }
      }
      approvedArc = retold.finalArc;
      // The critique travels to the beats prompt together with the re-telling's
      // contract lines: what was already fixed, and which scenes and turns must
      // survive the page division untouched (owner refinement, 2026-08-30 —
      // the study's round-4 regression deleted a story's best scene because
      // the fault list had no keep column).
      arcWeakPoints = [
        retold.critique,
        retold.fixing ? `Fixing (already addressed in the re-telling): ${retold.fixing}` : '',
        retold.keeping ? `Keeping (must survive the page division untouched): ${retold.keeping}` : '',
      ].filter(Boolean).join('\n');
      // Worst surviving fault (untagged lines count as MAJOR, so pre-tag
      // output keeps working); null = the critique names no faults at all.
      const maxSeverity = critiqueMaxSeverity(retold.critique);
      roundReports.push({
        round,
        panel,
        failedPanelists,
        retellModel: retellRes.modelId || arcCreatorModel,
        finalArc: retold.finalArc,
        used: retold.used,
        fixing: retold.fixing,
        keeping: retold.keeping,
        critique: retold.critique,
        maxSeverity,
      });
      gl.info('arc_retell', `Round ${round}: ${retellRes.modelId || arcCreatorModel} re-told the story (used: ${retold.used || 'not stated'}; worst surviving fault: ${maxSeverity || 'none'})`, null, {
        round, used: retold.used, maxSeverity, critiqueFaults: (retold.critique.match(/^\s*\d+[.)]/gm) || []).length,
      });
      // ADAPTIVE EARLY STOP (owner, 2026-08-30): another round only earns its
      // cost while a CRITICAL or MAJOR fault survives. When nothing above
      // MINOR remains, more rounds are where the study's regression came from.
      if (round < arcRounds && (maxSeverity === null || maxSeverity === 'MINOR')) {
        gl.info('arc_rounds_early_stop', `Round ${round}: critique has nothing above MINOR — skipping ${arcRounds - round} remaining round(s)`, null, {
          round, maxSeverity, reason: 'nothing above MINOR',
        });
        break;
      }
      // SECOND EARLY STOP (owner, 2026-08-31): each fresh critique tends to
      // mint a fresh MAJOR, so the trigger above rarely fires and max rounds
      // burn (the pirate validation run: every round's MAJOR was new). When
      // this re-telling's Fixing line addressed nothing above MINOR in the
      // critique it answered, the arc has stopped materially changing —
      // another round cannot earn its cost. Tolerant: unparseable Fixing
      // never stops on this trigger.
      if (round < arcRounds && fixingBelowMajor(retold.fixing, prevCritique)) {
        gl.info('arc_rounds_early_stop', `Round ${round}: Fixing addressed nothing above MINOR — skipping ${arcRounds - round} remaining round(s)`, null, {
          round, maxSeverity, reason: 'fixing_below_major',
        });
        break;
      }
      prevCritique = retold.critique;
      currentBlock = `FINAL ARC:\n${retold.finalArc}\n\nCRITIQUE:\n${retold.critique}`;
    }

    // GROK HINT PASS (owner verdict 2026-09-01, lean flow): one outside look
    // at the final arc — the top remaining issues travel forward as hints,
    // never as another re-telling round. Advisory: failure skips, never blocks.
    try {
      const hintsModel = MODEL_DEFAULTS.arcHintsModel || 'grok-4.6';
      const hintsPrompt = buildArcHintsPrompt(inputData, approvedArc);
      if (!hintsPrompt) throw new Error('arc-hints template unavailable');
      // null maxTokens = the model's own maximum; temp 0 on the non-Anthropic paths.
      const hintsRes = await textModels.callTextModelStreaming(hintsPrompt, null, onChunk, hintsModel, { usageLabel: 'arc_hints', ...tempFor(hintsModel, 0) });
      arcHints = parseArcHints(hintsRes?.text || '');
      if (!arcHints) throw new Error('no ISSUE → CHANGE lines parsed');
      gl.info('arc_hints', `Hint pass (${hintsRes.modelId || hintsModel}): ${arcHints.split('\n').length} hint(s) on the final arc`, null, {
        model: hintsRes.modelId || hintsModel, hints: arcHints.split('\n'),
      });
    } catch (hintErr) {
      arcHints = '';
      log.warn(`⚠️ [ARC] hint pass failed (${hintErr.message}) — beats and text proceed without hints`);
      gl.warn('arc_hints_failed', `Arc hint pass failed: ${hintErr.message} — beats and text proceed without hints`);
    }

    meta.timings.arcMs = Date.now() - t;
    // Everything the machine produced, verbatim — storage is cheap,
    // debuggability is the point. Text only, no images.
    arcReviewReport = {
      machine: 'create-panel-retell',
      creatorModel: createRes.modelId || arcCreatorModel,
      panelModels: arcPanelModels,
      roundsConfigured: arcRounds,
      roundsRun: roundReports.length,
      durationMs: meta.timings.arcMs,
      create: createRes.text,
      committedArc: commit.n,
      committed: commit.committed,
      discarded: commit.discarded,
      rounds: roundReports,
      finalArc: approvedArc,
      fixing: roundReports.length ? roundReports[roundReports.length - 1].fixing : '',
      keeping: roundReports.length ? roundReports[roundReports.length - 1].keeping : '',
      maxSeverity: roundReports.length ? roundReports[roundReports.length - 1].maxSeverity : null,
      critique: roundReports.length ? roundReports[roundReports.length - 1].critique : arcWeakPoints,
      arcHints,
    };
    gl.info('beats_arc', `Arc machine done: ${roundReports.length}/${arcRounds} round(s), final arc by ${arcCreatorModel} (${(meta.timings.arcMs / 1000).toFixed(1)}s)`, null, {
      rounds: roundReports.length, creatorModel: arcCreatorModel,
    });
  } catch (err) {
    // Never block a story on the arc step: without it the planner writes the
    // arc inline exactly as it did before this stage existed.
    log.warn(`🚨 [BEATS] Arc machine failed (${err.message}) — planning beats without an arc`);
    gl.warn('beats_arc_failed', `Arc machine failed: ${err.message} — beats planned without an arc`);
    approvedArc = '';
    arcWeakPoints = '';
    arcHints = '';
  }

  // ── Step 1: beats plan ────────────────────────────────────────────────────
  await checkCancellation();
  // The beats stage divides the FINISHED story (owner redesign, 2026-08-31:
  // "the beats gets the story"). The final arc enters the template as
  // {FINAL_ARC}; the challenge draw and the arc critique no longer travel here
  // — the arc machine consumed the one and answered the other. Since
  // 2026-09-02 the stage emits ONE thing per page: the plan line. The beat
  // prose it used to write measured as the lossiest step in the chain
  // (Lab #973) and is gone — see docs/decisions.md.
  const planPrompt = buildBeatsPrompt(inputData, pageCount, { finalArc: approvedArc, arcHints });
  if (!planPrompt) throw new Error('story-beats template unavailable — beats pipeline cannot run');

  /**
   * One planner response -> its PAGE PLAN text and its parsed beats.
   *
   * Used twice: the first division, and the single re-plan the plan check may
   * request. Keeping it one function is what makes the re-plan a genuine
   * re-division — the second response is read exactly like the first, with no
   * merge path that could leave half a plan behind.
   */
  const readPlan = (raw) => {
    const parsed = parsePlanResponse(String(raw || ''), expected);
    // The approved arc is the story; the planner does not author one.
    parsed.arc = approvedArc || '';
    return { parsed, pagePlan: parsed.pagePlan };
  };

  t = Date.now();
  await stage(3, 'Planning the story beats...', { next: 5, ms: 25000 });
  const planRes = await textModels.callTextModelStreaming(planPrompt, null, onChunk, planModel, { usageLabel: 'beats_plan' });
  meta.timings.planMs = Date.now() - t;
  const first = readPlan(planRes.text);
  const plan = first.parsed;
  let pagePlan = first.pagePlan;
  if (pagePlan) log.info(`📐 [BEATS] page plan: ${pagePlan.split('\n').filter(Boolean).length} line(s)`);
  if (plan.pages.length === 0) throw new Error('Beats planner returned no parseable plan lines');
  if (plan.missing.length > 0) {
    log.warn(`⚠️ [BEATS] Planner omitted page(s) ${plan.missing.join(', ')} — story will be ${plan.pages.length} pages`);
    gl.warn('beats_plan_incomplete', `Planner omitted page(s) ${plan.missing.join(', ')}`);
  }
  gl.info('beats_plan', `Page plan: ${plan.pages.length}/${pageCount} pages by ${planRes.modelId || planModel} (${(meta.timings.planMs / 1000).toFixed(1)}s)`, null, {
    pages: plan.pages.length, model: planRes.modelId || planModel,
  });

  // ── Step 2: THE PLAN CHECK — counters, one cheap call, ONE re-plan ────────
  //
  // What used to stand here: a blind beats audit, a full-context reviewer that
  // rewrote every faulted beat, a re-audit of its output, and a second review
  // round. All of it is deleted (owner ruling, 2026-09-01 — the reviewer
  // "should not fix the story at all... count the images").
  //
  // The beats layer therefore performs NO story checking by design. The arc
  // machine owns story correctness; the text audit downstream is the remaining
  // prose guard. What is left at this layer is arithmetic over the DIVISION —
  // shot distribution, cast per page, whether a character ever gets a page of
  // their own — and arithmetic belongs in code, where it is free and cannot
  // hallucinate (server/lib/planCounters.js). ONE cheap model call judges only
  // the three things a counter cannot: whether an emotional-highlight page is
  // really one person's felt moment, whether each character's first page stages
  // an arrival or a naming, and whether a 3+-cast page's justification holds.
  //
  // Neither half ever edits a beat. Findings travel back to the PLANNER as a
  // single re-plan request ("re-divide the named pages; everything else
  // stands"), and that loop runs at most once — a checker that could rewrite is
  // exactly the mechanism this replaced.
  await checkCancellation();
  let beats = plan.pages;
  let beatsReviewReport = null;
  const commissionedNames = (inputData?.characters || []).map(c => c && c.name).filter(Boolean);
  // The counters must never read a PLACE as a person. The names come from the
  // same authoritative data the planner itself was given — the resolved
  // landmark list, the family's town, and (historical stories) the canonical
  // locations and period objects — never from a word list or a prose pattern.
  // Story job_1788614817116_vxnu60yjg entered "Uetliberg" and "Aussichtsturm
  // Uetliberg" into the invented cast and manufactured six INVENTED_DOMINANT
  // pages off it (docs/decisions.md, 2026-09-05).
  const placeNames = collectPlaceNames(inputData, [
    ...(inputData?.storyCategory === 'historical'
      ? [...getHistoricalLocations(inputData.storyTopic), ...getHistoricalObjects(inputData.storyTopic)].map(e => e && e.name)
      : []),
  ]);
  if (placeNames.length) log.debug(`[BEATS] plan counters know ${placeNames.length} place name(s) that can never be cast`);
  const maxCast = IMAGE_MODELS[inputData?.modelOverrides?.imageModel || MODEL_DEFAULTS.pageImage]?.maxCharactersPerScene || 3;
  const planCheckModel = modelOverrides.planCheckModel || MODEL_DEFAULTS.planCheckModel;

  /**
   * Counters (free, deterministic) + the one model call. Never throws: the
   * model half is advisory, and a lost call leaves the counters standing alone
   * rather than skipping the check entirely.
   */
  const runCheck = async (label, pages, planText) => {
    const counters = runPlanCounters({ pages, commissionedNames, placeNames, maxCharactersPerScene: maxCast, highActionPages: highActionPageBudget(pageCount) });
    let modelFindings = [];
    let checkModelId = null;
    let prompt = null;
    try {
      prompt = buildPlanCheckPrompt(inputData, pages, approvedArc, planText, counters.lines);
      if (!prompt) throw new Error('plan-check template unavailable');
      const res = await textModels.callTextModelStreaming(prompt, null, onChunk, planCheckModel, {
        usageLabel: label,
        // Judges run at temperature 0 (settled); the Anthropic path sends none.
        ...(TEXT_MODELS[planCheckModel]?.provider === 'anthropic' ? {} : { temperature: 0 }),
      });
      checkModelId = res.modelId || planCheckModel;
      modelFindings = parsePlanCheck(res.text || '');
    } catch (err) {
      log.warn(`⚠️ [BEATS] Plan check (${label}) failed (${err.message}) — the counters' findings stand alone`);
      gl.warn(`${label}_failed`, `Plan check failed: ${err.message} — the counters' findings stand alone`);
    }
    // Findings travel STRUCTURED to the re-plan: a counter keeps its code, a
    // model finding the check number it answered, so buildReplanSection can rank
    // them without reading their prose. `lines` stays the flat rendering the
    // report and the logs have always carried.
    const structured = [
      ...counters.findings.map((f, i) => ({ kind: 'counter', code: f.code, line: counters.lines[i] })),
      ...modelFindings.map(f => ({ kind: 'check', check: f.check, line: `CHECK[${f.check}]: ${f.text}` })),
    ];
    const all = structured.map(f => f.line);
    gl.info(label, `Plan check by ${checkModelId || planCheckModel}: ${counters.lines.length} counter finding(s), ${modelFindings.length} model finding(s)`, null, {
      counterFindings: counters.lines, modelFindings, model: checkModelId, stats: counters.stats, cast: counters.cast,
    });
    return { counters, modelFindings, findings: structured, lines: all, checkModelId, prompt };
  };

  t = Date.now();
  await stage(4, 'Checking the page division...', { next: 5, ms: 45000 });
  const check1 = await runCheck('plan_check', plan.pages, pagePlan);
  let check2 = null;
  let replannedPages = [];
  if (check1.lines.length > 0) {
    try {
      await checkCancellation();
      await stage(5, 'Re-dividing the named pages...', { next: 18, ms: 45000 });
      const replanPrompt = buildBeatsPrompt(inputData, pageCount, {
        finalArc: approvedArc,
        arcHints,
        replan: buildReplanSection(pagePlan, check1.findings),
      });
      if (!replanPrompt) throw new Error('story-beats template unavailable');
      const rpRes = await textModels.callTextModelStreaming(replanPrompt, null, onChunk, planModel, { usageLabel: 'beats_replan' });
      const second = readPlan(rpRes.text);
      if (second.parsed.pages.length === 0) throw new Error('re-plan returned no parseable plan lines');
      if (second.parsed.missing.length > 0) {
        log.warn(`⚠️ [BEATS] Re-plan omitted page(s) ${second.parsed.missing.join(', ')} — first division kept`);
        gl.warn('beats_replan_incomplete', `Re-plan omitted page(s) ${second.parsed.missing.join(', ')} — first division kept`);
      } else {
        const before = new Map(plan.pages.map(p => [p.pageNumber, p.planLine || '']));
        replannedPages = second.parsed.pages
          .filter(p => (before.get(p.pageNumber) || '') !== (p.planLine || ''))
          .map(p => p.pageNumber);
        beats = second.parsed.pages;
        pagePlan = second.pagePlan || pagePlan;
        gl.info('beats_replan', `Planner re-divided ${replannedPages.length} page(s) for ${check1.lines.length} finding(s)`, null, {
          replannedPages, findings: check1.lines.length,
        });
        check2 = await runCheck('plan_recheck', beats, pagePlan);
      }
    } catch (err) {
      // Never block a story on the check: the first division is a complete plan.
      log.warn(`🚨 [BEATS] Re-plan failed (${err.message}) — the first division ships`);
      gl.warn('beats_replan_failed', `Re-plan failed: ${err.message} — the first division ships`);
      beats = plan.pages;
      replannedPages = [];
    }
  }
  meta.timings.planCheckMs = Date.now() - t;

  {
    // Stored under the beatsReviewReport key on purpose: the persistence in
    // storyJobPipeline, the dev-mode diff panels, and the cross-story challenge
    // memory (which reads `data->'beatsReviewReport'->>'arc'`) all key off it.
    // Renaming the key would silently empty a family's challenge history.
    const beforePlan = new Map(plan.pages.map(p => [p.pageNumber, p.planLine || '']));
    const summary = [
      check1.lines.length ? `Findings on the first division:\n${check1.lines.join('\n')}` : 'The first division drew no findings.',
      replannedPages.length ? `\nRe-divided page(s): ${replannedPages.join(', ')}` : '',
      check2 ? `\nFindings after the re-plan:\n${check2.lines.join('\n') || '(none)'}` : '',
    ].filter(Boolean).join('\n');
    beatsReviewReport = {
      check: 'counters+plan-check',
      model: check1.checkModelId || planCheckModel,
      durationMs: meta.timings.planCheckMs,
      arc: plan.arc || '',
      pagePlan,
      analysis: summary,
      counterFindings: check1.counters.lines,
      counterStats: check1.counters.stats,
      cast: check1.counters.cast,
      modelFindings: check1.modelFindings,
      changedPages: replannedPages,
      pages: replannedPages.map(n => ({
        pageNumber: n,
        before: `PLAN: ${beforePlan.get(n) || ''}`,
        after: `PLAN: ${(beats.find(b => b.pageNumber === n) || {}).planLine || ''}`,
      })),
      recheck: check2 ? {
        counterFindings: check2.counters.lines,
        counterStats: check2.counters.stats,
        modelFindings: check2.modelFindings,
      } : null,
      prompt: check1.prompt || '',
      briefsIn: plan.pages.map(x => ({
        pageNumber: x.pageNumber,
        brief: `PLAN: ${x.planLine || ''}`,
      })),
    };
    gl.info('beats_plan_checked', `Division checked: ${check1.lines.length} finding(s), ${replannedPages.length} page(s) re-divided${check2 ? `, ${check2.lines.length} remaining` : ''} (${(meta.timings.planCheckMs / 1000).toFixed(1)}s)`, null, {
      findings: check1.lines.length, replanned: replannedPages.length, remaining: check2 ? check2.lines.length : null,
    });
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
      await stage(18, 'Building the visual contract...', { next: 23, ms: 71000 });
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

  // Deliberately OUTSIDE the bible try/catch: a throw from the caller's hook
  // must abort the run, not be swallowed into "ships with an empty bible".
  if (onVisualBible && visualBible) await onVisualBible(visualBible);

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
    const clothingPrompt = buildClothingReviewPrompt(inputData, clothingRequirements, beats);
    if (!clothingPrompt) {
      gl.warn('beats_clothing_review_failed', 'Clothing review template unavailable — wardrobe shipped unreviewed');
    } else {
      t = Date.now();
      try {
        const cRes = await textModels.callTextModelStreaming(clothingPrompt, null, onChunk, clothingReviewModel, { usageLabel: 'beats_clothing_review' });
        const parsed = parseClothingReview(cRes.text || '');
        meta.timings.clothingReviewMs = Date.now() - t;
        const rewrites = [];
        const stray = [];
        for (const fix of parsed.entries) {
          // Match the character case-insensitively — the reviewer echoes the
          // name back and case drift must not silently drop a correction.
          const name = Object.keys(clothingRequirements)
            .find(n => n.toLowerCase() === fix.name.toLowerCase());
          let entry = name ? clothingRequirements[name]?.[fix.category] : null;
          // Check 9 (coverage) ADDS a category the bible missed: a beat that
          // transforms or costumes a character whose wardrobe has no entry for
          // it. Accepted only in the explicit `costumed:<name>` form — a plain
          // rewrite of an unused category is still stray (hallucination guard).
          if (name && fix.category === 'costumed' && fix.costume && (!entry || !entry.used)) {
            entry = clothingRequirements[name].costumed = {
              ...(clothingRequirements[name].costumed || {}),
              used: true,
              costume: fix.costume,
            };
          }
          if (!entry || !entry.used) { stray.push(`${fix.name}/${fix.category}`); continue; }
          const before = entry.description || '';
          if (before === fix.description) continue;
          entry.description = fix.description;
          rewrites.push({ name, category: fix.costume ? `costumed:${fix.costume}` : fix.category, before, after: fix.description });
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
          model: cRes.modelId || clothingReviewModel,
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
          gl.info('beats_clothing_review', `Wardrobe review by ${cRes.modelId || clothingReviewModel}: ${rewrites.length} outfit(s) rewritten (${(meta.timings.clothingReviewMs / 1000).toFixed(1)}s)`, null, {
            changed: rewrites.map(r => `${r.name}/${r.category}`), model: cRes.modelId || clothingReviewModel,
          });
        }
      } catch (err) {
        meta.timings.clothingReviewMs = Date.now() - t;
        log.warn(`🚨 [BEATS] Clothing review failed (${err.message}) — wardrobe shipped unreviewed`);
        gl.warn('beats_clothing_review_failed', `Reviewer ${clothingReviewModel} failed: ${err.message} — wardrobe shipped unreviewed`);
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
  const imgModelConfig = IMAGE_MODELS[modelOverrides.imageModel || inputData.modelOverrides?.imageModel || MODEL_DEFAULTS.pageRenderImage];
  const availableAvatars = buildAvailableAvatarsForPrompt(inputData.characters || [], clothingRequirements);
  const maxCharactersPerScene = imgModelConfig?.maxCharactersPerScene || 3;

  /**
   * Per-page expansion — the fallback for pages the single call omitted, and
   * the only remaining user of the per-page scene-expansion.txt template here.
   */
  async function expandOnePage(b) {
    // The PLAN line stands in for page.text: in a beats-first run the text
    // does not exist yet, so the Art Director works from the locked plan.
    const pageContent = `PLAN: ${b.planLine || ''}`;
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
        // Decides whether the text-zone rule family is asked for at all.
        story: inputData,
      }
    );
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Own usage label (2026-08-31): fallback pages used to book under
        // 'beats_scene_expansion' like the batch call, so a truncated batch
        // plus silent per-page recovery was invisible in the usage summary
        // (job_1788123310558: 6 calls under one label, no way to tell 1
        // batch + 5 fallbacks from 6 batches).
        const res = await textModels.callTextModelStreaming(prompt, null, onChunk, sceneModel, { usageLabel: 'beats_scene_expansion_fallback' });
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
  // No rulings travel here any more (2026-09-01): the beats reviewer that
  // produced them is gone, and the plan check never rules on anything — it
  // counts, and the planner re-divides. CARRY_ROUTES stays for the Lab.
  const allPrompt = buildSceneExpansionAllPrompt(inputData, beats, {
      visualBible,
      availableAvatars,
      maxCharactersPerScene,
      // The whole story, read-only, for the Art Director's judgment — it
      // stages only what each page's beat and plan line carry.
      finalArc: approvedArc,
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
    // Two attempts at the full batch (2026-08-31): the call already asks for
    // the model's full maxOutputTokens (maxTokens=null), but an incomplete
    // parse — the truncation signature — used to drop straight to the
    // per-page fallback with no batch retry and no stored warning until the
    // shortfall guard below. job_1788123310558 lost pages 12-16 that way
    // (gemini-3.1-pro's configured cap was 16384; raised in models.js).
    // First attempt's pages win the merge so a retry can only FILL gaps,
    // never rewrite pages already parsed.
    let allModelId = sceneModel;
    const byPage = new Map();
    await stage(30, 'Writing scene briefs...', { next: 42, ms: 176000 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      let allRaw = '';
      try {
        const res = await textModels.callTextModelStreaming(allPrompt, null, onChunk, sceneModel, { usageLabel: 'beats_scene_expansion' });
        allRaw = res?.text || '';
        allModelId = res?.modelId || sceneModel;
      } catch (err) {
        log.error(`🚨 [BEATS] All-pages scene expansion attempt ${attempt} failed (${err.message}) — falling back to per-page expansion`);
        gl.warn('beats_scene_expansion_failed', `All-pages call failed on attempt ${attempt}: ${err.message} — falling back to per-page expansion`);
        break;
      }
      const parsed = parseRefinedText(allRaw, beatPageNumbers, 'SCENES');
      for (const p of parsed.pages) {
        if (p.text && p.text.trim() && !byPage.has(p.pageNumber)) byPage.set(p.pageNumber, p.text);
      }
      if (byPage.size >= beats.length) break;
      if (attempt === 1) {
        const missingNow = beats.filter(b => !byPage.has(b.pageNumber)).map(b => b.pageNumber);
        log.error(`🚨 [BEATS] All-pages expansion truncated: ${byPage.size}/${beats.length} briefs parsed (missing page(s) ${missingNow.join(', ')}) — retrying the batch ONCE at full cap`);
        gl.warn('beats_scene_expansion_truncated', `All-pages call returned ${byPage.size}/${beats.length} briefs (missing page(s) ${missingNow.join(', ')}) — retrying the batch once at full output cap`);
      }
    }
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
  let briefUnfixedList = [];
  let briefIntroducedList = [];
  let briefSecondRound = null;
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
  // Hoisted for the post-review re-check below, which needs the same cast list
  // and the pre-review fault set to tell a SURVIVING fault from an INTRODUCED one.
  let briefCastNames = [];
  const briefBeforeByPage = new Map();
  try {
    const { checkScenes: checkBriefs, renderFindingsBlock: renderBriefBlock } = require('./sceneBriefCheck');
    // Secondary characters belong in this list too. `inputData.characters` is the
    // UPLOADED main cast, so a figure the story invents (a mermaid, a shopkeeper)
    // could never trigger cast_unlisted, and briefFindings came back empty on
    // every story we looked at. Verified on staging job_1786743927715_kcx0p939w:
    // the brief's prose describes Lira in full on p3/p4/p9 while its own
    // characters[] lists only Emma and Noah — three findings the review never saw.
    // Secondaries are the likeliest omission, since no avatar pipeline forces
    // them into metadata. Characters only — animals stay out (owner call
    // 2026-08-16). NOTE: this does not cover the OTHER shape of the same
    // symptom — job_1786737619634_d66c7bg9g p4 declared Lira correctly in the
    // brief, and she was dropped later from the stored per-page cast — so the
    // visual-bible `pages` fallback is still load-bearing for that case.
    const secondaryList = Array.isArray(visualBible?.secondaryCharacters)
      ? visualBible.secondaryCharacters
      : Object.values(visualBible?.secondaryCharacters || {});
    const seenCast = new Set();
    const castNames = [
      ...(inputData.characters || []).map(c => c && c.name),
      ...secondaryList.map(c => c && c.name),
    ].filter(Boolean).filter((n) => {
      const k = String(n).trim().toLowerCase();
      if (!k || seenCast.has(k)) return false;
      seenCast.add(k);
      return true;
    });
    briefCastNames = castNames;
    const res = checkBriefs(
      expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief })),
      castNames,
      visualBible,
      { textZoneRules: textZoneRulesActive(inputData) }
    );
    for (const [pn, list] of res.byPage) briefBeforeByPage.set(pn, new Set(list.map(f => f.type)));
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
      await stage(42, 'Reviewing scene briefs...', { next: 51, ms: 132000 });
      const srRes = await textModels.callTextModelStreaming(srPrompt, null, onChunk, sceneReviewModel, { usageLabel: 'beats_scene_review' });
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

      // RE-CHECK the brief faults — on EVERY page, not only the ones that
      // faulted before. This check's failure mode runs the opposite way to
      // clothing's: the reviewer can CREATE a fault while resolving a
      // different one, on a page that was clean when it was handed over.
      //
      // Measured on staging job_1787638394061_hs70901tfsn p1. Pre-review the
      // page carried one fault, cast_unlisted — the prose described a
      // secondary character its own characters[] omitted. The reviewer
      // resolved it exactly as asked, by adding that character to the page —
      // and gave them an interaction row with a second action. The page
      // shipped declaring two actions, on the pipeline whose entire purpose is
      // one, and scored semantic 40. The checks had run once, before the
      // review, so nothing ever looked at the rewrite.
      //
      // Reports, never repairs: the reviewer authored both halves and the
      // owner's 2026-08-11 decision keeps this side advisory. An INTRODUCED
      // fault is the louder of the two — it means the fix instruction itself
      // is producing defects.
      try {
        const { checkScenes: checkBriefs, REVIEWABLE } = require('./sceneBriefCheck');
        const after = checkBriefs(
          expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief })),
          briefCastNames,
          visualBible,
          { textZoneRules: textZoneRulesActive(inputData) }
        );
        // pageNumber 0 is the whole-book text-position tally. It is reported,
        // but it can never drive the targeted second round below — that round
        // re-sends only the faulted PAGES, and rebalancing a distribution means
        // re-sending the whole book at full cost.
        const left = after.findings.filter(f => REVIEWABLE.has(f.type) && f.pageNumber !== 0);
        const bookLevel = after.findings.filter(f => REVIEWABLE.has(f.type) && f.pageNumber === 0);
        if (bookLevel.length > 0) {
          const d = bookLevel.map(f => f.type).join('; ');
          log.warn(`⚠️ [BEATS] text-position distribution after review: ${d}`);
          gl.warn('beats_textzone_distribution', `Text-position distribution still off after the scene review: ${d}`, null, { findings: bookLevel });
        }
        const introduced = left.filter(f => !(briefBeforeByPage.get(f.pageNumber)?.has(f.type)));
        const survived = left.filter(f => briefBeforeByPage.get(f.pageNumber)?.has(f.type));
        briefUnfixedList = left;
        briefIntroducedList = introduced;
        if (introduced.length > 0) {
          const d = introduced.map(f => `p${f.pageNumber} ${f.type}`).join('; ');
          log.warn(`⚠️ [BEATS] brief check after review: ${introduced.length} fault(s) INTRODUCED by the rewrite — ${d}`);
          gl.warn('beats_brief_introduced',
            `The scene review introduced ${introduced.length} new brief fault(s) while rewriting: ${d}`, null, { findings: introduced });
        }
        if (survived.length > 0) {
          const d = survived.map(f => `p${f.pageNumber} ${f.type}`).join('; ');
          log.warn(`⚠️ [BEATS] brief check after review: ${survived.length} fault(s) survived — ${d}`);
          gl.warn('beats_brief_unfixed', `Brief faults survived the scene review: ${d}`, null, { findings: survived });
        }
        if (left.length === 0) log.info('🧩 [BEATS] brief check after review: clean');

        // TARGETED SECOND ROUND (owner, 2026-08-25). Reporting a fault does not
        // stop it shipping, and the page that motivated this — staging
        // job_1787638394061_hs70901tfsn p1 — went out declaring two actions.
        //
        // The briefs ARE the input: 71,030 of the review's ~19,820 input tokens
        // were the 16 briefs, so re-sending only the faulted ones costs roughly
        // an eighth of a full round (~$0.018 against $0.14 measured on that
        // story). buildSceneReviewPrompt already takes a page subset, so there
        // is nothing to change in the builder.
        //
        // Exactly ONE extra round, ever. No loop: whatever survives it is
        // reported and ships, which is the same contract as before, only with
        // one cheap attempt at a fix in between.
        if (left.length > 0) {
          const faultPages = new Set(left.map(f => f.pageNumber));
          const subset = expansions.filter(x => faultPages.has(x.pageNumber));
          const subsetByPage = new Map();
          for (const [pn, list] of after.byPage) if (faultPages.has(pn)) subsetByPage.set(pn, list);
          const { renderFindingsBlock: renderBriefBlock2 } = require('./sceneBriefCheck');
          const rrPrompt = buildSceneReviewPrompt(
            inputData,
            subset.map(x => ({ pageNumber: x.pageNumber, brief: x.brief })),
            { briefFindings: renderBriefBlock2(subsetByPage), beats }
          );
          if (rrPrompt) {
            try {
              const pagesLabel = [...faultPages].sort((a, b) => a - b).join(', ');
              log.info(`🧩 [BEATS] second review round on page(s) ${pagesLabel} (${subset.length}/${expansions.length} briefs)`);
              const rrRes = await textModels.callTextModelStreaming(rrPrompt, null, onChunk, sceneReviewModel, { usageLabel: 'beats_scene_review_r2' });
              const rrParsed = parseRefinedText(rrRes.text || '', subset.map(x => x.pageNumber), 'SCENES');
              const rrByPage = new Map(rrParsed.pages.map(p => [p.pageNumber, p.text]));
              const rrChanged = [];
              for (const x of subset) {
                const fixed = rrByPage.get(x.pageNumber);
                if (fixed && fixed.trim() && fixed !== x.brief) {
                  sceneDiffs.push({ pageNumber: x.pageNumber, before: x.brief, after: fixed, round: 2 });
                  x.brief = fixed;
                  x.reviewRewrote = true;
                  rrChanged.push(x.pageNumber);
                }
              }
              const after2 = checkBriefs(
                expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief })),
                briefCastNames,
                visualBible
              );
              const left2 = after2.findings.filter(f => REVIEWABLE.has(f.type));
              briefUnfixedList = left2;
              briefSecondRound = {
                pages: [...faultPages].sort((a, b) => a - b),
                rewrote: rrChanged,
                before: left.length,
                after: left2.length,
                usage: rrRes.usage || null,
              };
              if (left2.length === 0) {
                log.info(`🧩 [BEATS] second round resolved all ${left.length} fault(s)`);
                gl.info('beats_brief_round2', `Second review round on page(s) ${pagesLabel} resolved all ${left.length} fault(s)`);
              } else {
                const d = left2.map(f => `p${f.pageNumber} ${f.type}`).join('; ');
                log.warn(`⚠️ [BEATS] second round: ${left2.length}/${left.length} fault(s) still present — ${d}`);
                gl.warn('beats_brief_round2_unfixed', `Second review round left ${left2.length} fault(s): ${d}`, null, { findings: left2 });
              }
            } catch (r2Err) {
              log.warn(`⚠️ [BEATS] second review round failed (${r2Err.message}) — faults ship as reported`);
            }
          }
        }
      } catch (rcErr) {
        log.warn(`⚠️ [BEATS] brief re-check failed (${rcErr.message})`);
      }

      sceneReviewReport = {
        model: srRes.modelId || sceneReviewModel,
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
        briefUnfixed: briefUnfixedList,
        briefIntroduced: briefIntroducedList,
        briefSecondRound,
      };
      gl.info('beats_scene_review', `Scene review by ${srRes.modelId || sceneReviewModel}: ${changed.length} brief(s) rewritten (${(meta.timings.sceneReviewMs / 1000).toFixed(1)}s)`, null, {
        changedPages: changed, model: srRes.modelId || sceneReviewModel,
      });
    } catch (err) {
      log.warn(`🚨 [BEATS] Scene review failed (${err.message}) — proceeding with unreviewed briefs`);
      gl.warn('beats_scene_review_failed', `Reviewer ${sceneReviewModel} failed: ${err.message} — briefs shipped unreviewed`);
    }
  }

  // ── Step 6: page text — runs HERE, after the scene review, with the briefs ─
  await stage(51, 'Writing the page text...', { next: 56, ms: 75000 });
  const textResult = await runStoryText(expansions);
  const { textRaw, textModelId, parsedText } = textResult;

  if (parsedText.missing.length > 0) {
    log.warn(`⚠️ [BEATS] Text writer omitted page(s) ${parsedText.missing.join(', ')} after retry — those pages are dropped`);
    gl.warn('beats_text_incomplete', `Text writer omitted page(s) ${parsedText.missing.join(', ')}`);
  }
  // The title: nothing else in a beats run produces one. The writer emits three
  // candidates AND names the one to ship (TITLE_PICK) — it is the only call in a
  // beats run that has the candidates, the brief and the finished pages in one
  // place, which is why the pick lives here instead of in a separate judge call
  // (2026-08-27, owner: "the title can be judged in another prompt"). Without a
  // parseable TITLE_PICK the hash pick stands: stableCandidateIndex is the same
  // deterministic pick the unified parser uses, so cover generation and the
  // story save never diverge on the title.
  const titleSection = (textRaw.match(/---\s*TITLE\s*---\s*([\s\S]*?)(?=---\s*[A-Z])/i) || [])[1] || '';
  const cleanTitle = s => String(s || '')
    .replace(/^\**\s*TITLE\s*:\s*/i, '')
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    .replace(/^"|"$/g, '')
    .trim();
  const titleCandidates = titleSection
    .split('\n')
    .map(l => (l.match(/^\s*\d+[.)]\s*(.+?)\s*$/) || [])[1])
    .filter(Boolean)
    .map(cleanTitle)
    .filter(Boolean);
  // TITLE_PICK: 1-based candidate number + one sentence. Out of range or absent
  // → titleJudge stays null and the hash pick below stands.
  const pickMatch = titleSection.match(/^\s*TITLE_PICK\s*:\s*(\d+)\s*(?:[—–-]\s*(.*))?$/im);
  const pickIdx = pickMatch ? parseInt(pickMatch[1], 10) - 1 : -1;
  const titleJudge = (pickIdx >= 0 && pickIdx < titleCandidates.length)
    ? { pick: pickIdx, reason: String(pickMatch[2] || '').trim(), candidates: titleCandidates }
    : null;
  if (pickMatch && !titleJudge) {
    log.warn(`⚠️ [BEATS] TITLE_PICK ${pickMatch[1]} out of range (${titleCandidates.length} candidates) — falling back to the hash pick`);
  }
  // Fall back to the first non-empty line for a writer that ignored the list
  // format — a run must never lose its title to a format miss.
  const title = titleJudge
    ? titleCandidates[titleJudge.pick]
    : (titleCandidates.length
      ? titleCandidates[stableCandidateIndex(titleCandidates)]
      : (cleanTitle(titleSection.split('\n').find(l => l.trim())) || null));
  gl.info('beats_story_text', `Page text by ${textModelId}: ${parsedText.pages.length} page(s)${title ? ` — "${title}"` : ''}${titleCandidates.length ? ` (from ${titleCandidates.length} candidates${titleJudge ? ', writer-picked' : ''})` : ''} (${(meta.timings.storyTextMs / 1000).toFixed(1)}s)`, null, {
    pages: parsedText.pages.length, title, titleCandidates, titlePick: titleJudge?.pick ?? null, titleReason: titleJudge?.reason || null, model: textModelId,
  });

  /**
   * Page text written from the FINAL ARC and the LOCKED plan lines. Hoisted so it can be started
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
    const textPrompt = buildStoryTextFromBeatsPrompt(inputData, beats, finalExpansions, approvedArc, { arcHints });
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
    // sceneHint carries the page-plan line (the SCENE field's replacement).
    pages.push({
      pageNumber: b.pageNumber,
      text,
      sceneHint: b.planLine || '',
      sceneProse: '',
      characterClothing,
      characters,
    });
    // Same fields startSceneExpansion() resolves with (expandedScenes entries).
    scenes.push({
      pageNumber: b.pageNumber,
      text,
      sceneHint: b.planLine || '',
      sceneDescription,
      sceneDescriptionPrompt: exp?.prompt || null,
      sceneDescriptionModelId: exp?.modelId || sceneModel,
      characterClothing,
      characters,
      outlineCharacters: characters,
      // Marker kept as a sniffable "PLAN:" prefix: storyScorecard, textRefine
      // and the Lab's stored-beats recovery all decide beats-vs-unified mode
      // from this field's shape.
      outlineExtract: `PLAN: ${b.planLine || ''}`,
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
    // Candidates first: UnifiedStoryParser prefers the list and re-picks with
    // TITLE_PICK when present (same 1-based number the writer emitted), else
    // with the same stableCandidateIndex — either way it lands on the title
    // chosen above. TITLE_PICK goes AFTER the `TITLE:` line: the parser's
    // candidate-block regex ends at `TITLE:`, so the pick can never be read as
    // a candidate.
    ...(titleCandidates.length
      ? ['TITLE_CANDIDATES:', ...titleCandidates.map((t, i) => `${i + 1}. ${t}`)]
      : []),
    `TITLE: ${title || '(none)'}`,
    ...(titleJudge ? [`TITLE_PICK: ${titleJudge.pick + 1} — ${titleJudge.reason}`] : []),
    '',
    // Before ---BEATS--- on purpose: every beats extractor keys on that marker
    // with a lookahead to the next section, so a block ahead of it is invisible
    // to them and readable in the outline view.
    ...(plan.arc ? ['---ARC---', plan.arc, ''] : []),
    // The plan and the beats always come from the SAME planner response — a
    // re-plan replaces both — so this map is never stale against the beats below.
    ...(pagePlan ? ['---PAGE PLAN---', pagePlan, ''] : []),
    '---BEATS---',
    beats.map(b => `## Page ${b.pageNumber}\nPLAN: ${b.planLine || ''}`).join('\n\n'),
    '',
    // Marker unchanged on purpose: stored transcripts, storyMetrics and the
    // analysis scripts all key on it. What it holds is now the plan check.
    '---BEATS REVIEW---',
    beatsReviewReport?.analysis || '(no plan check)',
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

  return { title, titleJudge, beats, pages, scenes, rawOutline, meta, arcVarietyExclusions, challengeDraw, arcReviewReport, beatsReviewReport, clothingReviewReport, sceneReviewReport };
}

module.exports = { generateStoryViaBeats, resolvePipelineMode, PIPELINE_MODES, extractChallengeLines, loadPriorChallenges };

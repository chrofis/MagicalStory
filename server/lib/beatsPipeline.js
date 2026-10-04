

const { runPlanCounters, collectPlaceNames, castLostByReplan, reviewPlanChanges, refreshPlanShot, namesIn } = require('./planCounters');
const { commissionedCast, castCoverage, parsePlanCastBlock } = require('./castCoverage');
const { arcRepairFindingsWithCastCheck } = require('./jevAudit');
const jevDecisions = require('./jevDecisions');
const { resolveShotId } = require('./shotVocabulary');
const { salvageReplanRound } = require('./replanSalvage');
// The decided fields of every story page (Jev first, 2026-09-28): a leaf module,
// so a replay or a test can load them without the pipeline's provider graph.
const { decideBriefFields, pinDecidedFields, pageLocations, visualBibleJsonOf } = require('./jevBriefFields');
const { JevDecisionError } = jevDecisions;
const jevSelection = require('./jevSelection');
const { lookupByName } = require('./castResolver');
const { commissionedChildBand, applySecondaryAgeBand } = require('./inventedAgeBand');
const { buildCharacterDescription } = require('./visualBible');

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
 *   1. beats_plan            MODEL_DEFAULTS.outline    PAGE PLAN (one plan line per
 *      page), FROM the approved arc
 *   2. plan_check            counters + one cheap call: arithmetic over the
 *      DIVISION only, then at most ONE re-plan by the planner. No story
 *      checking happens at this layer by design (owner, 2026-09-01)
 *   3. beats_story_bible     MODEL_DEFAULTS.outline    CLOTHING REQUIREMENTS only
 *   4. THE ART DIRECTOR, two calls (owner, 2026-09-28, "Jev first"):
 *      beats_visual_bible    MODEL_DEFAULTS.sceneDescription  the VISUAL BIBLE alone;
 *      then the Jev decision layer fixes every story page's cited elements,
 *      looks, location, aboard, population and gaze (jevBriefFields.js);
 *      beats_scene_expansion MODEL_DEFAULTS.sceneDescription  ONE call over ALL pages
 *      — the covers included, as pages -1/-2/-3 from code-written cover beats
 *      (coverBeats.js) — each story page with its FIXED block
 *   5. beats_brief_reask     MODEL_DEFAULTS.sceneDescription  code checks every brief
 *      (briefChecks.js); the flagged pages go back to the Art Director ONCE.
 *      There is no scene review (deleted 2026-09-28, docs/decisions.md).
 *   6. beats_story_text      MODEL_DEFAULTS.storyText  page text written from the arc + the locked plan lines
 *
 * Model names are NOT written here: every stage above names the
 * server/config/models.js key it resolves from, so this header cannot go
 * stale when a model is swapped. (It had said "Sonnet" for the Art Director
 * for weeks after it moved to gemini-3.1-pro, and sent an investigator to the
 * wrong model.)
 *
 * Scheduling is by data dependency, not by list order:
 *
 *   beats ─> plan check ─> wardrobe ─┬─> styled avatars  (caller-owned, long pole)
 *                                    └─> visual bible ─> Jev fields ─> page briefs
 *                                          ─> brief checks + one re-ask ─> page text
 *
 * Step 6 runs AFTER the brief checks and reads the FINAL briefs (owner decision
 * 2026-08-10: the scenes come first, the text must follow — see the note at the
 * old kickoff site below). Styled avatars need only clothingRequirements, so
 * they start the instant step 3 returns (via opts.onClothingRequirements) and
 * overlap everything after it — page images await briefs AND avatars, both in
 * server.js, unchanged.
 *
 * Step 7 (text_refine) already runs downstream in server.js and is untouched.
 *
 * Every builder/parser here is the same one the Test Lab's `beats_scenes` stage
 * uses (server/lib/testlab.js → runBeatsScenesStage); that stage stays the
 * measurement harness, this module is the production wiring.
 *
 * Steps 3 and 4 together close the gap the unified call used to cover. The
 * split of authorship is deliberate (owner, 2026-09-11):
 *  - Step 3 writes the CLOTHING REQUIREMENTS, and only those. Styled avatars
 *    are the long pole in front of every image and start the moment it returns,
 *    so the wardrobe cannot wait for the Art Director. Clothing depends on the
 *    cast and the setting, both already fixed by the plan.
 *  - Step 4 — the ART DIRECTOR — writes the VISUAL BIBLE ahead of page 1, then
 *    the page briefs, the cover pages' among them. One author owns both what is
 *    in each picture and what each thing looks like, so the two cannot
 *    contradict each other, and a page's `objects[]` cannot name an entry that
 *    was never declared. Before this, step 3 had to GUESS page assignment from
 *    plan-line prose and on job_1789147573901_m3uam0nxi the guess emptied the
 *    story's central prop and the lettered signpost page 10 then asked for.
 *  - DOWNSTREAM: the raw sections from both steps are concatenated into
 *    `rawOutline` — which server.js feeds to UnifiedStoryParser as
 *    `unifiedResponse` — in the SAME section format and order the unified
 *    writer used, so extractClothingRequirements(), extractVisualBible() and
 *    extractCoverHints() work with no parsing change.
 *
 * If either call fails the run still completes, degraded (blind briefs, empty
 * VB, null clothing, default front-cover hint) rather than aborted. The
 * per-page fallback (expandOnePage) cannot author a whole-book bible and does
 * not try: it reuses whatever the all-pages call produced, and with nothing at
 * all it expands blind — the same degradation a failed bible stage always had.
 */

const textModels = require('./textModels');
const { MODEL_DEFAULTS, IMAGE_MODELS, TEXT_MODELS } = require('../config/models');
const {
  buildBeatsPrompt,
  buildArcCreatePrompt,
  buildArcPanelPrompt,
  buildArcRetellPrompt,
  buildArcHintsPrompt,
  parseArcHints,
  parseArcCreate,
  parseArcRetell,
  filterPanelFindings,
  splitCommittedBlock,
  arcInventedAllowance,
  arcShapeCounts,
  critiqueMaxSeverity,
  buildPlanCheckPrompt,
  parsePlanCheck,
  parsePlanCheckRoster,
  parsePlanCheckObstacles,
  parsePlanCheckPeoplelessPick,
  parsePlanCheckCentralPages,
  parsePlanCheckWanted,
  parsePlanCheckActions,
  replanKeepPages,
  buildReplanSection,
  parsePlanChanges,
  replanRank,
  countsTowardConvergence,
  replanRoundConverged,
  replanRoundRegressed,
  findingPages,
  buildClothingReviewPrompt,
  parseClothingReview,
  parsePlanResponse,
  pickMainCharacters,
  buildSceneExpansionPrompt,
  buildVisualBibleCallPrompt,
  buildSceneBriefsAllPrompt,
  buildStoryTextFromBeatsPrompt,
  buildStoryBibleFromBeatsPrompt,
  parseRefinedText,
  BRIEF_TRAILING_MARKERS,
  buildAvailableAvatarsForPrompt,
  extractSceneMetadata,
  stripTrailingSeparator,
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
  // 'unified' is TRIAL-ONLY since 2026-09-15: the pre-beats unified writer
  // (buildUnifiedStoryPrompt + prompts/story-unified*.txt) was deleted, so a
  // non-trial job has no single-call writer to run. Anything unrecognised — and
  // an explicit non-trial 'unified' — resolves to beats.
  if (!PIPELINE_MODES.includes(mode)) {
    log.warn(`[BEATS] Unknown pipelineMode "${raw}" — falling back to 'beats'`);
    return 'beats';
  }
  if (mode === 'unified') {
    log.warn(`[BEATS] pipelineMode 'unified' is trial-only (the unified writer was deleted) — running beats`);
    return 'beats';
  }
  return mode;
}

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {}, setStage: () => {} };

/**
 * The three sections the unified writer used to emit alongside the story, and
 * that UnifiedStoryParser still looks for in `unifiedResponse`:
 * extractClothingRequirements / extractVisualBible / extractCoverHints.
 * Spelling and spacing are the parser's regexes — do not "tidy" them.
 *
 * TWO AUTHORS since 2026-09-11. The wardrobe stage writes the first marker
 * (the styled avatars start the moment it returns and cannot wait); the
 * ALL-PAGES Art Director writes the other two, ahead of page 1, so no page can
 * cite an element that was never declared. beatsPipeline concatenates the two
 * bodies in this order, which is the order the transcript has always carried.
 */
const BIBLE_MARKERS = ['---CLOTHING REQUIREMENTS---', '---VISUAL BIBLE---'];
const CLOTHING_MARKERS = ['---CLOTHING REQUIREMENTS---'];
const AD_BIBLE_MARKERS = ['---VISUAL BIBLE---'];

/**
 * Strip any preamble the model wrote before the first section marker, and
 * everything from the first thing that ENDS the section block: a stray
 * ---STORY PAGES--- it invented, or (the Art Director's response) the real
 * `## Page N` heading that starts the briefs. Both matter because neither
 * terminates the cover-hints regex, so leaving them in would swallow the whole
 * story into the cover hints once this block is spliced into the transcript.
 *
 * @param {string} raw
 * @param {string[]} [markers] - which section markers this caller expects.
 * @returns {{body: string, found: string[]}|null} null when no expected marker exists at all.
 */
function extractBibleSections(raw, markers = BIBLE_MARKERS) {
  const text = String(raw || '');
  const positions = markers.map(m => text.indexOf(m));
  const present = positions.filter(i => i >= 0);
  if (present.length === 0) return null;

  let body = text.slice(Math.min(...present)).trim();
  const ends = [
    body.search(/---\s*STORY PAGES\s*---/i),
    // `-?`: a cover page carries a negative number (coverKeys.COVER_PAGE_NUMBERS).
    body.search(/^\s*#{1,4}\s*\**\s*(?:Page|Seite|Pagina)\s*\**\s*-?\d+/im),
  ].filter(i => i >= 0);
  if (ends.length) body = body.slice(0, Math.min(...ends)).trim();
  if (!body) return null;

  return { body, found: markers.filter(m => body.includes(m)) };
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

/**
 * Write the in-memory bible's page assignment (and the invented-peer age clamp)
 * back into the ---VISUAL BIBLE--- JSON of a bible transcript.
 *
 * Same reason as replaceClothingSection: mutating the parsed object is NOT
 * enough. `bibleSections` is spliced into `rawOutline`, storyJobPipeline
 * re-parses the bible out of that text (`parser.extractVisualBible()`), the
 * resume path and the Lab's `plainStoredBeats` re-parse `data.outline` again —
 * so every in-memory mutation done here reached exactly the Art Director and
 * nobody else. Measured on job_1788957347999_ijseol49a: `vbAssignmentTrim`
 * reported VEH002 stripped from pages 8 and 18, the stored bible and outline
 * still listed both, and the scene review's `vb_element_overflow` on those
 * pages survived every reviewer (Lab 1157/1179).
 *
 * The transcript JSON is the WRITER's shape (`pages`, raw `states`, `age`),
 * and the parser's is a superset built by spreading it, so the projection is a
 * field-by-field copy of exactly what the post-checks may change, matched by
 * entry id: `pages` from `appearsInPages`; each state's `pages` (a state left
 * without a page is gone from the array — `normaliseObjectStates` re-mints the
 * dotted ids identically on re-parse); a clamped secondary's `age` plus its
 * `secondaryAgeClamped` record. Entries the parser dropped (a real landmark
 * staged on no page) are left as written. Nothing else in the JSON is touched.
 *
 * @returns {string} the transcript with the section rewritten, or unchanged
 *   when there is no parseable section (the caller warns and keeps shipping).
 */
const SYNCED_COLLECTIONS = ['secondaryCharacters', 'animals', 'artifacts', 'vehicles', 'locations', 'clothing'];
function syncVisualBibleSection(bibleSections, visualBible) {
  const text = String(bibleSections || '');
  if (!text || !visualBible || typeof visualBible !== 'object') return text;
  const sectionRe = /(---VISUAL BIBLE---\s*)([\s\S]*?)(?=---[A-Z\s]+---|$)/i;
  const section = text.match(sectionRe);
  if (!section) return text;
  const jsonMatch = section[2].match(/```json\s*([\s\S]*?)```/i);
  if (!jsonMatch) return text;
  let json;
  try { json = JSON.parse(jsonMatch[1]); } catch { return text; }
  if (!json || typeof json !== 'object') return text;

  const pageList = (arr) => (Array.isArray(arr) ? arr : []).map(Number).filter(Number.isFinite);
  for (const key of SYNCED_COLLECTIONS) {
    const raw = json[key];
    const parsed = visualBible[key];
    if (!Array.isArray(raw) || !Array.isArray(parsed)) continue;
    const byId = new Map(parsed.filter(e => e && e.id).map(e => [String(e.id).trim().toUpperCase(), e]));
    for (const entry of raw) {
      if (!entry || !entry.id) continue;
      const mem = byId.get(String(entry.id).trim().toUpperCase());
      if (!mem) continue;
      entry.pages = pageList(mem.appearsInPages);
      // States are projected whenever the parsed copy has them — including
      // an entry the Art Director authored WITHOUT states[] that a later step
      // (the scene review's bible correction) gave looks to. Gated on the
      // authored entry already carrying states, the new looks never reached
      // the transcript (staging job_1790446348343_z3fw660ie, ART003).
      if (Array.isArray(mem.states) && (Array.isArray(entry.states) || mem.states.length > 0)) {
        entry.states = mem.states.map(st => ({
          name: st.name,
          delta: st.delta,
          pages: pageList(st.pages),
          ...(typeof st.held === 'boolean' ? { held: st.held } : {}),
        }));
      }
      // The authored English label (and the code repair that replaced it) is
      // a mutation like any other: unprojected, every later re-parse reads the
      // bible WITHOUT it and the page prompt falls back to `type` — the
      // duplicate-`tool` defect this label exists to end.
      if (mem.label) entry.label = mem.label;
      if (mem.labelRepaired) entry.labelRepaired = mem.labelRepaired;
      if (key === 'secondaryCharacters' && mem.secondaryAgeClamped) {
        entry.age = mem.age;
        entry.secondaryAgeClamped = mem.secondaryAgeClamped;
      }
      // Declared lettering (the brief re-ask's text lane, required_text_undeclared):
      // a withdrawn declaration is null in the parsed copy and leaves the transcript too.
      if (Object.prototype.hasOwnProperty.call(mem, 'text')) {
        if (typeof mem.text === 'string' && mem.text) entry.text = mem.text;
        else delete entry.text;
      }
      // The landmark photo citation — on the location and on each vantage. The
      // plates are painted from the photo it cites (b881cd2c1); the review's
      // [landmark_photo_mismatch] correction lands here.
      if (key === 'locations') {
        if (Object.prototype.hasOwnProperty.call(mem, 'landmarkPhoto')) entry.landmarkPhoto = mem.landmarkPhoto;
        const memVantages = new Map((Array.isArray(mem.vantages) ? mem.vantages : [])
          .filter(v => v && v.id).map(v => [String(v.id).trim().toUpperCase(), v]));
        for (const v of (Array.isArray(entry.vantages) ? entry.vantages : [])) {
          const mv = v && v.id ? memVantages.get(String(v.id).trim().toUpperCase()) : null;
          if (mv && Object.prototype.hasOwnProperty.call(mv, 'landmarkPhoto')) v.landmarkPhoto = mv.landmarkPhoto;
        }
      }
    }
  }

  const body = '```json\n' + JSON.stringify(json, null, 2) + '\n```\n\n';
  return text.replace(sectionRe, (_m, marker) => `${marker}${body}`);
}

/**
 * ONE fed-back round over the Visual Bible's element labels.
 *
 * Every element needs one authored English `label`: it is the only handle the
 * page prompt has on it (ids never reach an image model). On
 * job_1789301291267_ueh8h145m two artifacts both typed "tool", so REQUIRED
 * OBJECTS read `**tool** (object)` twice and the model could not tell the two
 * props apart.
 *
 * The shape is the canonical fed-back retry (worn-state round, landmark
 * minimum-2): a deterministic check names the faults, the AUTHOR gets exactly
 * one extra round to fix the ids it faulted on, and whatever survives is
 * repaired in code. Never a kill and never a second model round — a naming
 * guideline must not end a paid run.
 *
 * @param {object} visualBible mutated in place
 * @param {{model: string, language?: string, gl: object, log: object, stageReport?: object}} opts
 * @returns {Promise<{round: number, findings: number, repairedByModel: number, repairedByCode: number, unresolved: string[]}>}
 */
async function runVisualBibleLabelRound(visualBible, { model, language, gl, log: logger = log, stageReport } = {}) {
  const { validateLabels, repairLabels } = require('./vbLabel');
  const report = { round: 0, findings: 0, repairedByModel: 0, repairedByCode: 0, unresolved: [] };

  let findings = [];
  try { findings = validateLabels(visualBible) || []; } catch { findings = []; }
  if (!findings.length) {
    if (stageReport) stageReport.labelRound = report;
    return report;
  }
  report.findings = findings.length;

  const faulted = new Set(findings.map(f => String(f.id).trim().toUpperCase()));
  const byId = new Map();
  for (const key of SYNCED_COLLECTIONS) {
    for (const entry of (Array.isArray(visualBible?.[key]) ? visualBible[key] : [])) {
      const id = String(entry?.id ?? '').trim().toUpperCase();
      if (id && faulted.has(id)) byId.set(id, entry);
    }
  }

  const before = new Map([...byId].map(([id, e]) => [id, String(e.label ?? '')]));

  try {
    const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
    const template = PROMPT_TEMPLATES.vbLabelRepair;
    if (!template) throw new Error('vb-label-repair template unavailable');

    const block = findings.map(f => `- ${f.id}: ${f.detail}`).join('\n');
    const entries = [...byId.entries()].map(([id, e]) => ({
      id,
      label: String(e.label ?? ''),
      name: e.name ?? null,
      type: e.type ?? null,
      description: e.extractedDescription || e.description || null,
    }));
    const prompt = fillTemplate(template, {
      LABEL_FINDINGS: block,
      LABEL_ENTRIES: JSON.stringify(entries, null, 2),
      STORY_LANGUAGE: language || '',
    });

    // maxTokens null = the model's own maximum (owner rule: no output caps).
    const res = await textModels.callTextModelStreaming(prompt, null, null, model, { usageLabel: 'beats_vb_label_repair' });
    if (res?.truncation?.suspected) throw new Error(`reply ${textModels.describeTruncation(res.truncation)}`);

    const parsed = require('./storyHelpers').extractJsonFromText(res?.text || '');
    const rows = Array.isArray(parsed?.labels) ? parsed.labels : [];
    for (const row of rows) {
      const id = String(row?.id ?? '').trim().toUpperCase();
      const label = String(row?.label ?? '').trim();
      // ONLY the ids that faulted, and ONLY the label field.
      if (!label || !byId.has(id)) continue;
      byId.get(id).label = label;
    }
    report.round = 1;
  } catch (err) {
    logger.warn(`⚠️ [BEATS] Visual Bible label round failed (${err.message}) — repairing ${findings.length} label fault(s) in code`);
  }

  let after = [];
  try { after = validateLabels(visualBible) || []; } catch { after = []; }
  report.repairedByModel = [...byId.keys()].filter(id => !after.some(f => String(f.id).trim().toUpperCase() === id)
    && String(byId.get(id).label ?? '') !== before.get(id)).length;

  let repair = { repaired: [], unresolved: [] };
  if (after.length) repair = repairLabels(visualBible, after);
  report.repairedByCode = repair.repaired.length;
  report.unresolved = repair.unresolved;

  if (repair.unresolved.length) {
    visualBible.labelUnresolved = repair.unresolved;
    logger.warn(`⚠️ [BEATS] Visual Bible label(s) still faulty after the fed-back round and the code repair: ${repair.unresolved.join(', ')} — shipping flagged`);
    gl?.warn?.('beats_vb_label_unresolved',
      `Element label(s) unresolved after one author round and the code repair: ${repair.unresolved.join(', ')}`,
      null, { unresolved: repair.unresolved, findings: report.findings });
  } else {
    logger.info(`🏷️ [BEATS] Visual Bible labels: ${report.findings} fault(s) — ${report.repairedByModel} fixed by the author, ${report.repairedByCode} by code`);
    gl?.info?.('beats_vb_label_round',
      `Element labels: ${report.findings} fault(s) resolved (${report.repairedByModel} by the author, ${report.repairedByCode} by code)`,
      null, { findings: report.findings });
  }

  if (stageReport) stageReport.labelRound = report;
  return report;
}

// ── Cross-story challenge memory ────────────────────────────────────────────
// A family buys several books. Nothing used to stop the planner giving them the
// same challenge twice (the lost thing found, the storm crossed, the rival
// out-argued) — every run starts from the same commission shape with no memory
// of what the account already owns.
//
// VARIETY IS A SELECTION RULE, NOT A PROMPT INSTRUCTION (owner, 2026-09-19).
//
// The first design read the previous books' ARCS, pulled their numbered
// challenge lines out as prose, and pasted them into the arc prompt under "This
// reader's earlier books used these challenges — this story uses different
// ones". Two things were wrong with that, both measured on staging
// job_1789759147125_p08djwhbl:
//
//   1. It told the creator to avoid the commission. The nine injected lines
//      were "The cooling egg and Levin's indecision about where to warm it",
//      "Four strangers, one egg — agree or lose the time" — which IS the
//      premise the family had just commissioned. Nothing gave the commission
//      precedence over the exclusion list.
//   2. It leaked other books into this one. The lines carried their own stories'
//      cast by name (Tobias, Ramon, Zünsli) into a prompt that forbids inventing
//      figures, and into whose CHARACTER DETAILS those names do not appear.
//
// So the exclusion moved off the prompt and onto the DRAW. We record which
// catalogue ids each book TOOK, and the next book's draw filters them out — it
// simply never sees them. No prompt anywhere mentions a previous story, and
// there is no instruction for the creator to misread.
// How many earlier books the draw may remember. Raised 3 -> 12 (2026-09-20)
// once the exclusion stopped being all-or-nothing: the draw sheds the OLDEST
// book's ids one book at a time until its pool clears the floor, so offering
// more books costs nothing — an unaffordable one is simply dropped instead of
// collapsing the whole memory.
//
// TAKEN, NOT OFFERED (owner, 2026-09-21; shipped 2026-09-27). Excluding the 25
// ids a book was OFFERED capped the memory by band (3-5: ~3 books); a book
// takes ~3-5 challenges, so 12 books exclude at most ~60 ids and every band
// keeps the full 12 (3-5: 139 eligible). THIS number is the binding limit.
// Every story's generationLog records effective-vs-contributing, so the
// ceiling stays measured rather than assumed.
const PRIOR_STORY_LIMIT = 12;

/**
 * The challenge-catalogue ids this account's previous books actually TOOK.
 *
 * TAKEN, NOT OFFERED (owner, 2026-09-21, confirmed 2026-09-27 with the Jev
 * draw). A challenge that was drawn and never used never reached a reader, so
 * there is nothing to avoid repeating; excluding it burns catalogue — and,
 * since the Jev draw offers 12 of the 20 best fits, it would have removed the
 * best-fitting entries from the next book's window, decaying the draw book by
 * book (docs/decisions.md 2026-09-27 "Jev picks the challenges…", account-
 * memory table).
 *
 * Reads the DB directly (same lazy `require('../services/database')` every other
 * lib module uses) rather than threading a pool through the caller: the query
 * needs nothing storyJobPipeline has that jobId does not already resolve, and a
 * new parameter would have to be plumbed through server.js and the Test Lab too.
 *
 * `data->'challengeTakenIds'` doubles as the completeness filter — a book that
 * never got as far as an arc reporting its choices has nothing to contribute,
 * and story_jobs rows are pruned, so joining on job status would silently drop
 * the older books that matter most here.
 *
 * No fallback to the drawn ids: a second path reading the weaker column would
 * hide a broken tag contract forever. Books before 2026-09-20 recorded no taken
 * ids and contribute nothing.
 *
 * Never throws: a failed lookup means the draw runs unfiltered, which is exactly
 * what happened before any of this existed.
 *
 * Returned GROUPED BY BOOK, NEWEST FIRST (the SQL's `created_at DESC` ordering
 * is the grouping's meaning, so it is preserved all the way to the caller). The
 * draw sheds from the old end when the pool cannot carry the whole list, which
 * it can only do if it knows where one book's ids end and the next begin.
 *
 * `examined` is every prior book the query matched; `stories` is how many of
 * them contributed any id. They differ when a book completed with an empty taken
 * list — the silent-failure mode this depends on not happening — so the gap is
 * reported, never swallowed.
 *
 * @returns {Promise<{idsByStory: number[][], stories: number, examined: number}>}
 */
async function loadUsedChallengeIds(jobId, gl = NOOP_LOG) {
  if (!jobId) return { idsByStory: [], stories: 0, examined: 0 };
  try {
    const { dbQuery } = require('../services/database');
    const rows = await dbQuery(
      `SELECT s.id, s.data->'challengeTakenIds' AS ids
         FROM stories s
        WHERE s.user_id = (SELECT user_id FROM story_jobs WHERE id = $1)
          AND s.id <> $1
          AND jsonb_typeof(s.data->'challengeTakenIds') = 'array'
          -- Same story TYPE only (2026-08-27): the smoke account mixes toddler
          -- and standard books, and the age bands a draw is filtered by differ
          -- between them, so a toddler book's ids would exclude entries a
          -- standard book's draw never had access to in the first place.
          AND s.data->>'storyType' IS NOT DISTINCT FROM (SELECT input_data->>'storyType' FROM story_jobs WHERE id = $1)
        ORDER BY s.created_at DESC
        LIMIT ${PRIOR_STORY_LIMIT}`,
      [String(jobId)]
    );
    const idsByStory = [];
    const examined = (rows || []).length;
    const emptyStoryIds = [];
    for (const row of rows || []) {
      const own = [...new Set((Array.isArray(row.ids) ? row.ids : []).map(Number).filter(Number.isFinite))];
      if (own.length) idsByStory.push(own);
      else emptyStoryIds.push(row.id);
    }
    // A book that stored an EMPTY taken list contributes nothing, and a run
    // whose memory is silently empty must be visible in the story's own log
    // rather than looking identical to "this account has no earlier books".
    if (emptyStoryIds.length) {
      log.warn(`⚠️ [BEATS] ${emptyStoryIds.length}/${examined} earlier book(s) stored an empty challengeTakenIds — they contribute no cross-story memory`);
      gl.warn('arc_variety_empty_prior', `${emptyStoryIds.length} of ${examined} earlier book(s) recorded no challenges taken — no memory from them`, null, { emptyStoryIds });
    }
    return { idsByStory, stories: idsByStory.length, examined };
  } catch (err) {
    log.warn(`⚠️ [BEATS] Prior-challenge lookup failed (${err.message}) — challenges drawn without cross-story memory`);
    gl.warn('arc_variety_failed', `Prior-challenge lookup failed: ${err.message}`);
    return { idsByStory: [], stories: 0, examined: 0 };
  }
}

/**
 * A drawn-but-nothing-taken arc is a BROKEN CONTRACT, not a quiet edge case.
 *
 * The taken ids are the whole of the next book's cross-story memory. The arc
 * that ships reports them — the created arc when the re-telling gate stays
 * shut, else the last re-telling — each in its "Challenges taken:" block
 * (CHALLENGES_TAKEN_RULE). If that block is missing, or its [C###] tags do not
 * survive, this book contributes nothing and the next book's exclusion silently
 * becomes "exclude nothing". A draw WAS made and an arc WAS written from it, so
 * a block with no tagged line cannot be correct. A block whose every line is
 * [own] (`tagged` > 0, no id) is a valid answer: the arc used none of the draw.
 *
 * @param {{tagged?: number}} opts - how many block lines carry [C###] or [own]
 *   (parseChallengesTaken); defaults to the id count
 * @returns {boolean} true when the contract was broken (and reported)
 */
function reportChallengeMemoryBreach(jobId, challengeDrawIds, challengeTakenIds, gl = NOOP_LOG, { tagged = null } = {}) {
  const drawn = Array.isArray(challengeDrawIds) ? challengeDrawIds.length : 0;
  const taken = Array.isArray(challengeTakenIds) ? challengeTakenIds.length : 0;
  if (!drawn || taken || (tagged ?? 0) > 0) return false;
  log.error(`❌ [ARC] The shipped arc named no challenges taken though ${drawn} were drawn — this book contributes NOTHING to cross-story challenge variety`);
  gl.error('arc_challenges_taken_missing', `The shipped arc reported no [C###] challenge taken though ${drawn} were drawn — this story adds no cross-story variety memory`, null, {
    jobId: jobId || null, challengeDrawIds: challengeDrawIds || [],
  });
  return true;
}

/**
 * THE REPORT DESCRIBES THE DIVISION THAT SHIPPED (2026-09-18).
 *
 * The re-plan loop may run a round and then throw it away — the must-fix count
 * did not fall, a guard caught a corrupt return, or the call failed. Until this
 * function existed the canonical report fields were written from the LAST
 * round's variables regardless: `changedPages` accumulated every round's pages
 * including the discarded one, and `recheck` held the discarded round's
 * findings. Measured on staging job_1789681157795_wkt20ckod: round 1 re-divided
 * 4 pages and its recheck found 9; round 2 re-divided 14 and was discarded; the
 * row reported 14 pages and 7 findings, so every reader of the row concluded
 * the shipped plan had faults it does not have, on pages it never touched.
 *
 * The rounds are a ledger and this derives the shipped view from it: the union
 * of the KEPT rounds' pages, the LAST kept round's recheck, and every round
 * that did not ship under `discardedRounds` — never dropped, because a
 * discarded round is the diagnostic evidence for why the loop stopped.
 *
 * @param {Array<{round:number, changedPages?:number[], recheck?:Object|null, kept:boolean, discardReason?:string}>} rounds
 * @returns {{changedPages:number[], recheck:Object|null, discardedRounds:Array<{round:number, reason:string, changedPages:number[], recheck:Object|null, replanPrompt:string}>, replanPrompts:Array<{round:number, prompt:string}>}}
 */
function shippedReplanState(rounds = []) {
  const changed = new Set();
  let recheck = null;
  const discardedRounds = [];
  // What the SHIPPED division's rounds said they changed, and which of those
  // the review refused. A removal used to be recorded nowhere (2026-09-18).
  const declaredChanges = [];
  const changeRefusals = [];
  const replanPrompts = [];
  const replanReplies = [];
  for (const r of (rounds || [])) {
    if (!r) continue;
    if (r.kept) {
      for (const n of (r.changedPages || [])) changed.add(Number(n));
      for (const line of (r.declaredChanges || [])) declaredChanges.push({ round: r.round, line });
      // THE PROMPT THE RE-PLAN ACTUALLY READ (2026-09-20). `plannerPrompt` is
      // the FIRST-DIVISION prompt; the re-plan prompt is the only one that
      // carries `## MUST FIX` / `## ALSO NOTED`, and it was stored nowhere, so
      // answering "what was this round asked to fix" meant rebuilding
      // buildReplanSection at the run's commit. Same gap `plannerPrompt` closed,
      // one level down. Shaped like `declaredChanges`: one entry per kept round.
      if (r.replanPrompt) replanPrompts.push({ round: r.round, prompt: r.replanPrompt });
      if (r.replanReply) replanReplies.push({ round: r.round, reply: r.replanReply });
      for (const ref of (r.changeRefusals || [])) changeRefusals.push({ round: r.round, ...ref });
      // The recheck that measured the division now standing. A later kept round
      // supersedes an earlier one; a discarded round never does.
      recheck = r.recheck || null;
    } else {
      discardedRounds.push({
        round: r.round,
        reason: r.discardReason || 'discarded',
        changedPages: r.changedPages || [],
        recheck: r.recheck || null,
        // A discarded round is the diagnostic evidence for why the loop
        // stopped, so it keeps the prompt it was given like a kept round does.
        replanPrompt: r.replanPrompt || '',
        replanReply: r.replanReply || '',
      });
    }
  }
  return { changedPages: [...changed].sort((a, b) => a - b), recheck, discardedRounds, declaredChanges, changeRefusals, replanPrompts, replanReplies };
}

// ── THE ARC CREATOR'S CALL, SHARED WITH THE TEST LAB ───────────────────────
// Moved out of generateStoryViaBeats on 2026-09-27 so the Lab's arc replays
// make the creator call the run makes (one retry, a truncated reply is a failed
// attempt). `onCall` hands the Lab each reply; the run passes none.

/** OpenRouter/xAI take a temperature; the Anthropic path sends none. */
function arcTempFor(model, temp) {
  return (temp == null || TEXT_MODELS[model]?.provider === 'anthropic') ? {} : { temperature: temp };
}

/** Creator-side call: one retry, then throw — the creator is not advisory. */
// `model` and `effort` are this call's (MODEL_DEFAULTS.arcCreateModel +
// arcCreateEffort, or arcRetellModel + arcRetellEffort); null max_tokens =
// the model's own ceiling.
function makeArcCreatorCall(onChunk, onCall = null) {
  return async (prompt, label, model, temp, effort) => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await textModels.callTextModelStreaming(prompt, null, onChunk, model, { usageLabel: label, ...arcTempFor(model, temp), ...(effort ? { effort } : {}) });
        if (onCall) onCall(res);
        if (!String(res?.text || '').trim()) throw new Error('empty response');
        // A cut arc parses as a shorter arc (missing critique lines, a short
        // chain) — treat it as a failed attempt, never as the creator's answer.
        if (res.truncation?.suspected) throw new Error(`reply ${textModels.describeTruncation(res.truncation)}`);
        return res;
      } catch (err) {
        lastErr = err;
        log.warn(`⚠️ [ARC] ${label} attempt ${attempt} failed: ${err.message}`);
      }
    }
    throw new Error(`${label} failed after retry: ${lastErr?.message || 'unknown error'}`);
  };
}

// ── STEP 2 OF THE BEATS PIPELINE, SHARED WITH THE TEST LAB ─────────────────
// The plan check (counters + the one model call) and the re-plan rounds, moved
// verbatim out of generateStoryViaBeats on 2026-09-27 so the Lab's
// beats_replan stage runs the rounds production runs (owner: "The Lab must use
// 100% identical code to production"). The stage used to rebuild the check,
// one round and its guard itself — without the CAST table on the re-plan, the
// arc's invented / commissioned figures, the checker's PEOPLELESS pick, the
// review of declared changes and the second round.
// `labPromptOptions` carries a Test Lab A/B prompt knob (plannerMayAddDeeds)
// and `onCall` hands the Lab each model reply (its cost report); the run
// passes neither.

/**
 * One planner response -> its PAGE PLAN text and its parsed beats, for the
 * first division and every re-plan alike (shared with the Test Lab).
 */
function makePlanReader(expected, approvedArc) {
  return (raw) => {
    const parsed = parsePlanResponse(String(raw || ''), expected);
    // The approved arc is the story; the planner does not author one.
    parsed.arc = approvedArc || '';
    return { parsed, pagePlan: parsed.pagePlan };
  };
}

/**
 * The counter inputs of the plan check: the commissioned cast (the character
 * list plus the figures the arc tagged commissioned), the place names that
 * can never be cast, the page cast ceiling and the check model.
 */
function planCheckInputs(inputData, { arcPremiseNames = [], modelOverrides = {} } = {}) {
  // The character list PLUS the figures the premise supplied (the arc reports
  // them; see `arcPremiseNames`). A pet the commission named is commissioned.
  //
  // ONE definition, shared with the Test Lab replay (castCoverage.commissionedCast):
  // `listed` is the character list — the characters that owe the book a focal
  // page and the castCoverage() appearance floor — and `all` adds the figures
  // the commission supplied elsewhere, which are never invented.
  const commission = commissionedCast(inputData, arcPremiseNames);
  const commissionedNames = commission.all;
  if (arcPremiseNames.length) log.info(`👪 [BEATS] Figures the arc tagged (commissioned), counted as commissioned: ${arcPremiseNames.join(', ')}`);
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
  return { commission, commissionedNames, placeNames, maxCast, planCheckModel };
}

/**
 * Counters (free, deterministic) + the one model call. Never throws: the
 * model half is advisory, and a lost call leaves the counters standing alone
 * rather than skipping the check entirely.
 */
// MODEL FIRST, COUNTERS SECOND (2026-09-11). The counters used to run first
// and their lines were shown to the model for reference. They cannot run
// first any more: who is on a page is a question about English, the model
// call answers it as a ROSTER, and the counters do arithmetic on that answer
// instead of re-deriving the cast from the prose with a grammar heuristic.
function createPlanCheckRunner({ inputData, approvedArc, arcHints, arcStoryLogic, arcCentralFigure, castTable, commission, commissionedNames, placeNames, maxCast, arcInventedNames, arcInventedLimit, mainName, planCheckModel, onChunk, gl, labPromptOptions = {}, onCall = null }) {
  // The counters over one division's parsed check facts — shared by the real
  // check below and `compose` (a division mixing two checks' pages, judged
  // without a model call: replanSalvage.js).
  const countersFor = (pages, p) => runPlanCounters({ pages, commissionedNames, listedNames: commission.listed, placeNames, maxCharactersPerScene: maxCast, declaredInvented: arcInventedNames, inventedAllowance: arcInventedLimit, roster: p.roster, peoplelessPick: p.peoplelessPick, centralFigure: arcCentralFigure, centralPages: p.centralPages, mainName, castTable, actions: p.actions, legacyShots: !!labPromptOptions.legacyShots });
  const structure = (counters, modelFindings) => [
    ...counters.findings.map((f, i) => ({ kind: 'counter', code: f.code, line: counters.lines[i] })),
    ...modelFindings.map(f => ({ kind: 'check', check: f.check, line: `CHECK[${f.check}]: ${f.text}` })),
  ];
  const run = async (label, pages, planText) => {
    let modelFindings = [];
    let roster = null;
    // The check's OBSTACLES block: per page, the character whose action that
    // page's instant works against (plan-check Q11). It is the declared
    // evidence a re-plan's removal is judged against — a figure the arc gives a
    // moment of their own is not a figure a page may quietly drop — so it is
    // read as DATA here, never re-derived from a finding's prose.
    let obstacles = null;
    // The check's PEOPLELESS line (Q6): the page the checker nominates to give
    // up its cast, emitted only when no page is people-free. Read as DATA, the
    // same way the OBSTACLES block is — picking the page in code was built and
    // rejected on measurement (docs/decisions.md, 2026-09-20).
    let peoplelessPick = null;
    // The check's WANTED (Q4) and ACTION (Q12) lines: the pictures the next
    // round must keep, read as DATA like OBSTACLES (2026-09-23).
    let wanted = [];
    let actions = [];
    // The check's CENTRAL line: the pages whose picture shows the central
    // figure, answered for the name Q12 gives it (2026-09-25). null = no line.
    let centralPages = null;
    let checkModelId = null;
    let prompt = null;
    // THE REPLY IS EVIDENCE, NOT A BYPRODUCT (2026-09-19).
    //
    // `modelFindings: []` has two readings — the checker found nothing, or it
    // answered badly — and until this was kept the row could not tell them
    // apart. On staging job_1789759147125_p08djwhbl the eleven-check call
    // returned zero findings against a plan that breaks four of the planner's
    // own rules on page 5 alone, and the only reason we know the call arrived
    // at all is that `cast` happens to be derived from its roster.
    //
    // Text only, no images, and the arc stage already keeps the creator's full
    // reply (`arcReviewReport.create`) for exactly this reason.
    let reply = '';
    let rosterLines = [];
    try {
      // No counter findings ride in: they do not exist yet. See the builder's
      // header — the counters read this call's ROSTER, so they run below.
      prompt = buildPlanCheckPrompt(inputData, pages, approvedArc, planText, { arcHints, storyLogic: arcStoryLogic, centralFigure: arcCentralFigure, castTable, ...labPromptOptions });
      if (!prompt) throw new Error('plan-check template unavailable');
      const res = await textModels.callTextModelStreaming(prompt, null, onChunk, planCheckModel, {
        usageLabel: label,
        // Judges run at temperature 0 (settled); the Anthropic path sends none.
        ...(TEXT_MODELS[planCheckModel]?.provider === 'anthropic' ? {} : { temperature: 0 }),
      });
      if (onCall) onCall(res);
      checkModelId = res.modelId || planCheckModel;
      reply = String(res.text || '');
      modelFindings = parsePlanCheck(res.text || '');
      roster = parsePlanCheckRoster(res.text || '');
      obstacles = parsePlanCheckObstacles(res.text || '');
      peoplelessPick = parsePlanCheckPeoplelessPick(res.text || '');
      wanted = parsePlanCheckWanted(res.text || '');
      actions = parsePlanCheckActions(res.text || '');
      centralPages = parsePlanCheckCentralPages(res.text || '');
      // The roster AS PARSED, page by page. The raw reply above carries the
      // same lines verbatim; this is the form every counter actually reasons
      // on, so a reader can see what the arithmetic was given — including a
      // `covers` that expanded nobody, which is how "all four boys" reached
      // the cast count as two names on that same job.
      rosterLines = [...roster.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([pageNumber, r]) => ({ pageNumber, people: r.people, things: r.things, covers: r.covers }));
    } catch (err) {
      // LOUD, NEVER FATAL. A lost plan check takes the ENTIRE counter layer
      // with it (the counters do arithmetic on its roster), so this is an
      // ERROR in the run log and in the generation log — not a WARN that two
      // days of beats runs scrolled past (2026-09-13, the undefined
      // `parsePlanCheckRoster` binding). It still never aborts a paid run:
      // quality gates ship with a warning (feedback_gates_are_guidelines).
      log.error(`❌ [BEATS] Plan check (${label}) failed (${err.message}) — NO ROSTER, so the entire plan-counter layer is skipped this round`);
      gl.error(`${label}_failed`, `Plan check failed: ${err.message} — no roster, so every plan counter (cast, invented cast, shot variety, focal pages) is skipped this round`, null, { error: err.message, model: planCheckModel });
    }
    const parsed = { roster, obstacles, peoplelessPick, wanted, actions, centralPages };
    const counters = countersFor(pages, parsed);
    // The central-figure counter counts on the CENTRAL line alone; a check
    // that named no pages for a named figure leaves it uncounted — loudly.
    if (counters.stats?.centralFigure?.unanswered) {
      log.error(`❌ [BEATS] Plan check (${label}) gave no CENTRAL line for the central figure (${arcCentralFigure.join(' / ')}) — CENTRAL_FIGURE_ABSENT_THIRD did not run`);
      gl.error(`${label}_no_central_line`, 'The plan check named no pages for the central figure (CENTRAL line absent); the per-third presence counter did not run', null, { model: checkModelId || planCheckModel, centralFigure: arcCentralFigure });
    }
    // NO FALLBACK, NO SYNTHESIS. The finding degrades to its page-less
    // sentence when Q6 nominated nothing; code never picks the page itself.
    // The miss is loud so a checker that stops answering Q6 is visible.
    if (!peoplelessPick && counters.findings.some(f => f.code === 'NO_PEOPLELESS_PAGE')) {
      log.error(`❌ [BEATS] Plan check (${label}) fired NO_PEOPLELESS_PAGE but emitted no PEOPLELESS line — the finding names no page, and the planner picks blind`);
      gl.error(`${label}_no_peopleless_nomination`, 'The plan check found no people-free page but nominated none either (Q6 PEOPLELESS line absent); the finding degrades to naming no page', null, { model: checkModelId || planCheckModel });
    }
    if (counters.skipped) {
      const got = roster ? roster.size : 0;
      log.error(`❌ [BEATS] Plan counters (${label}) SKIPPED (${counters.skipped}) — the roster covers ${got} of ${pages.length} page(s); no cast, invented-cast, shot-variety or focal-page counting ran`);
      gl.error(`${label}_counters_skipped`, `Plan counters did not run (${counters.skipped}): the check's roster covers ${got} of ${pages.length} page(s)`, null, { reason: counters.skipped, rosterPages: got, pages: pages.length });
    }
    // Findings travel STRUCTURED to the re-plan: a counter keeps its code, a
    // model finding the check number it answered, so buildReplanSection can rank
    // them without reading their prose. `lines` stays the flat rendering the
    // report and the logs have always carried.
    const structured = structure(counters, modelFindings);
    const all = structured.map(f => f.line);
    gl.info(label, `Plan check by ${checkModelId || planCheckModel}: ${counters.lines.length} counter finding(s), ${modelFindings.length} model finding(s)`, null, {
      counterFindings: counters.lines, modelFindings, model: checkModelId, stats: counters.stats, cast: counters.cast,
    });
    return { counters, modelFindings, findings: structured, lines: all, checkModelId, prompt, obstacles, reply, rosterLines, wanted, actions, parsed };
  };
  /** A division judged from parsed facts already held — no model call, no log. */
  run.compose = (pages, parsed, modelFindings) => {
    const counters = countersFor(pages, parsed);
    const findings = structure(counters, modelFindings);
    return { counters, modelFindings, findings, lines: findings.map(f => f.line), obstacles: parsed.obstacles || new Map(), wanted: parsed.wanted || [], actions: parsed.actions || [], parsed, composite: true };
  };
  return run;
}

function recheckRecord(c) {
  // ONE shape for a recheck wherever it is recorded — the canonical `recheck`
  // and a discarded round's sit side by side in the stored report and a reader
  // must be able to compare them without learning two layouts.
  return (c ? {
    counterFindings: c.counters.lines,
    counterStats: c.counters.stats,
    modelFindings: c.modelFindings,
    // The flat rendering (counter lines + `CHECK[n]: …`) the summary prose and
    // the log line both read, so the record is self-contained and no reader
    // re-derives it.
    lines: c.lines,
    // Same evidence as the first check: an empty `modelFindings` on a RECHECK
    // is the same two-way ambiguity, and a discarded round's record is where
    // one would most want to see what the model actually said.
    reply: c.reply || '',
    rosterLines: c.rosterLines || [],
    // THE RECHECK'S OWN PROMPT (2026-09-23). Only the first check's prompt was
    // stored, so a recheck could be read only by rebuilding it at the run's
    // commit — a reconstruction, not the bytes sent.
    prompt: c.prompt || '',
    wanted: c.wanted || [],
    actions: c.actions || [],
  } : null);
}

/**
 * The re-plan rounds for a division whose first check raised findings. Pushes
 * every round onto `replanRounds` (kept and discarded alike) and returns the
 * division that ships.
 *
 * @returns {Promise<{beats: Array, pagePlan: string}>}
 */
async function runReplanRounds({ inputData, pageCount, plan, check1, replanRounds, approvedArc, arcHints, arcStoryLogic, arcCentralFigure, castTable, commission, commissionedNames, maxCast, planModel, readPlan, runCheck, onChunk, gl, stage, checkCancellation, labPromptOptions = {}, onCall = null, beats, pagePlan, jevReport = null }) {
  // The check whose roster describes the division that ships — the head count
  // the shot assignment reads (jevDecisions.decideShots).
  let bestCheck = check1;
  try {
    // RE-PLAN ROUNDS (2026-09-09). The loop used to be check → re-plan →
    // recheck → ship: a fault the RE-PLAN ITSELF introduced was named by the
    // recheck and never fixed. Measured on the dragon story: the first
    // division buried the spring's release inside a four-action page; the
    // re-plan correctly split it out and left the new page holding the deed
    // AND its effect ("rams the branch into the crack, water shoots out").
    // The recheck said so in those words and the story shipped that way.
    // A second round runs only when a MUST-FIX finding survives — the
    // ranking `replanRank` already computes, so an "also noted" line can
    // never spend a round. Bounded at two re-plans; the plan model is the
    // cheapest call in the stage and a third round has never been needed.
    const MAX_REPLAN_ROUNDS = 2;
    let pendingCheck = check1;
    // A round must EARN its keep. Measured 2026-09-09 on
    // job_1788903616404_iqvhj4l8m: round 2 re-wrote 17 of 18 pages to clear
    // three must-fix findings and minted five new ones (findings 26 -> 13 ->
    // 23). The planner re-emits the whole division each round, so a round
    // that does not reduce the must-fix count is not converging — it is
    // rolling the dice on every page at once. Such a round is DISCARDED and
    // the previous division stands, which makes the loop monotonic.
    //
    // THE COUNT IS THE CAST/FOCAL MUST-FIX COUNT, NOT THE RAW TOTAL
    // (2026-09-20). Shot-distribution findings are must-fix — the re-plan is
    // obliged to answer them — but they are exempt from THIS measure
    // (promptBuilders.REPLAN_CONVERGENCE_EXEMPT_CODES). A shot finding is
    // cleared by relabelling one page's shot word; a cast or focal finding
    // costs the book a picture, so a raw total lets cheap shot clears pay for
    // a lost wanted picture. Measured on job_1789853503332_riqncqg1i, whose
    // round 2 rewrote 17 of 18 pages, took Q4 wanted-picture findings 2 -> 3
    // and dropped its Q8 ending, yet read 6 -> 5 on the total because one
    // ultra-wide finding fell.
    let bestBeats = beats;
    let bestPagePlan = pagePlan;
    // The review's refusals from the round before, told to the next round.
    let lastRefusals = [];
    const coverageRule = castCoverage({ pageCount: beats.length, castCount: commission.listed.length });
    for (let round = 1; round <= MAX_REPLAN_ROUNDS; round++) {
      await checkCancellation();
      await stage(5, 'Re-dividing the named pages...', { next: 18, ms: 45000 });
      // WHAT THIS ROUND MUST KEEP (2026-09-23): the last page, the check's
      // WANTED and ACTION pages, and a character's only focal page — one list
      // for the prompt and for the review's `protected` rule below.
      const keep = replanKeepPages({
        pageCount: beats.length,
        wanted: pendingCheck.wanted,
        actions: pendingCheck.actions,
        focalPages: (pendingCheck.counters.stats && pendingCheck.counters.stats.focalPages) || {},
      });
      // THE GROUP-PAGE CUTS ARE DECIDED, NOT LEFT TO THE PLANNER (owner,
      // 2026-09-27). When the check counts more group pages than the budget,
      // Jev ranks them (TOGETHER) and scores who each page needs (NEEDED);
      // code keeps the top `budget`, cuts below 0.5 and puts back what the
      // constraints need (jevDecisions.decideGroupCuts). The aggregate finding
      // is replaced by one CAST CUT instruction per page; code writes the who
      // column after the reply, and the planner only re-words the instant.
      // A Jev failure throws JevDecisionError — no free choice to fall back to.
      const castAliases = (pendingCheck.counters.cast && pendingCheck.counters.cast.aliases) || {};
      const sameName = (a, b) => namesIn(String(a || ''), [String(b || '')], castAliases).length > 0
        || namesIn(String(b || ''), [String(a || '')], castAliases).length > 0;
      let roundFindings = pendingCheck.findings || [];
      let castCut = null;
      const groupFinding = roundFindings.find(f => f && f.code === 'GROUP_PAGES_OVER_BUDGET');
      if (groupFinding && jevActive(jevReport)) {
        const st = pendingCheck.counters.stats || {};
        try {
        castCut = await jevDecisions.decideGroupCuts({
          arc: approvedArc,
          pages: beats,
          present: new Map((st.castPerPage || []).map(r => [Number(r.pageNumber), r.names || []])),
          groupPages: (st.groupPages && st.groupPages.pages) || [],
          budget: st.groupPages ? st.groupPages.budget : null,
          obstacles: pendingCheck.obstacles || new Map(),
          focalPages: st.focalPages || {},
          listed: commission.listed,
          floor: coverageRule ? coverageRule.appearances.min : 0,
          mainName: st.mainCharacter || null,
          centralFigure: arcCentralFigure,
          centralPages: st.centralFigure ? st.centralFigure.pages : null,
          castTable,
          sameName,
        });
        } catch (jevErr) {
          if (!(jevErr instanceof JevDecisionError)) throw jevErr;
          // The backup: the planner chooses the cuts from the counter's own
          // finding, as before the layer.
          jevFallBack(jevReport, 'cast_cuts', jevErr, gl);
          castCut = null;
        }
      }
      if (castCut) {
        if (jevReport) jevReport.castCuts.push({ round, ...castCut });
        const instructions = jevDecisions.castCutFindings(castCut);
        roundFindings = [...roundFindings.filter(f => f !== groupFinding), ...instructions];
        const summary = castCut.decisions.filter(d => d.remove && d.remove.length).map(d => `p${d.pageNumber} keeps ${d.keep.join(', ')}, out ${d.remove.join(', ')}`).join(' | ');
        gl.info('beats_jev_cast_cuts', `Round ${round}: ${castCut.groupPages.length} group page(s), budget ${castCut.budget} — keep the group on ${castCut.keepGroup.join(', ') || 'none'}; ${summary || 'no cut'}`, null, { round, decisions: castCut.decisions, stats: castCut.stats });
        for (const d of castCut.decisions.filter(x => x.unsatisfiable)) {
          gl.error('beats_jev_cast_cut_unsatisfiable', `Round ${round}: page ${d.pageNumber} keeps its group — ${d.unsatisfiable}`, null, { round, pageNumber: d.pageNumber });
        }
      }
      const replanPrompt = buildBeatsPrompt(inputData, pageCount, {
        finalArc: approvedArc,
        arcHints,
        storyLogic: arcStoryLogic,
        centralFigure: arcCentralFigure,
        castTable,
        legacyShots: legacyShotsOf(jevReport),
        ...labPromptOptions,
        replan: buildReplanSection(pagePlan, roundFindings, { pageCount: beats.length, keep, refused: lastRefusals, castFloor: coverageRule ? coverageRule.appearances.min : null, castTable }),
      });
      if (!replanPrompt) throw new Error('story-beats template unavailable');
      const rpRes = await textModels.callTextModelStreaming(replanPrompt, null, onChunk, planModel, { usageLabel: 'beats_replan' });
      if (onCall) onCall(rpRes);
      const second = readPlan(rpRes.text);
      if (second.parsed.pages.length === 0) throw new Error('re-plan returned no parseable plan lines');
      // DECLARE. The round states each structural change it made — a name in
      // or out of frame, an action moved or dropped, one page's material
      // joining another's — with the finding it answers and why. `present:
      // false` is a round that emitted no block at all: every change it made
      // is then undeclared, which is the behaviour the merge had before
      // declarations existed (2026-09-18).
      const declared = parsePlanChanges(rpRes.text);
      // A TOTAL IS ALWAYS SELF-CERTIFIABLE: the block re-counts its own lines,
      // and a count that disagrees with the enumeration is the enumeration's
      // word against an assertion. The lines win; the discrepancy is reported.
      if (declared.present && declared.declaredCount != null && declared.declaredCount !== declared.counted) {
        gl.warn('beats_replan_change_count', `Round ${round}: the change block declares ${declared.declaredCount} change(s) and enumerates ${declared.counted} across ${declared.lines} line(s); the enumeration stands`, null, { round, declared: declared.declaredCount, counted: declared.counted, lines: declared.lines });
      }
      // ONE LINE, ONE CHANGE — recorded, not re-asked (2026-09-18). The
      // parser splits a packed line into its clauses rather than mis-reading
      // it, so a violation costs the round nothing; it is recorded because a
      // format nobody polices is not a format. A re-ask is deliberately NOT
      // wired: both planner models broke the contract on the first live
      // attempt (Lab 1326: 7 of 10 lines; 1327: 1 of 5), so an automatic
      // re-ask would buy a paid call on most rounds for a fault the parser
      // already absorbs.
      if (declared.violations.length) {
        const detail = declared.violations.map(v => `p${v.pageNumber} (${v.rule})`).join(', ');
        log.warn(`⚠️ [BEATS] Round ${round}: ${declared.violations.length} declared change(s) break the change-block format (${detail}) - read clause by clause, not refused`);
        gl.warn('beats_replan_change_format', `Round ${round}: ${declared.violations.length} declared change(s) break the one-line-one-change format — ${detail}; each was read clause by clause rather than refused`, null, { round, violations: declared.violations });
      }
      const unreadable = declared.changes.filter(c => c.kind === 'other');
      if (unreadable.length) {
        gl.warn('beats_replan_change_unreadable', `Round ${round}: ${unreadable.length} declared change(s) do not use the declared vocabulary, so nothing reviewed them`, null, { round, lines: unreadable.map(c => c.line.slice(0, 160)) });
      }
      // MERGE, don't replace. The re-plan is asked for ONLY the pages a
      // finding names; every other page stands. Until 2026-09-09 it returned
      // the whole division, and the planner rewrote 15-18 of 18 pages every
      // round — which is how a story lost the page where its quest object was
      // put back (job_1788903616404_iqvhj4l8m: check 9 named the page, the
      // re-plan answered by deleting the moment, and no check noticed it had
      // gone). Pages no finding named are restored from the division that
      // stands, so a round can only change what it was asked to change.
      const namedPages = new Set();
      for (const nf of roundFindings) for (const n of findingPages(nf)) namedPages.add(Number(n));
      // A DECLARED PAGE IS IN SCOPE. Splitting a page's second action onto a
      // picture of its own needs two pages rewritten — the one a finding
      // named and the neighbour whose number now stages the new moment — and
      // until 2026-09-18 the merge below restored the neighbour, which made
      // the split the prompt described structurally impossible. A page the
      // round DECLARES it changed, with the finding it answers and why, is
      // asked-for work; a page in neither list is still restored.
      const declaredPages = new Set();
      for (const c of declared.changes) {
        if (Number.isFinite(c.pageNumber)) declaredPages.add(Number(c.pageNumber));
        if (Number.isFinite(c.toPage)) declaredPages.add(Number(c.toPage));
        if (Number.isFinite(c.fromPage)) declaredPages.add(Number(c.fromPage));
      }
      // When NO finding names a page — a whole-book finding, or a finding whose
      // page reference could not be read — the re-plan is answering for the
      // whole division, so every returned page is accepted. The merge still
      // runs: a page the return omits is filled from the division that stands,
      // which is what keeps a partial answer from failing the page-count guard
      // below and having the round discarded without a word.
      const scopeAll = namedPages.size === 0;
      {
        const standing = new Map(beats.map(b => [b.pageNumber, b]));
        const kept = [];
        const inScope = n => namedPages.has(Number(n)) || declaredPages.has(Number(n));
        for (const pg of second.parsed.pages) {
          if (scopeAll || inScope(pg.pageNumber) || !standing.has(pg.pageNumber)) kept.push(pg);
          else kept.push(standing.get(pg.pageNumber));
        }
        for (const [num, pg] of standing) if (!kept.some(k => k.pageNumber === num)) kept.push(pg);
        kept.sort((a, b) => a.pageNumber - b.pageNumber);
        const overridden = scopeAll ? 0 : second.parsed.pages.filter(pg => !inScope(pg.pageNumber) && standing.has(pg.pageNumber)).length;
        if (overridden > 0) {
          log.warn(`[BEATS] Round ${round}: the re-plan returned ${overridden} page(s) no finding named and no change declared - restored from the standing division`);
          gl.warn('beats_replan_unnamed_pages', `Round ${round}: the re-plan rewrote ${overridden} page(s) that no finding named and no change declared; those pages were restored from the division that stands`, null, { round, overridden, named: [...namedPages].sort((a, b) => a - b), declared: [...declaredPages].sort((a, b) => a - b) });
        }
        second.parsed.pages = kept;
        second.parsed.missing = [];
      }
      // REVIEW, then APPLY (2026-09-18). A removal is judged, never banned
      // and never waved through.
      //
      // What this replaced: the round was told a removal is never a fix and
      // `castLostByReplan` mechanically restored every name a re-plan took
      // out. That rule is one-directional — `NO_COMMISSIONED_ON_PAGE` is
      // answered by adding, `CAST_OVER_CEILING` by writing a justification
      // into the line, plan-check Q3 likewise — so an over-crowded page could
      // only ever get more crowded, and the standing division was treated as
      // always right when it is itself a model output. Owner's verdict: "we
      // can not say delete only or add only; we must give a fair review and
      // allow both fix types."
      //
      // Two passes, in this order:
      //   1. DECLARED changes go to `reviewPlanChanges`, which refuses one
      //      against declared evidence — the check's own OBSTACLES line for
      //      that page, the figure's span across the book, the cast ceiling,
      //      and the page-count balance of a merge and a split. A refusal
      //      restores that page from the division that stands and the finding
      //      that named it survives to the recheck; it never discards a round.
      //   2. UNDECLARED removals — a name gone from a who column with no
      //      change line saying so — are restored exactly as before. A silent
      //      deletion is unreviewable: the plan line is the brief's authority,
      //      so the Art Director loses the figure and the scene review strips
      //      them by the book (`[cast_not_in_plan]`). On staging
      //      job_1789681157795_wkt20ckod that cost three CRITICAL and one
      //      MAJOR IMG fault for an antagonist the page text describes and no
      //      picture shows, and the only way anyone found it was diffing two
      //      who-columns after the book was finished.
      // CODE WRITES THE WHO COLUMN OF EVERY CUT PAGE (2026-09-27). The
      // re-planner was asked to re-word the instant and what is true after for
      // the cast code keeps. A returned line that still names a character code
      // cast out — or that did not come back rewritten — is REJECTED: the page
      // stands as it was, the error is logged, and the budget finding survives
      // to the recheck. Code never patches the planner's text.
      const codeOwned = new Map();
      const cutRejects = [];
      if (castCut) {
        const standingByPage = new Map(beats.map(b => [Number(b.pageNumber), b]));
        for (const d of castCut.decisions.filter(x => x.remove && x.remove.length)) {
          const n = Number(d.pageNumber);
          const idx = second.parsed.pages.findIndex(pg => Number(pg.pageNumber) === n);
          const line = idx >= 0 ? String(second.parsed.pages[idx].planLine || '') : '';
          const before = String((standingByPage.get(n) || {}).planLine || '');
          const told = jevDecisions.planParts(line).slice(2).join(' — ');
          const stillNamed = namesIn(told, d.remove, castAliases);
          let reason = null;
          if (!line || line === before) reason = 'the re-plan did not rewrite this page';
          else if (stillNamed.length) reason = `its instant or what is true after still names ${stillNamed.join(', ')}, whom code cast out`;
          let written = null;
          if (!reason) {
            try { written = jevDecisions.withWho(line, d.keep); } catch (e) { reason = e.message; }
          }
          if (reason) {
            cutRejects.push({ pageNumber: n, reason, keep: d.keep, remove: d.remove });
            if (idx >= 0 && standingByPage.has(n)) second.parsed.pages[idx] = standingByPage.get(n);
            log.error(`❌ [BEATS] Round ${round}: CAST CUT on page ${n} REJECTED — ${reason}; the page stands as it was and the group budget finding survives`);
            gl.error('beats_jev_cast_cut_rejected', `Round ${round}: page ${n}'s rewrite for its cast cut was rejected — ${reason}. The page stands as it was.`, null, { round, pageNumber: n, reason, keep: d.keep, remove: d.remove });
            continue;
          }
          second.parsed.pages[idx] = { ...second.parsed.pages[idx], planLine: written };
          codeOwned.set(n, { planLine: written, remove: d.remove });
        }
        if (jevReport) jevReport.castCuts[jevReport.castCuts.length - 1].applied = { pages: [...codeOwned.keys()], rejected: cutRejects };
      }
      let reviewRefusals = [];
      {
        const guardCast = (pendingCheck.counters.cast && pendingCheck.counters.cast.all) || commissionedNames;
        const guardAliases = (pendingCheck.counters.cast && pendingCheck.counters.cast.aliases) || {};
        const standing = new Map(beats.map(b => [b.pageNumber, b]));
        const restore = (pageNumbers) => {
          const want = new Set(pageNumbers.map(Number).filter(n => !codeOwned.has(n)));
          second.parsed.pages = second.parsed.pages.map(pg => (
            want.has(Number(pg.pageNumber)) && standing.has(pg.pageNumber) ? standing.get(pg.pageNumber) : pg
          ));
        };

        const review = reviewPlanChanges({
          // A code-cut page is decided, not proposed: the planner's own
          // declarations on it are not reviewed (code wrote its who column).
          changes: declared.changes.filter(c => !codeOwned.has(Number(c.pageNumber))),
          standing: beats,
          returned: second.parsed.pages,
          castNames: guardCast,
          aliases: guardAliases,
          maxCast,
          obstacles: pendingCheck.obstacles,
          focalNames: coverageRule && coverageRule.focalEach ? commission.listed : [],
          protectedPages: new Map(keep.map(k => [Number(k.page), k.why])),
          actions: pendingCheck.actions,
          rankOf: replanRank,
          // The commissioned span floor the re-plan was told (2026-09-25).
          castFloor: coverageRule ? { names: commission.listed, min: coverageRule.appearances.min } : null,
        });
        reviewRefusals = review.refusals;
        lastRefusals = review.refusals;
        if (review.notes.length) {
          gl.info('beats_replan_change_notes', `Round ${round}: ${review.notes.length} declared change(s) could not be tied to a finding or a cast name`, null, { round, notes: review.notes });
        }
        if (review.refusals.length) {
          restore(review.refusals.map(r => r.pageNumber));
          const detail = review.refusals.map(r => `p${r.pageNumber} (${r.rule}): ${r.detail}`).join('; ');
          log.warn(`⚠️ [BEATS] Round ${round}: ${review.refusals.length} declared change(s) refused on review - ${detail}`);
          gl.warn('beats_replan_change_refused', `Round ${round}: the review refused ${review.refusals.length} declared change(s) — ${detail}; ${review.refusals.length === 1 ? 'that page was' : 'those pages were'} restored from the division that stands`, null, { round, refusals: review.refusals });
        }

        // The code's cast cuts are declared removals: they are the decision.
        const declaredOut = new Map(review.declaredOut instanceof Map
          ? review.declaredOut
          : Object.entries(review.declaredOut || {}).map(([k, v]) => [Number(k), v]));
        for (const [n, c] of codeOwned) declaredOut.set(n, [...(declaredOut.get(n) || []), ...c.remove]);
        const lost = castLostByReplan(beats, second.parsed.pages, guardCast, guardAliases, declaredOut);
        if (lost.length) {
          restore(lost.map(l => l.pageNumber));
          const detail = lost.map(l => `p${l.pageNumber}: ${l.lost.join(', ')}`).join('; ');
          log.warn(`⚠️ [BEATS] Round ${round}: the re-plan dropped cast from ${lost.length} page(s) without declaring it (${detail}) - restored from the standing division`);
          gl.warn('beats_replan_cast_lost', `Round ${round}: the re-plan removed ${detail} from the page plan and declared no change for it; an undeclared removal is unreviewable, so ${lost.length === 1 ? 'that page was' : 'those pages were'} restored from the division that stands`, null, { round, pages: lost, declaredBlock: declared.present });
        }
      }
      // A re-plan that answers "this page holds two actions" by copying a
      // neighbouring page has destroyed the page, not fixed it. Measured
      // 2026-09-09 on job_1788903616404_iqvhj4l8m: the page staging the
      // quest object's return came back as a verbatim duplicate of the page
      // before it, and the story lost its climax with no check firing.
      // Two pages with the same instant is corruption, so the round is
      // discarded and the division that stands is kept.
      {
        const instants = second.parsed.pages.map(pg => String(pg.planLine || '').toLowerCase().replace(/\s+/g, ' ').trim());
        const dupe = instants.find((t, k) => t && instants.indexOf(t) !== k);
        if (dupe) {
          log.warn(`[BEATS] Round ${round} returned two pages with the same line - discarding it, the previous division stands`);
          gl.warn('beats_replan_duplicate', `Round ${round} produced two pages with an identical plan line; the round was discarded and the previous division stands`, null, { round, line: dupe.slice(0, 160) });
          replanRounds.push({ round, changedPages: [], recheck: null, kept: false, replanPrompt, replanReply: String(rpRes.text || ''), discardReason: 'two pages returned with an identical plan line' });
          beats = bestBeats;
          pagePlan = bestPagePlan;
          break;
        }
      }
      // THE PAGE COUNT IS THE ORDER (2026-09-14). The re-plan may move, split
      // or merge instants, but a round that returns more or fewer pages than
      // the division that stands is not a re-division of THIS book: on
      // job_1789337998754_apslnsq1z an 18-page order came back as 19 plan
      // lines, passed both guards above (no duplicate, nothing omitted), and
      // shipped as a 19-page book. Same remedy as the duplicate guard: the
      // round is discarded and the previous division stands.
      if (second.parsed.pages.length !== beats.length) {
        log.warn(`[BEATS] Round ${round} returned ${second.parsed.pages.length} page(s) for a ${beats.length}-page book - discarding it, the previous division stands`);
        gl.warn('beats_replan_page_count', `Round ${round} returned ${second.parsed.pages.length} page(s) for a ${beats.length}-page book; the round was discarded and the previous division stands`, null, { round, returned: second.parsed.pages.length, expected: beats.length });
        replanRounds.push({ round, changedPages: [], recheck: null, kept: false, replanPrompt, replanReply: String(rpRes.text || ''), discardReason: `returned ${second.parsed.pages.length} page(s) for a ${beats.length}-page book` });
        beats = bestBeats;
        pagePlan = bestPagePlan;
        break;
      }
      if (second.parsed.missing.length > 0) {
        log.warn(`⚠️ [BEATS] Re-plan omitted page(s) ${second.parsed.missing.join(', ')} — previous division kept`);
        gl.warn('beats_replan_incomplete', `Re-plan omitted page(s) ${second.parsed.missing.join(', ')} — previous division kept`);
        replanRounds.push({ round, changedPages: [], recheck: null, kept: false, replanPrompt, replanReply: String(rpRes.text || ''), discardReason: `omitted page(s) ${second.parsed.missing.join(', ')}` });
        break;
      }
      const before = new Map(beats.map(p => [p.pageNumber, p.planLine || '']));
      let changedThisRound = second.parsed.pages
        .filter(p => (before.get(p.pageNumber) || '') !== (p.planLine || ''))
        .map(p => p.pageNumber);
      beats = second.parsed.pages;
      // Rebuild the plan TEXT from the merged pages. `second.pagePlan` is the
      // raw re-plan response, so on any page the merge restored, the string
      // and the array disagreed — and the string is what every report, every
      // later reader and the recheck see. Measured 2026-09-09: one page of
      // eighteen, and it was one of the pages a reviewer then judged against
      // a line that had never been used. Deriving it from the pages makes the
      // two representations incapable of diverging.
      pagePlan = beats.map(pg => `Page ${pg.pageNumber}: ${pg.planLine || ''}`).join(String.fromCharCode(10));
      gl.info('beats_replan', `Round ${round}: planner re-divided ${changedThisRound.length} page(s) for ${pendingCheck.lines.length} finding(s)`, null, {
        round, replannedPages: changedThisRound, findings: pendingCheck.lines.length,
      });
      let check2 = await runCheck(round === 1 ? 'plan_recheck' : `plan_recheck_r${round}`, beats, pagePlan);
      // Entered KEPT and demoted below if the round is thrown away, so the
      // ledger records the round whichever way the verdict goes.
      const roundRecord = {
        round,
        changedPages: changedThisRound,
        findingsIn: pendingCheck.lines.length,
        // The re-plan request this round was given, verbatim — the only
        // prompt in the stage that carries the findings (## MUST FIX / ##
        // ALSO NOTED). Text, additive, read by nothing.
        replanPrompt,
        // The re-plan's reply verbatim (2026-09-23): the stored round kept
        // only the merged pages and the parsed changes.
        replanReply: String(rpRes.text || ''),
        recheck: recheckRecord(check2),
        kept: true,
        // WHAT THE ROUND SAID IT DID, AND WHAT THE REVIEW MADE OF IT. Before
        // 2026-09-18 a removal was recorded nowhere at all — the only way to
        // find one was diffing two who-columns after the book was finished.
        // `declaredChanges: null` marks a round that emitted no block.
        declaredChanges: declared.present ? declared.changes.map(c => c.line) : null,
        changeRefusals: reviewRefusals,
      };
      replanRounds.push(roundRecord);
      // THE GUARD — every round, round 1 included (owner, 2026-09-24). Until
      // then `&& round > 1` exempted round 1, and 8 of 32 stored books shipped
      // a round-1 division with MORE cast/focal must-fix findings than the
      // division it replaced (job_1790100385959_1nitlympp: 5 → 7). A round
      // that regresses is discarded on any round; a round 2+ must also reduce
      // (it is bought only to mop up). See `replanRoundRegressed` for the
      // measure, which sets aside a model verdict that flips on a page the
      // round never touched.
      let verdict = replanRoundRegressed(pendingCheck, check2, changedThisRound, { round });
      // A DISCARDED ROUND KEEPS ITS GOOD PAGES (owner, 2026-09-28). Before the
      // round is thrown away, code puts back the fewest changed pages that
      // make the rest stop regressing (replanSalvage.salvageReplanRound, judged
      // from the two checks' per-page facts without a model call), then the
      // division it picked gets one real plan check and the same guard.
      // Staging job_1790539784661_6mjcny1c7 round 1: p4 and p7 cast Levin in,
      // p12 took the book over its group budget, and the whole round went.
      if (verdict.discard) {
        const salvage = salvageReplanRound({ standing: bestBeats, returned: beats, changedPages: changedThisRound, given: pendingCheck, recheck: check2, compose: runCheck.compose, round });
        if (salvage) {
          const salvagedPlan = salvage.pages.map(pg => `Page ${pg.pageNumber}: ${pg.planLine || ''}`).join(String.fromCharCode(10));
          log.info(`🩹 [BEATS] Round ${round}: putting back page(s) ${salvage.reverted.join(', ')} and keeping ${salvage.kept.join(', ')} clears the regression on the per-page facts (cast/focal must-fix ${verdict.before} → ${salvage.verdict.after}) — rechecking that division`);
          const check3 = await runCheck(`plan_recheck_salvage_r${round}`, salvage.pages, salvagedPlan);
          const v3 = replanRoundRegressed(pendingCheck, check3, salvage.kept, { round });
          roundRecord.salvage = { reverted: salvage.reverted, kept: salvage.kept, steps: salvage.steps, compositeAfter: salvage.verdict.after, recheck: recheckRecord(check3), before: v3.before, after: v3.after, salvaged: !v3.discard };
          if (!v3.discard) {
            gl.info('beats_replan_salvaged', `Round ${round} regressed as a whole (cast/focal must-fix ${verdict.before} → ${verdict.after}); page(s) ${salvage.reverted.join(', ')} were put back and its changes on page(s) ${salvage.kept.join(', ')} kept — rechecked ${v3.before} → ${v3.after}`, null, {
              round, reverted: salvage.reverted, kept: salvage.kept, wholeRoundAfter: verdict.after, compositeAfter: salvage.verdict.after, before: v3.before, after: v3.after,
            });
            beats = salvage.pages;
            pagePlan = salvagedPlan;
            check2 = check3;
            changedThisRound = salvage.kept;
            verdict = v3;
            roundRecord.changedPages = salvage.kept;
            roundRecord.recheck = recheckRecord(check3);
          } else {
            gl.warn('beats_replan_salvage_failed', `Round ${round}: keeping page(s) ${salvage.kept.join(', ')} cleared the regression on the per-page facts, but their recheck did not (cast/focal must-fix ${v3.before} → ${v3.after}); the whole round is discarded`, null, {
              round, reverted: salvage.reverted, kept: salvage.kept, compositeAfter: salvage.verdict.after, before: v3.before, after: v3.after,
            });
          }
        }
      }
      // Every surviving must-fix finding — what the NEXT round is mandated to
      // answer, and what the ships-as-it-stands warning names.
      const stillMustFix = (check2.findings || []).filter(f => replanRank(f) === 'must');
      // The subset the round-keeping decision is made on: cast/focal only.
      const stillConverging = stillMustFix.filter(countsTowardConvergence);
      const shotOnly = stillMustFix.length - stillConverging.length;
      if (verdict.discard) {
        const noiseNote = verdict.noise.length ? `, ${verdict.noise.length} checker verdict(s) on untouched pages set aside` : '';
        const detail = `cast/focal must-fix ${verdict.before} → ${verdict.after}${noiseNote}`
          + ` (${stillMustFix.length} must-fix in total, ${shotOnly} of them shot-distribution, which do not count toward convergence)`;
        const what = verdict.regressed ? 'raised' : 'did not reduce';
        log.warn(`⚠️ [BEATS] Round ${round} ${what} the cast/focal must-fix count (${detail}) — discarding it, the previous division stands`);
        gl.warn('beats_replan_discarded', `Round ${round} ${what} the cast/focal must-fix count (${detail}) — the round was discarded and the previous division stands`, null, {
          round, before: verdict.before, after: verdict.after, noise: verdict.noise.map(f => f.line),
          totalMustFixAfter: stillMustFix.length, shotMustFixAfter: shotOnly,
        });
        roundRecord.kept = false;
        roundRecord.discardReason = `${what} the cast/focal must-fix count (${detail})`;
        beats = bestBeats;
        pagePlan = bestPagePlan;
        break;
      }
      bestBeats = beats;
      bestPagePlan = pagePlan;
      bestCheck = check2;
      if (stillMustFix.length === 0) break;
      // A FURTHER ROUND MUST BE MOPPING UP, NOT RE-ROLLING (2026-09-21).
      //
      // The planner re-emits the whole division each round, so a round is only
      // worth buying when the one before it was CONVERGING: strictly fewer
      // cast/focal must-fix findings than it was given, and not one of them
      // new. A recheck that names a fault the previous check did not is a
      // round that moved sideways, and the next round is then re-rolling the
      // same dice at ~$0.09 and ~160s a throw — which is exactly what the
      // monotonic discard below then throws away.
      //
      // Measured by replaying this test over stored staging
      // `beatsReviewReport` rows (28 books with a recheck in 45 days, zero
      // paid calls): 6 rechecks are a strict subset and still buy a round; 22
      // are not, 10 of them because the recheck minted a new cast/focal
      // must-fix. Exactly 2 books ever ran a round 2 in that window, this test
      // would have skipped both, and BOTH were discarded by the convergence
      // rule below after they ran — i.e. no kept round 2 exists in the window.
      //
      // The identity of a finding is its code (a counter) or the check number
      // that produced it (a model finding) plus the pages it names — never its
      // prose, which this codebase forbids reading for meaning.
      {
        const conv = replanRoundConverged(pendingCheck, check2);
        if (!conv.converged) {
          const why = conv.minted.length
            ? `the recheck names ${conv.minted.length} cast/focal must-fix finding(s) the check before it did not`
            : `cast/focal must-fix ${conv.given} → ${conv.surviving} is not a reduction`;
          log.warn(`⚠️ [BEATS] Round ${round} did not converge (${why}) — no further round; the division it produced ships`);
          gl.info('beats_replan_no_further_round', `Round ${round} did not converge (${why}); no further re-plan round was bought and the division that round produced ships`, null, {
            round, given: conv.given, surviving: conv.surviving,
            minted: conv.minted.map(f => f.line),
          });
          break;
        }
      }
      if (round === MAX_REPLAN_ROUNDS) {
        // Ships with the fault named. A division is never withheld from a
        // paid run over a plan finding (gates are guidelines).
        log.warn(`⚠️ [BEATS] ${stillMustFix.length} must-fix finding(s) survive ${MAX_REPLAN_ROUNDS} re-plan round(s) — the division ships as it stands`);
        gl.warn('beats_replan_unfixed', `${stillMustFix.length} must-fix finding(s) survive ${MAX_REPLAN_ROUNDS} round(s): ${stillMustFix.map(f => f.line).join(' | ')}`, null, {
          rounds: MAX_REPLAN_ROUNDS, unfixed: stillMustFix.map(f => f.line),
        });
        break;
      }
      pendingCheck = check2;
    }
  } catch (err) {
    // A Jev decision failure is NOT a failed re-plan: the cut instructions have
    // no second author, so the step fails loudly (docs/decisions.md 2026-09-27
    // "Jev decision layer wired").
    if (err instanceof JevDecisionError) throw err;
    // Never block a story on the check: the first division is a complete plan.
    log.warn(`🚨 [BEATS] Re-plan failed (${err.message}) — the first division ships`);
    gl.warn('beats_replan_failed', `Re-plan failed: ${err.message} — the first division ships`);
    beats = plan.pages;
    // The FIRST division ships, so no round describes what shipped any more —
    // including a round that had been kept before the failure. They stay on
    // the ledger as discarded rather than being deleted (diagnostics).
    for (const r of replanRounds) {
      if (!r.kept) continue;
      r.kept = false;
      r.discardReason = `re-plan failed after this round (${err.message}) — the first division ships`;
    }
    return { beats, pagePlan, check: check1 };
  }
  return { beats, pagePlan, check: bestCheck };
}

// THE JEV-OUTAGE BACKUP switch (jevActive / jevFallBack) lives in jevDecisions.js
// since 2026-09-27: the trial's landmark selection flips the same switch.
const { jevActive, jevFallBack } = jevDecisions;

/** Shots authored by the planner: only a story that started on the backup. */
function legacyShotsOf(jevReport) { return !!(jevReport && jevReport.fallback && jevReport.fallback.step === 'start'); }

/**
 * THE SHOT OF EVERY PAGE — the Jev decision layer's Part 1 (owner, 2026-09-27).
 * The planner writes the placeholder; after the re-plan, Jev scores each shot's
 * fit per page and code assigns them under the budget (jevDecisions.decideShots),
 * then writes the word into field 0 of every plan line. The head count is the
 * `present` list of the check whose roster describes the shipped division —
 * never a name regex. No roster, no shots: the step fails loudly.
 *
 * Production and the Test Lab beats_replan stage call this same function.
 *
 * @returns {Promise<{beats: Array, pagePlan: string, report: object}>}
 */
async function finalizePlanShots({ approvedArc, beats, check, gl, callImpl, jevReport = null }) {
  const unchanged = (why) => ({ beats, pagePlan: beats.map(pg => `Page ${pg.pageNumber}: ${pg.planLine || ''}`).join(String.fromCharCode(10)), report: { skipped: why } });
  // The backup from the start: the planner wrote the shots.
  if (legacyShotsOf(jevReport)) return unchanged('backup path: the planner authored the shots');
  // The backup from a later step: the plan carries the placeholder and the Art
  // Director picks each shot (JEV_FIXED_FIELDS_RULE's placeholder sentence).
  if (!jevActive(jevReport)) return unchanged(`backup path from "${jevReport.fallback.step}": the Art Director picks each shot`);
  try {
    return await finalizePlanShotsJev({ approvedArc, beats, check, gl, callImpl });
  } catch (err) {
    if (!(err instanceof JevDecisionError) || !jevReport) throw err;
    jevFallBack(jevReport, 'shots', err, gl);
    return unchanged(`backup path from "shots": the Art Director picks each shot`);
  }
}

/**
 * The head count of a checked division: page → the names its plan check counts
 * in frame (planCounters `present`). ONE reading for the shot assignment and
 * the gaze roster. Null when the check carries no roster.
 */
function presentOf(check) {
  const perPage = check && check.counters && check.counters.stats && check.counters.stats.castPerPage;
  return Array.isArray(perPage) && perPage.length ? new Map(perPage.map(r => [Number(r.pageNumber), r.names || []])) : null;
}

async function finalizePlanShotsJev({ approvedArc, beats, check, gl, callImpl }) {
  const present = presentOf(check);
  if (!present) {
    throw new JevDecisionError(`no head count for the shipped division (${check && check.counters && check.counters.skipped ? `plan counters skipped: ${check.counters.skipped}` : 'the plan check gave no roster'}) — the shot assignment cannot apply the group rule, so no page gets a shot`);
  }
  const t0 = Date.now();
  const d = await jevDecisions.decideShots({ arc: approvedArc, pages: beats, present }, callImpl ? { callImpl } : {});
  const shotBeats = jevDecisions.applyShots(beats, d.shots);
  const pagePlan = shotBeats.map(pg => `Page ${pg.pageNumber}: ${pg.planLine || ''}`).join(String.fromCharCode(10));
  const report = { ...d, elapsedMs: Date.now() - t0 };
  gl.info('beats_jev_shots', `Shots by Jev + code: ${d.shots.map((x, i) => `p${beats[i].pageNumber} ${x}`).join(', ')} (${d.stats.calls} Jev calls, $${d.stats.costUsd}, ${(report.elapsedMs / 1000).toFixed(1)}s)${d.unmet ? ` — UNMET: ${d.unmet.join(', ')}` : ''}`, null, { shots: d.shots, violations: d.violations, unmet: d.unmet, stats: d.stats });
  if (d.unmet) gl.error('beats_jev_shots_unmet', `The shot assignment could not meet ${d.unmet.join(', ')}`, null, { unmet: d.unmet });
  return { beats: shotBeats, pagePlan, report };
}

/**
 * STEP 4 OF THE BEATS PIPELINE — the Art Director, in two calls with the
 * decision layer between them (owner, 2026-09-28: "Jev first, then remove the
 * scene review"):
 *   light     Jev's timeOfDay / indoors per story page (unchanged);
 *   call 1    the Visual Bible alone (visual-bible.txt; two attempts), then its
 *             adoption — label round, invented-child age clamp, transcript
 *             sync, landmark link, wardrobe-vs-bible corrections, the caller's
 *             bible hook (the landmark-shortfall abort now fires before any
 *             brief is paid for);
 *   decide    every other decided field of every story page
 *             (decideBriefFields → b.jevFixed);
 *   call 2    every page's brief, the covers included (scene-briefs-all.txt;
 *             two attempts), each story page with its FIXED block; the
 *             per-page fallback for pages it still owes;
 *   pin       code writes the decided fields (pinDecidedFields).
 * The briefs are then checked and re-asked once by the caller
 * (briefChecks.runBriefChecks). On the Jev-outage backup (path A) nothing is
 * fixed and call 2 authors every field itself.
 *
 * `labCallOptions` (the Lab's reasoning A/B), `labForcePerPage` (the historical
 * per-page comparison) and `onCall` are Test Lab knobs; the run passes none.
 *
 * @param {Map<number,string[]>} present - the shipped plan check's head count per page (the gaze roster)
 * @returns {Promise<{expansions: Array, visualBible: object|null, bibleSections: string|null, wardrobeBibleReport: object|null, sceneExpansionReport: object, briefBeats: Array, coverBeats: Array, briefsPrompt: string|null}>}
 */
async function runArtDirector({ inputData, modelOverrides, clothingRequirements, visualBible, bibleSections, sceneModel, onChunk, gl, meta, stage, beats, arcCentralFigure, approvedArc, present = null, onVisualBible = null, wardrobeBibleReport = null, labCallOptions = {}, labForcePerPage = false, onCall = null, jevReport = null }) {
  const lang = inputData.language || 'en';
  const imgModelConfig = IMAGE_MODELS[modelOverrides.imageModel || inputData.modelOverrides?.imageModel || MODEL_DEFAULTS.pageRenderImage];
  const availableAvatars = buildAvailableAvatarsForPrompt(inputData.characters || [], clothingRequirements);
  const maxCharactersPerScene = imgModelConfig?.maxCharactersPerScene || 3;

  /**
   * Per-page expansion — the fallback for pages the page-brief call omitted.
   * The PLAN line stands in for page.text (the text does not exist yet), with
   * the page's FIXED block under it exactly as in the all-pages plan block
   * (promptBuilders.planBlocks).
   */
  async function expandOnePage(b) {
    const pageContent = [`PLAN: ${b.planLine || ''}`, jevDecisions.fixedBlock(b)].filter(Boolean).join(String.fromCharCode(10));
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
        jevBackup: !jevActive(jevReport),
      }
    );
    let lastErr = null;
    // The best incomplete brief seen, kept as the last resort. A page with half
    // a spec still beats a page with none: this fallback's throw ABORTS the run
    // (Promise.all over the missing pages), and a contract miss must never end a
    // paid run (docs/SETTLED.md, gates are guidelines).
    let salvage = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await textModels.callTextModelStreaming(prompt, null, onChunk, sceneModel, { usageLabel: 'beats_scene_expansion_fallback', ...labCallOptions });
        if (onCall) onCall(res);
        if (!res || !res.text || !res.text.trim()) throw new Error('empty scene brief');
        const { assessSceneBrief, describeSceneBrief } = require('./iterateBriefGuard');
        const verdict = assessSceneBrief(res.text);
        if (!verdict.usable) {
          if (!salvage) salvage = { pageNumber: b.pageNumber, brief: res.text, prompt, modelId: res.modelId || sceneModel, verdict };
          throw new Error(`incomplete scene brief — ${describeSceneBrief(verdict)}`);
        }
        return { pageNumber: b.pageNumber, brief: res.text, prompt, modelId: res.modelId || sceneModel };
      } catch (err) {
        lastErr = err;
        log.warn(`⚠️ [BEATS] Scene expansion page ${b.pageNumber} attempt ${attempt} failed: ${err.message}`);
      }
    }
    if (salvage) {
      const { describeSceneBrief } = require('./iterateBriefGuard');
      const why = describeSceneBrief(salvage.verdict);
      log.error(`🚨 [BEATS] Page ${b.pageNumber}: both per-page attempts returned an incomplete brief (${why}) — SHIPPING IT ANYWAY; every metadata-driven supervisor runs blind on this page`);
      gl.warn('beats_scene_brief_incomplete', `Page ${b.pageNumber} ships with an incomplete brief after two per-page attempts — ${why}`, null, { pages: [b.pageNumber] });
      return { pageNumber: salvage.pageNumber, brief: salvage.brief, prompt: salvage.prompt, modelId: salvage.modelId };
    }
    throw new Error(`Scene expansion failed for page ${b.pageNumber}: ${lastErr?.message || 'unknown error'}`);
  }

  let t = Date.now();
  // THE LIGHT IS DECIDED BEFORE THE ART DIRECTOR WRITES (owner, 2026-09-27,
  // Part 4): Jev's timeOfDay (the clock held forward in code) and indoors per
  // story page, from the arc and the plan. Weather stays the Art Director's,
  // Jev's answer logged beside it. A Jev failure switches to the backup.
  if (jevActive(jevReport)) try {
    const light = await jevDecisions.decideLight({ arc: approvedArc, pages: beats });
    const byNum = new Map(light.pages.map(r => [r.pageNumber, r]));
    for (const b of beats) {
      const r = byNum.get(Number(b.pageNumber));
      if (r) b.fixed = { timeOfDay: r.timeOfDay, indoor: r.indoor, weatherAdvice: r.weatherAdvice };
    }
    if (jevReport) jevReport.light = light;
    gl.info('beats_jev_light', `Light by Jev + code: ${light.pages.map(r => `p${r.pageNumber} ${r.timeOfDay}${r.indoor ? '/in' : ''}`).join(', ')}${light.clockHeld.length ? ` — clock held on ${light.clockHeld.map(h => `p${h.pageNumber} (${h.jev}→${h.held})`).join(', ')}` : ''}`, null, { pages: light.pages, clockHeld: light.clockHeld, stats: light.stats });
  } catch (err) {
    if (!(err instanceof JevDecisionError) || !jevReport) throw err;
    // The backup: the Art Director authors the light, as before the layer.
    for (const b of beats) delete b.fixed;
    jevFallBack(jevReport, 'light', err, gl);
  }
  // COVERS ARE PAGES (owner, 2026-09-24). Each cover the job renders is a page
  // whose BEAT code writes (coverBeats.js), briefed by the Art Director with
  // every other page. They ride AFTER the story pages and never reach the page
  // text writer or the plan counters — `beats` stays the story.
  const { buildCoverBeats } = require('./coverBeats');
  const { coverTypesFor } = require('./coverKeys');
  // On the Jev path code decides each cover's place after the Visual Bible
  // (decideCoverPlaces below), so the beat names none; a cover left undecided
  // gets the Art Director's own-place rule back before the page-brief call.
  const coverBeatOpts = { coverTypes: coverTypesFor(inputData), clothingRequirements, centralFigure: arcCentralFigure };
  const coverBeats = buildCoverBeats(inputData, { ...coverBeatOpts, placeDecided: jevActive(jevReport) });
  const briefBeats = [...beats, ...coverBeats];
  const beatPageNumbers = briefBeats.map(b => b.pageNumber);
  // The head count each story page's brief checks read (cast_not_in_plan): the
  // shipped plan check's `present`, on the Jev path and the backup alike.
  if (present) for (const b of beats) b.inFrame = present.get(Number(b.pageNumber)) || [];

  // ── Call 1: the Visual Bible ──────────────────────────────────────────────
  // Two attempts; a reply is whole only when its JSON parses — a partial bible
  // must never ship, and JSON.parse is the completeness test.
  const vbPrompt = buildVisualBibleCallPrompt(inputData, briefBeats, {
    jevBackup: !jevActive(jevReport), availableAvatars, maxCharactersPerScene, finalArc: approvedArc, clothingRequirements,
  });
  const vbReplies = [];
  let adBible = null;
  if (!vbPrompt) {
    log.error('🚨 [BEATS] visual-bible template unavailable — the story ships with an empty bible');
    gl.warn('beats_visual_bible_missing', 'The Visual Bible template is unavailable — story ships with an empty bible');
  } else {
    await stage(30, 'Writing the visual bible...', { next: 36, ms: 90000 });
    for (let attempt = 1; attempt <= 2 && !adBible; attempt++) {
      try {
        const res = await textModels.callTextModelStreaming(vbPrompt, null, onChunk, sceneModel, { usageLabel: 'beats_visual_bible', ...labCallOptions });
        if (onCall) onCall(res);
        const raw = res?.text || '';
        vbReplies.push({ attempt, modelId: res?.modelId || sceneModel, text: raw });
        const sections = extractBibleSections(raw, AD_BIBLE_MARKERS);
        const parsedVb = sections ? new UnifiedStoryParser(sections.body).extractVisualBible() : null;
        if (sections && parsedVb) adBible = { body: sections.body, visualBible: parsedVb, found: sections.found, modelId: res?.modelId || sceneModel };
        else log.error(`🚨 [BEATS] Visual Bible attempt ${attempt}: ${sections ? `---VISUAL BIBLE--- present but its JSON did not parse (${sections.body.length} chars)` : `no ---VISUAL BIBLE--- section (${raw.length} chars)`}`);
      } catch (err) {
        log.error(`🚨 [BEATS] Visual Bible attempt ${attempt} failed: ${err.message}`);
        gl.warn('beats_visual_bible_failed', `Visual Bible call failed on attempt ${attempt}: ${err.message}`);
      }
    }
  }
  const vbMs = Date.now() - t;

  // ── Adopt the Visual Bible ────────────────────────────────────────────────
  // With no parseable bible the run is degraded — empty VB, blind briefs — and
  // says so loudly. It is never a kill: a contract miss must not end a paid run
  // (docs/SETTLED.md, gates are guidelines).
  if (adBible) {
    visualBible = adBible.visualBible;
    let bibleBody = adBible.body;
    // ONE authored English label per element, enforced the moment the bible is
    // adopted — BEFORE the clamp, so the clamp's own sync carries the labels too.
    const labelRound = await runVisualBibleLabelRound(visualBible, {
      model: sceneModel, language: inputData.language, gl, log, stageReport: meta,
    });
    if (labelRound.findings > 0) {
      const synced = syncVisualBibleSection(bibleBody, visualBible);
      if (synced === bibleBody) {
        log.warn('⚠️ [BEATS] Element labels could not be written back into the transcript — downstream re-parses will read the UNLABELLED bible');
        gl.warn('beats_vb_sync_failed', 'Element labels could not be written back into the transcript — stored bible will not reflect them');
      } else {
        bibleBody = synced;
      }
    }
    // An invented child the bible declares a PEER of the commissioned children
    // must state an age inside their band: clamp, flag, warn — never a kill
    // (job_1788641639919_mpjwlzkf1).
    const childBand = visualBible?.secondaryCharacters?.length
      ? commissionedChildBand(inputData.characters || [])
      : null;
    if (childBand) {
      const ageClamps = applySecondaryAgeBand(visualBible.secondaryCharacters, childBand, buildCharacterDescription);
      for (const a of ageClamps) {
        log.warn(`⚠️ [BEATS] ${a.detail} — clamped to ${a.clampedTo}`);
        gl.warn('beats_secondary_age_clamped', `${a.name} was ${a.statedAge} beside commissioned children ${childBand.min}-${childBand.max}; clamped to ${a.clampedTo}`, null, {
          id: a.id, statedAge: a.statedAge, clampedTo: a.clampedTo, bandLow: childBand.low, bandHigh: childBand.high,
        });
      }
      if (ageClamps.length > 0) {
        const synced = syncVisualBibleSection(bibleBody, visualBible);
        if (synced === bibleBody) {
          log.warn('⚠️ [BEATS] Age clamp could not be written back into the transcript — downstream re-parses will read the UNCLAMPED bible');
          gl.warn('beats_vb_sync_failed', 'Age clamp could not be written back into the transcript — stored bible will not reflect it');
        } else {
          bibleBody = synced;
        }
      }
    }
    // Append to the wardrobe transcript: CLOTHING REQUIREMENTS, VISUAL BIBLE.
    bibleSections = bibleSections ? `${bibleSections.trimEnd()}

${bibleBody}` : bibleBody;
    const vbCount = Object.values(visualBible).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
    gl.info('beats_visual_bible', `Visual Bible by ${adBible.modelId || sceneModel}: ${vbCount} entr(ies), written before the page briefs (${(vbMs / 1000).toFixed(1)}s)`, null, {
      vbEntries: vbCount, sections: adBible.found,
    });
  } else if (vbPrompt) {
    log.error('🚨 [BEATS] The Visual Bible call produced NO parseable bible after both attempts — story ships with an empty bible and blind briefs');
    gl.warn('beats_visual_bible_missing', 'The Art Director returned no parseable Visual Bible — story ships with an empty bible');
  }

  // Each real landmark's PHOTO VARIANTS on its bible entry (the resolver serves
  // the photo a vantage's `landmarkPhoto` cites). Cheap and idempotent.
  if (visualBible) {
    try {
      if (inputData.availableLandmarks?.length) {
        require('./visualBible').linkPreDiscoveredLandmarks(visualBible, inputData.availableLandmarks);
      }
      await require('./landmarkPhotos').loadLandmarkPhotoDescriptions(visualBible);
      const realLandmarks = (visualBible.locations || []).filter(l => l.isRealLandmark);
      if (realLandmarks.length > 0) {
        const withVariants = realLandmarks.filter(l => l.photoVariants?.length).length;
        log.info(`🌍 [BEATS] Landmark photo variants linked: ${withVariants}/${realLandmarks.length} real landmark(s) carry variants`);
      }
    } catch (err) {
      log.warn(`⚠️ [BEATS] Landmark linking/variants did not load: ${err.message}`);
    }
  }

  // ── Wardrobe contract vs Visual Bible ────────────────────────────────────
  // The contract owns garment wording (owner, 2026-09-23): a linked entry naming
  // the SAME garment takes the contract's words (`adopt`); a DIFFERENT garment in
  // an occupied slot becomes a new OUTFIT VERSION (owner, 2026-09-24). A throw
  // ships the contradiction rather than killing the run, but never silently.
  if (visualBible && clothingRequirements && Object.keys(clothingRequirements).length > 0) {
    try {
      const { applyWardrobeBibleCorrections } = require('./clothingCheck');
      const { findings, applied, versions, unresolved } = applyWardrobeBibleCorrections(clothingRequirements, visualBible);
      const correctionKey = (f) => `${f.character} ${f.category} ${f.slot} ${f.elementId || ''}`;
      const appliedKeys = new Set([...applied, ...versions].map(correctionKey));
      if (findings.length > 0) {
        wardrobeBibleReport = {
          conflicts: findings.map(f => ({
            kind: f.kind, character: f.character, category: f.category, slot: f.slot,
            elementId: f.elementId, elementLabel: f.elementLabel, elementText: f.elementText,
            wardrobeClause: f.wardrobeClause, corrected: appliedKeys.has(correctionKey(f)),
          })),
        };
        if (versions.length > 0) {
          wardrobeBibleReport.versions = versions.map(f => ({
            character: f.character, category: f.category, slot: f.slot, elementId: f.elementId,
            replaces: f.wardrobeClause, garment: f.elementText, outfit: f.versionOutfit,
          }));
        }
        gl.warn('beats_wardrobe_bible_conflict', `${findings.length} wardrobe/bible disagreement(s): ${findings.map(f => `${f.kind} ${f.character}/${f.slot} "${f.wardrobeClause}" vs ${f.elementId || '?'} "${f.elementLabel}"`).join('; ')}`, null, {
          conflicts: wardrobeBibleReport.conflicts,
        });
        if (unresolved.length > 0) {
          wardrobeBibleReport.unresolved = unresolved.map(f => ({
            kind: f.kind, character: f.character, category: f.category, slot: f.slot,
            elementId: f.elementId, elementLabel: f.elementLabel, wardrobeClause: f.wardrobeClause,
          }));
        }
      }
    } catch (err) {
      log.error(`🚨 [BEATS] Wardrobe-vs-bible check failed: ${err.message} — a contract/bible contradiction would ship unnoticed`);
    }
  }

  // Deliberately OUTSIDE every try/catch above: a throw from the caller's hook
  // must abort the run (the landmark-shortfall retry uses exactly that). Since
  // the split it fires before any page brief is paid for.
  if (onVisualBible && visualBible) await onVisualBible(visualBible);

  // ── The decided fields of every story page (Jev first) ───────────────────
  let fieldsReport = null;
  if (jevActive(jevReport)) try {
    const decided = await decideBriefFields({ beats, visualBible, bibleSections, approvedArc, inputData, present, gl });
    bibleSections = decided.bibleSections;
    fieldsReport = decided.report;
    if (jevReport) Object.assign(jevReport, { vb: decided.report.vb, population: decided.report.population, gaze: decided.report.gaze, locations: decided.report.locations });
  } catch (err) {
    if (!(err instanceof JevDecisionError) || !jevReport) throw err;
    // The backup: nothing is fixed, and the page-brief call authors every
    // field itself. No brief exists yet, so only the records are cleared.
    for (const b of beats) delete b.jevFixed;
    jevFallBack(jevReport, 'brief_fields', err, gl);
  }

  // ── The covers' places (Jev ranks, code makes them distinct) ─────────────
  // Owner, 2026-10-04: each cover gets a wide / ultra-wide vantage of a place
  // the story's pages stand on, a different one per cover while they last.
  // The result is the cover beat's location-only FIXED field (pinned like a
  // story page's location) and the covers' pages in the bible's tables.
  if (jevActive(jevReport) && coverBeats.length) try {
    const { decideCoverPlaces, applyCoverPlacePages } = require('./jevBriefFields');
    const places = await decideCoverPlaces({ arc: approvedArc, pages: beats, visualBible, coverKeys: coverBeats.map(cb => cb.coverKey) });
    if (jevReport) jevReport.coverPlaces = places;
    if (!places.covers.length) {
      log.error(`🚨 [BEATS] No cover place decided: ${places.reason} — the covers keep the Art Director's own-place rule`);
      gl.error('beats_cover_place_unassigned', `No cover place decided: ${places.reason} — the Art Director picks each cover's place under the own-place rule`, null, { reason: places.reason });
    }
    const citeByPage = new Map();
    for (const c of places.covers) {
      const cb = coverBeats.find(b => b.coverKey === c.coverKey);
      cb.jevFixed = { coverPlace: true, location: c.cite, labels: { [c.cite]: c.label } };
      citeByPage.set(Number(cb.pageNumber), c.cite);
    }
    if (visualBible && applyCoverPlacePages(visualBible, citeByPage) && bibleSections) {
      const synced = syncVisualBibleSection(bibleSections, visualBible);
      if (synced === bibleSections) gl.warn('beats_vb_sync_failed', 'The covers\' decided places could not be written back into the transcript');
      else bibleSections = synced;
    }
    gl.info('beats_jev_cover_places', `Cover places by Jev + code: ${places.covers.map(c => `p${coverBeats.find(b => b.coverKey === c.coverKey).pageNumber} ${c.cite} (${c.p}${c.shared ? ', shared' : ''})`).join(', ') || 'none'} over ${places.candidates.length} wide vantage(s)`, null, { covers: places.covers, candidates: places.candidates, stats: places.stats });
  } catch (err) {
    if (!(err instanceof JevDecisionError) || !jevReport) throw err;
    for (const cb of coverBeats) delete cb.jevFixed;
    jevFallBack(jevReport, 'cover_places', err, gl);
  }
  // A cover whose place code did not decide (the backup, or no candidate)
  // carries the Art Director's own-place rule into the page-brief call.
  if (coverBeats.some(cb => !(cb.jevFixed && cb.jevFixed.location))) {
    const ownRule = buildCoverBeats(inputData, { ...coverBeatOpts, placeDecided: false });
    for (const cb of coverBeats) {
      if (cb.jevFixed && cb.jevFixed.location) continue;
      cb.planLine = ownRule.find(o => o.coverKey === cb.coverKey).planLine;
    }
  }

  // ── Call 2: every page's brief ───────────────────────────────────────────
  t = Date.now();
  let expansions = [];
  // THE REPLY AS RETURNED, one row per attempt (2026-09-23): only parsed parts
  // were stored before, and an audit once compared the wrong bible.
  const adReplies = [];
  const allPrompt = labForcePerPage ? null : buildSceneBriefsAllPrompt(inputData, briefBeats, {
    jevBackup: !jevActive(jevReport),
    availableAvatars,
    maxCharactersPerScene,
    // The whole story, read-only, for the Art Director's judgment.
    finalArc: approvedArc,
    clothingRequirements,
    visualBible: visualBibleJsonOf(bibleSections),
  });
  if (!allPrompt) {
    log.error(labForcePerPage ? '🧪 [BEATS] Test Lab per-page comparison — every page expanded per-page' : '🚨 [BEATS] scene-briefs-all template unavailable — falling back to per-page expansion for every page');
    gl.warn('beats_scene_expansion_fallback', 'All-pages template unavailable — every page expanded per-page (no cross-page continuity)');
  } else {
    // Two attempts; the first attempt's pages win the merge, so a retry can
    // only FILL gaps (job_1788123310558 lost pages 12-16 to a cut reply).
    let allModelId = sceneModel;
    const byPage = new Map();
    await stage(36, 'Writing the scene briefs...', { next: 42, ms: 140000 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      let allRaw = '';
      try {
        const res = await textModels.callTextModelStreaming(allPrompt, null, onChunk, sceneModel, { usageLabel: 'beats_scene_expansion', ...labCallOptions });
        if (onCall) onCall(res);
        allRaw = res?.text || '';
        allModelId = res?.modelId || sceneModel;
        adReplies.push({ attempt, modelId: allModelId, text: allRaw });
      } catch (err) {
        log.error(`🚨 [BEATS] All-pages scene briefs attempt ${attempt} failed (${err.message}) — falling back to per-page expansion`);
        gl.warn('beats_scene_expansion_failed', `All-pages call failed on attempt ${attempt}: ${err.message} — falling back to per-page expansion`);
        break;
      }
      const parsed = parseRefinedText(allRaw, beatPageNumbers, 'SCENES', BRIEF_TRAILING_MARKERS);
      // A PAGE IS NOT A BRIEF: a page cut mid-sentence is not merged, which
      // hands it to the retry and the per-page fallback (iterateBriefGuard).
      const { partitionSceneBriefs, describeSceneBrief } = require('./iterateBriefGuard');
      const { whole, cut, formatWide } = partitionSceneBriefs(parsed.pages);
      for (const p of (formatWide ? cut : whole)) {
        if (!byPage.has(p.pageNumber)) byPage.set(p.pageNumber, p.text);
      }
      if (formatWide) {
        log.error(`🚨 [BEATS] All-pages attempt ${attempt}: not one of the ${cut.length} brief(s) meets the brief contract (${describeSceneBrief(cut[0].verdict)}) — accepting them as written rather than re-expanding the whole book`);
        gl.warn('beats_scene_brief_contract_missed', `No scene brief in the all-pages reply meets the brief contract (${cut.length} page(s), first: ${describeSceneBrief(cut[0].verdict)}) — briefs ship as written and every metadata-driven supervisor runs blind`);
      } else if (cut.length > 0) {
        const detail = cut.sort((a, b) => a.pageNumber - b.pageNumber)
          .map(p => `p${p.pageNumber} (${describeSceneBrief(p.verdict)})`).join('; ');
        const pages = cut.map(p => p.pageNumber);
        log.error(`🚨 [BEATS] All-pages attempt ${attempt}: incomplete brief(s) — ${detail} — treating them as NOT delivered`);
        gl.warn('beats_scene_brief_incomplete', `Brief(s) for page(s) ${pages.join(', ')} came back incomplete — ${detail}. Not accepted; re-expanded instead`, null, { pages });
      }
      if (briefBeats.every(b => byPage.has(b.pageNumber))) break;
      if (attempt === 1) {
        const missingNow = briefBeats.filter(b => !byPage.has(b.pageNumber)).map(b => b.pageNumber);
        log.error(`🚨 [BEATS] All-pages briefs incomplete: ${byPage.size}/${briefBeats.length} parsed, missing page(s) ${missingNow.join(', ')} — retrying the batch ONCE at full cap`);
        gl.warn('beats_scene_expansion_truncated', `All-pages call returned ${byPage.size}/${briefBeats.length} briefs, missing page(s) ${missingNow.join(', ')} — retrying the batch once at full output cap`);
      }
    }
    expansions = briefBeats
      .filter(b => byPage.has(b.pageNumber))
      .map(b => ({ pageNumber: b.pageNumber, brief: byPage.get(b.pageNumber), prompt: allPrompt, modelId: allModelId }));
  }

  // Page-count guard: only the MISSING pages are re-expanded per-page.
  const missingBriefs = briefBeats.filter(b => !expansions.some(x => x.pageNumber === b.pageNumber));
  if (missingBriefs.length > 0) {
    log.error(`🚨 [BEATS] All-pages briefs returned ${expansions.length}/${briefBeats.length} — re-expanding page(s) ${missingBriefs.map(b => b.pageNumber).join(', ')} per-page`);
    gl.warn('beats_scene_expansion_incomplete', `All-pages call returned ${expansions.length}/${briefBeats.length} briefs — page(s) ${missingBriefs.map(b => b.pageNumber).join(', ')} expanded per-page`);
    const recovered = await Promise.all(missingBriefs.map(expandOnePage));
    expansions = expansions.concat(recovered).sort((a, b) => a.pageNumber - b.pageNumber);
  }
  const briefsMs = Date.now() - t;
  meta.timings.sceneExpansionMs = vbMs + briefsMs;

  // ── Pin: code writes the decided fields ───────────────────────────────────
  const disobeyed = pinDecidedFields(expansions, briefBeats, gl);
  if (jevReport && fieldsReport) jevReport.fixedChanges = disobeyed;
  // Jev's weather is an ADVICE: a disagreement with the Art Director's own
  // weather is logged, never written.
  const disagree = beats.filter(b => b.fixed && b.fixed.weatherAdvice).map((b) => {
    const x = expansions.find(e => e.pageNumber === b.pageNumber);
    const f = x ? ((extractSceneMetadata(x.brief) || {}).fullData || extractSceneMetadata(x.brief) || {}) : {};
    return f.weather && f.weather !== b.fixed.weatherAdvice ? `p${b.pageNumber} AD ${f.weather} / Jev ${b.fixed.weatherAdvice}` : null;
  }).filter(Boolean);
  if (disagree.length) gl.info('beats_jev_weather_advice', `Weather, Art Director vs Jev (advisory): ${disagree.join(', ')}`, null, { disagree });

  // THE PROMPTS THAT WROTE THE BIBLE AND THE BRIEFS (2026-09-19): stored with
  // the replies. `prompts[]` is built by the caller (rollUpScenePrompts).
  const sceneExpansionReport = {
    durationMs: meta.timings.sceneExpansionMs,
    visualBibleMs: vbMs,
    briefsMs,
    fallbackPages: missingBriefs.map(b => b.pageNumber),
    visualBiblePrompt: vbPrompt || null,
    visualBibleReplies: vbReplies,
    replies: adReplies,
    jevFieldsDisobeyed: disobeyed,
  };
  gl.info('beats_scenes', `${expansions.length} scene briefs by ${sceneModel} (bible ${(vbMs / 1000).toFixed(1)}s + briefs ${(briefsMs / 1000).toFixed(1)}s)${missingBriefs.length ? ` (+${missingBriefs.length} per-page fallback)` : ''}; ${disobeyed.length} page(s) had decided fields restored`, null, {
    pages: expansions.length, fallbackPages: missingBriefs.map(b => b.pageNumber), model: sceneModel, disobeyed: disobeyed.map(d => d.pageNumber),
  });

  return {
    expansions, visualBible, bibleSections, wardrobeBibleReport, sceneExpansionReport, briefBeats, coverBeats, briefsPrompt: allPrompt,
    // Carried for the brief re-ask's slimmed context (briefChecks.runBriefChecks):
    // the same avatar list, cast cap and bible JSON this call itself used, so
    // the re-ask's context can never disagree with what wrote the briefs.
    availableAvatars, maxCharactersPerScene, visualBibleJson: visualBibleJsonOf(bibleSections),
  };
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
 * @returns {Promise<{title, beats, pages, scenes, rawOutline, meta, beatsReviewReport, storyBibleReport, clothingReviewReport, wardrobeBibleReport, briefCheckReport}>}
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
  // Create and re-tell are separate keys (owner, 2026-09-25: create on Opus
  // 5.5 at xhigh, re-tell on Opus 5) — models.js arcCreateModel.
  const arcCreateModel = modelOverrides.arcCreateModel || MODEL_DEFAULTS.arcCreateModel;
  const arcRetellModel = modelOverrides.arcRetellModel || MODEL_DEFAULTS.arcRetellModel;
  const arcPanelModels = (Array.isArray(MODEL_DEFAULTS.arcPanelModels) ? MODEL_DEFAULTS.arcPanelModels : [])
    .filter(m => TEXT_MODELS[m]);
  // Hard cap at 3 (owner, 2026-08-30): the iteration study peaked at v3 and
  // regressed at v4. The adaptive early stop below usually ends sooner.
  const arcRoundsRequested = parseInt(modelOverrides.arcRounds, 10) || MODEL_DEFAULTS.arcRounds || 1;
  const arcRoundsMax = MODEL_DEFAULTS.arcRoundsMax || 3;
  const arcRounds = Math.max(1, Math.min(arcRoundsMax, arcRoundsRequested));
  if (arcRoundsRequested > arcRoundsMax) log.warn(`⚠️ [ARC] arcRounds=${arcRoundsRequested} clamped to ${arcRoundsMax} (owner cap 2026-08-30 — iteration study regressed at round 4)`);
  // Scene and wardrobe reviews are their own decisions — see models.js. They
  // deliberately do NOT follow the beats reviewer.
  const clothingReviewModel = modelOverrides.clothingReviewModel || MODEL_DEFAULTS.clothingReviewModel || reviewModel;
  const sceneModel = modelOverrides.sceneDescriptionModel || MODEL_DEFAULTS.sceneDescription;
  const textModel = modelOverrides.textModel || MODEL_DEFAULTS.storyText;

  const meta = { pageCount, models: { planModel, arcCreateModel, arcRetellModel, arcPanelModels, arcRounds, planCheckModel: modelOverrides.planCheckModel || MODEL_DEFAULTS.planCheckModel, reviewModel, clothingReviewModel, sceneModel, briefReaskModel: sceneModel, textModel }, timings: {} };
  const started = Date.now();
  log.info(`🪜 [BEATS] job=${jobId} pages=${pageCount} plan=${planModel} arcCreate=${arcCreateModel} arcRetell=${arcRetellModel} arcPanel=${arcPanelModels.join('+')} arcRounds=${arcRounds} planCheck=${modelOverrides.planCheckModel || MODEL_DEFAULTS.planCheckModel} review=${reviewModel} wardrobeReview=${clothingReviewModel} scenes=${sceneModel} (bible + briefs + re-ask) text=${textModel}`);

  // THE JEV DECISION LAYER'S REPORT (owner, 2026-09-27): every decision the
  // layer makes on this story — cast cuts per re-plan round, shots, light, VB
  // citations, aboard, population, gaze — stored as `stories.data.jevDecisions`
  // so a run can be replayed; `fallback` is the backup switch (jevFallBack).
  const jevReport = { castCuts: [], shots: null, light: null, vb: null, population: null, gaze: null, fixedChanges: null, fallback: null, probe: null };
  // B — THE PRE-START HEALTH CHECK: one tiny Jev question. Down → the whole
  // story runs the backup (today's setup before the layer), never refused.
  {
    const probe = await jevDecisions.probeJev();
    jevReport.probe = probe;
    if (probe.ok) log.info(`🩺 [JEV] probe ok (${probe.ms} ms) — the decision layer is live for this story`);
    else jevFallBack(jevReport, 'start', new Error(`pre-start probe failed: ${probe.error}`), gl);
  }

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
  // out of existence. Since 2026-09-25 the re-telling runs only when a quoted
  // MAJOR or CRITICAL finding survives, and repairs only those (the gate in
  // the round loop; arcRepairFindings).
  await checkCancellation();
  // The random catalogue draw is an INPUT like any other — drawn ONCE, given to
  // the arc creator AND the beats planner, and persisted so "which challenges
  // was this book offered / which did it take" is answerable from the story
  // record (owner, 2026-08-29).
  //
  // The draw EXCLUDES what this account's earlier books actually TOOK
  // (loadUsedChallengeIds; owner, 2026-09-21 / 2026-09-27) — variety is a
  // selection rule, so no prompt ever mentions a previous story. The taken ids
  // (a subset of the offered ones) are persisted next to the drawn ones so the
  // next book can exclude this one.
  //
  // JEV SELECTS (owner, 2026-09-27): the landmark list is ordered by its fit
  // to the commissioned idea (LB2), and the draw is 12 at random from Jev's 20
  // best-fitting eligible entries (CB2) — both inside the layer's one switch:
  // on the backup the list keeps the resolver's shuffle and the draw is
  // today's random 25 (jevSelection.js).
  await jevSelection.selectStoryLandmarks(inputData, { jevReport, gl, mode: 'full' });
  const priorIds = await loadUsedChallengeIds(jobId, gl);
  const draw = await jevSelection.selectChallengeDraw({ inputData, excludeIds: priorIds.idsByStory, jevReport, gl });
  const challengeSelection = draw.selection;
  if (priorIds.stories > 0) {
    // EFFECTIVE, not offered. The draw sheds the oldest books whose ids its
    // band cannot afford, so the number that matters — and the one a story's
    // generationLog has to show — is how much memory actually survived.
    const kept = priorIds.idsByStory.slice(0, draw.effectiveStories);
    const excludedIds = [...new Set(kept.flat())];
    gl.info('arc_variety', `Excluding ${excludedIds.length} catalogue challenge(s) taken by ${draw.effectiveStories} of ${priorIds.stories} earlier book(s) on this account (${priorIds.examined} examined)`
      + (draw.effectiveStories < priorIds.stories ? ` — the oldest ${priorIds.stories - draw.effectiveStories} shed, this age band's pool cannot carry them` : ''), null, {
      storiesContributing: priorIds.stories, storiesExamined: priorIds.examined, storiesEffective: draw.effectiveStories, excludedIds,
    });
  } else if (priorIds.examined > 0) {
    // Books exist on this account and NONE of them contributed a taken id: the
    // exclusion is a no-op, which looks exactly like success unless it is said.
    gl.warn('arc_variety', `No cross-story exclusion: ${priorIds.examined} earlier book(s) examined, none recorded any challenge taken`, null, {
      storiesContributing: 0, storiesExamined: priorIds.examined, storiesEffective: 0, excludedIds: [],
    });
  }
  const challengeIdeas = draw.section;
  const challengeDrawIds = draw.ids;
  // Which drawn challenges the SHIPPED arc builds on: the created arc reports
  // them (arc-create "Challenges taken:"), and a re-telling, when the gate
  // opens, reports them again for the arc it writes. Checked once the arc
  // machine is done (reportChallengeMemoryBreach).
  let challengeTakenIds = [];
  // How many lines of that block carry a tag ([C###] or [own]): an arc built
  // only on its own challenges is valid; a block with no tagged line is not.
  let challengeTakenTagged = 0;
  const challengeDraw = challengeIdeas.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2));
  if (challengeDraw.length) gl.info('challenge_draw', `Drew ${challengeDraw.length} challenge idea(s) for the arc plan`, null, { challengeDraw, challengeDrawIds });
  let approvedArc = '';
  // The FINAL ARC's own critique — handed to the beats prompt as the known
  // weak points the page division must not amplify.
  let arcWeakPoints = '';
  // The lean flow's hint pass (owner verdict 2026-09-01): the top remaining
  // ISSUE → CHANGE lines on the final arc. They ride into the beats prompt
  // (applied while dividing) and the text writer (the text supports them).
  let arcHints = '';
  // The arc's own declared invented-figure list and the allowance it was given.
  // Both travel to the plan counters as a REPORTING-ONLY cross-check.
  let arcInventedNames = null;
  // Named figures the commission's PREMISE supplies that its character list does
  // not — a sibling, a friend, a pet. They are commissioned (the arc budget rule
  // has always excluded them from the invented count), but only the arc reads
  // the premise, so without this list the counters saw `inputData.characters`
  // alone and charged them against the invented allowance.
  let arcPremiseNames = [];
  let arcInventedLimit = null;
  // The commission's central figure as the arc's STORY LOGIC names it (null =
  // "none", or no arc). The planner, plan-check Q12 and the
  // CENTRAL_FIGURE_ABSENT_THIRD counter read it (owner, 2026-09-24, d4).
  let arcCentralFigure = null;
  // The final arc's STORY LOGIC block body (parseStoryLogic().text): the facts
  // it was told from. The planner, the re-plan and plan-check Q18 read it
  // (owner, 2026-09-26); '' when the arc machine failed.
  let arcStoryLogic = '';
  // The machine's full trail. Kept under the arcReviewReport key so the
  // storyJobPipeline persistence and the dev-mode wiring stay untouched.
  let arcReviewReport = null;
  // CROSS-STORY MEMORY: the challenges this account's previous books used. Only
  // the arc-plan call sees them — that is the one call that invents challenges;
  // every later stage divides and dresses what this one decided.
  let t = Date.now();
  try {
    const tempFor = arcTempFor;
    const creatorCall = makeArcCreatorCall(onChunk);

    // CREATE: ONE arc, its STORY LOGIC first (owner, 2026-09-24). A parse miss
    // (no or incomplete logic block, no ARC block) gets one full re-create,
    // then throws into the outer containment.
    await stage(1, 'Shaping the story arc...', { next: 2, ms: 90000 });
    const createPrompt = buildArcCreatePrompt(inputData, pageCount, { challengeIdeas });
    if (!createPrompt) throw new Error('arc-create template unavailable');
    let createRes = null;
    let commit = null;
    for (let attempt = 1; attempt <= 2 && !commit; attempt++) {
      createRes = await creatorCall(createPrompt, 'arc_create', arcCreateModel, null, MODEL_DEFAULTS.arcCreateEffort);
      try {
        commit = parseArcCreate(createRes.text);
      } catch (parseErr) {
        log.warn(`⚠️ [ARC] create parse failed (${parseErr.message})${attempt === 1 ? ' — one re-create' : ''}`);
        if (attempt === 2) throw parseErr;
      }
    }
    // THE CODE COUNTS (d1-d3): what the old critique certified itself. d1 and
    // d2 are logged only (D4); d3 drives the forced round below.
    const logArcCounts = (label, round, counts) => {
      if (!counts.sentencesInRange) {
        gl.warn('arc_length_out_of_range', `${label}: ${counts.sentences} numbered sentences against a range of ${counts.sentenceRange.lo}-${counts.sentenceRange.hi}`, null, { round, sentences: counts.sentences, range: counts.sentenceRange });
      }
      if (!counts.chainInRange) {
        gl.warn('arc_chain_out_of_range', `${label}: ${counts.chainLinks} chain links against a range of ${counts.chainRange.lo}-${counts.chainRange.hi}`, null, { round, chainLinks: counts.chainLinks, range: counts.chainRange });
      }
    };
    // The created arc's own "Challenges taken:" — the shipped value whenever
    // the re-telling gate stays shut; a re-telling replaces it.
    challengeTakenIds = commit.takenIds;
    challengeTakenTagged = commit.takenTagged;
    const createCounts = arcShapeCounts({ sentences: commit.sentences, logic: commit.logic, inputData, pageCount });
    logArcCounts('arc create', 0, createCounts);
    gl.info('arc_create', `Arc creator ${createRes.modelId || arcCreateModel} wrote one arc (${commit.sentences} sentences, ${createCounts.chainLinks} chain links, ${commit.logic.invented.length} new figure(s))`, null, {
      model: createRes.modelId || arcCreateModel, sentences: commit.sentences, chainLinks: createCounts.chainLinks,
      invented: commit.logic.invented, commissioned: commit.logic.commissioned, centralFigure: commit.logic.centralFigure,
    });
    // Defaults if every panel round comes back empty: the committed arc stands,
    // its own critique as the known weak points.
    approvedArc = commit.arc;
    arcWeakPoints = commit.critique;

    // PANEL + RE-TELL rounds. Round k>1 feeds the previous FINAL ARC + its
    // critique back to the same panel, then the same creator re-tells again.
    let currentBlock = commit.committed;
    // The story logic the current arc was told from — the create's, then each
    // re-telling's updated block.
    let currentLogic = commit.logic;
    const countsTrail = [{ round: 0, ...createCounts }];
    // The critique the NEXT re-telling's Fixing line answers — the create
    // critique for round 1, then each round's fresh critique.
    let prevCritique = commit.critique;
    const roundReports = [];
    // Why the re-telling did not run, or null (the gate below, 2026-09-25).
    let retellSkipped = null;
    // The invented-figure allowance this commission carries, and the list the
    // arc declares against it. Code re-counts the DECLARED LIST only — never
    // the arc prose (planCounters.js:227 documents why a regex cast extraction
    // over narrative is banned).
    // The list is the (new)-tagged figures of the STORY LOGIC (D1-A); the
    // (commissioned) ones feed commissionedCast, which drops the listed cast.
    const inventedAllowance = arcInventedAllowance(inputData);
    arcInventedLimit = inventedAllowance;
    arcInventedNames = commit.logic.invented;
    arcPremiseNames = commit.logic.commissioned;
    arcCentralFigure = commit.logic.centralFigure;
    // A forced round may extend the budget by one, never past the clamp, and
    // at most once per story.
    let roundBudget = arcRounds;
    let inventedRoundForced = false;
    for (let round = 1; round <= roundBudget; round++) {
      let forceAnotherRound = false;
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
        if (r.status === 'fulfilled') {
          // Each panelist reports its three worst issues (owner, 2026-09-25).
          // An issue none of whose quotes is in the arc, a line that is not an
          // issue line, and an issue past the third are dropped before the
          // re-telling reads them — each loudly. The raw reply stays in the
          // report beside what was kept and dropped.
          const f = filterPanelFindings(r.value.text, currentBlock);
          if (f.malformed.length) {
            gl.warn('arc_panel_malformed', `Panelist ${r.value.model} (round ${round}): ${f.malformed.length} line(s) not in the "<n>. [SEVERITY] (s<N>, …) …" issue shape dropped as parse errors`, null, { round, model: r.value.model, malformed: f.malformed });
          }
          if (f.dropped.length) {
            gl.warn('arc_panel_unquoted', `Panelist ${r.value.model} (round ${round}): ${f.dropped.length} issue(s) dropped — none of their quotes is in the arc`, null, { round, model: r.value.model, dropped: f.dropped });
          }
          if (f.overflow.length) {
            gl.warn('arc_panel_overflow', `Panelist ${r.value.model} (round ${round}): ${f.overflow.length} issue(s) past the three worst dropped`, null, { round, model: r.value.model, overflow: f.overflow });
          }
          panel.push({ ...r.value, raw: r.value.text, text: f.text, findings: f.findings, keptFindings: f.kept.length, droppedFindings: f.dropped, malformedFindings: f.malformed, overflowFindings: f.overflow });
          return;
        }
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
      gl.info('arc_panel', `Round ${round}: ${panel.length}/${arcPanelModels.length} panelists reported; findings kept ${panel.reduce((n, p) => n + p.keptFindings, 0)}, dropped as unquoted ${panel.reduce((n, p) => n + p.droppedFindings.length, 0)}`, null, {
        round, panelists: panel.map(p => p.model), failed: failedPanelists,
        kept: panel.map(p => p.keptFindings), dropped: panel.map(p => p.droppedFindings.length),
      });

      // No model names in prompts (owner, 2026-08-31): panelists appear as
      // letters, stable in arcPanelModels order. The letter→model mapping
      // stays in the trail via each panel entry's `letter` + `model`.
      panel.forEach((p, i) => { p.letter = String.fromCharCode(65 + i); });

      // THE RE-TELL GATE (owner, 2026-09-25; docs/decisions.md). A re-telling
      // answering MINOR findings made every judged arc worse (Lab #1459-1467),
      // and the early stops below only act BETWEEN rounds, so with one round
      // the re-telling always ran. It runs now only while a quoted MAJOR or
      // CRITICAL finding survives — the arc's own critique or the panel's —
      // and it is handed those findings alone. Same gate as the Lab mirrors
      // (testlab.js arc_effort / arc_panel_replay, sibling set arc-retell-gate).
      const { arcBlock, critique: roundCritique } = splitCommittedBlock(currentBlock);
      // + the Jev cast check (owner, 2026-09-27): a character on the list with no
      // act of their own is FEEDBACK for this round's re-telling if the gate opens
      // on its own findings; it never opens the gate.
      const { gate, jevCast } = await arcRepairFindingsWithCastCheck({
        critique: roundCritique, reviewedArc: arcBlock, panel, castNames: commissionedCast(inputData).listed,
      }, { jevFallback: jevReport.fallback });
      if (jevCast?.weak.length) {
        gl.info('arc_jev_cast', `Round ${round}: Jev cast check — ${jevCast.weak.map(w => `${w.name} ${w.score}`).join(', ')} with no act of their own; ${jevCast.delivered === 'retell' ? 'handed to the re-telling as feedback' : 'recorded only (the gate stayed shut)'}`, null, { round, ...jevCast });
      } else if (jevCast?.skipped) {
        gl.warn('arc_jev_cast_skipped', `Round ${round}: Jev cast check not run — ${jevCast.skipped}`, null, { round, skipped: jevCast.skipped });
      } else if (jevCast && !jevCast.ok) {
        gl.error('arc_jev_cast_failed', `Round ${round}: Jev cast check FAILED — no cast feedback this round: ${jevCast.error}`, null, { round, error: jevCast.error });
      }
      if (gate.critique.malformed.length || gate.critique.dropped.length) {
        gl.warn('arc_critique_dropped', `Round ${round}: critique faults dropped — ${gate.critique.malformed.length} not in the issue shape, ${gate.critique.dropped.length} quoting nothing in the arc`, null, { round, malformed: gate.critique.malformed, dropped: gate.critique.dropped });
      }
      const gateReport = {
        repair: gate.count, duplicates: gate.duplicates, critiqueRepair: gate.critiqueRepair, panelRepair: gate.panelRepair,
        critiqueDropped: gate.critique.dropped, critiqueMalformed: gate.critique.malformed,
        jevCast,
      };
      if (!gate.retell) {
        retellSkipped = gate.skipReason;
        roundReports.push({ round, panel, failedPanelists, panelPrompt, retellSkipped, gate: gateReport });
        gl.info('arc_retell_skipped', `Round ${round}: no quoted MAJOR or CRITICAL finding from the critique or the panel — the ${round === 1 ? 'created' : 'current'} arc is final`, null, {
          round, reason: retellSkipped, ...gateReport,
        });
        // The invented-figure count still applies to the arc that ships; no
        // round is forced for it here, because the re-telling it would force
        // has no MAJOR finding to repair.
        const shipping = round === 1 ? commit.logic.invented : currentLogic.invented;
        if (shipping.length > inventedAllowance) {
          gl.warn('arc_invented_overcount', `Round ${round}: ${shipping.length} invented figures (${shipping.join(', ')}) against an allowance of ${inventedAllowance} — no re-telling runs, the arc ships with the overrun`, null, { round, names: shipping, counted: shipping.length, allowance: inventedAllowance });
        }
        break;
      }
      gl.info('arc_retell_gate', `Round ${round}: ${gate.count} quoted MAJOR/CRITICAL finding(s) go to the re-telling (critique ${gate.critiqueRepair.length}, panel ${gate.count - gate.critiqueRepair.length})`, null, { round, ...gateReport });

      // RE-TELL: same creator, the arc + its story logic + the MAJOR and
      // CRITICAL findings, repaired sentence by sentence. A parse miss (no
      // FINAL ARC) gets one more telling, then throws.
      await stage(2, 'Re-telling the story arc...', { next: 3, ms: 90000 });
      const retellPrompt = buildArcRetellPrompt(inputData, pageCount, arcBlock, gate.text, { challengeIdeas });
      if (!retellPrompt) throw new Error('arc-retell template unavailable');
      let retellRes = null;
      let retold = null;
      for (let attempt = 1; attempt <= 2 && !retold; attempt++) {
        retellRes = await creatorCall(retellPrompt, 'arc_retell', arcRetellModel, MODEL_DEFAULTS.arcRetellTemperature, MODEL_DEFAULTS.arcRetellEffort);
        try {
          retold = parseArcRetell(retellRes.text);
        } catch (parseErr) {
          log.warn(`⚠️ [ARC] re-tell parse failed (${parseErr.message})${attempt === 1 ? ' — one more telling' : ''}`);
          if (attempt === 2) throw parseErr;
        }
      }
      approvedArc = retold.finalArc;
      currentLogic = retold.logic;
      const retellCounts = arcShapeCounts({ sentences: retold.sentences, logic: retold.logic, inputData, pageCount });
      countsTrail.push({ round, ...retellCounts });
      logArcCounts(`arc re-tell round ${round}`, round, retellCounts);
      // Which of the drawn challenges this book actually built on, by catalogue
      // id — the join between what was offered and what shipped. The last
      // re-telling wins: it is the one whose arc becomes the story.
      challengeTakenIds = retold.takenIds || [];
      challengeTakenTagged = retold.takenTagged || 0;
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
      // INVENTED-FIGURE RE-COUNT (2026-09-09; source moved 2026-09-24). The
      // arc used to grade its own cast inside the same call and self-certify:
      // job_1788903616404_iqvhj4l8m wrote four invented figures on an
      // allowance of two and reported "exactly two". The count is arithmetic
      // on the (new)-tagged figures of the STORY LOGIC, nothing else.
      const arcInvented = { names: retold.logic.invented };
      arcInventedNames = arcInvented.names;
      arcPremiseNames = retold.logic.commissioned;
      arcCentralFigure = retold.logic.centralFigure;
      const inventedCount = arcInvented.names.length;
      if (MODEL_DEFAULTS.arcForceRoundOnInventedOvercount && inventedCount > inventedAllowance) {
        const detail = { round, names: arcInvented.names, counted: inventedCount, allowance: inventedAllowance };
        if (inventedRoundForced) {
          log.warn(`⚠️ [ARC] Round ${round}: ${inventedCount} invented figure(s) [${arcInvented.names.join(', ')}] against an allowance of ${inventedAllowance} — a round was already forced for this story; shipping with the overrun`);
          gl.warn('arc_invented_overcount', `Round ${round}: ${inventedCount} invented figures (${arcInvented.names.join(', ')}) against an allowance of ${inventedAllowance} — one round was already forced; the arc ships with the overrun`, null, detail);
        } else if (round >= roundBudget && roundBudget >= arcRoundsMax) {
          log.warn(`⚠️ [ARC] Round ${round}: ${inventedCount} invented figure(s) [${arcInvented.names.join(', ')}] against an allowance of ${inventedAllowance} — cannot force another round at the clamp of ${arcRoundsMax}; shipping with the overrun`);
          gl.warn('arc_invented_overcount_declined', `Round ${round}: ${inventedCount} invented figures (${arcInvented.names.join(', ')}) against an allowance of ${inventedAllowance} — the round clamp of ${arcRoundsMax} is reached, so no round is forced; the arc ships with the overrun`, null, detail);
        } else {
          inventedRoundForced = true;
          forceAnotherRound = true;
          if (round >= roundBudget) roundBudget = Math.min(arcRoundsMax, roundBudget + 1);
          log.warn(`⚠️ [ARC] Round ${round}: ${inventedCount} invented figure(s) [${arcInvented.names.join(', ')}] against an allowance of ${inventedAllowance} — forcing one more re-telling round (budget now ${roundBudget}/${arcRoundsMax})`);
          gl.warn('arc_invented_overcount_forced', `Round ${round}: ${inventedCount} invented figures (${arcInvented.names.join(', ')}) against an allowance of ${inventedAllowance} — forcing one more panel + re-telling round`, null, { ...detail, roundBudget });
        }
      }
      roundReports.push({
        round,
        panel,
        failedPanelists,
        retellSkipped: null,
        gate: gateReport,
        // The prompts each round actually sent (2026-09-11). The report already
        // keeps every OUTPUT verbatim; without the inputs a dev-mode reader can
        // see what the panel said but not what it was asked, which is where a
        // prompt regression hides. Same treatment the beats and text stages
        // already give their prompts (outlinePrompt, storyTextPrompts).
        panelPrompt,
        retellPrompt,
        // The re-telling's raw reply (2026-09-23). The parsed fields below drop
        // its "Challenges taken:" head and strip the [C###] tags, so without
        // the raw nothing they were parsed from could be audited.
        retellRaw: retellRes.text,
        retellModel: retellRes.modelId || arcRetellModel,
        logic: retold.logic.text,
        finalArc: retold.finalArc,
        used: retold.used,
        fixing: retold.fixing,
        keeping: retold.keeping,
        critique: retold.critique,
        maxSeverity,
      });
      gl.info('arc_retell', `Round ${round}: ${retellRes.modelId || arcRetellModel} re-told the story (used: ${retold.used || 'not stated'}; worst surviving fault: ${maxSeverity || 'none'})`, null, {
        round, used: retold.used, maxSeverity, critiqueFaults: (retold.critique.match(/^\s*\d+[.)]/gm) || []).length,
      });
      // ADAPTIVE EARLY STOP (owner, 2026-08-30): another round only earns its
      // cost while a CRITICAL or MAJOR fault survives. When nothing above
      // MINOR remains, more rounds are where the study's regression came from.
      if (!forceAnotherRound && round < roundBudget && (maxSeverity === null || maxSeverity === 'MINOR')) {
        gl.info('arc_rounds_early_stop', `Round ${round}: critique has nothing above MINOR — skipping ${roundBudget - round} remaining round(s)`, null, {
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
      if (!forceAnotherRound && round < roundBudget && fixingBelowMajor(retold.fixing, prevCritique)) {
        gl.info('arc_rounds_early_stop', `Round ${round}: Fixing addressed nothing above MINOR — skipping ${roundBudget - round} remaining round(s)`, null, {
          round, maxSeverity, reason: 'fixing_below_major',
        });
        break;
      }
      prevCritique = retold.critique;
      currentBlock = `STORY LOGIC:\n${retold.logic.text}\n\nFINAL ARC:\n${retold.finalArc}\n\nCRITIQUE:\n${retold.critique}`;
    }

    // GROK HINT PASS (owner verdict 2026-09-01, lean flow): one outside look
    // at the final arc — the top remaining issues travel forward as hints,
    // never as another re-telling round. Advisory: failure skips, never blocks.
    // Prompt and raw reply are kept whether or not the pass parses (2026-09-23):
    // the prompt was built and sent but never stored, so a hint could not be
    // traced to what the pass was shown.
    arcStoryLogic = currentLogic.text;
    let hintsPrompt = null;
    let hintsRaw = null;
    const hintsModel = MODEL_DEFAULTS.arcHintsModel || 'grok-4.6';
    try {
      hintsPrompt = buildArcHintsPrompt(inputData, approvedArc, currentLogic.text);
      if (!hintsPrompt) throw new Error('arc-hints template unavailable');
      // null maxTokens = the model's own maximum; temp 0 on the non-Anthropic paths.
      const hintsRes = await textModels.callTextModelStreaming(hintsPrompt, null, onChunk, hintsModel, { usageLabel: 'arc_hints', ...tempFor(hintsModel, 0) });
      hintsRaw = hintsRes?.text || '';
      arcHints = parseArcHints(hintsRaw);
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
    // The last round that re-told (a skipped round carries a panel only).
    const lastRetold = roundReports.filter(r => !r.retellSkipped).at(-1) || null;
    // Everything the machine produced, verbatim — storage is cheap,
    // debuggability is the point. Text only, no images.
    arcReviewReport = {
      machine: 'create-panel-retell',
      creatorModel: createRes.modelId || arcCreateModel,
      panelModels: arcPanelModels,
      roundsConfigured: arcRounds,
      roundsRun: roundReports.length,
      // 'no MAJOR' when the gate kept the arc as it stood (2026-09-25), else null.
      retellSkipped,
      durationMs: meta.timings.arcMs,
      create: createRes.text,
      createPrompt,
      // The block the panel read: the create's logic, arc and critique.
      committed: commit.committed,
      // The STORY LOGIC the final arc was told from, and the create's own.
      // Stored here only (D5-a): finalArc keeps its shape for every reader.
      logic: currentLogic.text,
      createLogic: commit.logic.text,
      centralFigure: arcCentralFigure,
      // The code counts per round (round 0 = the create): sentences, chain
      // links and (new) figures against their ranges (D4: logged only).
      counts: countsTrail,
      rounds: roundReports,
      finalArc: approvedArc,
      fixing: lastRetold ? lastRetold.fixing : '',
      keeping: lastRetold ? lastRetold.keeping : '',
      maxSeverity: lastRetold ? lastRetold.maxSeverity : critiqueMaxSeverity(commit.critique),
      critique: lastRetold ? lastRetold.critique : arcWeakPoints,
      arcHints,
      hintsModel,
      hintsPrompt,
      hintsRaw,
    };
    gl.info('beats_arc', `Arc machine done: ${roundReports.length}/${arcRounds} round(s)${retellSkipped ? ` (re-telling skipped: ${retellSkipped})` : ''}, final arc by ${lastRetold ? arcRetellModel : arcCreateModel} (${(meta.timings.arcMs / 1000).toFixed(1)}s)`, null, {
      rounds: roundReports.length, createModel: arcCreateModel, retellModel: lastRetold ? arcRetellModel : null,
    });
    // Taken is a subset of offered: a tag the arc was never shown is a misread,
    // not a memory, and is dropped loudly.
    const offTheMenu = challengeTakenIds.filter(id => !challengeDrawIds.includes(id));
    if (offTheMenu.length) {
      gl.warn('arc_challenges_taken_undrawn', `The arc tagged ${offTheMenu.length} challenge(s) it was never offered (${offTheMenu.map(id => `C${id}`).join(', ')}) — dropped from the taken list`, null, { offTheMenu, challengeDrawIds });
      challengeTakenIds = challengeTakenIds.filter(id => challengeDrawIds.includes(id));
    }
    // The taken ids are the next book's whole memory: the shipped arc drew on
    // the draw, so an empty list is a broken tag contract, said loudly.
    reportChallengeMemoryBreach(jobId, challengeDrawIds, challengeTakenIds, gl, { tagged: challengeTakenTagged });
  } catch (err) {
    // Never block a story on the arc step: without it the planner writes the
    // arc inline exactly as it did before this stage existed.
    log.warn(`🚨 [BEATS] Arc machine failed (${err.message}) — planning beats without an arc`);
    gl.warn('beats_arc_failed', `Arc machine failed: ${err.message} — beats planned without an arc`);
    approvedArc = '';
    arcWeakPoints = '';
    arcHints = '';
    arcStoryLogic = '';
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
  const planPrompt = buildBeatsPrompt(inputData, pageCount, { finalArc: approvedArc, arcHints, storyLogic: arcStoryLogic, centralFigure: arcCentralFigure, legacyShots: legacyShotsOf(jevReport) });
  if (!planPrompt) throw new Error('story-beats template unavailable — beats pipeline cannot run');

  /**
   * One planner response -> its PAGE PLAN text and its parsed beats.
   *
   * Used twice: the first division, and the single re-plan the plan check may
   * request. Keeping it one function is what makes the re-plan a genuine
   * re-division — the second response is read exactly like the first, with no
   * merge path that could leave half a plan behind.
   */
  const readPlan = makePlanReader(expected, approvedArc);

  t = Date.now();
  await stage(3, 'Planning the story beats...', { next: 5, ms: 25000 });
  const planRes = await textModels.callTextModelStreaming(planPrompt, null, onChunk, planModel, { usageLabel: 'beats_plan' });
  meta.timings.planMs = Date.now() - t;
  const first = readPlan(planRes.text);
  // The planner's reply verbatim (2026-09-23): the report kept only the parsed
  // division, so what the model actually wrote — a line the parser dropped, a
  // preamble — was unrecoverable.
  const plannerReply = String(planRes.text || '');
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
  // THE CAST TABLE (owner, 2026-09-25): the promises the planner wrote before
  // its plan lines — each character's deed page and the pages they are in
  // frame on, and the last page's cast. The counters hold every plan line to
  // it (CAST_PROMISE_BROKEN) in the check and in each recheck, and a re-plan is
  // shown it and keeps it. A reply without a readable table is an ERROR, never
  // a default: the table's counter does not run, and the run says so.
  let castTable = null;
  let castTableError = null;
  if ((inputData?.characters || []).some(c => c && c.name)) {
    try {
      castTable = parsePlanCastBlock(plannerReply, { listed: commissionedCast(inputData).listed });
      log.info(`📋 [BEATS] CAST block: ${castTable.characters.map(c => `${c.name} deed p${c.deedPage} + ${c.alsoOn.join(',') || '-'}`).join('; ')}; ending p${castTable.ending.page}`);
    } catch (err) {
      castTableError = err.message;
      log.error(`❌ [BEATS] CAST block unreadable (${err.message}) — no plan line is held to a cast table this run`);
      gl.error('beats_cast_table_unreadable', `The planner's CAST block could not be read: ${err.message}. CAST_PROMISE_BROKEN does not run this run.`, null, { error: err.message });
    }
  }
  // The book's focus character, from the one place that decides it — never
  // the first name on the character list (MAIN_UNDER_HALF, 2026-09-25).
  const mainName = pickMainCharacters(inputData).focus?.name || null;

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
  const { commission, commissionedNames, placeNames, maxCast, planCheckModel } = planCheckInputs(inputData, { arcPremiseNames, modelOverrides });

  const runCheck = createPlanCheckRunner({
    inputData, approvedArc, arcHints, arcStoryLogic, arcCentralFigure, castTable, commission, commissionedNames, placeNames,
    maxCast, arcInventedNames, arcInventedLimit, mainName, planCheckModel, onChunk, gl,
    labPromptOptions: legacyShotsOf(jevReport) ? { legacyShots: true } : {},
  });


  t = Date.now();
  await stage(4, 'Checking the page division...', { next: 5, ms: 45000 });
  const check1 = await runCheck('plan_check', plan.pages, pagePlan);
  // The LEDGER of re-plan rounds, kept and discarded alike. The report's
  // canonical fields are derived from it by shippedReplanState() so they can
  // only ever describe the division that shipped.
  const replanRounds = [];
  // The check whose roster describes the shipped division: the head count the
  // shot assignment reads.
  let shippedCheck = check1;
  if (check1.lines.length > 0) {
    ({ beats, pagePlan, check: shippedCheck } = await runReplanRounds({
      inputData, pageCount, plan, check1, replanRounds, approvedArc, arcHints, arcStoryLogic, arcCentralFigure, castTable,
      commission, commissionedNames, maxCast, planModel, readPlan, runCheck, onChunk, gl, stage, checkCancellation, beats, pagePlan, jevReport,
    }));
  }
  meta.timings.planCheckMs = Date.now() - t;
  // ── Step 2b: THE SHOTS — Jev picks, code assigns and writes field 0 ───────
  await checkCancellation();
  {
    const shot = await finalizePlanShots({ approvedArc, beats, check: shippedCheck, gl, jevReport });
    beats = shot.beats;
    pagePlan = shot.pagePlan;
    jevReport.shots = shot.report;
    meta.timings.jevShotsMs = shot.report.elapsedMs || 0;
  }

  {
    // Stored under the beatsReviewReport key on purpose: the persistence in
    // storyJobPipeline, the dev-mode diff panels and the beats replay inputs
    // (beatsReplayInputs.js reads `beatsReviewReport.arc` as the pre-2026-09
    // fallback for the final arc) all key off it.
    //
    // The cross-story challenge memory no longer reads this key: since
    // 2026-09-19 variety is a selection rule on the draw and reads
    // `data->'challengeDrawIds'` instead (docs/decisions.md).
    // EVERY canonical field below describes the division that SHIPPED. A round
    // the loop threw away is kept verbatim under `discardedRounds` and nowhere
    // else, so the row and the log can no longer disagree with the book.
    const shipped = shippedReplanState(replanRounds);
    const beforePlan = new Map(plan.pages.map(p => [p.pageNumber, p.planLine || '']));
    const summary = [
      check1.lines.length ? `Findings on the first division:\n${check1.lines.join('\n')}` : 'The first division drew no findings.',
      shipped.changedPages.length ? `\nRe-divided page(s): ${shipped.changedPages.join(', ')}` : '',
      shipped.recheck ? `\nFindings after the re-plan:\n${(shipped.recheck.lines || []).join('\n') || '(none)'}` : '',
      shipped.discardedRounds.length
        ? `\nDiscarded re-plan round(s) (not in the shipped division, kept under discardedRounds): ${shipped.discardedRounds.map(d => `round ${d.round} — ${d.reason}`).join('; ')}`
        : '',
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
      // The CAST block the first division wrote, parsed (2026-09-25); null
      // with `castTableError` when the reply carried none that could be read.
      castTable,
      castTableError,
      changedPages: shipped.changedPages,
      pages: shipped.changedPages.map(n => ({
        pageNumber: n,
        before: `PLAN: ${beforePlan.get(n) || ''}`,
        after: `PLAN: ${(beats.find(b => b.pageNumber === n) || {}).planLine || ''}`,
      })),
      recheck: shipped.recheck,
      // Always written, empty array included: an empty list says "no round was
      // thrown away", while a MISSING key says "this row predates the fix and
      // its canonical fields may describe a discarded round" (2026-09-18).
      discardedRounds: shipped.discardedRounds,
      // The structural edits the shipped division's rounds DECLARED, and the
      // ones the review refused. Empty arrays mean nothing was declared and
      // nothing refused; a MISSING key means the row predates declarations.
      declaredChanges: shipped.declaredChanges,
      changeRefusals: shipped.changeRefusals,
      prompt: check1.prompt || '',
      // THE PROMPT THAT DIVIDED THE BOOK. `prompt` above is the CHECKER's; the
      // planner's was stored nowhere, so answering "what was this division
      // actually asked for" meant rebuilding buildBeatsPrompt in a worktree at
      // the run's commit from inputData + finalArc + arcHints — which is a
      // reconstruction, not the bytes sent. The arc stage has kept its
      // creator prompt (`arcReviewReport.createPrompt`) since it was written.
      plannerPrompt: planPrompt || '',
      plannerReply,
      // …and the RE-PLAN prompts, one per kept round. `plannerPrompt` is the
      // FIRST division's; the re-plan request is the only prompt in this stage
      // that carries the findings (## MUST FIX / ## ALSO NOTED), so it is the
      // only one that answers "what was this round asked to fix". A discarded
      // round keeps its own under `discardedRounds[].replanPrompt`.
      replanPrompts: shipped.replanPrompts,
      replanReplies: shipped.replanReplies,
      // The first check's WANTED and ACTION lines (2026-09-23).
      wanted: check1.wanted || [],
      actions: check1.actions || [],
      // The checker's reply verbatim, and the roster as the counters received
      // it. See the comment in runCheck: `modelFindings: []` is otherwise
      // unreadable.
      checkReply: check1.reply || '',
      rosterLines: check1.rosterLines || [],
      briefsIn: plan.pages.map(x => ({
        pageNumber: x.pageNumber,
        brief: `PLAN: ${x.planLine || ''}`,
      })),
    };
    // Reads from `shipped`, same as the row: a reader of the log and a reader of
    // the stored report must reach the same conclusion about the same book.
    gl.info('beats_plan_checked', `Division checked: ${check1.lines.length} finding(s), ${shipped.changedPages.length} page(s) re-divided${shipped.recheck ? `, ${(shipped.recheck.lines || []).length} remaining` : ''}${shipped.discardedRounds.length ? `, ${shipped.discardedRounds.length} round(s) discarded` : ''} (${(meta.timings.planCheckMs / 1000).toFixed(1)}s)`, null, {
      findings: check1.lines.length,
      replanned: shipped.changedPages.length,
      remaining: shipped.recheck ? (shipped.recheck.lines || []).length : null,
      discardedRounds: shipped.discardedRounds.length,
    });
  }

  // ── Step 3: WARDROBE contract from the locked beats ───────────────────────
  // Clothing ONLY since 2026-09-11. The Visual Bible and the cover hints used
  // to be written here and are now authored by the all-pages Art Director
  // below, alongside the page briefs — a bible written at this point had to
  // guess which page used which element from plan-line prose, and on
  // job_1789147573901_m3uam0nxi that guess emptied the story's central prop and
  // the signpost carrying the plot-critical text.
  //
  // Clothing did NOT move, deliberately: the styled avatars are the long pole
  // in front of every image and start the instant this call returns (via
  // onClothingRequirements below). Clothing depends on the cast and the
  // setting, both fixed by the plan, so it needs nothing the Art Director adds.
  //
  // The call never throws: a beats run without a wardrobe is degraded (null
  // clothing, avatars from the stored wardrobe) but must still produce a story.
  await checkCancellation();
  const bibleModel = planModel;
  // The transcript spliced into rawOutline. The wardrobe section lands here
  // first; the Art Director's bible + cover sections are appended to it below.
  let bibleSections = null;
  // Authored by the ALL-PAGES Art Director, further down. Declared here because
  // the clothing review, the avatar kickoff and expandOnePage all close over it.
  let visualBible = null;
  let clothingRequirements = null;
  // What the wardrobe call was sent and what it answered, verbatim — the
  // transcript's CLOTHING section is rewritten by the review and by the
  // wardrobe-vs-bible check, so it is not a copy of the reply.
  let storyBibleReport = null;
  // The wardrobe-vs-Visual-Bible check, filled once the Art Director has run.
  let wardrobeBibleReport = null;
  // The arc names whose garment the plot uses ("lift the egg in X's jacket");
  // the plan line often says only "his jacket".
  const biblePrompt = buildStoryBibleFromBeatsPrompt(inputData, beats, { arc: approvedArc });
  if (!biblePrompt) {
    log.warn('⚠️ [BEATS] story-bible-from-beats template unavailable — no clothing requirements');
    gl.warn('beats_story_bible_failed', 'Wardrobe template unavailable — story ships with no clothing contract');
  } else {
    t = Date.now();
    try {
      await stage(18, 'Building the wardrobe contract...', { next: 23, ms: 71000 });
      const bibleRes = await textModels.callTextModelStreaming(biblePrompt, null, onChunk, bibleModel, { usageLabel: 'beats_story_bible' });
      const sections = extractBibleSections(bibleRes.text || '', CLOTHING_MARKERS);
      meta.timings.storyBibleMs = Date.now() - t;
      storyBibleReport = {
        model: bibleRes.modelId || bibleModel,
        durationMs: meta.timings.storyBibleMs,
        prompt: biblePrompt,
        rawResponse: bibleRes.text || '',
      };
      if (!sections) {
        log.warn(`🚨 [BEATS] Wardrobe call returned no parseable section marker (${(bibleRes.text || '').length} chars)`);
        gl.warn('beats_story_bible_failed', `${bibleRes.modelId || bibleModel} emitted no ---CLOTHING REQUIREMENTS--- marker — story ships with no clothing contract`);
      } else {
        bibleSections = sections.body;
        // Parse with the SAME parser server.js will run over the finished
        // transcript, so what this stage hands on and what the story stores
        // downstream can never diverge.
        clothingRequirements = new UnifiedStoryParser(bibleSections).extractClothingRequirements();
        gl.info('beats_story_bible', `Wardrobe contract by ${bibleRes.modelId || bibleModel}: ${Object.keys(clothingRequirements || {}).length} clothing req(s) (${(meta.timings.storyBibleMs / 1000).toFixed(1)}s)`, null, {
          clothingChars: Object.keys(clothingRequirements || {}).length, model: bibleRes.modelId || bibleModel,
        });
      }
    } catch (err) {
      meta.timings.storyBibleMs = Date.now() - t;
      log.warn(`🚨 [BEATS] Wardrobe call failed (${err.message}) — story ships with no clothing contract`);
      gl.warn('beats_story_bible_failed', `${bibleModel} failed: ${err.message} — story ships with no clothing contract`);
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
    const clothingPrompt = buildClothingReviewPrompt(inputData, clothingRequirements, beats);
    if (!clothingPrompt) {
      gl.warn('beats_clothing_review_failed', 'Clothing review template unavailable — wardrobe shipped unreviewed');
    } else {
      t = Date.now();
      try {
        const cRes = await textModels.callTextModelStreaming(clothingPrompt, null, onChunk, clothingReviewModel, { usageLabel: 'beats_clothing_review', reasoning: MODEL_DEFAULTS.clothingReviewReasoning });
        const parsed = parseClothingReview(cRes.text || '');
        meta.timings.clothingReviewMs = Date.now() - t;
        const rewrites = [];
        const stray = [];
        for (const fix of parsed.entries) {
          // Match the character case-insensitively — the reviewer echoes the
          // name back and case drift must not silently drop a correction.
          // RESOLVE: one name-keyed-map reader for the reviewer's echoed name.
          const hit = lookupByName(clothingRequirements, fix.name, null);
          const name = hit ? hit.key : null;
          let entry = hit ? hit.value?.[fix.category] : null;
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
          reasoning: MODEL_DEFAULTS.clothingReviewReasoning,
          durationMs: meta.timings.clothingReviewMs,
          analysis: parsed.analysis || '',
          changed: rewrites,
          // The whole reply: a stray entry (a creature the reviewer dressed)
          // is dropped from `changed`, so this is the only copy of its text.
          rawResponse: cRes.text || '',
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

  // THE OUTFIT GUARD (owner, 2026-09-28): every commissioned character leaves
  // the wardrobe with an outfit. A character without one is handed to every
  // brief author as "Wearing: NONE" and drawn undressed (bug
  // clothing-review-none-body-erases-outfit). Code invents no garment, so this
  // is loud, never a silent default.
  if (clothingRequirements && Object.keys(clothingRequirements).length > 0) {
    const { outfitAbsent } = require('./clothingCheck');
    const absent = outfitAbsent(clothingRequirements, (inputData.characters || []).map(c => c && c.name).filter(Boolean));
    if (absent.length > 0) {
      log.error(`❌ [BEATS] No outfit in the wardrobe contract for ${absent.join(', ')} — every brief will describe them undressed`);
      gl.error('beats_outfit_absent', `The wardrobe contract gives ${absent.join(', ')} no outfit to wear`, null, { characters: absent });
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
  const ad = await runArtDirector({
    inputData, modelOverrides, clothingRequirements, visualBible, bibleSections, sceneModel, onChunk, gl, meta, stage,
    beats, arcCentralFigure, approvedArc, onVisualBible, wardrobeBibleReport, jevReport,
    // The gaze roster: the head count of the division that shipped — the same
    // `present` the shot assignment read (finalizePlanShots).
    present: presentOf(shippedCheck),
  });
  let expansions = ad.expansions;
  visualBible = ad.visualBible;
  bibleSections = ad.bibleSections;
  wardrobeBibleReport = ad.wardrobeBibleReport;
  const { sceneExpansionReport, briefBeats, coverBeats } = ad;
  const { isCoverPage } = require('./coverBeats');

  // ── Step 4b: the brief checks and the ONE re-ask (owner, 2026-09-28) ─────
  // There is no scene review (deleted 2026-09-28): the decided fields reached
  // the Art Director before it wrote, so what is left to catch is what code can
  // check — including the review rules the owner kept as code checks (Q9).
  await checkCancellation();
  const { runBriefChecks } = require('./briefChecks');
  const briefCheckReport = await runBriefChecks({
    inputData, expansions, briefBeats, visualBible, clothingRequirements,
    visualBibleJson: ad.visualBibleJson, availableAvatars: ad.availableAvatars, maxCharactersPerScene: ad.maxCharactersPerScene,
    model: sceneModel, gl, stage,
  });
  meta.timings.briefChecksMs = briefCheckReport.durationMs;
  // Lettering the re-ask declared (required_text_undeclared) reaches the
  // transcript every later re-parse reads.
  if (briefCheckReport.bibleText?.applied.length && bibleSections) {
    const synced = syncVisualBibleSection(bibleSections, visualBible);
    if (synced === bibleSections) gl.warn('beats_vb_sync_failed', 'The re-ask\'s declared text could not be written back into the transcript');
    else bibleSections = synced;
  }

  // VB ELEMENT BUDGET — REPORTED HERE, NEVER ENFORCED (owner, 2026-09-11).
  // `truncateBriefToBudget` used to cut each brief's `objects[]` down to the
  // budget at this point, lowest-ranked first. It was removed with the
  // assignment trim above: code has no way to know which objects a page is
  // about, and dropping a citation removes the object from the page prompt's
  // REQUIRED OBJECTS line even though its reference cell exists — the same
  // failure as the trim, one layer down. The budget is now enforced ONLY where
  // it is understood: the Art Director's prompt and the Jev element decision,
  // both fed from VB_ELEMENT_BUDGET. An overflowing brief ships with
  // every object it asked for.
  // The overflow REPORT stays: it is stored per page as `vbElementOverflow`
  // and the Lab measures reviewer behaviour with it. `dropped` now means
  // "over budget and shipped anyway", not "removed from the brief".
  const vbOverflowByPage = new Map();
  try {
    // Same call, same ranking — its rewritten `brief` is DISCARDED. Reusing it
    // keeps one source of truth for what counts and what ranks lowest; only
    // the assignment of `x.brief` is gone.
    const { truncateBriefToBudget, VB_ELEMENT_BUDGET } = require('./vbElementBudget');
    for (const x of expansions) {
      const t2 = truncateBriefToBudget(x.brief, visualBible, x.pageNumber);
      if (!t2) continue;
      vbOverflowByPage.set(x.pageNumber, { requested: t2.requested, kept: t2.kept, dropped: t2.dropped });
      log.warn(`⚠️ [BEATS] VB element budget: page ${x.pageNumber} references ${t2.requested.length} elements after the brief checks — over budget, shipping as written (lowest-ranked: ${t2.dropped.join(', ')})`);
      gl.warn('beats_vb_element_overflow',
        `Page ${x.pageNumber} references ${t2.requested.length} Visual Bible elements (budget ${VB_ELEMENT_BUDGET}) after the brief checks — shipped unchanged, lowest-ranked ${t2.dropped.join(', ')}`,
        null, { pageNumber: x.pageNumber, requested: t2.requested, kept: t2.kept, dropped: t2.dropped, enforced: false });
    }
    if (vbOverflowByPage.size === 0) log.info('🧱 [BEATS] VB element budget: every page within budget');
  } catch (vbErr) {
    log.warn(`⚠️ [BEATS] VB element budget check failed (${vbErr.message}) — briefs ship as written`);
  }

  // ── The covers leave here ─────────────────────────────────────────────────
  // Briefed and reviewed with the pages; from here on they are not story
  // pages: no page text, no story-page assembly. Returned as `coverScenes`.
  const coverExpansions = expansions.filter(x => isCoverPage(x.pageNumber));
  expansions = expansions.filter(x => !isCoverPage(x.pageNumber));
  for (const cb of coverBeats) {
    if (!coverExpansions.some(x => x.pageNumber === cb.pageNumber)) {
      log.error(`🚨 [BEATS] ${cb.coverKey} (page ${cb.pageNumber}) has no Art Director brief — that cover will not be rendered`);
      gl.error('beats_cover_brief_missing', `${cb.coverKey} has no Art Director brief — the cover is not rendered`, null, { coverKey: cb.coverKey });
    }
  }

  // ── Step 6: page text — runs HERE, after the brief checks, with the briefs ─
  await stage(51, 'Writing the page text...', { next: 56, ms: 75000 });
  const textResult = await runStoryText(expansions);
  const { textRaw, textModelId, parsedText, textPromptSent, textUsage } = textResult;

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
  // The block runs to the next block marker or to the end of the reply — it is
  // the LAST block since 2026-09-11 (the title is picked from the finished
  // pages, not guessed ahead of them), and the old lookahead required a
  // following `---X` that no longer exists.
  // The writer's TITLE block. Parsed by the shared helper in promptBuilders so
  // this pipeline and the Test Lab stages that replay the SAME page-text call
  // read it identically — the Lab replay extracted no title at all until
  // 2026-09-20 and reported `title: null` on every run.
  const { parseTitleBlock } = require('./promptBuilders');
  const parsedTitle = parseTitleBlock(textRaw);
  const { outOfRange } = parsedTitle;
  if (outOfRange) {
    log.warn(`⚠️ [BEATS] TITLE_PICK out of range (${outOfRange}) — falling back to the hash pick`);
  }
  // THE TITLE GOES THROUGH THE LECTOR (2026-10-04) before anything renders it —
  // the front cover bakes it into the art. See applyTitleProofread.
  const { title, titleCandidates, titleJudge, titleProofread } = await applyTitleProofread(inputData, parsedTitle, gl);
  meta.titleProofread = titleProofread;

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
    // The plan line's shot is what the planner ASKED for; the brief's is what
    // the Art Director drew, and the scene review deliberately rewrites a
    // close-up to medium without touching the plan. The writer is told the PLAN
    // line names the shot, so from here on it names the shot that shipped.
    // `beatsReviewReport.pagePlan` was captured before the Art Director ran and
    // keeps its meaning: the division the planner decided.
    const shotMoves = [];
    for (const b of beats) {
      const brief = (finalExpansions || []).find(x => x && x.pageNumber === b.pageNumber);
      if (!brief || !brief.brief) continue;
      const shot = (extractSceneMetadata(brief.brief) || {}).shot;
      const next = refreshPlanShot(b.planLine, shot);
      if (!next.changed) continue;
      b.planLine = next.planLine;
      shotMoves.push(`p${b.pageNumber} ${next.from}->${next.to}`);
    }
    if (shotMoves.length) {
      log.info(`🎬 [BEATS] Plan shot refreshed from the finished brief on ${shotMoves.length} page(s): ${shotMoves.join(', ')}`);
    }
    const withBrief = (finalExpansions || []).filter(x => x && x.brief).length;
    log.info(`🪜 [BEATS] Step 6 page text: ${withBrief}/${beats.length} page(s) carry a locked scene brief`);
    if (!withBrief) {
      // Never silent: without briefs this is the OLD sibling behaviour, and the
      // text can contradict the art again.
      log.warn('⚠️ [BEATS] Step 6 has NO scene briefs — text is being written blind to the illustrations');
      gl.warn('beats_text_without_briefs', 'Page text written without scene briefs — text and art may disagree');
    }
    const textPrompt = buildStoryTextFromBeatsPrompt(inputData, beats, finalExpansions, approvedArc, { arcHints, visualBible, clothingRequirements });
    if (!textPrompt) throw new Error('story-text-from-beats template unavailable — beats pipeline cannot run');
    const beatPages = beats.map(b => b.pageNumber);
    let raw = '';
    let modelId = textModel;
    let parsed = null;
    let usage = null;
    const t0 = Date.now();
    for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
      try {
        const res = await textModels.callTextModelStreaming(textPrompt, null, onChunk, textModel, { usageLabel: 'beats_story_text' });
        // TITLE is the LAST block (2026-09-11) — name it so the final page's
        // text stops there instead of swallowing it.
        const candidate = parseRefinedText(res.text || '', beatPages, 'STORY TEXT', ['TITLE']);
        if (candidate.pages.length === 0 || candidate.missing.length > 0) {
          log.warn(`⚠️ [BEATS] Text attempt ${attempt}: ${candidate.pages.length} page(s) parsed, missing ${candidate.missing.join(', ') || 'none'}`);
          if (attempt < 2) continue;
        }
        raw = res.text || '';
        modelId = res.modelId || textModel;
        usage = res.usage || null;
        parsed = candidate;
      } catch (err) {
        log.warn(`⚠️ [BEATS] Story text attempt ${attempt} failed: ${err.message}`);
        if (attempt >= 2) throw err;
      }
    }
    meta.timings.storyTextMs = Date.now() - t0;
    if (!parsed || parsed.pages.length === 0) throw new Error('Beats text writer returned no parseable pages');
    // The prompt and the RAW reply travel with the parse (2026-09-06). Step 1
    // of story-text-from-beats.txt is an ---ANALYSIS--- block — which stretch
    // each page tells, which pages risk repeating the one before, which arc
    // facts have not found a page. parseRefinedText splits it off and only the
    // page bodies were kept, so the writer's own continuity reasoning was
    // unrecoverable after the run. `raw` carries it verbatim; `parsed.analysis`
    // is the same block already isolated.
    return { textRaw: raw, textModelId: modelId, parsedText: parsed, textPromptSent: textPrompt, textUsage: usage };
  }

  // ── Assemble the downstream contract ──────────────────────────────────────
  const textByPage = new Map(parsedText.pages.map(p => [p.pageNumber, p.text]));
  const briefByPage = new Map(expansions.map(x => [x.pageNumber, x]));

  const pages = [];
  const scenes = [];
  for (const b of beats) {
    // stripTrailingSeparator: the writer's "---" page rule, when it lands
    // INSIDE the page body, survives the parser's cut at the next heading and
    // ships under the illustration (job_1789348171785_9oxos7dwv p1/p2/p8).
    const text = stripTrailingSeparator((textByPage.get(b.pageNumber) || '').trim());
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
      // Set when the fed-back worn-state round left an item undeclared: the
      // render used the "worn" default, so the page is worth a human look.
      wornStateUnresolved: exp?.wornStateUnresolved || false,
      outlineCharacters: characters,
      // Marker kept as a sniffable "PLAN:" prefix: storyScorecard, textRefine
      // and the Lab's stored-beats recovery all decide beats-vs-unified mode
      // from this field's shape.
      outlineExtract: `PLAN: ${b.planLine || ''}`,
      // The decided fields (2026-09-28), stored so an iterate rewrite re-pins them.
      ...(b.jevFixed ? { jevFixed: b.jevFixed } : {}),
      // Present only on a page whose brief went OVER the element budget:
      // {requested, kept, dropped} ids, for the page view and the Lab. Since
      // 2026-09-11 nothing is actually dropped — the brief ships as written
      // and `dropped` names the lowest-ranked ids that went over.
      ...(vbOverflowByPage.has(b.pageNumber) ? { vbElementOverflow: vbOverflowByPage.get(b.pageNumber) } : {}),
    });
  }
  if (pages.length === 0) throw new Error('Beats pipeline produced no usable pages');

  // THE COVER PAGES — each one a brief the Art Director wrote from its cover
  // beat, in the same record shape a story scene has (no text). The caller
  // renders them through the page path into `coverImages` (coverKeys:
  // COVER_PAGE_NUMBERS). `coverKey` names the cover.
  const { coverKeyOfPage } = require('./coverBeats');
  const coverScenes = coverExpansions.map((exp) => {
    const cb = coverBeats.find(b => b.pageNumber === exp.pageNumber) || {};
    const sm = extractSceneMetadata(exp.brief);
    if (!sm) log.warn(`⚠️ [BEATS] Cover page ${exp.pageNumber}: brief has no parseable METADATA block`);
    return {
      pageNumber: exp.pageNumber,
      coverKey: coverKeyOfPage(exp.pageNumber),
      text: '',
      sceneHint: cb.planLine || '',
      sceneDescription: exp.brief,
      sceneDescriptionPrompt: exp.prompt || null,
      sceneDescriptionModelId: exp.modelId || sceneModel,
      characterClothing: sm?.characterClothing || {},
      characters: sm?.characters || [],
      outlineCharacters: sm?.characters || [],
      outlineExtract: `PLAN: ${cb.planLine || ''}`,
      wornStateUnresolved: exp.wornStateUnresolved || false,
      // The cover's decided place (2026-10-04), stored so an iterate rewrite re-pins it.
      ...(cb.jevFixed ? { jevFixed: cb.jevFixed } : {}),
      ...(vbOverflowByPage.has(exp.pageNumber) ? { vbElementOverflow: vbOverflowByPage.get(exp.pageNumber) } : {}),
    };
  });

  // USAGE COMES FROM THE BRIEFS. The bible's `pages` were guessed before a
  // single brief existed; the briefs are now final, so rebuild every entry's
  // `appearsInPages` (and its states/vantages) from what they actually cite.
  // This runs BEFORE rawOutline is assembled and before the caller kicks off
  // the reference sheet (storyJobPipeline, full mode), so the cells that get
  // rendered are the elements the story asks for — and an entry no brief cites
  // truthfully renders none. See job_1789147573901_m3uam0nxi, where the old
  // plan-line trim emptied the central prop and the lettered signpost that p10
  // then asked for by id. Never a kill: a page with no parseable metadata
  // contributes nothing, and with no briefs at all this is a no-op.
  if (visualBible) {
    const { applyBriefUsage } = require('./vbElementBudget');
    // The covers count: an element only a cover cites still needs its reference
    // cell. Their negative page numbers mark cover rows in the page tables.
    const usage = applyBriefUsage(visualBible, [...scenes, ...coverScenes]);
    // A BRIEF THAT COULD NOT BE READ IS NOT A BRIEF THAT ASKS FOR NOTHING.
    // Those pages keep the bible's own assignment rather than withdrawing every
    // element from it (applyBriefUsage header) — and they are named here, so the
    // absence is in the log and the generation record instead of looking like a
    // page the Art Director chose to leave bare. Outside the `applied` branch on
    // purpose: an unread page is worth saying even when no entry changed.
    if (usage.unreadPages && usage.unreadPages.length > 0) {
      const pages = usage.unreadPages.join(', ');
      log.error(`❌ [VB-USAGE] Page(s) ${pages}: the brief's METADATA could not be read, so nothing on them could be credited — those pages keep the Visual Bible's own page assignment instead of losing every element to an unreadable brief`);
      gl.warn('vb_usage_brief_unread',
        `Visual Bible usage could not be derived for page(s) ${pages} — their briefs have no readable METADATA, so the bible's assignment for them stands unverified`,
        null, { unreadPages: usage.unreadPages });
    }
    if (usage.applied) {
      const changed = usage.entries.filter(e => e.gained.length || e.lost.length);
      if (beatsReviewReport) beatsReviewReport.vbBriefUsage = usage;
      const detail = changed.slice(0, 12)
        .map(e => `${e.id} [${e.oldPages.join(',')}] → [${e.newPages.join(',')}]`).join('; ');
      // AN ELEMENT OR A LOOK THE BOOK NO LONGER REACHES IS A WARNING, not a
      // status line. Both mean the bible and the briefs — written in one
      // Art-Director breath — disagree about what is on the page, and both
      // leave a paid reference cell rendered for a cell nothing will attach.
      const deadStates = (usage.emptiedStates || []);
      const lost = usage.emptied.length + deadStates.length;
      const summary = `Visual Bible page assignment rebuilt from the final briefs: ${usage.changed}/${usage.entries.length} entr(ies) changed`
        + (usage.revived.length ? `, ${usage.revived.length} revived (${usage.revived.join(', ')})` : '')
        + (usage.emptied.length ? `, ${usage.emptied.length} now cited by no brief (${usage.emptied.join(', ')})` : '')
        + (deadStates.length ? `, ${deadStates.length} state(s) no page reaches (${deadStates.map(s => `${s.id} "${s.name}" was [${s.oldPages.join(',')}]`).join('; ')})` : '')
        + (detail ? ` — ${detail}` : '');
      if (lost > 0) gl.warn('vb_usage_from_briefs', summary, null, usage);
      else gl.info('vb_usage_from_briefs', summary, null, usage);
      for (const e of changed) {
        log.info(`[VB-USAGE] ${e.id} "${e.name}" [${e.oldPages.join(',')}] → [${e.newPages.join(',')}]`);
      }
      for (const s of deadStates) {
        log.warn(`⚠️ [VB-USAGE] ${s.id} "${s.name}" claimed page(s) [${s.oldPages.join(',')}] and no brief cites it — a look the book never reaches`);
      }
      // ONE SOURCE OF TRUTH: the transcript below is what storyJobPipeline,
      // the resume path and the Lab re-parse. Write the rebuilt pages back.
      if (usage.changed > 0 && bibleSections) {
        const synced = syncVisualBibleSection(bibleSections, visualBible);
        if (synced === bibleSections) {
          log.warn('⚠️ [BEATS] Brief-derived page assignment could not be written back — the transcript has no rewritable ---VISUAL BIBLE--- JSON');
          gl.warn('beats_vb_sync_failed', 'Brief-derived Visual Bible pages could not be written back into the transcript — stored bible keeps the bible-time guess');
        } else {
          bibleSections = synced;
        }
      }
    }
  }

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
    // The brief checks and their one re-ask (2026-09-28) — what the scene
    // review's analysis block held before.
    '---BRIEF CHECKS---',
    `${briefCheckReport.findingsBefore.length} finding(s) before the re-ask, ${briefCheckReport.findingsAfter.length} after; re-asked page(s): ${(briefCheckReport.reask && briefCheckReport.reask.pages.join(', ')) || 'none'}`,
    '',
    ...(bibleSections ? [bibleSections, ''] : []),
    '---STORY PAGES---',
    pages.map(p => `## Page ${p.pageNumber}\n${p.text}`).join('\n\n'),
  ].join('\n');

  meta.totalMs = Date.now() - started;
  meta.title = title;
  meta.textModelId = textModelId;
  // The page-text writer's call, for the dev-mode "Full API Output (Story
  // Text)" panel — beats mode used to ship storyTextPrompts empty, which is
  // where the Step-1 ANALYSIS block was being lost.
  meta.storyTextCall = {
    prompt: textPromptSent || '',
    rawResponse: textRaw || '',
    analysis: (parsedText.analysis || '').trim(),
    modelId: textModelId,
    usage: textUsage || { input_tokens: 0, output_tokens: 0 },
    startPage: pages.length ? pages[0].pageNumber : 1,
    endPage: pages.length ? pages[pages.length - 1].pageNumber : 0,
  };
  log.info(`🪜 [BEATS] job=${jobId} done: ${pages.length} pages in ${(meta.totalMs / 1000).toFixed(1)}s`);

  // `visualBible` is the SAME object the Art Director and the reviews used —
  // trimmed, age-clamped, landmark-linked. The caller prefers it over a
  // re-parse of rawOutline so the two can never diverge (the transcript is
  // kept in step by syncVisualBibleSection; the re-parse is the fallback).
  // The backup marker rides on the report the dev panel already shows.
  if (beatsReviewReport) beatsReviewReport.jevFallback = jevReport.fallback;
  return { title, titleJudge, beats, pages, scenes, coverScenes, rawOutline, visualBible, meta, challengeDrawIds, challengeTakenIds, challengeDraw, challengeSelection, arcReviewReport, beatsReviewReport, jevDecisions: jevReport, jevFallback: jevReport.fallback, storyBibleReport, clothingReviewReport, wardrobeBibleReport, sceneExpansionReport, briefCheckReport };
}

/**
 * The writer's title block, proofread (2026-10-04). Every candidate goes
 * through the page lector's prompt, model and substitution
 * (textRefine.proofreadTitleCandidates) in ONE call, before anything renders
 * the title: the front cover bakes it into its art, and the cover, the story
 * record, the PDF, the viewer and the emails all read the title chosen here.
 *
 * All candidates, not only the pick: the pick is made by the writer in the
 * same call that wrote them, so nothing can be corrected before it; correcting
 * the whole list costs the same one call and keeps `titleCandidates`,
 * `titleJudge.candidates` and `title` the same strings everywhere they are
 * stored. The pick is kept by INDEX — the hash fallback (stableCandidateIndex)
 * hashes the text, so it is never recomputed over corrected strings.
 *
 * Every changed candidate is logged (`title_proofread_corrected`). A failed
 * call is logged at ERROR (`title_proofread_failed`) and the writer's title
 * ships uncorrected, the way a failed page lector ships the page text.
 *
 * @param {Object} inputData - language, languageLevel
 * @param {{title:string|null, titleCandidates:string[], titleJudge:Object|null}} parsed - parseTitleBlock's result
 * @param {Object} gl - generation log
 * @param {{proofread?: Function}} [deps] - test seam; defaults to textRefine.proofreadTitleCandidates
 * @returns {Promise<{title:string|null, titleCandidates:string[], titleJudge:Object|null, titleProofread:Object|null}>}
 */
async function applyTitleProofread(inputData, parsed, gl, deps = {}) {
  const { title, titleCandidates, titleJudge } = parsed;
  // No candidate list: the writer's single TITLE line is the one candidate.
  const list = titleCandidates.length ? titleCandidates : (title ? [title] : []);
  if (!list.length) return { title, titleCandidates, titleJudge, titleProofread: null };
  const pickIdx = list.indexOf(title);
  const proofread = deps.proofread || require('./textRefine').proofreadTitleCandidates;
  let pr;
  try {
    pr = await proofread(inputData, list);
  } catch (err) {
    log.error(`❌ [TITLE-LECTOR] failed (${err.message}) — the title ships unproofread: "${title}"`);
    gl.error('title_proofread_failed', `Title proofread failed (${err.message}) — the writer's title ships unchecked for spelling and grammar: "${title}"`, null, { title, candidates: list, error: err.message });
    return { title, titleCandidates, titleJudge, titleProofread: { ok: false, error: err.message } };
  }
  const corrected = pr.candidates;
  const changes = list
    .map((before, i) => ({ index: i, before, after: corrected[i] }))
    .filter(c => c.after !== c.before);
  for (const c of changes) {
    const picked = c.index === pickIdx;
    log.info(`✍️  [TITLE-LECTOR] candidate ${c.index + 1}${picked ? ' (the shipped title)' : ''}: "${c.before}" → "${c.after}"`);
    gl.info('title_proofread_corrected', `Title candidate ${c.index + 1}${picked ? ' (the shipped title)' : ''} corrected: "${c.before}" → "${c.after}"`, null, { ...c, picked, modelId: pr.modelId });
  }
  for (const d of pr.dropped || []) {
    log.warn(`⚠️ [TITLE-LECTOR] dropped "${d.quote}" (${d.reason})`);
  }
  for (const u of pr.unparsed || []) {
    log.warn(`⚠️ [TITLE-LECTOR] unreadable finding line — ${u.reason}: ${u.line}`);
  }
  if (!changes.length) log.info(`✍️  [TITLE-LECTOR] ${pr.modelId}: no fault in ${list.length} title candidate(s) (${(pr.elapsedMs / 1000).toFixed(1)}s)`);
  return {
    title: pickIdx >= 0 ? corrected[pickIdx] : title,
    titleCandidates: titleCandidates.length ? corrected : titleCandidates,
    titleJudge: titleJudge ? { ...titleJudge, candidates: corrected } : null,
    titleProofread: {
      ok: true, modelId: pr.modelId, elapsedMs: pr.elapsedMs, changes,
      rawResponse: pr.rawResponse, droppedCount: (pr.dropped || []).length,
    },
  };
}

module.exports = { generateStoryViaBeats, applyTitleProofread, reportChallengeMemoryBreach, finalizePlanShots, presentOf, decideBriefFields, pinDecidedFields, pageLocations, visualBibleJsonOf, runArtDirector, arcTempFor, makeArcCreatorCall, makePlanReader, planCheckInputs, createPlanCheckRunner, recheckRecord, runReplanRounds, runVisualBibleLabelRound, resolvePipelineMode, PIPELINE_MODES, loadUsedChallengeIds, syncVisualBibleSection, replaceClothingSection, extractBibleSections, shippedReplanState, BIBLE_MARKERS, CLOTHING_MARKERS, AD_BIBLE_MARKERS };

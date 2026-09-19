

const { runPlanCounters, collectPlaceNames, castLostByReplan, reviewPlanChanges } = require('./planCounters');
const { lookupByName } = require('./castResolver');
const { textZoneRulesActive } = require('../config/runtime');
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
 *   4. beats_scene_expansion MODEL_DEFAULTS.sceneDescription  ONE call over ALL pages: the VISUAL BIBLE
 *      and the COVER SCENE HINTS first, then every page's brief (cross-page
 *      continuity, and no page can cite an element nobody declared)
 *   5. beats_scene_review    MODEL_DEFAULTS.sceneReviewModel  ONE call over ALL briefs, rewrites faulted
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
 *                                    └─> scene expansion (bible + briefs)
 *                                          ─> scene review ─> page text
 *
 * Step 6 runs AFTER the scene review and reads the FINAL briefs (owner decision
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
 *  - Step 4 — the ART DIRECTOR — writes the VISUAL BIBLE and the COVER SCENE
 *    HINTS, ahead of page 1, then the page briefs. One author owns both what is
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
  drawChallengeIdeas,
  buildArcCreatePrompt,
  buildArcPanelPrompt,
  buildArcRetellPrompt,
  buildArcHintsPrompt,
  parseArcHints,
  parseArcCreate,
  parseArcRetell,
  arcInventedAllowance,
  critiqueMaxSeverity,
  buildPlanCheckPrompt,
  parsePlanCheck,
  parsePlanCheckRoster,
  parsePlanCheckObstacles,
  buildReplanSection,
  parsePlanChanges,
  replanRank,
  findingPages,
  buildClothingReviewPrompt,
  parseClothingReview,
  parsePlanResponse,
  buildSceneExpansionPrompt,
  buildSceneExpansionAllPrompt,
  buildSceneReviewPrompt,
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
const { parseCastRemovals, diffCastRemovals, restoreUndeclaredRemovals } = require('./sceneReviewGuard');
// The corrective loop's shared halves — the payload contract and the
// introduced-vs-survived verdict. The rewrite path (images.js iteratePageCore)
// reaches the same two through briefCorrection.correctFindings.
const { judgeCorrection, assertCorrectorSeesText } = require('./briefCorrection');
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
const BIBLE_MARKERS = ['---CLOTHING REQUIREMENTS---', '---VISUAL BIBLE---', '---COVER SCENE HINTS---'];
const CLOTHING_MARKERS = ['---CLOTHING REQUIREMENTS---'];
const AD_BIBLE_MARKERS = ['---VISUAL BIBLE---', '---COVER SCENE HINTS---'];

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
    body.search(/^\s*#{1,4}\s*\**\s*(?:Page|Seite|Pagina)\s*\**\s*\d+/im),
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
/**
 * Adopt the scene review's ---VISUAL BIBLE--- corrections.
 *
 * The review is the one stage holding both the plan lines and the bible, so it
 * is the one stage that can say which pages a state covers. Evidence for the
 * channel: job_1789343124794_z2c779f7i, whose first state was a change claiming
 * every page of the story — the page-prompt path can drop a wrong delta from
 * the prose but cannot swap the reference cell, so the first six pages rendered
 * an object in a look the story had not reached.
 *
 * STRICTLY a page-range edit. Only `states[]` is taken, only for ids the bible
 * already holds, and every structural problem drops that entry's correction
 * with a warning — a malformed review section must never end a paid run.
 *
 * A correction may also LOSE a look. On Lab 1264 the reviewer inserted the
 * missing unaltered state and returned three states where the bible held four,
 * silently dropping "broken" — and page 17, the page the object breaks open,
 * ended up covered by no state at all. The invariant is PAGE COVERAGE, not
 * names: renaming, merging and re-ranging states is precisely what the reviewer
 * is for, since it is the one stage holding the plan lines. On Lab 1265 it
 * re-covered pages 9-11 with a differently named state ("unaltered" replacing
 * "muddy"), losing nothing — a name-matching rule wrongly rejected that and the
 * repair went net-zero. Two rules guard the real invariant, both dropping the
 * whole entry's correction so the authored bible stands:
 *   1. every page the current `states[]` covers must be covered by some
 *      incoming state;
 *   2. a handle a brief already cites (`ID.N`) must still have a state at that
 *      id afterwards — a handle whose state changed name or delta is fine,
 *      that is the correction working.
 *
 * @param {Set<string>|Array<string>} [citedHandles] dotted handles the briefs
 *   cite (e.g. `ART001.3`). Omitted → rule 2 is skipped.
 * @returns {{applied: Array, rejected: Array}} applied entries carry
 *   {id, name, oldPages, newPages}; rejected carry {id, reason}.
 */
function applyReviewBibleCorrections(raw, visualBible, pageCount, citedHandles) {
  const out = { applied: [], rejected: [] };
  const text = String(raw || '');
  if (!text || !visualBible || typeof visualBible !== 'object') return out;
  const marker = text.match(/---\s*VISUAL BIBLE\s*---/i);
  if (!marker) return out;
  const body = text.slice(marker.index + marker[0].length).split(/\n---\s*[A-Z][A-Z ]*---/)[0];
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenced ? fenced[1] : body).trim();
  if (!jsonText) return out;
  let json;
  try { json = JSON.parse(jsonText); } catch (err) {
    out.rejected.push({ id: '(section)', reason: `unparseable JSON (${err.message})` });
    return out;
  }
  if (!json || typeof json !== 'object') {
    out.rejected.push({ id: '(section)', reason: 'section is not a JSON object' });
    return out;
  }

  // Every entry the bible holds, by BASE id, whatever collection it sits in —
  // a reviewer that files an artifact under the wrong key still names a real
  // entry, and the id is the identity.
  const byId = new Map();
  for (const key of SYNCED_COLLECTIONS) {
    for (const e of (Array.isArray(visualBible[key]) ? visualBible[key] : [])) {
      const id = e && e.id && String(e.id).trim().toUpperCase().split('.')[0];
      if (id) byId.set(id, e);
    }
  }
  const maxPage = Number.isFinite(Number(pageCount)) && Number(pageCount) > 0 ? Number(pageCount) : null;
  const incoming = [];
  for (const value of Object.values(json)) {
    if (Array.isArray(value)) incoming.push(...value);
  }
  for (const row of incoming) {
    const id = row && row.id && String(row.id).trim().toUpperCase().split('.')[0];
    if (!id) { out.rejected.push({ id: '(none)', reason: 'entry has no id' }); continue; }
    const entry = byId.get(id);
    if (!entry) { out.rejected.push({ id, reason: 'no bible entry has that id' }); continue; }
    if (!Array.isArray(row.states) || row.states.length === 0) {
      out.rejected.push({ id, reason: 'correction carries no states[]' });
      continue;
    }
    const states = [];
    let bad = null;
    for (const st of row.states) {
      const name = st && String(st.name || '').trim();
      const delta = st && String(st.delta || '').trim();
      if (!name || !delta) { bad = 'a state is missing name or delta'; break; }
      const pages = (Array.isArray(st.pages) ? st.pages : []).map(Number);
      if (pages.length === 0 || pages.some(n => !Number.isFinite(n) || n < 1 || (maxPage && n > maxPage))) {
        bad = `state "${name}" has pages outside the book`;
        break;
      }
      // `held` is the object's contact flag, read by resolveObjectState. Take
      // the reviewer's when it states one, else keep what the same look had.
      const prior = (Array.isArray(entry.states) ? entry.states : [])
        .find(o => String(o && o.name || '').trim().toLowerCase() === name.toLowerCase());
      const held = typeof (st && st.held) === 'boolean' ? st.held
        : (typeof (prior && prior.held) === 'boolean' ? prior.held : null);
      states.push({ name, delta, pages, ...(typeof held === 'boolean' ? { held } : {}) });
    }
    if (bad) { out.rejected.push({ id, reason: bad }); continue; }
    // Ids stay canonical: numbered by position, never carried over from the
    // review (which renumbers nothing when it reorders).
    states.forEach((st, i) => { st.id = `${id}.${i + 1}`; });

    const current = Array.isArray(entry.states) ? entry.states.filter(Boolean) : [];
    // RULE 1 — no page loses its look. The names may change freely; the pages
    // the bible already covers may not fall out from under the briefs.
    const coveredNow = new Set();
    for (const st of states) for (const p of st.pages) coveredNow.add(p);
    let uncovered = null;
    for (const o of current) {
      const pages = (Array.isArray(o.pages) ? o.pages : []).map(Number).filter(n => Number.isFinite(n));
      const lost = pages.filter(p => !coveredNow.has(p));
      if (lost.length > 0) { uncovered = { from: o, lost }; break; }
    }
    if (uncovered) {
      out.rejected.push({
        id,
        reason: `correction leaves page(s) ${JSON.stringify(uncovered.lost)} uncovered — they carry state `
          + `${uncovered.from.id || `${id}.?`} ("${uncovered.from.name}"), and no incoming state covers them`,
      });
      continue;
    }
    // RULE 2 — a handle a brief already cites must still exist. Its state may
    // change name or delta; there must simply BE a state at that id.
    const cited = citedHandles instanceof Set ? citedHandles
      : (Array.isArray(citedHandles) ? new Set(citedHandles) : null);
    if (cited && cited.size > 0) {
      const incomingIds = new Set(states.map(st => String(st.id).toUpperCase()));
      let vanished = null;
      for (const h of cited) {
        const handle = String(h || '').trim().toUpperCase();
        if (!handle.includes('.') || handle.split('.')[0] !== id) continue;
        if (!incomingIds.has(handle)) { vanished = handle; break; }
      }
      if (vanished) {
        out.rejected.push({
          id,
          reason: `correction removes cited handle ${vanished}: a brief cites it, and the correction `
            + `leaves no state at that id`,
        });
        continue;
      }
    }
    const oldPages = (Array.isArray(entry.states) ? entry.states : [])
      .map(o => `${o && o.name}=${JSON.stringify((o && o.pages) || [])}`).join(' ');
    entry.states = states;
    out.applied.push({
      id,
      name: entry.name || null,
      oldPages,
      newPages: states.map(st => `${st.name}=${JSON.stringify(st.pages)}`).join(' '),
    });
  }
  return out;
}

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
      if (Array.isArray(entry.states) && Array.isArray(mem.states)) {
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
// catalogue ids each book was offered, and the next book's draw filters them
// out — it simply never sees them. No prompt anywhere mentions a previous
// story, and there is no instruction for the creator to misread.
const PRIOR_STORY_LIMIT = 3;

/**
 * The challenge-catalogue ids this account's previous books were offered.
 *
 * Reads the DB directly (same lazy `require('../services/database')` every other
 * lib module uses) rather than threading a pool through the caller: the query
 * needs nothing storyJobPipeline has that jobId does not already resolve, and a
 * new parameter would have to be plumbed through server.js and the Test Lab too.
 *
 * `data->'challengeDrawIds'` doubles as the completeness filter — a job that
 * never got as far as drawing has nothing to contribute, and story_jobs rows are
 * pruned, so joining on job status would silently drop the older books that
 * matter most here.
 *
 * Never throws: a failed lookup means the draw runs unfiltered, which is exactly
 * what happened before any of this existed.
 *
 * @returns {Promise<{ids: number[], stories: number}>}
 */
async function loadUsedChallengeIds(jobId, gl = NOOP_LOG) {
  if (!jobId) return { ids: [], stories: 0 };
  try {
    const { dbQuery } = require('../services/database');
    const rows = await dbQuery(
      `SELECT s.id, s.data->'challengeDrawIds' AS ids
         FROM stories s
        WHERE s.user_id = (SELECT user_id FROM story_jobs WHERE id = $1)
          AND s.id <> $1
          AND jsonb_typeof(s.data->'challengeDrawIds') = 'array'
          -- Same story TYPE only (2026-08-27): the smoke account mixes toddler
          -- and standard books, and the age bands a draw is filtered by differ
          -- between them, so a toddler book's ids would exclude entries a
          -- standard book's draw never had access to in the first place.
          AND s.data->>'storyType' IS NOT DISTINCT FROM (SELECT input_data->>'storyType' FROM story_jobs WHERE id = $1)
        ORDER BY s.created_at DESC
        LIMIT ${PRIOR_STORY_LIMIT}`,
      [String(jobId)]
    );
    const ids = new Set();
    let stories = 0;
    for (const row of rows || []) {
      const own = (Array.isArray(row.ids) ? row.ids : []).map(Number).filter(Number.isFinite);
      if (!own.length) continue;
      stories += 1;
      for (const id of own) ids.add(id);
    }
    return { ids: [...ids], stories };
  } catch (err) {
    log.warn(`⚠️ [BEATS] Prior-challenge lookup failed (${err.message}) — challenges drawn without cross-story memory`);
    gl.warn('arc_variety_failed', `Prior-challenge lookup failed: ${err.message}`);
    return { ids: [], stories: 0 };
  }
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
 * @returns {{changedPages:number[], recheck:Object|null, discardedRounds:Array<{round:number, reason:string, changedPages:number[], recheck:Object|null}>}}
 */
function shippedReplanState(rounds = []) {
  const changed = new Set();
  let recheck = null;
  const discardedRounds = [];
  // What the SHIPPED division's rounds said they changed, and which of those
  // the review refused. A removal used to be recorded nowhere (2026-09-18).
  const declaredChanges = [];
  const changeRefusals = [];
  for (const r of (rounds || [])) {
    if (!r) continue;
    if (r.kept) {
      for (const n of (r.changedPages || [])) changed.add(Number(n));
      for (const line of (r.declaredChanges || [])) declaredChanges.push({ round: r.round, line });
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
      });
    }
  }
  return { changedPages: [...changed].sort((a, b) => a - b), recheck, discardedRounds, declaredChanges, changeRefusals };
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
 * @param {Function} [opts.onWardrobeCorrected] - fired when the wardrobe/bible
 *   check actually REWROTE an outfit clause, with the affected character names.
 *   The avatars for those characters were kicked off from the pre-correction
 *   text (the kickoff is deliberately early — the Visual Bible does not exist
 *   yet at that point), so the caller re-renders exactly those and nothing else.
 *   Non-blocking, owns its own error handling.
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
    onWardrobeCorrected = null,
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
  const arcRoundsMax = MODEL_DEFAULTS.arcRoundsMax || 3;
  const arcRounds = Math.max(1, Math.min(arcRoundsMax, arcRoundsRequested));
  if (arcRoundsRequested > arcRoundsMax) log.warn(`⚠️ [ARC] arcRounds=${arcRoundsRequested} clamped to ${arcRoundsMax} (owner cap 2026-08-30 — iteration study regressed at round 4)`);
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
  //
  // The draw EXCLUDES what this account's earlier books were offered
  // (loadUsedChallengeIds) — variety is a selection rule, so no prompt ever
  // mentions a previous story. The ids are persisted next to the lines so the
  // next book can exclude this one.
  const priorIds = await loadUsedChallengeIds(jobId, gl);
  if (priorIds.ids.length > 0) {
    gl.info('arc_variety', `Excluding ${priorIds.ids.length} catalogue challenge(s) offered to ${priorIds.stories} earlier book(s) on this account`, null, {
      stories: priorIds.stories, excludedIds: priorIds.ids,
    });
  }
  const draw = drawChallengeIdeas(inputData, { excludeIds: priorIds.ids });
  const challengeIdeas = draw.section;
  const challengeDrawIds = draw.ids;
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
  // The machine's full trail. Kept under the arcReviewReport key so the
  // storyJobPipeline persistence and the dev-mode wiring stay untouched.
  let arcReviewReport = null;
  // CROSS-STORY MEMORY: the challenges this account's previous books used. Only
  // the arc-plan call sees them — that is the one call that invents challenges;
  // every later stage divides and dresses what this one decided.
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
          // A cut arc parses as a shorter arc (missing ARC 2, missing critique
          // lines) — treat it as a failed attempt, never as the creator's answer.
          if (res.truncation?.suspected) throw new Error(`reply ${textModels.describeTruncation(res.truncation)}`);
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
    const createPrompt = buildArcCreatePrompt(inputData, pageCount, { challengeIdeas });
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
    // The invented-figure allowance this commission carries, and the list the
    // arc declares against it. Code re-counts the DECLARED LIST only — never
    // the arc prose (planCounters.js:227 documents why a regex cast extraction
    // over narrative is banned).
    const inventedAllowance = arcInventedAllowance(inputData);
    arcInventedLimit = inventedAllowance;
    let arcInvented = commit.invented || { present: false, names: [] };
    if (commit.premiseFigures?.names?.length) arcPremiseNames = commit.premiseFigures.names;
    if (arcInvented.present) arcInventedNames = arcInvented.names;
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
      // INVENTED-FIGURE RE-COUNT (2026-09-09). The arc used to grade its own
      // cast inside the same call and self-certify: job_1788903616404_iqvhj4l8m
      // wrote four invented figures on an allowance of two and reported
      // "Invented figures past allowance: none — Fenno and Nolo, exactly two".
      // Arithmetic on the model's own emitted list, nothing else.
      arcInvented = retold.invented && retold.invented.present ? retold.invented : arcInvented;
      if (retold.premiseFigures?.names?.length) arcPremiseNames = retold.premiseFigures.names;
      const inventedCount = (arcInvented.names || []).length;
      if (arcInvented.present) arcInventedNames = arcInvented.names;
      if (MODEL_DEFAULTS.arcForceRoundOnInventedOvercount && arcInvented.present && inventedCount > inventedAllowance) {
        const detail = { round, names: arcInvented.names, counted: inventedCount, allowance: inventedAllowance, declaredWritten: arcInvented.written, declaredAllowed: arcInvented.allowed };
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
        // The prompts each round actually sent (2026-09-11). The report already
        // keeps every OUTPUT verbatim; without the inputs a dev-mode reader can
        // see what the panel said but not what it was asked, which is where a
        // prompt regression hides. Same treatment the beats and text stages
        // already give their prompts (outlinePrompt, storyTextPrompts).
        panelPrompt,
        retellPrompt,
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
      createPrompt,
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
  // The character list PLUS the figures the premise supplied (the arc reports
  // them; see `arcPremiseNames`). A pet the commission named is commissioned.
  const commissionedNames = [
    ...(inputData?.characters || []).map(c => c && c.name).filter(Boolean),
    ...arcPremiseNames.filter(n => n && String(n).trim()),
  ];
  if (arcPremiseNames.length) log.info(`👪 [BEATS] Premise figures counted as commissioned: ${arcPremiseNames.join(', ')}`);
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
  // MODEL FIRST, COUNTERS SECOND (2026-09-11). The counters used to run first
  // and their lines were shown to the model for reference. They cannot run
  // first any more: who is on a page is a question about English, the model
  // call answers it as a ROSTER, and the counters do arithmetic on that answer
  // instead of re-deriving the cast from the prose with a grammar heuristic.
  const runCheck = async (label, pages, planText) => {
    let modelFindings = [];
    let roster = null;
    // The check's OBSTACLES block: per page, the character whose action that
    // page's instant works against (plan-check Q11). It is the declared
    // evidence a re-plan's removal is judged against — a figure the arc gives a
    // moment of their own is not a figure a page may quietly drop — so it is
    // read as DATA here, never re-derived from a finding's prose.
    let obstacles = null;
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
      prompt = buildPlanCheckPrompt(inputData, pages, approvedArc, planText);
      if (!prompt) throw new Error('plan-check template unavailable');
      const res = await textModels.callTextModelStreaming(prompt, null, onChunk, planCheckModel, {
        usageLabel: label,
        // Judges run at temperature 0 (settled); the Anthropic path sends none.
        ...(TEXT_MODELS[planCheckModel]?.provider === 'anthropic' ? {} : { temperature: 0 }),
      });
      checkModelId = res.modelId || planCheckModel;
      reply = String(res.text || '');
      modelFindings = parsePlanCheck(res.text || '');
      roster = parsePlanCheckRoster(res.text || '');
      obstacles = parsePlanCheckObstacles(res.text || '');
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
    const counters = runPlanCounters({ pages, commissionedNames, placeNames, maxCharactersPerScene: maxCast, declaredInvented: arcInventedNames, inventedAllowance: arcInventedLimit, roster });
    if (counters.skipped) {
      const got = roster ? roster.size : 0;
      log.error(`❌ [BEATS] Plan counters (${label}) SKIPPED (${counters.skipped}) — the roster covers ${got} of ${pages.length} page(s); no cast, invented-cast, shot-variety or focal-page counting ran`);
      gl.error(`${label}_counters_skipped`, `Plan counters did not run (${counters.skipped}): the check's roster covers ${got} of ${pages.length} page(s)`, null, { reason: counters.skipped, rosterPages: got, pages: pages.length });
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
    return { counters, modelFindings, findings: structured, lines: all, checkModelId, prompt, obstacles, reply, rosterLines };
  };

  // ONE shape for a recheck wherever it is recorded — the canonical `recheck`
  // and a discarded round's sit side by side in the stored report and a reader
  // must be able to compare them without learning two layouts.
  const recheckRecord = c => (c ? {
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
  } : null);

  t = Date.now();
  await stage(4, 'Checking the page division...', { next: 5, ms: 45000 });
  const check1 = await runCheck('plan_check', plan.pages, pagePlan);
  // The LEDGER of re-plan rounds, kept and discarded alike. The report's
  // canonical fields are derived from it by shippedReplanState() so they can
  // only ever describe the division that shipped.
  const replanRounds = [];
  if (check1.lines.length > 0) {
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
      const mustFixCount = c => (c.findings || []).filter(f => replanRank(f) === 'must').length;
      let bestBeats = beats;
      let bestPagePlan = pagePlan;
      let bestMustFix = mustFixCount(check1);
      for (let round = 1; round <= MAX_REPLAN_ROUNDS; round++) {
        await checkCancellation();
        await stage(5, 'Re-dividing the named pages...', { next: 18, ms: 45000 });
        const replanPrompt = buildBeatsPrompt(inputData, pageCount, {
          finalArc: approvedArc,
          arcHints,
          replan: buildReplanSection(pagePlan, pendingCheck.findings, { pageCount: beats.length }),
        });
        if (!replanPrompt) throw new Error('story-beats template unavailable');
        const rpRes = await textModels.callTextModelStreaming(replanPrompt, null, onChunk, planModel, { usageLabel: 'beats_replan' });
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
        for (const nf of (pendingCheck.findings || [])) for (const n of findingPages(nf)) namedPages.add(Number(n));
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
        let reviewRefusals = [];
        {
          const guardCast = (pendingCheck.counters.cast && pendingCheck.counters.cast.all) || commissionedNames;
          const guardAliases = (pendingCheck.counters.cast && pendingCheck.counters.cast.aliases) || {};
          const standing = new Map(beats.map(b => [b.pageNumber, b]));
          const restore = (pageNumbers) => {
            const want = new Set(pageNumbers.map(Number));
            second.parsed.pages = second.parsed.pages.map(pg => (
              want.has(Number(pg.pageNumber)) && standing.has(pg.pageNumber) ? standing.get(pg.pageNumber) : pg
            ));
          };

          const review = reviewPlanChanges({
            changes: declared.changes,
            standing: beats,
            returned: second.parsed.pages,
            castNames: guardCast,
            aliases: guardAliases,
            maxCast,
            obstacles: pendingCheck.obstacles,
          });
          reviewRefusals = review.refusals;
          if (review.notes.length) {
            gl.info('beats_replan_change_notes', `Round ${round}: ${review.notes.length} declared change(s) could not be tied to a finding or a cast name`, null, { round, notes: review.notes });
          }
          if (review.refusals.length) {
            restore(review.refusals.map(r => r.pageNumber));
            const detail = review.refusals.map(r => `p${r.pageNumber} (${r.rule}): ${r.detail}`).join('; ');
            log.warn(`⚠️ [BEATS] Round ${round}: ${review.refusals.length} declared change(s) refused on review - ${detail}`);
            gl.warn('beats_replan_change_refused', `Round ${round}: the review refused ${review.refusals.length} declared change(s) — ${detail}; ${review.refusals.length === 1 ? 'that page was' : 'those pages were'} restored from the division that stands`, null, { round, refusals: review.refusals });
          }

          const lost = castLostByReplan(beats, second.parsed.pages, guardCast, guardAliases, review.declaredOut);
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
            replanRounds.push({ round, changedPages: [], recheck: null, kept: false, discardReason: 'two pages returned with an identical plan line' });
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
          replanRounds.push({ round, changedPages: [], recheck: null, kept: false, discardReason: `returned ${second.parsed.pages.length} page(s) for a ${beats.length}-page book` });
          beats = bestBeats;
          pagePlan = bestPagePlan;
          break;
        }
        if (second.parsed.missing.length > 0) {
          log.warn(`⚠️ [BEATS] Re-plan omitted page(s) ${second.parsed.missing.join(', ')} — previous division kept`);
          gl.warn('beats_replan_incomplete', `Re-plan omitted page(s) ${second.parsed.missing.join(', ')} — previous division kept`);
          replanRounds.push({ round, changedPages: [], recheck: null, kept: false, discardReason: `omitted page(s) ${second.parsed.missing.join(', ')}` });
          break;
        }
        const before = new Map(beats.map(p => [p.pageNumber, p.planLine || '']));
        const changedThisRound = second.parsed.pages
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
        const check2 = await runCheck(round === 1 ? 'plan_recheck' : `plan_recheck_r${round}`, beats, pagePlan);
        // Entered KEPT and demoted below if the round is thrown away, so the
        // ledger records the round whichever way the verdict goes.
        const roundRecord = {
          round,
          changedPages: changedThisRound,
          findingsIn: pendingCheck.lines.length,
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
        const stillMustFix = (check2.findings || []).filter(f => replanRank(f) === 'must');
        if (stillMustFix.length >= bestMustFix && round > 1) {
          log.warn(`⚠️ [BEATS] Round ${round} did not reduce must-fix (${bestMustFix} → ${stillMustFix.length}) — discarding it, the previous division stands`);
          gl.warn('beats_replan_discarded', `Round ${round} did not reduce must-fix findings (${bestMustFix} → ${stillMustFix.length}) — the round was discarded and the previous division stands`, null, {
            round, before: bestMustFix, after: stillMustFix.length,
          });
          roundRecord.kept = false;
          roundRecord.discardReason = `did not reduce must-fix findings (${bestMustFix} → ${stillMustFix.length})`;
          beats = bestBeats;
          pagePlan = bestPagePlan;
          break;
        }
        bestBeats = beats;
        bestPagePlan = pagePlan;
        bestMustFix = stillMustFix.length;
        if (stillMustFix.length === 0) break;
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
    }
  }
  meta.timings.planCheckMs = Date.now() - t;

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
  const biblePrompt = buildStoryBibleFromBeatsPrompt(inputData, beats);
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
        const cRes = await textModels.callTextModelStreaming(clothingPrompt, null, onChunk, clothingReviewModel, { usageLabel: 'beats_clothing_review' });
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
    // The best incomplete brief seen, kept as the last resort. A page with half
    // a spec still beats a page with none: this fallback's throw ABORTS the run
    // (Promise.all over the missing pages), and a contract miss must never end a
    // paid run (docs/SETTLED.md, gates are guidelines).
    let salvage = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Own usage label (2026-08-31): fallback pages used to book under
        // 'beats_scene_expansion' like the batch call, so a truncated batch
        // plus silent per-page recovery was invisible in the usage summary
        // (job_1788123310558: 6 calls under one label, no way to tell 1
        // batch + 5 fallbacks from 6 batches).
        const res = await textModels.callTextModelStreaming(prompt, null, onChunk, sceneModel, { usageLabel: 'beats_scene_expansion_fallback' });
        if (!res || !res.text || !res.text.trim()) throw new Error('empty scene brief');
        // Same contract as the batch merge above — a recovery that itself comes
        // back cut is not a recovery. The second attempt is the retry; if both
        // are cut the throw below names why, instead of storing half a spec.
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

  t = Date.now();
  const beatPageNumbers = beats.map(b => b.pageNumber);
  let expansions = [];
  // The Visual Bible + cover hints the Art Director emits ahead of page 1.
  let adBible = null;
  // No rulings travel here any more (2026-09-01): the beats reviewer that
  // produced them is gone, and the plan check never rules on anything — it
  // counts, and the planner re-divides. CARRY_ROUTES stays for the Lab.
  const allPrompt = buildSceneExpansionAllPrompt(inputData, beats, {
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
    await stage(30, 'Writing the visual bible and the scene briefs...', { next: 42, ms: 176000 });
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
      // THE BIBLE RIDES IN FRONT of page 1 (2026-09-11). A response is only
      // whole when BOTH halves parsed: a partial bible must never ship, and
      // JSON.parse is the completeness test — a reply cut mid-JSON yields null
      // here, not half a bible, and the retry below is the recovery.
      if (!adBible) {
        const sections = extractBibleSections(allRaw, AD_BIBLE_MARKERS);
        const parsedVb = sections ? new UnifiedStoryParser(sections.body).extractVisualBible() : null;
        if (sections && parsedVb) {
          adBible = { body: sections.body, visualBible: parsedVb, found: sections.found, modelId: allModelId };
        } else if (sections) {
          log.error(`🚨 [BEATS] All-pages attempt ${attempt}: ---VISUAL BIBLE--- present but its JSON did not parse (${sections.body.length} chars) — treating the bible as MISSING rather than shipping a partial one`);
        } else {
          log.error(`🚨 [BEATS] All-pages attempt ${attempt}: response carries no ---VISUAL BIBLE--- section (${allRaw.length} chars)`);
        }
      }
      const parsed = parseRefinedText(allRaw, beatPageNumbers, 'SCENES', BRIEF_TRAILING_MARKERS);
      // A PAGE IS NOT A BRIEF. parseRefinedText accepts any non-empty run of
      // text under a `## Page N` heading, so a page the reply cut mid-sentence
      // counted as delivered: no retry, no fallback, no warning — the generator
      // rendered half a spec and the eval judged it against that same half.
      // Measured once in 955 staging pages (job_1789207854566_l43qgl34w p7).
      // Incomplete pages are simply not merged, which hands them to the retry
      // above and the per-page fallback below — the recovery that already
      // exists. The verdict is the one the iterate round already uses
      // (iterateBriefGuard.js), built from this very page: prose, parseable
      // metadata, a sceneIntent. Measured over 1035 stored beats briefs / 85
      // staging stories it rejects 4 — p7, and three August pages that predate
      // sceneIntent. No current story loses a page to it.
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
      if (byPage.size >= beats.length && adBible) break;
      if (attempt === 1) {
        const missingNow = beats.filter(b => !byPage.has(b.pageNumber)).map(b => b.pageNumber);
        const what = [
          missingNow.length ? `missing page(s) ${missingNow.join(', ')}` : null,
          adBible ? null : 'no parseable Visual Bible',
        ].filter(Boolean).join(' and ');
        log.error(`🚨 [BEATS] All-pages expansion incomplete: ${byPage.size}/${beats.length} briefs parsed, ${what} — retrying the batch ONCE at full cap`);
        gl.warn('beats_scene_expansion_truncated', `All-pages call returned ${byPage.size}/${beats.length} briefs, ${what} — retrying the batch once at full output cap`);
      }
    }
    expansions = beats
      .filter(b => byPage.has(b.pageNumber))
      .map(b => ({ pageNumber: b.pageNumber, brief: byPage.get(b.pageNumber), prompt: allPrompt, modelId: allModelId }));
  }

  // ── Adopt the Art Director's Visual Bible ─────────────────────────────────
  // Runs BEFORE the per-page fallback below, so a recovered page is expanded
  // against the same bible the batch wrote, and before the scene review and the
  // page text, so the landmark-shortfall hook can still abort attempt 1 cheaply.
  //
  // With no parseable bible at all the run is degraded exactly as a failed
  // bible stage used to be — empty VB, no cover hints, blind per-page briefs —
  // and says so loudly. It is never a kill: a contract miss must not end a paid
  // run (docs/SETTLED.md, gates are guidelines).
  if (adBible) {
    visualBible = adBible.visualBible;
    let bibleBody = adBible.body;
    if (!adBible.found.includes('---COVER SCENE HINTS---')) {
      log.warn('⚠️ [BEATS] Art Director emitted no ---COVER SCENE HINTS--- section — covers fall back to the default hint');
      gl.warn('beats_story_bible_partial', 'Art Director emitted no cover scene hints — covers use the default hint');
    }

    // An invented child the bible declares a PEER of the commissioned children
    // must state an age inside their band. The band went into the prompt above;
    // this is the deterministic post-check over what came back — no model call,
    // no classification, it reads the bible's own `peer` field and compares a
    // number. Fail-soft: clamp to the nearest tolerated edge, flag the entry,
    // warn. No retry loop and never a kill — an age constraint must not be able
    // to end a paid run. Evidence: job_1788641639919_mpjwlzkf1, CHR001 "The boy
    // in the striped scarf" stated ten next to a commissioned 6-year-old,
    // rendered 11-12 on p5.
    // ONE authored English label per element, enforced the moment the bible is
    // adopted — BEFORE the clamp, so the clamp's own sync carries the labels
    // too. Its own sync below runs regardless, so the projection never depends
    // on whether the clamp fired.
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
      // ONE SOURCE OF TRUTH. The clamp mutated this module's parsed copy only;
      // the transcript is what every later reader re-parses (storyJobPipeline,
      // resume, the Lab). Write the mutated fields back so every
      // extractVisualBible() from here on agrees.
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

    // Append to the wardrobe transcript in the order the transcript has always
    // carried: CLOTHING REQUIREMENTS, VISUAL BIBLE, COVER SCENE HINTS.
    bibleSections = bibleSections ? `${bibleSections.trimEnd()}

${bibleBody}` : bibleBody;

    const vbCount = Object.values(visualBible).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
    gl.info('beats_visual_bible', `Visual Bible by ${adBible.modelId || sceneModel}: ${vbCount} entr(ies), written with the page briefs`, null, {
      vbEntries: vbCount, sections: adBible.found,
    });
  } else if (allPrompt) {
    log.error('🚨 [BEATS] All-pages call produced NO parseable Visual Bible after both attempts — story ships with an empty bible, no cover hints and blind briefs');
    gl.warn('beats_visual_bible_missing', 'The Art Director returned no parseable Visual Bible — story ships with an empty bible and no cover hints');
  }

  // The page images need each real landmark's PHOTO VARIANTS on the bible entry
  // (the resolver serves the variant a brief's landmarkView asks for). The Art
  // Director already chose its viewpoints from the PHOTOS lines in
  // {AVAILABLE_LANDMARKS_SECTION}; these two steps link what it chose to the
  // index rows. Both are cheap (in-memory matching; one DB query) and
  // idempotent, so the caller repeating them costs nothing.
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
  // The two describe the same body and nothing compared them: a costume line
  // could put a hat on a character the bible already dresses with a different
  // one, on every page she appears (staging job_1789420511893_zly5rcdej,
  // ART002). The bible wins — it has a rendered reference cell — so the outfit
  // clause is rewritten here, the first moment both exist, and every swap is
  // logged. Contained like every other check: a throw ships the contradiction
  // rather than killing the run, but never silently.
  let wardrobeBibleReport = null;
  if (visualBible && clothingRequirements && Object.keys(clothingRequirements).length > 0) {
    try {
      const { applyWardrobeBibleCorrections } = require('./clothingCheck');
      const { findings, applied, unresolved } = applyWardrobeBibleCorrections(clothingRequirements, visualBible);
      // `applied` holds RE-DERIVED finding objects (the corrector re-checks
      // after every rewrite), so identity comparison against `findings` was
      // always false and every successful correction logged as uncorrected.
      // Compare on what identifies a finding instead.
      const correctionKey = (f) => `${f.character} ${f.category} ${f.slot} ${f.elementId || ''}`;
      const appliedKeys = new Set(applied.map(correctionKey));
      if (findings.length > 0) {
        wardrobeBibleReport = {
          conflicts: findings.map(f => ({
            character: f.character, category: f.category, slot: f.slot,
            elementId: f.elementId, elementLabel: f.elementLabel,
            wardrobeClause: f.wardrobeClause, corrected: appliedKeys.has(correctionKey(f)),
          })),
        };
        gl.warn('beats_wardrobe_bible_conflict', `${findings.length} wardrobe/bible wardrobe conflict(s): ${findings.map(f => `${f.character}/${f.slot} "${f.wardrobeClause}" vs ${f.elementId || '?'} "${f.elementLabel}"`).join('; ')}`, null, {
          conflicts: wardrobeBibleReport.conflicts,
        });
        // The transcript is what every later consumer re-parses the contract
        // out of; correcting only the object leaves them on the old outfit.
        if (applied.length > 0 && bibleSections) {
          const rewritten = replaceClothingSection(bibleSections, clothingRequirements);
          if (rewritten === bibleSections) {
            gl.warn('beats_wardrobe_bible_unmerged', `${applied.length} outfit(s) corrected against the Visual Bible but the transcript has no CLOTHING REQUIREMENTS section to update`);
          } else {
            bibleSections = rewritten;
          }
        }
        if (unresolved.length > 0) {
          wardrobeBibleReport.unresolved = unresolved.map(f => ({
            character: f.character, category: f.category, slot: f.slot,
            elementId: f.elementId, elementLabel: f.elementLabel, wardrobeClause: f.wardrobeClause,
          }));
        }
      }
      // THE AVATAR WAS RENDERED FROM THE PRE-CORRECTION TEXT. The styled-avatar
      // kickoff fires at the story-bible stage, long before the Visual Bible
      // this check needs exists — deliberately, because avatars are the long
      // pole in front of every image. So page prompts would carry the corrected
      // garment while the avatar reference cell still wore the old one: the
      // words-vs-picture split, one layer upstream. The affected characters —
      // and only those — are re-rendered by the caller.
      if (applied.length > 0 && typeof onWardrobeCorrected === 'function') {
        const names = [...new Set(applied.map(f => f.character).filter(Boolean))];
        try {
          onWardrobeCorrected(names, clothingRequirements);
        } catch (err) {
          log.warn(`🚨 [BEATS] onWardrobeCorrected threw (${err.message}) — avatars keep the pre-correction outfit`);
        }
      }
    } catch (err) {
      log.error(`🚨 [BEATS] Wardrobe-vs-bible check failed: ${err.message} — a contract/bible contradiction would ship unnoticed`);
    }
  }

  // Deliberately OUTSIDE every try/catch above: a throw from the caller's hook
  // must abort the run (the landmark-shortfall retry uses exactly that), not be
  // swallowed into "ships with an empty bible".
  if (onVisualBible && visualBible) await onVisualBible(visualBible);

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

  // THE PROMPT THAT WROTE THE BRIEFS (2026-09-19).
  //
  // `sceneReviewReport.prompt` is the REVIEWER's prompt. The Art Director's own
  // — ~100k chars of rules, the Visual Bible spec, the cover spec and all 18
  // plan lines — was stored nowhere, so recovering it for
  // job_1789759147125_p08djwhbl meant a git worktree at the run's commit plus a
  // rebuild from inputData + finalArc + pagePlan + clothingRequirements +
  // characterAvatars. Worse, WHICH commit to rebuild at was only decidable by
  // probing the stored review prompt for a constant a candidate commit had
  // introduced. The beats planner got `plannerPrompt` the same day; this is the
  // same gap one stage later.
  //
  // Rolled up by DISTINCT prompt rather than one copy per page: the all-pages
  // call normally covers every page in one row, and a page that fell back to the
  // per-page template keeps its own prompt in a row of its own. Storing it per
  // page would mean eighteen copies of the same 100k string.
  //
  // Written HERE, not into sceneReviewReport: that object is assigned only
  // inside the branch where the review template loaded, so a run that shipped
  // briefs unreviewed — precisely the run worth inspecting — would carry no
  // prompt at all.
  const sceneExpansionReport = (() => {
    const byPrompt = new Map();
    for (const x of expansions) {
      const key = `${x.modelId || ''}\u0000${x.prompt || ''}`;
      if (!byPrompt.has(key)) byPrompt.set(key, { prompt: x.prompt || '', modelId: x.modelId || null, pages: [] });
      byPrompt.get(key).pages.push(x.pageNumber);
    }
    return {
      durationMs: meta.timings.sceneExpansionMs,
      fallbackPages: missingBriefs.map(b => b.pageNumber),
      prompts: [...byPrompt.values()].map(r => ({ ...r, pages: r.pages.sort((a, b) => a - b) })),
    };
  })();

  gl.info('beats_scenes', `${expansions.length} scene briefs expanded by ${sceneModel} in one call${missingBriefs.length ? ` (+${missingBriefs.length} per-page fallback)` : ''} (${(meta.timings.sceneExpansionMs / 1000).toFixed(1)}s)`, null, {
    pages: expansions.length, fallbackPages: missingBriefs.map(b => b.pageNumber), model: sceneModel,
  });

  // ── Step 4: ONE review over ALL scene briefs ──────────────────────────────
  await checkCancellation();
  let sceneReviewAnalysis = '';
  // Set when the review reply was truncated (textReplyGuard.js): the briefs
  // shipped unreviewed and the report says so instead of "rewrote nothing".
  let sceneReviewFailed = null;
  // Same contract as beatsReviewReport above: null only when the review never
  // ran; an object with empty pages[] when it ran and rewrote nothing.
  let sceneReviewReport = null;
  // What the review's optional ---VISUAL BIBLE--- section changed, so the next
  // story proves the channel ran (the labelRound lesson).
  let bibleCorrections = null;
  let castRemovalsDeclared = null;
  let castRemovalAudit = [];
  // Mechanical clothing faults, computed here and handed to the review — the
  // ONE place they get fixed (owner decision 2026-08-08). Free: no API call, no
  // image. Only the findings measured to carry signal are rendered
  // (outfit_misattributed, removal_unstated); see clothingCheck.js.
  let clothingFindings = '';
  let clothingByPage = null;
  let clothingUnfixedList = [];
  // Worn-item states the fed-back round could not get declared. The pages ship
  // flagged; wornItems.js then defaults them to "worn" (decisions.md 2026-09-06).
  let wornUnresolved = [];
  let wornUnresolvedPages = [];
  let wornRound = null;
  let briefUnfixedList = [];
  let briefIntroducedList = [];
  // The two REWRITE-UNTIL-ZERO types (owner, 2026-09-08): a page declaring two
  // actions, and a page over the three-element budget. What this adds is a
  // VISIBLE verdict when they survive the single review round — page numbers per type,
  // and for the budget which pages the brief itself could not have fixed
  // (the bible's `appearsInPages` places elements the brief never cited, and
  // objectsAsked ≤ 3 means the reviewer had nothing left to withdraw).
  // Null when both types ended at zero. Never kills the run.
  let rewriteToZeroUnfixed = null;
  try {
    const { checkScenes, renderFindingsBlock } = require('./clothingCheck');
    const checkPages = expansions.map(x => {
      const meta = extractSceneMetadata(x.brief) || {};
      return {
        pageNumber: x.pageNumber,
        prose: String(x.brief || '').split('---METADATA---')[0],
        cast: (meta.characters || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean),
        perCharClothing: meta.characterClothing || {},
        // Structured worn-item states (server/lib/wornItems.js) — removal_unstated
        // is a MISSING-FIELD fault since 2026-09-06, not a prose search.
        wornItems: meta.wornItems || [],
      };
    });
    const res = checkScenes(checkPages, clothingRequirements, { artifacts: (visualBible || {}).artifacts, visualBible });
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
  // The plan line rides along for the element-coverage check: it is the page's
  // authority on what is in the picture, and the brief's objects[] is the only
  // route by which any of it reaches the illustrator. Hoisted — the re-check
  // after the review must compare against the same lines.
  const planLineOf = (pageNumber) => (beats.find(b => b && b.pageNumber === pageNumber) || {}).planLine || '';
  // Hoisted for the post-review re-check below, which needs the same cast list
  // and the pre-review fault set to tell a SURVIVING fault from an INTRODUCED one.
  let briefCastNames = [];
  const briefBeforeByPage = new Map();
  let briefBefore = [];
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
      expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief, planLine: planLineOf(x.pageNumber) })),
      castNames,
      visualBible,
      { textZoneRules: textZoneRulesActive(inputData) }
    );
    for (const [pn, list] of res.byPage) briefBeforeByPage.set(pn, new Set(list.map(f => f.type)));
    // The findings THEMSELVES, not only their types: the post-review verdict is
    // briefCorrection.judgeCorrection, the same partition the rewrite path now
    // runs, and it keys a finding by (page, type). Page 0 is the whole-book
    // tally and is reported on its own line, so it stays out of both sides.
    {
      const { REVIEWABLE: R } = require('./sceneBriefCheck');
      briefBefore = res.findings.filter(f => f && R.has(f.type) && f.pageNumber !== 0);
    }
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
    // Locked beats feed the review's check 5 (character in beat vs brief);
    // the bible feeds check 9f (a stated object's state page ranges).
    { clothingFindings, briefFindings, beats, visualBible }
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
      // THE PAYLOAD CONTRACT, asserted on this path too (2026-09-17). A
      // corrector is shown the text it is correcting — this path always has
      // been, through {ALL_SCENES}, and the rewrite path was not, which is the
      // defect that made its re-ask a re-roll. One function answers for both
      // so neither can lose it silently.
      // Reported, never fatal: a review that runs is worth more than a story
      // that dies on its own contract check, and this path's whole ruling is
      // advisory anyway.
      for (const pn of briefBeforeByPage.keys()) {
        const faulted = briefsIn.find(b => b.pageNumber === pn);
        if (!faulted) continue;
        try {
          assertCorrectorSeesText(srPrompt, faulted.brief, `scene review p${pn}`);
        } catch (seeErr) {
          log.error(`❌ [BEATS] p${pn}: ${seeErr.message} — the reviewer is being asked to correct a brief it cannot see`);
          gl.warn('beats_brief_unseen', `The scene review prompt does not carry page ${pn}'s brief — its faults cannot be corrected`, null, { pageNumber: pn });
        }
      }
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
      // TRUNCATION (textReplyGuard.js): a review cut at the ceiling rewrote the
      // EARLIEST pages and never reached the ones it named — adopting the pages
      // that fit would ship a half-review as a review. Fall back to the raw
      // briefs (the input), exactly as the Lab guard does; the failure is
      // recorded on the story (sceneReviewFailed) and in the generation log.
      const srTruncated = !!srRes.truncation?.suspected;
      if (srTruncated) {
        sceneReviewFailed = `scene review ${textModels.describeTruncation(srRes.truncation)} — briefs shipped unreviewed`;
        log.error(`❌ [BEATS] ${sceneReviewFailed}`);
        gl.warn('beats_scene_review_truncated', sceneReviewFailed, null, srRes.truncation);
      }
      // BRIEF_TRAILING_MARKERS: the reply's optional ---VISUAL BIBLE---
      // block follows the last page, and without a terminator it was appended
      // to that page's brief and stored as part of it (p17 of
      // job_1789759147125_p08djwhbl). The block itself is still read, from the
      // RAW reply, by applyReviewBibleCorrections below.
      const parsed = srTruncated ? { analysis: '', pages: [] } : parseRefinedText(srRes.text || '', expansions.map(x => x.pageNumber), 'SCENES', BRIEF_TRAILING_MARKERS);
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
      // DECLARED REMOVALS (owner decision 2026-09-13). A rewrite that drops a
      // character used to be expressible only as an absence — no delta, no
      // reason, and nothing parsed. `REMOVED CAST:` in the output contract is
      // that channel; this reads it, then checks it against what actually
      // happened to `characters[]`, page by page. Mechanical name-set
      // arithmetic over the brief metadata only — never an inference from
      // description prose.
      //
      // Detected AND REVERTED (2026-09-15, superseding the detect-only ruling
      // of 2026-09-13). Evidence for the detection:
      // job_1789207854566_l43qgl34w p7/p15, where five commissioned characters
      // became "five soaked pirates: one in a blue tricorn…" with
      // `characters: []` / `["Fiona"]` and nothing said. Evidence for the
      // revert: job_1789420511893_zly5rcdej p16, where the error fired, the
      // page rendered on the emptied cast anyway, and the corrupt contract
      // produced a phantom CRITICAL against a child who IS in the prose — three
      // repair rounds, and a correct original destroyed by the round-2 inpaint.
      const castRemovals = parseCastRemovals(sceneReviewAnalysis);
      const metaOf = (brief) => (extractSceneMetadata(brief) || {});
      castRemovalsDeclared = castRemovals;
      castRemovalAudit = diffCastRemovals(
        sceneDiffs.map(d => {
          const mb = metaOf(d.before), ma = metaOf(d.after);
          // CAST UNPARSEABLE IS NOT CAST EMPTIED (2026-09-19). A brief whose
          // parsers all failed comes back from the recovery path with
          // `isRecovered: true` and an empty `characters[]`
          // (sceneMetadata.js, describeDegradedSceneMetadata) — and the name
          // arithmetic below would read that emptiness as the reviewer having
          // silently dropped the entire page cast, then "restore" rows into a
          // roster that in fact still lists them. Skip the page instead; a
          // degraded brief is a known-recorded input, never a fault verdict.
          if (ma.isRecovered === true) {
            log.warn(`⚠️ [BEATS] Page ${d.pageNumber}: reviewed brief came back from the metadata recovery path — cast-removal diff skipped for this page (unparseable is not emptied)`);
            return null;
          }
          // `objects[]` carries the Visual Bible secondaries. A name that moved
          // there is still commissioned — routing, not removal.
          return {
            pageNumber: d.pageNumber,
            beforeCast: mb.characters || [],
            afterCast: ma.characters || [],
            afterObjects: (ma.objects || []).map(o => (typeof o === 'string' ? o : (o && (o.id || o.name)))).filter(Boolean),
          };
        }).filter(Boolean),
        castRemovals
      );
      if (castRemovals.malformed.length > 0) {
        log.warn(`⚠️ [BEATS] Scene review REMOVED CAST line has ${castRemovals.malformed.length} unparseable entr(ies): ${castRemovals.malformed.join(' | ')}`);
        gl.warn('beats_scene_review_removals_malformed', `REMOVED CAST entries could not be parsed: ${castRemovals.malformed.join(' | ')}`, null, castRemovals.malformed);
      }
      for (const r of castRemovalAudit) {
        if (r.declared.length === 0) continue;
        const why = (castRemovals.pages.find(p => p.pageNumber === r.pageNumber) || {}).reason || '(no reason given)';
        log.info(`📣 [BEATS] Scene review DECLARED removal on page ${r.pageNumber}: ${r.declared.join(', ')} — ${why}`);
        gl.info('beats_scene_review_removal_declared', `Page ${r.pageNumber}: reviewer removed ${r.declared.join(', ')} — ${why}`, null, r);
      }
      const undeclaredRemovals = castRemovalAudit.filter(r => r.undeclared.length > 0);
      if (undeclaredRemovals.length > 0) {
        const detail = undeclaredRemovals.map(r => `page ${r.pageNumber}: ${r.undeclared.join(', ')}`).join('; ');
        log.error(`❌ [BEATS] Scene review removed cast WITHOUT declaring it — ${detail}`);
        gl.error('beats_scene_review_removal_undeclared',
          `Reviewer dropped character(s) from characters[] with no REMOVED CAST declaration — ${detail}`, null, undeclaredRemovals);
        // The page does NOT render on a cast the reviewer silently emptied —
        // but only the DROPPED NAMES come back (owner, 2026-09-17), spliced
        // verbatim out of the pre-review brief's own `characters[]`. The rest
        // of the reviewed brief stands. The whole-brief revert it supersedes
        // cost p18 of job_1789584708605_rts4wqupm every other fix that review
        // made (shipped at 45; the previous run's reviewed p18 scored 95).
        // A page whose `characters[]` cannot be located structurally still
        // falls back to the whole-brief revert — `changed` is trimmed there,
        // before the faulted-but-not-rewritten check reads it.
        const { restored, reverted } = restoreUndeclaredRemovals(expansions, sceneDiffs, changed, undeclaredRemovals);
        if (restored.length > 0) {
          const detail = restored.map(r => `page ${r.pageNumber}: ${r.names.join(', ')}`).join('; ');
          log.warn(`↩️ [BEATS] Restored undeclared-removed cast into the reviewed brief — ${detail}`);
          gl.warn('beats_scene_review_removal_restored',
            `Dropped character(s) put back into the reviewed brief's characters[]; the rest of the review's fixes stand — ${detail}`,
            null, restored);
        }
        if (reverted.length > 0) {
          const pages = reverted.map(r => r.pageNumber).join(', ');
          log.error(`↩️ [BEATS] Page(s) ${pages} reverted to the pre-review brief — the reviewed brief has no locatable characters[] to restore into`);
          gl.warn('beats_scene_review_removal_reverted',
            `Page(s) ${pages} shipped the PRE-REVIEW brief: the rewrite dropped cast with no declaration and its characters[] could not be located, so that page's review fixes were discarded with it`,
            null, reverted);
        }
      }

      // BIBLE CORRECTIONS (2026-09-14). The review may return an optional
      // ---VISUAL BIBLE--- section correcting a stated object's state page
      // ranges — the fault sceneBriefCheck's vb_state_* findings hand it. The
      // merge is strict and fail-soft; see applyReviewBibleCorrections.
      if (visualBible && !srTruncated) {
        try {
          // The handles the briefs ALREADY cite: a correction that renames one
          // of them re-points a page at a different look (Lab 1264).
          const citedHandles = new Set();
          for (const ex of (Array.isArray(expansions) ? expansions : [])) {
            const meta = extractSceneMetadata(ex && ex.brief) || {};
            const objs = Array.isArray(meta.objects) ? meta.objects : [];
            for (const o of objs) {
              const h = typeof o === 'string' ? o.trim().toUpperCase() : '';
              if (h.includes('.')) citedHandles.add(h);
            }
          }
          const corr = applyReviewBibleCorrections(srRes.text || '', visualBible, expansions.length, citedHandles);
          bibleCorrections = corr;
          for (const r of corr.rejected) {
            log.warn(`⚠️ [BEATS] Scene review bible correction REJECTED for ${r.id}: ${r.reason}`);
            gl.warn('beats_scene_review_bible_rejected', `Bible correction for ${r.id} rejected: ${r.reason}`, null, r);
          }
          if (corr.applied.length > 0) {
            for (const e of corr.applied) {
              log.info(`[VB-STATE] ${e.id} "${e.name}" ${e.oldPages} → ${e.newPages}`);
            }
            gl.info('beats_scene_review_bible',
              `Scene review corrected ${corr.applied.length} stated object(s): `
              + corr.applied.map(e => `${e.id} ${e.oldPages} → ${e.newPages}`).join('; '), null, corr);
            // ONE SOURCE OF TRUTH: the transcript is what every later reader
            // re-parses, exactly as the label round and the age clamp do.
            const synced = syncVisualBibleSection(bibleSections, visualBible);
            if (synced === bibleSections) {
              log.warn('⚠️ [BEATS] Scene review bible correction could not be written back into the transcript — downstream re-parses will read the UNCORRECTED bible');
              gl.warn('beats_vb_sync_failed', 'Scene review bible correction could not be written back into the transcript — stored bible will not reflect it');
            } else {
              bibleSections = synced;
            }
          }
        } catch (bcErr) {
          log.warn(`⚠️ [BEATS] Scene review bible correction failed (${bcErr.message}) — bible unchanged`);
        }
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
              wornItems: m2.wornItems || [],
            };
          }), clothingRequirements, { artifacts: (visualBible || {}).artifacts, visualBible });
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

          // FED-BACK WORN-STATE ROUND (owner ruling 2026-09-06). The old prose
          // finding was handed to the review on 9 pages of
          // job_1788641639919_mpjwlzkf1 and fixed on 0 of them. It is now a
          // missing FIELD, so the retry can name exactly what to add and the
          // re-check can verify it — the same shape as the brief second round
          // below and the landmark minimum-2 retry (cadd4ee72).
          //
          // Exactly ONE extra round. Strike two SHIPS: a WARN, a stored
          // `wornStateUnresolved` flag on the page, and the state defaults to
          // "worn" because the avatar reference wears the full outfit. A
          // guideline never kills a paid run.
          const wornLeft = left.filter(f => f.type === 'removal_unstated');
          if (wornLeft.length > 0) {
            const wornPages = new Set(wornLeft.map(f => f.pageNumber));
            const subset = expansions.filter(x => wornPages.has(x.pageNumber));
            const subsetByPage = new Map();
            for (const [pn, list] of after.byPage) {
              const rows = list.filter(f => f.type === 'removal_unstated');
              if (rows.length > 0 && wornPages.has(pn)) subsetByPage.set(pn, rows);
            }
            const { renderFindingsBlock: renderClothing2 } = require('./clothingCheck');
            const wrPrompt = buildSceneReviewPrompt(
              inputData,
              subset.map(x => ({ pageNumber: x.pageNumber, brief: x.brief })),
              { clothingFindings: renderClothing2(subsetByPage), beats },
            );
            const label = [...wornPages].sort((a, b) => a - b).join(', ');
            if (!wrPrompt) {
              log.warn(`⚠️ [BEATS] worn-state round skipped (no review template) — page(s) ${label} ship flagged`);
              wornUnresolved = wornLeft;
            } else {
              try {
                log.info(`🎩 [BEATS] worn-state round on page(s) ${label} (${subset.length}/${expansions.length} briefs)`);
                const wrRes = await textModels.callTextModelStreaming(wrPrompt, null, onChunk, sceneReviewModel, { usageLabel: 'beats_scene_review_worn' });
                // A cut round is a failed round — the catch below keeps the
                // briefs as they were and ships the pages flagged.
                if (wrRes.truncation?.suspected) throw new Error(`reply ${textModels.describeTruncation(wrRes.truncation)}`);
                const wrParsed = parseRefinedText(wrRes.text || '', subset.map(x => x.pageNumber), 'SCENES', BRIEF_TRAILING_MARKERS);
                const wrByPage = new Map(wrParsed.pages.map(pg => [pg.pageNumber, pg.text]));
                for (const x of subset) {
                  const fixed = wrByPage.get(x.pageNumber);
                  if (fixed && fixed.trim() && fixed !== x.brief) {
                    sceneDiffs.push({ pageNumber: x.pageNumber, before: x.brief, after: fixed, round: 'worn' });
                    x.brief = fixed;
                    x.reviewRewrote = true;
                  }
                }
                const after3 = checkScenes(expansions.map(x => {
                  const m3 = extractSceneMetadata(x.brief) || {};
                  return {
                    pageNumber: x.pageNumber,
                    prose: String(x.brief || '').split('---METADATA---')[0],
                    cast: (m3.characters || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean),
                    perCharClothing: m3.characterClothing || {},
                    wornItems: m3.wornItems || [],
                  };
                }), clothingRequirements, { artifacts: (visualBible || {}).artifacts, visualBible });
                wornUnresolved = after3.findings.filter(f => f.type === 'removal_unstated');
                clothingUnfixedList = after3.findings.filter(f => REVIEWABLE.has(f.type));
                wornRound = {
                  pages: [...wornPages].sort((a, b) => a - b),
                  before: wornLeft.length,
                  after: wornUnresolved.length,
                  usage: wrRes.usage || null,
                };
              } catch (wrErr) {
                log.warn(`⚠️ [BEATS] worn-state round failed (${wrErr.message}) — page(s) ${label} ship flagged`);
                wornUnresolved = wornLeft;
              }
            }
            if (wornUnresolved.length === 0) {
              log.info(`🎩 [BEATS] worn-state round resolved all ${wornLeft.length} fault(s)`);
              gl.info('beats_worn_state_round', `Worn-state round on page(s) ${label} resolved all ${wornLeft.length} fault(s)`);
            } else {
              const d = wornUnresolved.map(f => `p${f.pageNumber} ${f.artifactId || ''} (${f.character})`).join('; ');
              wornUnresolvedPages = [...new Set(wornUnresolved.map(f => f.pageNumber))].sort((a, b) => a - b);
              log.warn(`⚠️ [BEATS] worn state STILL undeclared on page(s) ${wornUnresolvedPages.join(', ')} — shipping flagged, state defaults to worn: ${d}`);
              gl.warn('beats_worn_state_unresolved',
                `Worn-item state undeclared after the fed-back round on page(s) ${wornUnresolvedPages.join(', ')} — pages ship with wornStateUnresolved and the item defaults to worn: ${d}`,
                null, { findings: wornUnresolved });
              for (const x of expansions) {
                if (wornUnresolvedPages.includes(x.pageNumber)) x.wornStateUnresolved = true;
              }
            }
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
          expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief, planLine: planLineOf(x.pageNumber) })),
          briefCastNames,
          visualBible,
          { textZoneRules: textZoneRulesActive(inputData) }
        );
        // pageNumber 0 is the whole-book text-position tally, reported on its
        // own line below rather than mixed into the per-page fault list.
        const left = after.findings.filter(f => REVIEWABLE.has(f.type) && f.pageNumber !== 0);
        const bookLevel = after.findings.filter(f => REVIEWABLE.has(f.type) && f.pageNumber === 0);
        if (bookLevel.length > 0) {
          const d = bookLevel.map(f => f.type).join('; ');
          log.warn(`⚠️ [BEATS] text-position distribution after review: ${d}`);
          gl.warn('beats_textzone_distribution', `Text-position distribution still off after the scene review: ${d}`, null, { findings: bookLevel });
        }
        // THE VERDICT IS SHARED (2026-09-17). This partition — introduced vs
        // survived, keyed by (page, type) — is briefCorrection.judgeCorrection,
        // and the rewrite path's corrective re-ask now reaches the same
        // function through correctFindings. It used to hand-roll
        // `after.length < before.length` instead, which scores a correction
        // that swaps one fault for another as EQUAL and rejects it; measured
        // over 11 stored rounds it resolved nothing on any of them.
        // `advisory` is this path's ruling (owner, 2026-08-11): the reviewer
        // authored both halves, so its rewrite stands and its faults are
        // reported.
        const { introduced, survived } = judgeCorrection({ before: briefBefore, after: left, acceptance: 'advisory' });
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

        // NO SECOND MODEL ROUND (owner, 2026-09-11). A targeted second
        // reviewer call used to re-send the faulted pages here. Measured over
        // two reruns it broke even: on the dragon rerun it cleared
        // interaction_object_shared_hands and the p12/p13 trough plate but
        // INTRODUCED interaction_multiple_actions on p1 (it split one action
        // back into two), and on the pirate rerun it changed nothing at all.
        // A paid call that trades one fault for another is not worth making.
        // The deterministic re-check above stays — it costs nothing and is the
        // diagnostic signal — so faults are reported and ship flagged, which
        // is the same contract round 2 had on the pages it failed to fix.

        // REWRITE-UNTIL-ZERO verdict for the two one-moment types, after the
        // single review round. Measured on staging
        // job_1788816451791_25b31uqlp: 11 of 18 pages shipped over budget after
        // two rounds, and on every one of them the brief's own objects[] was
        // already within three — the surplus came from the bible's
        // appearsInPages, which no rewrite can withdraw. Saying so per page is
        // the difference between "the reviewer ignored the fault" and "the
        // fault is not the reviewer's to fix".
        const ZERO_TYPES = ['interaction_multiple_actions', 'vb_element_overflow'];
        const zeroLeft = briefUnfixedList.filter(f => ZERO_TYPES.includes(f.type) && f.pageNumber !== 0);
        if (zeroLeft.length > 0) {
          const { rankPageElements, VB_ELEMENT_BUDGET } = require('./vbElementBudget');
          const pagesOf = (type) => [...new Set(zeroLeft.filter(f => f.type === type).map(f => f.pageNumber))].sort((a, b) => a - b);
          const overflowDetail = pagesOf('vb_element_overflow').map((pn) => {
            const x = expansions.find(e => e.pageNumber === pn);
            const meta = x ? (extractSceneMetadata(x.brief) || {}) : {};
            const ranked = rankPageElements(pn, meta, visualBible);
            const objectsAsked = ranked.filter(e => e.fromObjects).length;
            return { pageNumber: pn, elements: ranked.length, objectsAsked, briefFixable: objectsAsked > VB_ELEMENT_BUDGET };
          });
          rewriteToZeroUnfixed = {
            interaction_multiple_actions: pagesOf('interaction_multiple_actions'),
            vb_element_overflow: pagesOf('vb_element_overflow'),
            vbOverflowDetail: overflowDetail,
            rounds: 1,
          };
          const parts = [];
          if (rewriteToZeroUnfixed.interaction_multiple_actions.length) parts.push(`two actions on page(s) ${rewriteToZeroUnfixed.interaction_multiple_actions.join(', ')}`);
          if (rewriteToZeroUnfixed.vb_element_overflow.length) {
            const bibleSide = overflowDetail.filter(d => !d.briefFixable).map(d => d.pageNumber);
            parts.push(`over the ${VB_ELEMENT_BUDGET}-element budget on page(s) ${rewriteToZeroUnfixed.vb_element_overflow.join(', ')}`
              + (bibleSide.length ? ` (bible-side on ${bibleSide.join(', ')} — the brief cites ≤${VB_ELEMENT_BUDGET}, the surplus is appearsInPages)` : ''));
          }
          log.warn(`⚠️ [BEATS] rewrite-until-zero NOT reached after ${rewriteToZeroUnfixed.rounds} round(s): ${parts.join('; ')} — shipping flagged`);
          gl.warn('beats_one_moment_unfixed', `Briefs still ${parts.join('; ')} after the review's round budget — shipped flagged, never killed`, null, rewriteToZeroUnfixed);
        }
      } catch (rcErr) {
        log.warn(`⚠️ [BEATS] brief re-check failed (${rcErr.message})`);
      }

      sceneReviewReport = {
        model: srRes.modelId || sceneReviewModel,
        durationMs: meta.timings.sceneReviewMs,
        changedPages: sceneDiffs.map(d => d.pageNumber),
        namedButNotRewritten: faultedNotFixed,
        // The reviewer's declared-removals channel and the mechanical audit of
        // it (2026-09-13). `castRemovalAudit` holds one row per page that lost
        // a name, split into `declared` / `undeclared`.
        castRemovals: castRemovalsDeclared,
        castRemovalAudit,
        failed: sceneReviewFailed,
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
        wornUnresolved,
        wornUnresolvedPages,
        wornRound,
        // The VB label round writes its outcome to `meta` at adoption time;
        // without this line it reached no stored report (job_1789337998754_apslnsq1z
        // had valid labels and a null labelRound everywhere).
        labelRound: meta.labelRound || null,
        // {applied, rejected} from the review's ---VISUAL BIBLE--- section.
        bibleCorrections,
        briefUnfixed: briefUnfixedList,
        briefIntroduced: briefIntroducedList,
        rewriteToZeroUnfixed,
      };
      gl.info('beats_scene_review', `Scene review by ${srRes.modelId || sceneReviewModel}: ${changed.length} brief(s) rewritten (${(meta.timings.sceneReviewMs / 1000).toFixed(1)}s)`, null, {
        changedPages: changed, model: srRes.modelId || sceneReviewModel,
      });
    } catch (err) {
      log.warn(`🚨 [BEATS] Scene review failed (${err.message}) — proceeding with unreviewed briefs`);
      gl.warn('beats_scene_review_failed', `Reviewer ${sceneReviewModel} failed: ${err.message} — briefs shipped unreviewed`);
    }
  }

  // VB ELEMENT BUDGET — REPORTED HERE, NEVER ENFORCED (owner, 2026-09-11).
  // `truncateBriefToBudget` used to cut each brief's `objects[]` down to the
  // budget at this point, lowest-ranked first. It was removed with the
  // assignment trim above: code has no way to know which objects a page is
  // about, and dropping a citation removes the object from the page prompt's
  // REQUIRED OBJECTS line even though its reference cell exists — the same
  // failure as the trim, one layer down. The budget is now enforced ONLY where
  // it is understood: the Art Director's prompt and the scene review's fault
  // block, both fed from VB_ELEMENT_BUDGET. An overflowing brief ships with
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
      log.warn(`⚠️ [BEATS] VB element budget: page ${x.pageNumber} references ${t2.requested.length} elements after the review — over budget, shipping as written (lowest-ranked: ${t2.dropped.join(', ')})`);
      gl.warn('beats_vb_element_overflow',
        `Page ${x.pageNumber} references ${t2.requested.length} Visual Bible elements (budget ${VB_ELEMENT_BUDGET}) after the scene review — shipped unchanged, lowest-ranked ${t2.dropped.join(', ')}`,
        null, { pageNumber: x.pageNumber, requested: t2.requested, kept: t2.kept, dropped: t2.dropped, enforced: false });
    }
    if (vbOverflowByPage.size === 0) log.info('🧱 [BEATS] VB element budget: every page within budget');
  } catch (vbErr) {
    log.warn(`⚠️ [BEATS] VB element budget check failed (${vbErr.message}) — briefs ship as written`);
  }

  // ── Step 6: page text — runs HERE, after the scene review, with the briefs ─
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
  const titleSection = (textRaw.match(/---\s*TITLE\s*---\s*([\s\S]*?)(?=---\s*[A-Z]|$)/i) || [])[1] || '';
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
      // Present only on a page whose brief went OVER the element budget:
      // {requested, kept, dropped} ids, for the page view and the Lab. Since
      // 2026-09-11 nothing is actually dropped — the brief ships as written
      // and `dropped` names the lowest-ranked ids that went over.
      ...(vbOverflowByPage.has(b.pageNumber) ? { vbElementOverflow: vbOverflowByPage.get(b.pageNumber) } : {}),
    });
  }
  if (pages.length === 0) throw new Error('Beats pipeline produced no usable pages');

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
    const usage = applyBriefUsage(visualBible, scenes);
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
  return { title, titleJudge, beats, pages, scenes, rawOutline, visualBible, meta, challengeDrawIds, challengeDraw, arcReviewReport, beatsReviewReport, clothingReviewReport, sceneExpansionReport, sceneReviewReport };
}

module.exports = { generateStoryViaBeats, applyReviewBibleCorrections, runVisualBibleLabelRound, resolvePipelineMode, PIPELINE_MODES, loadUsedChallengeIds, syncVisualBibleSection, replaceClothingSection, extractBibleSections, shippedReplanState, BIBLE_MARKERS, CLOTHING_MARKERS, AD_BIBLE_MARKERS };

/**
 * BEATS REPLAY INPUTS — one resolver for every Test Lab stage that replays a
 * beats writer call against a STORED story.
 *
 * WHY THIS EXISTS. `pipelineMode` is 'beats' in every environment
 * (server/config/runtime.js:44) and storyJobPipeline.js:664 says so out loud:
 * "pipelineMode=beats — unified writer + outline review are skipped". So the
 * only story-text call production makes is
 *
 *     buildStoryTextFromBeatsPrompt(inputData, beats, finalExpansions,
 *                                   approvedArc, { arcHints })
 *                                            (server/lib/beatsPipeline.js:2327)
 *
 * and the only all-pages Art Director call it makes is
 *
 *     buildSceneExpansionAllPrompt(inputData, beats, { availableAvatars,
 *       maxCharactersPerScene, finalArc: approvedArc, clothingRequirements })
 *                                            (server/lib/beatsPipeline.js:1511)
 *
 * Three Lab stages replayed those calls with THINNER arguments than production
 * passes, so every A/B run through them measured a task production never sets:
 *
 *   - `expansions` was `[]`, which means no page block carried the
 *     `ILLUSTRATION (already locked — what the reader will SEE on this page)`
 *     section (promptBuilders.js:6689-6699). Production names that exact state
 *     a defect: beatsPipeline.js:2321-2326 warns
 *     "Step 6 has NO scene briefs — text is being written blind to the
 *     illustrations … this is the OLD sibling behaviour". The Lab ran the old
 *     sibling behaviour on every run.
 *   - `arcHints` was never passed, so the `# HINTS — apply these in the text
 *     where the beats have not` block was absent.
 *   - the arc came from `parseBeats(storyData.outline).arc` alone, where the
 *     arc production hands the writer is the arc MACHINE's approved output
 *     (`arcReviewReport.finalArc`); the parsed outline is only the last-ditch
 *     fallback. Three Lab sites spelled this three different ways.
 *   - `buildSceneExpansionAllPrompt` was called with no `finalArc` at all, so
 *     FINAL_ARC rendered as "(no arc was recorded for this story)".
 *
 * This is the same class of defect, and the same remedy, as
 * sceneMetadata.resolveEvalSceneHint (3b3070dce), wornItems.resolveGeneratedOutfit
 * (e403345b1) and bookAudit.buildAuditPages (2beda5425): ONE resolver, so a
 * fourth divergent expression cannot be written.
 *
 * The BASELINE must equal production. A stage may still OVERRIDE an input —
 * that is what an A/B is for — but the override has to be explicit at the call
 * site, never an argument quietly left empty.
 *
 * Dependency-free on purpose: helpers are injected, so this module can be unit
 * tested without loading promptBuilders/testlab.
 */

/**
 * The arc production hands the beats writer, resolved from a stored story.
 *
 * Production's `approvedArc` is the arc machine's committed output. On a stored
 * story that is `arcReviewReport.finalArc`; `beatsReviewReport.arc` covers runs
 * from before the arc machine, and the outline's `---ARC---` section is the
 * last resort (a story whose reports were dropped). Same ladder
 * storyJobPipeline.js:3970 uses when it stores the arc.
 *
 * @param {Object} storyData
 * @param {{ parseBeats?: Function }} helpers — storyHelpers.parseBeats, injected
 * @returns {string}
 */
function resolveReplayArc(storyData, { parseBeats } = {}) {
  const fromReports = storyData?.arcReviewReport?.finalArc
    || storyData?.beatsReviewReport?.arc
    || '';
  if (String(fromReports || '').trim()) return String(fromReports).trim();
  if (typeof parseBeats !== 'function') return '';
  try {
    return String(parseBeats(String(storyData?.outline || '')).arc || '').trim();
  } catch {
    return '';
  }
}

/**
 * The hint lines production passes alongside the arc (`{ arcHints }` on both
 * buildBeatsPrompt and buildStoryTextFromBeatsPrompt). Stored on
 * arcReviewReport.arcHints (beatsPipeline.js:911).
 *
 * @param {Object} storyData
 * @returns {string}
 */
function resolveReplayArcHints(storyData) {
  return String(storyData?.arcReviewReport?.arcHints || '').trim();
}

/**
 * The central figure production passes to the planner and the plan check
 * (`{ centralFigure }`, 2026-09-24): the names the arc's STORY LOGIC gave it,
 * stored on arcReviewReport.centralFigure. Null for "none", and for a story
 * written before the logic-first arc — nothing was named then, so nothing is
 * passed, exactly as production passed nothing.
 *
 * @param {Object} storyData
 * @returns {string[]|null}
 */
function resolveReplayCentralFigure(storyData) {
  const names = storyData?.arcReviewReport?.centralFigure;
  return Array.isArray(names) && names.length ? names : null;
}

/**
 * The locked scene briefs production hands the text writer (`finalExpansions`).
 *
 * On a stored story the final, post-review brief for a page IS
 * `sceneImages[].sceneDescription` — the same artefact
 * sceneMetadata.resolveEvalSceneHint treats as "the brief the generator got"
 * for a page. Pre-review snapshots (`sceneReviewReport.briefsIn`) are
 * deliberately NOT used: the writer was given the reviewed briefs.
 *
 * buildStoryTextFromBeatsPrompt strips the `---METADATA` block itself, so the
 * stored description is passed through whole.
 *
 * @param {Object} storyData
 * @returns {Array<{pageNumber:number, brief:string}>}
 */
function resolveReplayExpansions(storyData) {
  return (storyData?.sceneImages || [])
    .filter(s => s && s.pageNumber != null && String(s.sceneDescription || '').trim())
    .map(s => ({ pageNumber: s.pageNumber, brief: String(s.sceneDescription) }));
}

/**
 * Every argument buildStoryTextFromBeatsPrompt takes in production, resolved
 * from a stored story. Call it as
 *
 *     const a = buildReplayTextArgs(storyData, beats, { parseBeats });
 *     buildStoryTextFromBeatsPrompt(storyData, a.beats, a.expansions, a.arc,
 *                                   { arcHints: a.arcHints, visualBible: storyData.visualBible,
 *                                     clothingRequirements: storyData.clothingRequirements });
 *
 * `overrides` is the A/B lever and must be explicit: pass
 * `{ expansions: [] }` to deliberately measure the blind-writer arm.
 *
 * @param {Object} storyData
 * @param {Array} beats
 * @param {Object} opts — { parseBeats, overrides }
 */
function buildReplayTextArgs(storyData, beats, { parseBeats, overrides = {} } = {}) {
  const resolved = {
    beats,
    expansions: resolveReplayExpansions(storyData),
    arc: resolveReplayArc(storyData, { parseBeats }),
    arcHints: resolveReplayArcHints(storyData),
    centralFigure: resolveReplayCentralFigure(storyData),
  };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] !== undefined) resolved[key] = overrides[key];
  }
  resolved.overridden = Object.keys(overrides).filter(k => overrides[k] !== undefined);
  return resolved;
}

/**
 * The `options` object buildSceneExpansionAllPrompt gets in production
 * (beatsPipeline.js:1511), resolved from a stored story.
 *
 * `primaryClothing` stays out deliberately — production cannot have it at this
 * point (pageClothing is derived from THIS stage's own output) and a finished
 * story does, so passing it sends the Lab down a branch production never takes.
 *
 * @param {Object} storyData
 * @param {Object} opts — { availableAvatars, maxCharactersPerScene, parseBeats, overrides }
 */
function buildReplaySceneOptions(storyData, { availableAvatars = '', maxCharactersPerScene = 3, parseBeats, overrides = {} } = {}) {
  const resolved = {
    availableAvatars,
    maxCharactersPerScene,
    finalArc: resolveReplayArc(storyData, { parseBeats }),
    clothingRequirements: storyData?.clothingRequirements || null,
  };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] !== undefined) resolved[key] = overrides[key];
  }
  return resolved;
}

/**
 * AN ARC FROM AN arc_effort EXPERIMENT, in place of the story's stored arc
 * (2026-09-25). The question it answers: does the page plan still give every
 * commissioned character its page when the arc was written by a different arc
 * call (a new effort, a new prompt) than the one the story shipped with?
 *
 * Reads the experiment ROW (`{ stage, results }`), never the database, so it is
 * testable offline. Throws on anything that would make the run measure a
 * different story or a different arm than the one asked for:
 *   - the row is not an arc_effort experiment;
 *   - no result carries the target story (the experiment's storyId must equal
 *     the target — an arc for another cast is not a replay);
 *   - no OK arm of the phase (default: `retell` when the result has one, else
 *     `create`), or several and no `arcEffort` to pick one;
 *   - the arm stored no arc, or no STORY LOGIC block to read the central figure
 *     from.
 *
 * `arcHints` is null by construction: arc_effort does not run the hints call,
 * so the Lab arc carries none — the caller records that, it never borrows the
 * story's own hints (they answer a different arc).
 *
 * @param {{stage: string, results: Array}} row
 * @param {{ expId: number, storyId: string, arcPhase?: string, arcEffort?: string }} want
 * @param {{ parseStoryLogic: Function }} helpers — promptBuilders.parseStoryLogic, injected
 */
function resolveArcFromExperiment(row, { expId, storyId, arcPhase, arcEffort } = {}, { parseStoryLogic } = {}) {
  const tag = `arcFromExperiment ${expId}`;
  if (!row) throw new Error(`${tag}: not found`);
  if (row.stage !== 'arc_effort') throw new Error(`${tag}: stage is ${row.stage}, not arc_effort`);
  const results = Array.isArray(row.results) ? row.results : [];
  const out = results.find(r => r && r.storyId === storyId);
  if (!out) {
    const others = [...new Set(results.map(r => r && r.storyId).filter(Boolean))];
    throw new Error(`${tag}: no result for story ${storyId} (the experiment ran on ${others.join(', ') || 'no story'})`);
  }
  const arms = (out.arms || []).filter(a => a && a.ok && (a.phase === 'create' || a.phase === 'retell'));
  const phase = arcPhase || (arms.some(a => a.phase === 'retell') ? 'retell' : 'create');
  if (phase !== 'create' && phase !== 'retell') throw new Error(`${tag}: arcPhase must be 'retell' or 'create', not "${phase}"`);
  let pick = arms.filter(a => a.phase === phase);
  if (arcEffort) pick = pick.filter(a => a.effort === arcEffort);
  if (pick.length === 0) throw new Error(`${tag}: no successful ${phase} arm${arcEffort ? ` at effort ${arcEffort}` : ''}`);
  if (pick.length > 1) throw new Error(`${tag}: ${pick.length} ${phase} arms (efforts ${pick.map(a => a.effort).join(', ')}) — pass arcEffort to pick one`);
  const arm = pick[0];
  if (arm.parseError) throw new Error(`${tag}: the ${phase} ${arm.effort} arm did not commit (${arm.parseError})`);
  const arc = String(arm.arc || '').trim();
  if (!arc) throw new Error(`${tag}: the ${phase} ${arm.effort} arm stored no arc`);
  if (!String(arm.logic || '').trim()) throw new Error(`${tag}: the ${phase} ${arm.effort} arm stored no STORY LOGIC block`);
  // `arm.logic` is the block body without its heading (parseStoryLogic().text).
  const logic = parseStoryLogic(`STORY LOGIC:\n${arm.logic}`);
  return {
    arc,
    arcHints: null,
    logic,
    centralFigure: logic.centralFigure,
    pageCount: Number(out.pageCount) || null,
    source: { experimentId: Number(expId), phase, effort: arm.effort, model: arm.model || null, arcHints: 'none — arc_effort runs no hints call' },
  };
}

module.exports = {
  resolveArcFromExperiment,
  resolveReplayArc,
  resolveReplayArcHints,
  resolveReplayCentralFigure,
  resolveReplayExpansions,
  buildReplayTextArgs,
  buildReplaySceneOptions,
};

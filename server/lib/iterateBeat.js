/**
 * The beat an iterate round is allowed to see — and the backstop that keeps the
 * generator and the judge on the same roster.
 *
 * WHY THIS EXISTS
 *
 * `iteratePageCore` rewrites a page's brief and regenerates the whole frame, and
 * until 2026-09-14 it passed `null` for the outline context. With that null,
 * buildSceneDescriptionPrompt filled BOTH beat-shaped slots — `{SCENE_SUMMARY}`
 * and `{DRAFT_SCENE_DESCRIPTION}` ("your starting point") — from the previous
 * brief's own one-line `imageSummary`. The rewriter was therefore handed a
 * self-summary of the artefact it was rewriting and nothing else, while
 * scene-iteration.txt rule 1 told it "the outline is authoritative". It never
 * received an outline. A page whose brief had already drifted could only drift
 * further, because the only narrative anchor in the prompt was the drift.
 *
 * The page's beat IS stored: `sceneDescriptions[].outlineExtract` /
 * `sceneImages[].outlineExtract`, written by beatsPipeline as `PLAN: <shot> —
 * <who/what is in frame> — <the instant> — <why this page exists>`.
 *
 * THE RISK THIS MODULE IS SHAPED AROUND
 *
 * The Art Director trims cast on purpose to keep an image readable, and that is
 * legitimate (owner ruling). Commit 3b3070dce deliberately repointed the
 * semantic JUDGE away from the plan line onto the reviewed brief, because
 * judging a picture against the beat manufactured false findings. The judge's
 * expected roster comes from the brief's own `characters[]` / `objects[]`
 * (`buildExpectedCastBlock`).
 *
 * So a beat-fed rewriter can reinstate a figure the brief had trimmed — and if
 * it reinstates that figure in the PROSE only, the judge (correctly reading the
 * brief) scores it as an extra character. Generator and judge on two different
 * rosters, and the generator's extra work penalised.
 *
 * The rule that prevents it: ANYTHING THE REWRITE PUTS IN THE PICTURE MUST BE
 * DECLARED IN THAT SAME REWRITE'S `characters[]` / `objects[]`. It is stated in
 * the prompt and verified afterwards here (`checkRewrittenBrief`), which is the
 * prompt-plus-backstop shape CLAUDE.md's eval-logic rule asks for. The judge is
 * NOT touched: it keeps reading the reviewed brief, never a plan line.
 *
 * THE SECOND GAP
 *
 * The "Cast is locked" list the rewriter sees was built by keeping only
 * `kind === 'cast'` entries, so visual-bible ANIMALS and SECONDARY CHARACTERS
 * staged on the page never reached it by name. They arrived only inside the bulk
 * `RECURRING_ELEMENTS` dump, while rule 3 said "no character outside the list
 * may be added" — so a rewrite would keep the figure but strip its identity:
 * measured on staging `job_1789348171785_9oxos7dwv` p7, where a named dog became
 * "the scruffy terrier mix dog" in the prose. An unnamed figure has no
 * reference cell and no name for the detector to match, which is how that page
 * carried an unmatched figure. `collectStagedFigures` names them.
 *
 * THE PAGE RANGE
 *
 * Two sites put a Visual Bible entity on a page: `collectStagedFigures` (names
 * a figure onto the locked cast) and `partitionAnchoredObjects` (lets the
 * rewrite ADD a cited id). Both consult the bible's STRUCTURED page range
 * (`vbEntityCoversPage`) and never a name token — the page text may use a
 * creature's proper name for the object it hatches from. They live in this one
 * module and are pinned together by the `iterate-page-staging-sites` set in
 * scripts/admin/sibling-registry.json, because the first gate shipped on one
 * site only (2026-09-16).
 */

const { log } = require('../utils/logger');

const PLAN_PREFIX = /^\s*PLAN:\s*/i;

/**
 * The page's plan line, from wherever the pipeline stored it.
 *
 * @param {object|null} currentScene   the `sceneDescriptions[]` row
 * @param {object|null} savedScene     the `sceneImages[]` row
 * @returns {string|null} the line verbatim (`PLAN: …`), or null
 */
function resolvePlanLine(currentScene, savedScene) {
  for (const src of [currentScene, savedScene]) {
    const raw = src && src.outlineExtract;
    const text = raw === null || raw === undefined ? '' : String(raw).trim();
    if (text) return text;
  }
  return null;
}

/**
 * The staged segment of a plan line — the "who/what is in frame" and "the
 * instant" fields, never the shot and never the trailing purpose clause.
 *
 * Same scoping, and the same reason, as sceneBriefCheck.checkElementCoverage:
 * the purpose clause routinely names elements that are elsewhere in the world
 * ("the creature cannot reach the object inside"), and reading it is where a
 * naive whole-line match earns its false positives.
 */
function planStagedSegment(planLine) {
  const plan = String(planLine || '').replace(PLAN_PREFIX, '').trim();
  if (!plan) return '';
  return plan.split(/\s+[—–]\s+/).slice(1, 3).join(' ');
}

/** Every named visual-bible figure that is not a roster character. */
function figurePool(visualBible) {
  const vb = visualBible || {};
  const out = [];
  for (const [key, kind] of [['secondaryCharacters', 'secondary'], ['animals', 'animal']]) {
    for (const e of (Array.isArray(vb[key]) ? vb[key] : [])) {
      if (!e || !e.id || !e.name) continue;
      out.push({
        id: String(e.id).trim().toUpperCase().split('.')[0],
        name: String(e.name).trim(),
        kind,
        description: String(e.extractedDescription || e.description || '').trim(),
        entry: e,
      });
    }
  }
  return out;
}

const baseId = (o) => String(typeof o === 'string' ? o : (o && o.id) || '')
  .trim().toUpperCase().split('.')[0];

/** Whole-word, diacritic-safe presence of `name` in `haystack`. */
function namedIn(haystack, name) {
  const word = String(name || '').trim();
  if (word.length < 2) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\p{L}\\p{N}])' + esc + '([^\\p{L}\\p{N}]|$)', 'iu').test(haystack);
}

/**
 * DOES THIS VISUAL-BIBLE ENTRY BELONG ON THIS PAGE? (2026-09-16)
 *
 * Reads STRUCTURED page-range data only — `pages` / `appearsInPages` as written
 * by the Visual Bible author, plus any per-state page lists. Never prose, never
 * a finding's text: the page range is a fact the bible states, and matching on
 * words is how a creature got staged early because the page text legitimately
 * named the object it hatches from.
 *
 * TOLERANT BY DESIGN: an entry that declares no range at all returns `null`
 * ("unknown"), and the caller must fall back to its previous behaviour rather
 * than coerce. Only a range that EXISTS and EXCLUDES this page returns false.
 *
 * @returns {boolean|null} true = in range, false = out of range, null = unknown
 */
function vbEntityCoversPage(ent, pageNumber) {
  const n = Number(pageNumber);
  if (!ent || !Number.isFinite(n)) return null;
  const nums = new Set();
  const collect = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) { const v = Number(p); if (Number.isFinite(v)) nums.add(v); }
  };
  collect(ent.pages);
  collect(ent.appearsInPages);
  for (const st of (Array.isArray(ent.states) ? ent.states : [])) collect(st && st.pages);
  if (nums.size === 0) return null;
  return nums.has(n);
}

/**
 * The text an ADDED citation may be anchored in: the evaluator's feedback, the
 * page text and the plan line — the three structured inputs the rewriter was
 * handed. One construction, shared by the allow-list and the declared-set
 * allowance so the two never read different inputs.
 */
function anchorHaystack({ evaluationFeedback = null, pageText = '', planLine = '' } = {}) {
  return `${JSON.stringify(evaluationFeedback || {})}\n${pageText || ''}\n${planLine || ''}`.toLowerCase();
}

/**
 * The named non-roster figures staged on this page, from every source that can
 * legitimately claim one: the previous brief's `characters[]` and `objects[]`,
 * the saved scene metadata, and the plan line's staged segment.
 *
 * The plan line is a source on purpose — it is the one input that still knows
 * about a figure the previous brief dropped, and reinstating that figure BY NAME
 * is the whole point of feeding iterate the beat. Everything returned here is
 * offered to the rewriter as part of the locked cast, never forced into the
 * picture.
 *
 * PAGE RANGE BEATS THE NAME TOKEN here too (2026-09-16). The plan line is the
 * one source that ADDS a figure the previous brief did not cite, and it names
 * figures by word — so a creature whose proper name the page text also uses for
 * the object it hatches from was staged four pages before the bible says it
 * exists (staging job_1789506283204_3kxqshifx p13/p16; the creature's range is
 * [17,18]). Same rule as partitionAnchoredObjects: an id the previous brief
 * already cites is lineage and passes; a name-only hit from the plan line needs
 * the bible's STRUCTURED range to cover this page; no range at all is unknown,
 * never excluded.
 *
 * @returns {Array<{id,name,kind,description}>} deduped by visual-bible id
 */
function collectStagedFigures({ visualBible = null, sceneMetadata = null, savedScene = null, planLine = null, pageNumber = null } = {}) {
  const pool = figurePool(visualBible);
  if (pool.length === 0) return [];

  const citedIds = new Set();
  const namedRefs = [];
  const readMetadata = (meta) => {
    if (!meta) return;
    const raw = (meta.fullData && Array.isArray(meta.fullData.characters)) ? meta.fullData.characters
      : (Array.isArray(meta.characters) ? meta.characters : []);
    for (const c of raw) {
      const n = String(typeof c === 'string' ? c : (c && c.name) || '').trim();
      if (n) namedRefs.push(n);
    }
    const objs = (meta.fullData && Array.isArray(meta.fullData.objects)) ? meta.fullData.objects
      : (Array.isArray(meta.objects) ? meta.objects : []);
    for (const o of objs) {
      const id = baseId(o);
      if (id) citedIds.add(id);
      else if (typeof o === 'string' && o.trim()) namedRefs.push(o.trim());
    }
  };
  readMetadata(sceneMetadata);
  readMetadata(savedScene && savedScene.sceneMetadata);

  const staged = planStagedSegment(planLine);

  const picked = [];
  for (const f of pool) {
    const hit = citedIds.has(f.id)
      || namedRefs.some(n => namedIn(n, f.name) || namedIn(f.name, n))
      || (staged && namedIn(staged, f.name) && vbEntityCoversPage(f.entry, pageNumber) !== false);
    if (hit) picked.push({ id: f.id, name: f.name, kind: f.kind, description: f.description });
  }
  return picked;
}

/**
 * ANCHORED-OBJECT ALLOW-LIST (owner decision 2026-07-18; moved here from
 * images.js on 2026-09-16 so it sits beside collectStagedFigures — the two
 * sites that put a Visual Bible entity on a page, pinned by one registry set).
 *
 * The rewrite may keep/drop objects freely and may ADD an object only when
 * something asked for it — the original scene metadata, the evaluator feedback
 * (e.g. "rowing boat missing"), the page text, or the plan line (an anchor
 * source since the rewriter started receiving it, 2026-09-14: an element the
 * page's own beat stages is asked for by the beat, and scrubbing it would undo
 * the reinstatement in the same breath). Unanchored additions are scrubbed
 * (observed: a rewrite swapped the scene's vehicle for an unrelated statue and
 * the model painted it into the scene). Matching is tolerant across the
 * language boundary: entity id, entity name, or >=5-char words from the
 * name/English VB description against feedback + page text + plan line.
 *
 * PAGE RANGE BEATS THE NAME TOKEN (2026-09-16). The token anchor matches
 * >=5-char words from the entity's name/description against the page text — so
 * a creature was anchored on its own proper name because the page text
 * legitimately used that name for the OBJECT it hatches from, and the
 * transformation was staged pages early. The Visual Bible already states which
 * pages an entity appears on; that STRUCTURED range decides, and no prose is
 * consulted. Tolerant: an entry with no range at all is unknown, not excluded,
 * and falls through to the token anchor.
 *
 * @returns {{kept: Array, scrubbed: Array}} both in the rewrite's own order
 */
function partitionAnchoredObjects({ rewriteObjects = [], origObjects = [], evaluationFeedback = null, pageText = '', planLine = '', visualBible = null, pageNumber = null } = {}) {
  const list = Array.isArray(rewriteObjects) ? rewriteObjects : [];
  if (list.length === 0) return { kept: [], scrubbed: [] };
  const origSet = new Set((Array.isArray(origObjects) ? origObjects : []).map(baseId));
  const haystack = anchorHaystack({ evaluationFeedback, pageText, planLine });
  const vbEntityById = new Map();
  for (const pool of [visualBible?.artifacts, visualBible?.animals, visualBible?.vehicles, visualBible?.locations, visualBible?.secondaryCharacters]) {
    for (const e of (pool || [])) if (e?.id) vbEntityById.set(baseId(e.id), e);
  }
  const isAnchored = (obj) => {
    const id = baseId(obj);
    if (origSet.has(id)) return true;
    if (haystack.includes(id.toLowerCase())) return true;
    const ent = vbEntityById.get(id);
    if (!ent) return true; // not a VB id — plain names pass through
    if (vbEntityCoversPage(ent, pageNumber) === false) return false;
    const tokens = [String(ent.name || ''), ...String(ent.name || '').split(/\s|-/), ...String(ent.description || '').split(/[^A-Za-zÀ-ž]+/)]
      .map(t => t.trim().toLowerCase()).filter(t => t.length >= 5);
    return tokens.some(t => haystack.includes(t));
  };
  const scrubbed = list.filter(o => !isAnchored(o));
  const kept = list.filter(o => !scrubbed.includes(o));
  return { kept, scrubbed };
}

/**
 * Render the staged figures as the `{STAGED_FIGURES}` block. Empty string when
 * the page has none, so the prompt gains nothing on the common page.
 */
function renderStagedFiguresBlock(figures) {
  const list = Array.isArray(figures) ? figures : [];
  if (list.length === 0) return '';
  const lines = list.map(f => {
    const label = f.kind === 'animal' ? 'animal' : 'secondary character';
    return `- **${f.name}** [${f.id}] (${label})${f.description ? `: ${f.description}` : ''}`;
  });
  return [
    '',
    '**Also staged on this page — named figures who are part of the locked cast:**',
    ...lines,
    'Each of these that stays in the picture is named in the prose by its own name — never by its species or role alone — and cited in `objects[]` by its id. Drop one only when the feedback asked for it.',
    '',
  ].join('\n');
}

// The two faults that mean a figure is in the picture but not on the roster the
// judge reads. Both come from sceneBriefCheck, which the first-generation path
// already runs on every brief — the iterate path ran neither on its rewrite.
const REINSTATE_TYPES = new Set(['cast_unlisted', 'element_uncited']);

/**
 * Post-rewrite backstop: does the rewritten brief's own metadata declare
 * everything its prose (and its plan line) puts in the frame?
 *
 * Reuses sceneBriefCheck.checkPage with the page's plan line set — the
 * owner-sanctioned non-fidelity use of the beat. Reports only; the caller
 * decides what to do, because an iterate round is a paid round and a gate here
 * must never destroy one.
 *
 * @returns {Array} findings, filtered to REINSTATE_TYPES
 */
function checkRewrittenBrief({ pageNumber, brief, planLine = null, castNames = [], visualBible = null } = {}) {
  if (!String(brief || '').trim()) return [];
  try {
    const { checkPage } = require('./sceneBriefCheck');
    const findings = checkPage(
      { pageNumber, brief: String(brief), planLine: planLine || '' },
      castNames,
      visualBible,
      {}
    );
    return findings.filter(f => f && REINSTATE_TYPES.has(f.type));
  } catch (err) {
    log.warn(`[ITERATE-BEAT] page ${pageNumber}: brief consistency check failed: ${err.message}`);
    return [];
  }
}

/**
 * THE DECLARED SET (2026-09-16). A rewrite's `objects[]` and `characters[]` may
 * cite only what the previous brief already cited, what the plan line stages,
 * or what the evaluator asked for — original ∪ plan-line ∪ feedback. Measured on
 * staging job_1789506283204_3kxqshifx: three of five rewrites cited a landmark
 * or a creature none of their inputs named (p7 LOC003; p13 LOC002, LOC003,
 * ANI003; p16 LOC003, ANI003), and each invented citation became a critical on
 * content that had been correct; p2 and p10 cited nothing new.
 *
 * A length budget shipped beside this check the same day and was removed: the
 * 2.2x-3.4x raw growth it was built on was the iterate template's own mandated
 * audit keys (diagnosis, previewMismatches, corrections, draftValidation,
 * translatedSummary…), not prose — prose grew 1.0x-1.7x — and length was never
 * the signal for the damage. The id set is.
 *
 * This computes the allowance from exactly the inputs the rewriter was handed.
 * @returns {{allowedObjects: string[], allowedNames: string[]}}
 */
function declaredSetAllowance({ origObjects = [], rewriteObjects = [], evaluationFeedback = null, pageText = '', planLine = '', origCharacters = [], promptCharacters = [], stagedFigures = [] } = {}) {
  const haystack = anchorHaystack({ evaluationFeedback, pageText, planLine });
  const nameOf = (c) => String((c && c.name) || c || '').trim();
  // An id either was already there, or something asked for it by name in a
  // structured input.
  const allowedObjects = [
    ...(Array.isArray(origObjects) ? origObjects : []).map(baseId),
    ...(Array.isArray(rewriteObjects) ? rewriteObjects : []).map(baseId).filter(id => id && haystack.includes(id.toLowerCase())),
  ].filter(Boolean);
  const allowedNames = [
    ...(Array.isArray(origCharacters) ? origCharacters : []).map(nameOf),
    ...(Array.isArray(promptCharacters) ? promptCharacters : []).map(nameOf),
    ...(Array.isArray(stagedFigures) ? stagedFigures : []).map(nameOf),
  ].filter(Boolean);
  return { allowedObjects, allowedNames };
}

/**
 * Did the rewrite cite outside its declared set? Each finding carries the
 * offending ids / names structurally so a caller never parses the sentence.
 *
 * Reports only — a gate is a guideline and an iterate round is paid.
 * @returns {Array<{type:string,detail:string,ids?:string[],names?:string[]}>}
 */
function checkDeclaredSet({ newMetadata = null, allowedObjects = [], allowedNames = [] } = {}) {
  const findings = [];
  const allowedIds = new Set((allowedObjects || []).map(baseId).filter(Boolean));
  const addedIds = (Array.isArray(newMetadata?.objects) ? newMetadata.objects : [])
    .map(baseId).filter(id => id && !allowedIds.has(id));
  if (addedIds.length > 0) {
    findings.push({
      type: 'object_outside_declared_set',
      ids: addedIds,
      detail: `objects[] cites ${addedIds.join(', ')}, which the previous brief, the plan line and the feedback all leave out.`,
    });
  }
  const allowedLower = new Set((allowedNames || []).map(n => String(n || '').trim().toLowerCase()).filter(Boolean));
  const addedNames = (Array.isArray(newMetadata?.characters) ? newMetadata.characters : [])
    .map(c => String((c && c.name) || c || '').trim())
    .filter(n => n && !allowedLower.has(n.toLowerCase()));
  if (addedNames.length > 0) {
    findings.push({
      type: 'character_outside_declared_set',
      names: addedNames,
      detail: `characters[] adds ${addedNames.join(', ')}, who the previous brief, the plan line and the feedback all leave out.`,
    });
  }
  return findings;
}

/** One short line per finding, for a log and for the corrective re-ask. */
function describeBriefFindings(findings) {
  return (findings || []).map(f => `[${f.type}] ${f.detail}`).join('\n');
}

module.exports = {
  resolvePlanLine,
  planStagedSegment,
  figurePool,
  vbEntityCoversPage,
  anchorHaystack,
  collectStagedFigures,
  partitionAnchoredObjects,
  renderStagedFiguresBlock,
  checkRewrittenBrief,
  declaredSetAllowance,
  checkDeclaredSet,
  describeBriefFindings,
  REINSTATE_TYPES,
};

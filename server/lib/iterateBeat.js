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
const { vbIdFacet, baseVbId } = require('./vbIdGuard');

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
 * The purpose clause routinely names elements that are elsewhere in the world
 * ("the creature cannot reach the object inside"), so reading it is where a
 * naive whole-line match earns its false positives. (sceneBriefCheck's
 * element-coverage check drew the same line for the same reason until it was
 * removed on 2026-09-18; the scoping is still right for the figure pass here,
 * which resolves NAMES against the bible rather than matching prose words.)
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
 * ROSTER CHARACTERS THE PLAN LINE STAGES (2026-09-17, staging
 * job_1789584708605_rts4wqupm p10).
 *
 * Strict-mode iterate builds the rewriter's CHARACTER DETAILS from the PARENT
 * brief's `characters[]` alone, while template rule 3a invites the rewrite to
 * bring back a figure the plan line stages that the brief had dropped. On p10
 * the plan line and the evaluator both named the older brother; the brief did
 * not, so his sheet was withheld -- and the rewrite wrote him as "a middle-aged
 * man with short brown hair, stubble", which is the iteration template's own
 * example token for an apparent-age category. The preschooler shipped as a
 * bearded adult standing beside his toddler brother, and the page's own AGE &
 * PROPORTIONS block said "preschool-age" three paragraphs above the prose that
 * contradicted it. Same class as the 2026-06 fix that gave iterate the full
 * character block instead of a bare name list ("a 38-year-old came back as a
 * kindergartner") -- this is the variant where the character is not in the list
 * at all.
 *
 * Same shape as collectStagedFigures, for the other pool: that one reinstates
 * NAMED NON-ROSTER figures (animals, secondaries) from the plan line, this one
 * reinstates ROSTER characters. A roster character has no Visual Bible page
 * range, so there is nothing structured to consult -- the plan line's staged
 * segment (never its trailing purpose clause) is the whole test, and the name
 * match is the same whole-word, diacritic-safe one.
 *
 * Offering the sheet is not forcing the figure into the frame: the rewriter
 * still decides, under rule 3a, whether the plan line stages them.
 *
 * @param {Array}  characters    the story roster
 * @param {string} planLine      the page's `PLAN: ...` line
 * @param {Array}  alreadyLocked entries already in the locked cast
 * @returns {Array} roster entries the staged segment names and the lock dropped
 */
function collectPlanLineCast({ characters = [], planLine = null, alreadyLocked = [] } = {}) {
  const staged = planStagedSegment(planLine);
  if (!staged) return [];
  const have = new Set(Array.isArray(alreadyLocked) ? alreadyLocked : []);
  const out = [];
  for (const c of (Array.isArray(characters) ? characters : [])) {
    if (!c || have.has(c)) continue;
    const name = String(c.name || '').trim();
    if (!name || !namedIn(staged, name)) continue;
    out.push(c);
  }
  return out;
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

/**
 * THREE INPUTS THE REWRITER NEVER HAD (2026-09-17).
 *
 * The first Art Director authors a page brief from the plan line, the bible and
 * the clothing contract. The rewriter authors the SAME artefact from all of
 * those PLUS one thing the Art Director never sees: a render that failed. It
 * was given the failure as a score and a list of finding sentences — and
 * nothing else. Not the evaluator's own figure-by-figure inventory of what was
 * actually drawn, not the regions the evaluator named, and not the worn state
 * the page it is rewriting had already declared.
 *
 * `evaluationFeedback.reasoning` has been handed to iteratePageCore by the
 * repair pipeline since the pipeline was written and read by nothing.
 *
 * These render the three blocks. Each returns '' when it has nothing, so a
 * page with no evaluator context builds exactly the prompt it built before.
 */

/** The evaluator's own reasoning about the failed render, or ''. */
function renderEvaluatorReasoning(evaluationFeedback) {
  const raw = evaluationFeedback && evaluationFeedback.reasoning;
  const text = typeof raw === 'string' ? raw.trim() : (raw ? JSON.stringify(raw) : '');
  return text || '';
}

/**
 * The regions the evaluator marked, one line each: what is wrong, how bad, and
 * where it looked. The bounds are normalised [x0,y0,x1,y1] — named as a frame
 * region rather than as numbers, because the rewriter writes prose positions
 * and the AD templates forbid percentages and metrics in a brief.
 */
const REGION_COLS = [[0.34, 'left'], [0.67, 'centre'], [1.01, 'right']];
const REGION_ROWS = [[0.34, 'top'], [0.67, 'middle'], [1.01, 'bottom']];
function regionOf(bounds) {
  if (!Array.isArray(bounds) || bounds.length < 4) return '';
  const nums = bounds.map(Number);
  if (nums.some(n => !Number.isFinite(n))) return '';
  const cx = (nums[0] + nums[2]) / 2;
  const cy = (nums[1] + nums[3]) / 2;
  const col = (REGION_COLS.find(([edge]) => cx < edge) || REGION_COLS[REGION_COLS.length - 1])[1];
  const row = (REGION_ROWS.find(([edge]) => cy < edge) || REGION_ROWS[REGION_ROWS.length - 1])[1];
  return row === 'middle' && col === 'centre' ? 'centre of the frame' : `${row}-${col} of the frame`;
}

function renderFixTargetLines(evaluationFeedback, fallbackTargets) {
  const src = (evaluationFeedback && (evaluationFeedback.fixTargets || evaluationFeedback.enrichedFixTargets))
    || fallbackTargets || [];
  const rows = (Array.isArray(src) ? src : []).slice(0, 8);
  const lines = [];
  for (const t of rows) {
    if (!t) continue;
    const what = String(t.issue || t.description || t.element || t.type || '').trim();
    if (!what) continue;
    const where = regionOf(t.bounds || t.bodyBox);
    const sev = t.severity ? ` [${t.severity}]` : '';
    lines.push(`- ${what}${sev}${where ? ` \u2014 ${where}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * The page's worn-item states as the PARENT brief declared them, rendered by
 * the same builder the image prompt uses so the rewriter and the illustrator
 * read one sentence about one item.
 */
function renderParentWornState({ visualBible, promptCharacters, parentSceneMetadata, pageNumber }) {
  if (!visualBible) return '';
  try {
    const { resolveWornItemsForPage, buildWornStateLines } = require('./wornItems');
    const resolved = resolveWornItemsForPage(
      visualBible, promptCharacters || [], parentSceneMetadata || {}, { pageNumber }
    );
    return buildWornStateLines(resolved).join('\n');
  } catch {
    // A bible shape this resolver cannot read costs the rewriter one input; it
    // never costs it the rewrite.
    return '';
  }
}

// The fault that means a figure is in the picture but not on the roster the
// judge reads. It comes from sceneBriefCheck, which the first-generation path
// already runs on every brief — the iterate path ran it on no rewrite at all.
// It fires on the rewrite whatever the parent brief did: reinstating a figure
// the parent dropped is the rewriter's own job (template rule 3a), so an
// inherited one is still its to answer for.
//
// THIS SET HELD TWO TYPES UNTIL 2026-09-18. `element_uncited` was removed from
// sceneBriefCheck entirely that day (owner call — it classified by matching
// plan-line words against bible names; 33 of 43 production findings were false,
// and the scene review acted on 20 of them and was wrong on 12; the rule now
// lives only in prompts/scene-review.txt check 9d). On this corpus it named one
// round, rts4wqupm p6, and `checkDeclaredSet` names that same page from the
// other basis — `object_dropped_from_declared_set [ART001]`, the parent's own
// citation the rewrite stopped making — so the measured guard survives the
// removal. What does NOT survive is the shape with no citation on either side:
// a rewrite that reinstates an ANIMAL or an artefact in the prose alone, which
// `cast_unlisted` cannot see because animals are deliberately out of that
// roster (owner, 2026-08-16) and `checkDeclaredSet` cannot see because the
// parent never cited it either. A person or a bible secondary reinstated in the
// prose alone is still caught. Recorded in tasks/BACKLOG.md.
const REINSTATE_TYPES = new Set(['cast_unlisted']);

/**
 * THE REST OF THE MECHANICAL CHECKS, ON WHAT THE REWRITE INTRODUCED
 * (2026-09-17).
 *
 * `checkPage` computes eleven fault types and the iterate path discarded nine of
 * them. They are the types `sceneBriefCheck.REVIEWABLE` sends to the scene
 * review on the authored path — minus `vb_state_no_base`, which is a whole-book
 * tally `checkPage` never produces, and minus the `textzone_*` family, which
 * only runs when the text-zone rules are active and whose position a repaired
 * page usually has locked.
 *
 * INTRODUCED ONLY, and that is the whole difference from the two above: a
 * rewrite inherits the bible's page tables and the parent's citations, so a
 * fault the parent brief already carried is one the rewrite cannot be asked to
 * fix inside a page rewrite — spending the one corrective re-ask on it would
 * buy nothing. The authored path draws exactly this line for exactly this
 * reason (beatsPipeline's post-review re-check, `introduced` vs `survived`).
 *
 * MEASURED over the 11 stored iterate rounds of staging
 * job_1789584708605_rts4wqupm (p4, p6, p9, p10, p13, p16) and
 * job_1789506283204_3kxqshifx (p2, p7, p10, p13, p16), by running `checkPage`
 * over each round's PARENT brief and its REWRITE:
 *
 *   today's reinstate set  1 round of 11 (rts p6, element_uncited — that type
 *                          was removed on 2026-09-18, see REINSTATE_TYPES; the
 *                          same page is still named by checkDeclaredSet)
 *   vb_page_uncited        5 rounds introduced — AND ALREADY COVERED, see below
 *   vb_cite_offpage        3 rounds introduced — AND ALREADY COVERED
 *   the other six types    0 rounds. Three of them CANNOT fire at all while the
 *                          rewrite omits `action`: rts p9's parent brief
 *                          carried interaction_multiple_actions AND
 *                          interaction_object_shared_hands, and its rewrite —
 *                          which declares four interaction rows against the
 *                          parent's two — reads clean only because the field
 *                          the count is taken from is gone. An absent counter
 *                          is not a clean score; `checkCarriedFields` is what
 *                          makes those three able to fire.
 *
 * THE TWO CITATION TYPES ARE DELIBERATELY NOT IN THIS SET. `checkDeclaredSet`
 * was run over the same 11 rounds and produced the SAME defects from the other
 * basis: rts p6 / rts p16 / kxq p13 / kxq p16 `object_dropped_from_declared_set
 * [ART001]`, kxq p7 `[ART004]`, and `object_outside_declared_set` naming
 * LOC003 on p7, LOC002+LOC003+ANI003 on p13, LOC003+ANI003 on p16 — 8 of 8 of
 * what `vb_page_uncited` / `vb_cite_offpage` would have added, plus one thing
 * they cannot see (`character_outside_declared_set[Crow]`, kxq p10). Naming one
 * defect twice, in two different paid re-asks, buys nothing. The two bases
 * genuinely differ — the declared set reads the PARENT's citations, the page
 * table reads the BIBLE's — but where they differ is a page the parent brief
 * also failed to cite, and that is precisely the inherited case this set
 * suppresses. They converge, so one of them runs.
 *
 * What is left is what NOTHING on the iterate path checked: an id that resolves
 * to no bible entry, two declared actions on a one-action pipeline, one object
 * under two pairs of hands, an actor nobody can resolve, the owner's cap of
 * three packable elements, and a page whose instant contradicts the object
 * state it resolves to.
 */
const INTRODUCED_TYPES = new Set([
  'cast_id_unresolved', 'interaction_multiple_actions', 'interaction_object_shared_hands',
  'interaction_actor_unknown', 'vb_element_overflow', 'vb_state_contradicted',
  // A rewrite INHERITS `population` (images.js carries the field forward, since
  // scene-iteration.txt does not emit it), so a rewrite that newly peoples the
  // prose contradicts a field it never wrote and the page is billed for the
  // surplus. Introduced-only: a parent that already contradicted itself is the
  // scene review's fault, not this rewrite's.
  'population_contradicted',
]);

/**
 * Post-rewrite backstop: does the rewritten brief hold the same mechanical
 * contract an authored brief is held to?
 *
 * Reuses sceneBriefCheck.checkPage with the page's plan line set — the
 * owner-sanctioned non-fidelity use of the beat — and runs it a second time
 * over the brief this rewrite replaces, so an INTRODUCED fault can be told from
 * an inherited one. Free: pure code, no model call, no image.
 *
 * Reports only; the caller decides what to do, because an iterate round is a
 * paid round and a gate here must never destroy one.
 *
 * @param {string} [parentBrief] the brief being replaced. Without it every
 *   INTRODUCED_TYPES finding is suppressed rather than guessed at — a caller
 *   that cannot say what the parent declared cannot say what the rewrite added.
 * @returns {Array} findings: all of REINSTATE_TYPES, plus INTRODUCED_TYPES the
 *   parent brief was free of
 */
function checkRewrittenBrief({ pageNumber, brief, parentBrief = null, planLine = null, castNames = [], visualBible = null } = {}) {
  if (!String(brief || '').trim()) return [];
  try {
    const { checkPage } = require('./sceneBriefCheck');
    const run = (text) => (String(text || '').trim()
      ? checkPage({ pageNumber, brief: String(text), planLine: planLine || '' }, castNames, visualBible, {})
      : []);
    const findings = run(brief);
    const parentTypes = new Set(run(parentBrief).map(f => f && f.type));
    return findings.filter(f => f && (
      REINSTATE_TYPES.has(f.type)
      || (INTRODUCED_TYPES.has(f.type) && String(parentBrief || '').trim() && !parentTypes.has(f.type))
    ));
  } catch (err) {
    log.warn(`[ITERATE-BEAT] page ${pageNumber}: brief consistency check failed: ${err.message}`);
    return [];
  }
}

/**
 * A REWRITE MAY NOT DROP A FIELD ITS PARENT DECLARED (2026-09-17).
 *
 * The metadata half of the same subtraction the citation checks catch on
 * `objects[]`. Measured over the same 11 rounds: every one of them returned
 * `characters[].depth`, `characters[].looksAt` and `interactions[].action` on
 * ZERO rows where the brief it replaced stated all three on every row.
 *
 * The cost is not only the field. `interactions[].action` is what the one-action
 * count (`interaction_multiple_actions`) and the hand-off count are computed
 * from, and `characters[].depth` is what the text-zone collision check reads —
 * so a rewrite that omits them does not merely lose a field, it silently
 * switches three checks off and reads clean. On rts p9 the parent brief carried
 * two interaction faults and its rewrite reported none, with four undeclared
 * interaction rows.
 *
 * ONLY the fields the iterate templates state as REQUIRED on every row
 * (`characters[]`: "Always name, clothing, position, depth and looksAt";
 * `interactions[]`: "action is required on every row"). `hands` is deliberately
 * out — the template makes it a claim about contact, so its absence is a
 * legitimate answer, not a dropped field.
 *
 * AND ONLY the fields nothing else already carries. `shot`, `landmarkView`,
 * `wornItems`, `era`, `aboard`, `crowdExpected` and `textZoneDescription` were
 * dropped by all 11 rounds too and are restored in code by the
 * `iterateSceneMetadata` merge (images.js) — reporting them here would ask the
 * model to re-supply what the caller has already put back.
 *
 * Presence is tested ACROSS the list, not row by row: a rewrite legitimately
 * restages a page, so comparing row to row would report a re-cast frame as a
 * loss. A parent that states the field somewhere and a rewrite that states it
 * nowhere is the measured failure and is the whole test.
 *
 * @returns {Array} zero or one finding, shaped like every other brief finding
 */
const CARRIED_ROW_FIELDS = [
  { list: 'characters', field: 'depth' },
  { list: 'characters', field: 'looksAt' },
  // `emotion` (2026-09-23) is the brief half of emotionCheck.js; a rewrite
  // that drops it switches that comparison off for the rest of the page's life.
  { list: 'characters', field: 'emotion' },
  { list: 'interactions', field: 'action' },
];

/** The object rows of a metadata list, from `fullData` or the flat key. */
function metadataRows(metadata, key) {
  const m = metadata || {};
  const raw = (m.fullData && Array.isArray(m.fullData[key])) ? m.fullData[key]
    : (Array.isArray(m[key]) ? m[key] : []);
  return raw.filter(r => r && typeof r === 'object');
}

const statesField = (rows, field) => rows.some(r => r[field] !== undefined && r[field] !== null && String(r[field]).trim() !== '');

function checkCarriedFields({ parentMetadata = null, rewriteMetadata = null } = {}) {
  const dropped = [];
  for (const { list, field } of CARRIED_ROW_FIELDS) {
    const rewriteRows = metadataRows(rewriteMetadata, list);
    if (rewriteRows.length === 0) continue;                       // no row to carry it on
    if (!statesField(metadataRows(parentMetadata, list), field)) continue;  // the parent never declared it
    if (!statesField(rewriteRows, field)) dropped.push(`${list}[].${field}`);
  }
  if (dropped.length === 0) return [];
  return [{
    type: 'brief_field_dropped',
    fields: dropped,
    detail: `no row of ${dropped.join(' or ')} states a value, and the brief this replaces states `
      + `${dropped.length > 1 ? 'each of them' : 'it'} on its rows. `
      + `Return the same moment with ${dropped.length > 1 ? 'those fields' : 'that field'} stated on every row.`,
  }];
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
function checkDeclaredSet({ newMetadata = null, allowedObjects = [], allowedNames = [], requiredObjects = [], nameIds = null } = {}) {
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
  // ── THE OTHER DIRECTION (2026-09-17) ────────────────────────────────────
  // The additions check above caught zero breaches on staging
  // job_1789584708605_rts4wqupm; SUBTRACTION did the damage. Two of six
  // rewrites stopped citing the artefact the page is about (p6 and p16 both
  // dropped the egg), and p16's REQUIRED OBJECTS block shipped with a header
  // and no entries. A rewrite may REORDER its citations; it may not drop one.
  //
  // Still cited counts an id filed anywhere the union reader looks: `objects[]`,
  // a VB id in `characters[]`, or — for a secondary character — that entry's
  // NAME in `characters[]`, which is how a CHR id legitimately moves list
  // (p13's CHR001/Ramon on the same run). `nameIds` carries that id↔name map
  // from the bible; without it a name can never satisfy an id.
  // VB ids only, on BOTH sides: `baseVbId` returns null for anything that is
  // not a handle, so a free-text citation ("a pile of leaves") is never turned
  // into a pseudo-id and never reported as dropped.
  const stillCited = new Set();
  for (const o of (Array.isArray(newMetadata?.objects) ? newMetadata.objects : [])) {
    const id = baseVbId(typeof o === 'string' ? o : (o && o.id));
    if (id) stillCited.add(id);
  }
  const nameToId = new Map(Object.entries(nameIds || {})
    .map(([n, id]) => [String(n).trim().toLowerCase(), baseVbId(id)])
    .filter(([, id]) => id));
  for (const c of (Array.isArray(newMetadata?.characters) ? newMetadata.characters : [])) {
    const raw = String((c && c.name) || c || '').trim();
    const id = baseVbId(raw) || nameToId.get(raw.toLowerCase()) || null;
    if (id) stillCited.add(id);
  }
  const droppedIds = [...new Set((requiredObjects || [])
    .map(o => baseVbId(typeof o === 'string' ? o : (o && o.id))).filter(Boolean))]
    .filter(id => !stillCited.has(id));
  if (droppedIds.length > 0) {
    findings.push({
      type: 'object_dropped_from_declared_set',
      ids: droppedIds,
      detail: `the previous brief cited ${droppedIds.join(', ')} and this rewrite cites neither in objects[] nor in characters[]; a rewrite may reorder its citations but never drop one.`,
    });
  }
  return findings;
}

/**
 * Every Visual Bible pool a brief may cite, in one place. Facets live on
 * `states[]` (objects) or `vantages[]` (locations); both are read here so a
 * dotted handle is checked against whichever list its entry actually carries.
 */
const CITABLE_POOLS = ['artifacts', 'animals', 'vehicles', 'locations', 'clothing', 'secondaryCharacters'];

/** Index every citable bible entry by its BASE id. */
function entryIndex(visualBible) {
  const idx = new Map();
  for (const pool of CITABLE_POOLS) {
    for (const e of (Array.isArray(visualBible?.[pool]) ? visualBible[pool] : [])) {
      const id = baseId(e?.id);
      if (id && !idx.has(id)) idx.set(id, { entry: e, pool });
    }
  }
  return idx;
}

/** The facet rows of an entry — `states[]` for objects, `vantages[]` for locations. */
function entryFacets(entry) {
  const states = Array.isArray(entry?.states) ? entry.states : [];
  const vantages = Array.isArray(entry?.vantages) ? entry.vantages : [];
  return states.length > 0 ? states : vantages;
}

/**
 * A CITED FACET MUST EXIST (2026-09-17, staging job_1789584708605_rts4wqupm).
 *
 * Five of six iterate rewrites appended a facet suffix to an entry that has no
 * such facet — `LOC001.1`, `LOC002.1`, `LOC003.2` on locations whose
 * `vantages[]` is empty, and `ART001.2` on a state whose `pages[]` is empty.
 * Nothing rejected them: `matchesEntry` falls back to the parent id, the
 * reference-cell picker falls back to `.1`, and the page silently rendered
 * against a look the bible never declared for it.
 *
 * Structured only — ids and facet lists, never a text match. A handle whose
 * facet does not exist, or whose facet covers no page at all, is REDUCED to the
 * bare parent id (the entry is still cited; only the bogus facet is dropped).
 *
 * @returns {{objects: Array, rejected: Array<{handle:string, base:string, reason:string}>}}
 */
function normalizeCitedHandles({ objects = [], visualBible = null } = {}) {
  const list = Array.isArray(objects) ? objects : [];
  if (list.length === 0 || !visualBible) return { objects: list, rejected: [] };
  const idx = entryIndex(visualBible);
  const rejected = [];
  const out = list.map((raw) => {
    const handle = String(typeof raw === 'string' ? raw : (raw && raw.id) || '').trim();
    const facet = vbIdFacet(handle);
    if (!facet) return raw;
    const base = baseId(handle);
    const hit = idx.get(base);
    if (!hit) return raw; // not a bible id at all — nothing to check it against
    const facets = entryFacets(hit.entry);
    const row = facets[facet - 1] || null;
    if (!row) {
      rejected.push({ handle: handle.toUpperCase(), base, reason: `the entry declares ${facets.length} facet(s)` });
      return typeof raw === 'string' ? base : { ...raw, id: base };
    }
    if (Array.isArray(row.pages) && row.pages.length === 0) {
      rejected.push({ handle: handle.toUpperCase(), base, reason: 'that facet covers no page' });
      return typeof raw === 'string' ? base : { ...raw, id: base };
    }
    return raw;
  });
  return { objects: out, rejected };
}

/**
 * THE PARENT'S CITATIONS ARE CARRIED FORWARD (2026-09-23; replaces
 * `restoreParentObjects`, which restored the parent's list only when the
 * rewrite's resolved to nothing printable).
 *
 * A rewrite may reorder its citations, never drop one — the rule
 * `checkDeclaredSet` states. Stating it was not enough: staging
 * job_1790100385959_1nitlympp p17's parent brief cited
 * `["LOC002.5", "ART002.2", "ANI002", "ANI003"]`; the rewrite cited
 * `["LOC002.1", "ART002.2"]` and moved the two creatures into `characters[]` BY
 * NAME. The drop check counts a name as a refile, but `buildImagePrompt` takes
 * only VB-id-shaped entries from `characters[]`, so both creatures left
 * REQUIRED OBJECTS with their size riders and reference cell, and the hatchling
 * was drawn as a red copy of the adult. The old restore did not fire because
 * `ART002.2` was still listable.
 *
 * Structured throughout: every parent citation that is a Visual Bible handle
 * and whose BASE id the rewrite's `objects[]` no longer holds is appended
 * verbatim. A base id the rewrite still cites keeps the rewrite's facet
 * (`LOC002.1` stands; the parent's `LOC002.5` is not added beside it). Free-text
 * citations are never carried — `baseVbId` returns null for them.
 *
 * @returns {{objects: Array, carried: string[]}} rewrite order first, carried after
 */
function carryParentObjects({ rewriteObjects = [], parentObjects = [] } = {}) {
  const list = Array.isArray(rewriteObjects) ? rewriteObjects : [];
  const parent = Array.isArray(parentObjects) ? parentObjects : [];
  const handleOf = (o) => String(typeof o === 'string' ? o : (o && o.id) || '').trim();
  const have = new Set(list.map(o => baseVbId(handleOf(o))).filter(Boolean));
  const add = [];
  for (const o of parent) {
    const id = baseVbId(handleOf(o));
    if (!id || have.has(id)) continue;
    have.add(id);
    add.push(o);
  }
  return { objects: [...list, ...add], carried: add.map(handleOf) };
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
  collectPlanLineCast,
  partitionAnchoredObjects,
  renderStagedFiguresBlock,
  renderEvaluatorReasoning,
  renderFixTargetLines,
  renderParentWornState,
  regionOf,
  checkRewrittenBrief,
  checkCarriedFields,
  declaredSetAllowance,
  checkDeclaredSet,
  normalizeCitedHandles,
  carryParentObjects,
  describeBriefFindings,
  REINSTATE_TYPES,
  INTRODUCED_TYPES,
  CARRIED_ROW_FIELDS,
};

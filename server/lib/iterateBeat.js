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
 * @returns {Array<{id,name,kind,description}>} deduped by visual-bible id
 */
function collectStagedFigures({ visualBible = null, sceneMetadata = null, savedScene = null, planLine = null } = {}) {
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
      || (staged && namedIn(staged, f.name));
    if (hit) picked.push({ id: f.id, name: f.name, kind: f.kind, description: f.description });
  }
  return picked;
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

// THE REWRITE BUDGET (2026-09-16). Measured on job_1789506283204_3kxqshifx:
// every one of the five iterate rewrites grew the brief 2.2x-3.4x over the
// brief it was correcting (1891->4890, 2430->5920, 1320->4440, 2176->5758,
// 3174->6947), and the added clauses invented content that had been correct — a
// real landmark deleted, contradictory trees added, a described feature lost.
// scene-iteration.txt rule 1 ("Simplify, don't elaborate") is prose and was
// ignored, so the limit is a NUMBER computed here, injected into both iterate
// templates, and checked afterwards with one corrective re-ask.
//
// 1.5x is the factor: it sits below the smallest growth ever measured (2.2x) so
// every observed runaway is caught, while still leaving a rewrite half the
// original brief again of new room — more than enough to restate a fix, add a
// pose or re-frame a shot, which is all rule 1 asks it to do.
const BRIEF_GROWTH_FACTOR = 1.5;
// A very short original must not produce an impossible budget: a brief has
// mandatory structure (setting, cast, framing) regardless of what it replaces.
const BRIEF_MIN_BUDGET_CHARS = 1200;

/** The prose half of a brief — the ---METADATA--- JSON is structure, not prose. */
function briefProse(text) {
  const s = String(text || '');
  const cut = s.indexOf('---METADATA---');
  return (cut >= 0 ? s.slice(0, cut) : s).trim();
}

/**
 * The concrete budget for one rewrite, from the brief it is rewriting.
 * @returns {{originalChars:number,maxChars:number,growthFactor:number}}
 */
function computeBriefBudget(originalBrief) {
  const originalChars = briefProse(originalBrief).length;
  const maxChars = Math.max(BRIEF_MIN_BUDGET_CHARS, Math.ceil(originalChars * BRIEF_GROWTH_FACTOR));
  return { originalChars, maxChars, growthFactor: BRIEF_GROWTH_FACTOR };
}

/** The sentence the templates carry, built from the numbers above. */
function renderBriefBudget(budget) {
  if (!budget) return '';
  return `**Length budget (hard): ${budget.maxChars} characters of prose.** The brief you are correcting is ${budget.originalChars} characters; yours may be at most ${budget.growthFactor}x that. Spend the room on the flagged problems. Do not restate what already worked, and do not add scenery, props or figures the plan line and the feedback did not ask for.`;
}

/**
 * Did the rewrite stay inside its budget? Length plus the declaration sets:
 * `objects[]` and `characters[]` may cite only what the original brief already
 * cited, what the plan line stages, or what the evaluator asked for.
 *
 * Reports only — a gate is a guideline and an iterate round is paid.
 * @returns {Array<{type:string,detail:string}>}
 */
function checkBriefBudget({ brief, budget, newMetadata = null, allowedObjects = [], allowedNames = [] } = {}) {
  const findings = [];
  const prose = briefProse(brief);
  if (budget && prose.length > budget.maxChars) {
    findings.push({
      type: 'brief_over_budget',
      detail: `the brief is ${prose.length} characters of prose; the budget is ${budget.maxChars} (the brief it replaces is ${budget.originalChars}). Cut ${prose.length - budget.maxChars} characters.`,
    });
  }
  const allowedIds = new Set((allowedObjects || []).map(baseId).filter(Boolean));
  const addedObjects = (Array.isArray(newMetadata?.objects) ? newMetadata.objects : [])
    .filter(o => baseId(o) && !allowedIds.has(baseId(o)));
  if (addedObjects.length > 0) {
    findings.push({
      type: 'object_outside_budget',
      detail: `objects[] cites ${addedObjects.map(o => baseId(o)).join(', ')}, which the previous brief, the plan line and the feedback all leave out.`,
    });
  }
  const allowedLower = new Set((allowedNames || []).map(n => String(n || '').trim().toLowerCase()).filter(Boolean));
  const addedNames = (Array.isArray(newMetadata?.characters) ? newMetadata.characters : [])
    .map(c => String((c && c.name) || c || '').trim())
    .filter(n => n && !allowedLower.has(n.toLowerCase()));
  if (addedNames.length > 0) {
    findings.push({
      type: 'character_outside_budget',
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
  collectStagedFigures,
  renderStagedFiguresBlock,
  checkRewrittenBrief,
  describeBriefFindings,
  vbEntityCoversPage,
  briefProse,
  computeBriefBudget,
  renderBriefBudget,
  checkBriefBudget,
  BRIEF_GROWTH_FACTOR,
  BRIEF_MIN_BUDGET_CHARS,
  REINSTATE_TYPES,
};

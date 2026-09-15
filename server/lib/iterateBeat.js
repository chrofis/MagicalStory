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
  REINSTATE_TYPES,
};

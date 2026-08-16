/**
 * Story scorecard — the ONE source of truth for the model-comparison rubric,
 * the four final-artifact extractors, and the dim→score math. Used by both the
 * CLI (scripts/analysis/score-story.js) and the Test Lab `story_scorecard`
 * stage (server/lib/testlab.js) so they always agree on what is scored and how.
 *
 * Reviewer-judged, final outputs only. See docs/model-comparison/README.md.
 */

const crypto = require('crypto');

// artifact -> ordered dimension keys. The active judge prompt mirrors these
// exactly. v1.2 grew the beats rubric to a strict SUPERSET of the beats
// reviewer's checks (stakes, illustratable, repetition, castVariety,
// looseThreads) so a review fix always has a dimension that can reward it —
// before that, the reviewer closed loose threads the judge never scored, and
// scores sat flat across passes while real fixes landed.
const RUBRIC = {
  beats:       ['arc', 'pacing', 'emotion', 'causality', 'themeFit',
                'stakes', 'illustratable', 'repetition', 'castVariety', 'looseThreads'],
  scene:       ['clarity', 'variety', 'grounding', 'setting', 'composition'],
  storyText:   ['language', 'readability', 'voice', 'alignment', 'dialogue'],
  visualBible: ['completeness', 'wardrobe', 'world', 'anchors', 'consistency'],
};

// The rubric each evaluator VERSION scores against. Dims are per-version so old
// persisted rows (5-dim beats) remain interpretable next to new 10-dim rows;
// cross-version comparison is already flagged in the UI.
const RUBRIC_V1 = {
  ...RUBRIC,
  beats: ['arc', 'pacing', 'emotion', 'causality', 'themeFit'],
};

// Evaluator version — BUMP when the rubric dims or the judge prompt change so
// scores from different evaluators never get silently compared. The semver is
// for humans ("why did scores move"); the hash is tamper-evidence — it folds in
// the rubric AND the judge-prompt text, so a silent prompt edit that forgot to
// bump the semver still shows a changed hash. Every score record carries both.
// version → PROMPT_TEMPLATES key. Add a row + a prompts/*.txt file to ship a new
// evaluator; RUBRIC (the dimensions) stays fixed so versions stay comparable.
// SCORER REGISTRY. From version 2 on, the version number identifies BOTH halves
// of a score: the MAJOR is the rubric/prompt generation, the MINOR is which
// model judged it (2.1 sonnet, 2.2 grok, 2.3 gemini, .4 next…). Before this, the
// judge lived only in a separate column, so "v1.2" meant three different things
// depending on who ran it — and a sonnet-judged table was silently compared
// against a gemini-judged one. Each scorer is named after its judge.
// 1.x are frozen legacy rows (judge not pinned) — kept so old scores stay readable.
const EVALUATORS = {
  '1.0': { name: 'legacy 1.0', promptKey: 'storyScorecardJudge', rubric: RUBRIC_V1, judge: null },
  '1.1': { name: 'legacy 1.1 (harsh)', promptKey: 'storyScorecardJudgeV1_1', rubric: RUBRIC_V1, judge: null },
  '1.2': { name: 'legacy 1.2 (10-dim beats)', promptKey: 'storyScorecardJudgeV1_2', rubric: RUBRIC, judge: null },
  '2.1': { name: 'sonnet', promptKey: 'storyScorecardJudgeV2', rubric: RUBRIC, judge: 'claude-sonnet' },
  '2.2': { name: 'grok', promptKey: 'storyScorecardJudgeV2', rubric: RUBRIC, judge: 'grok-4.6' },
  '2.3': { name: 'gemini', promptKey: 'storyScorecardJudgeV2', rubric: RUBRIC, judge: 'gemini-3.1-pro' },
};
// back-compat shapes for anything that read these directly
const EVALUATOR_PROMPT_KEYS = Object.fromEntries(Object.entries(EVALUATORS).map(([v, e]) => [v, e.promptKey]));
const EVALUATOR_RUBRICS = Object.fromEntries(Object.entries(EVALUATORS).map(([v, e]) => [v, e.rubric]));
const DEFAULT_EVALUATOR_VERSION = '2.1'; // prompt gen 2, judged by sonnet
const EVALUATOR_VERSION = DEFAULT_EVALUATOR_VERSION; // back-compat export

function resolveEvaluator(version) {
  const v = version || DEFAULT_EVALUATOR_VERSION;
  const e = EVALUATORS[v];
  if (!e) throw new Error(`Unknown evaluator version "${v}" (have ${Object.keys(EVALUATORS).join(', ')})`);
  return { version: v, name: e.name, promptKey: e.promptKey, rubric: e.rubric, judge: e.judge };
}

/**
 * Which version means "this prompt generation, judged by THIS model". Used when a
 * caller names a judge instead of a version (re-judging a stored row), so the
 * stamped version never claims a judge that did not produce the score.
 */
function findEvaluatorForJudge(judge, promptKey) {
  const hit = Object.entries(EVALUATORS).find(([, e]) => e.judge === judge && (!promptKey || e.promptKey === promptKey));
  return hit ? { version: hit[0], ...hit[1] } : null;
}

/** Scorers a UI can offer: only the ones with a pinned judge. */
function listScorers() {
  return Object.entries(EVALUATORS)
    .filter(([, e]) => e.judge)
    .map(([version, e]) => ({ version, name: e.name, judge: e.judge }));
}

function evaluatorStamp(judgePromptText, version) {
  const v = version || DEFAULT_EVALUATOR_VERSION;
  const basis = JSON.stringify(EVALUATOR_RUBRICS[v] || RUBRIC) + '\n' + (judgePromptText || '');
  return {
    evaluatorVersion: v,
    evaluatorHash: crypto.createHash('sha256').update(basis).digest('hex').slice(0, 12),
  };
}

const mean = (nums) => (nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : 0);

// Final beats = the per-page outlineExtract that fed scene expansion (the
// complete, post-review set). beatsReviewReport stores only CHANGED pages, so
// it is not the full artifact. Falls back to the ---BEATS--- outline section.
function finalBeats(d) {
  const scenes = (d.sceneDescriptions || []).filter(s => s && s.outlineExtract);
  if (scenes.length) {
    return scenes
      .sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0))
      .map(s => `--- Page ${s.pageNumber} ---\n${String(s.outlineExtract).trim()}`)
      .join('\n\n');
  }
  const m = (d.outline || '').match(/---\s*BEATS\s*---([\s\S]*?)(?:\n---|$)/i);
  return m ? m[1].trim() : (d.outline || '(no beats found)');
}

function finalScenes(d) {
  return (d.sceneDescriptions || [])
    .sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0))
    .map(s => `--- Page ${s.pageNumber} ---\n${s.description || s.scenePrompt || ''}`)
    .join('\n\n');
}

function extractArtifacts(d) {
  return {
    beats: finalBeats(d),
    scene: finalScenes(d),
    storyText: d.storyText || '(none)',
    visualBible: JSON.stringify(d.visualBible || {}, null, 2),
  };
}

const SECTION_TITLES = {
  beats: '# BEATS (narrative skeleton)',
  scene: '# SCENE BRIEFS (illustration descriptions)',
  storyText: '# STORY TEXT (child-facing prose)',
  visualBible: '# VISUAL BIBLE (entity / consistency spec)',
};

// Build the judge input from an artifacts object, including only the artifacts
// actually present. A full-story score passes all four; a single-stage rerun
// (e.g. just the beats, just the text) passes one — the judge then scores only
// that subset, and scoreFromDims({partial:true}) grades whatever came back.
function buildJudgeInputFromArtifacts(artifacts) {
  return Object.keys(RUBRIC)
    .filter(k => artifacts[k] != null && String(artifacts[k]).trim())
    .map(k => `${SECTION_TITLES[k]}\n${artifacts[k]}`)
    .join('\n\n===\n\n');
}

// The single-message input handed to the judge for a full stored story.
function buildJudgeInput(d) {
  return buildJudgeInputFromArtifacts(extractArtifacts(d));
}

// Which model made each artifact — so a record answers "which model, how good".
function provenanceOf(d) {
  return {
    writer: d.outlineModelId || null,
    beatsReview: d.beatsReviewReport?.model || null,
    sceneReview: d.sceneReviewReport?.model || null,
    textRefine: d.textRefineReport?.model || null,
  };
}

/**
 * Validate a dims-only judgment against the rubric and compute per-artifact
 * scores + overall. Throws on a missing artifact, a missing/out-of-range dim,
 * or an unknown dim, so a malformed judge response fails loudly instead of
 * silently scoring a partial rubric.
 * @param {Object} input {beats:{dims:{...},notes?}, scene:{...}, ...}
 * @returns {{artifacts: Object, overall: number}}
 */
function scoreFromDims(input, { partial = false, only = null, rubric = null } = {}) {
  if (!input || typeof input !== 'object') throw new Error('scorecard input is not an object');
  const artifacts = {};
  const artScores = [];
  for (const [artifact, dims] of Object.entries(rubric || RUBRIC)) {
    // Grade ONLY the artifacts actually sent to the judge. A judge handed just
    // `beats` often echoes the full JSON skeleton with 0s for the artifacts it
    // was not given; those must be ignored, not validated (0 is out of 1-10 and
    // would throw, killing a valid single-artifact score).
    if (only && !only.includes(artifact)) continue;
    const given = input[artifact];
    if (!given || typeof given.dims !== 'object') {
      if (partial || only) continue; // score only the artifacts the judge returned
      throw new Error(`missing scores for artifact "${artifact}"`);
    }
    const vals = [];
    for (const dim of dims) {
      const v = given.dims[dim];
      if (typeof v !== 'number' || v < 1 || v > 10) throw new Error(`${artifact}.${dim} must be a number 1-10, got ${JSON.stringify(v)}`);
      vals.push(v);
    }
    const extra = Object.keys(given.dims).filter(k => !dims.includes(k));
    if (extra.length) throw new Error(`${artifact} has unknown dims: ${extra.join(', ')}`);
    const score = mean(vals);
    artScores.push(score);
    artifacts[artifact] = { dims: given.dims, score, notes: typeof given.notes === 'string' ? given.notes : '' };
  }
  if ((partial || only) && artScores.length === 0) throw new Error('partial scorecard scored no artifacts');
  return { artifacts, overall: mean(artScores) };
}

// Tolerant JSON extraction from a model response (strips prose/fences).
function parseJudgeJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in judge response');
  return JSON.parse(s.slice(start, end + 1));
}

module.exports = {
  RUBRIC, RUBRIC_V1, EVALUATOR_RUBRICS, mean, finalBeats, finalScenes, extractArtifacts,
  buildJudgeInput, buildJudgeInputFromArtifacts, provenanceOf,
  scoreFromDims, parseJudgeJson,
  EVALUATOR_VERSION, DEFAULT_EVALUATOR_VERSION, EVALUATOR_PROMPT_KEYS, EVALUATORS,
  resolveEvaluator, findEvaluatorForJudge, listScorers, evaluatorStamp,
};

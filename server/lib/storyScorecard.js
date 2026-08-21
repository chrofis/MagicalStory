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
                'stakes', 'illustratable', 'repetition', 'castVariety', 'looseThreads',
                // Added 2026-08-21 (owner): length-appropriate complexity, single
                // focus, staggered entrances, difficulty vs reading level, and
                // whether the thing the book is ABOUT is actually on the page.
                // None of these existed, so every earlier beats score was blind
                // to them — numbers before this date are on a different scale.
                'fit', 'focus', 'entrances', 'difficulty', 'subject',
                // The listener test applies at plan level too (owner, 2026-08-21):
                // this run's beats carried a heard-once logic break (navigating by a
                // trail the dragon is leaving behind them) that causality at 6-7
                // failed to name.
                'sense', 'engaging'],
  scene:       ['clarity', 'variety', 'grounding', 'setting', 'composition'],
  // The listener test (owner, 2026-08-21): a book is read aloud to a child, so
  // the text is judged as a listening experience, not as prose craft. Old craft
  // dims are frozen into RUBRIC_V1/RUBRIC_V3 below so 1.x-3.x rows keep meaning.
  storyText:   ['language', 'sense', 'engaging', 'ageFit', 'alignment'],
  visualBible: ['completeness', 'wardrobe', 'world', 'anchors', 'consistency'],
};

// The rubric each evaluator VERSION scores against. Dims are per-version so old
// persisted rows (5-dim beats) remain interpretable next to new 10-dim rows;
// cross-version comparison is already flagged in the UI.
const RUBRIC_V1 = {
  ...RUBRIC,
  beats: ['arc', 'pacing', 'emotion', 'causality', 'themeFit'],
  storyText: ['language', 'readability', 'voice', 'alignment', 'dialogue'],
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
// The 10-dimension beats rubric that generations 1.2 through 3.x were scored on.
// Their stored scores mean what they meant; a rubric change makes a NEW version
// rather than redefining an old one.
const RUBRIC_V3 = {
  ...RUBRIC,
  beats: ['arc', 'pacing', 'emotion', 'causality', 'themeFit',
          'stakes', 'illustratable', 'repetition', 'castVariety', 'looseThreads'],
  storyText: ['language', 'readability', 'voice', 'alignment', 'dialogue'],
};

// Rubric for the arc-only judge (story-arc-judge.txt). Lives here, not in the
// stage that uses it: this module declares itself the one home of rubrics, and a
// second copy in testlab.js already drifted once.
const ARC_RUBRIC = { arc: ['shape', 'attempts', 'lost', 'agency', 'ensemble', 'change', 'blockers', 'grounding', 'fit', 'focus', 'entrances', 'difficulty', 'sense', 'engaging'] };

const EVALUATORS = {
  '1.0': { name: 'legacy 1.0', promptKey: 'storyScorecardJudge', rubric: RUBRIC_V1, judge: null },
  '1.1': { name: 'legacy 1.1 (harsh)', promptKey: 'storyScorecardJudgeV1_1', rubric: RUBRIC_V1, judge: null },
  '1.2': { name: 'legacy 1.2 (10-dim beats)', promptKey: 'storyScorecardJudgeV1_2', rubric: RUBRIC_V3, judge: null },
  '2.1': { name: 'sonnet', promptKey: 'storyScorecardJudgeV2', rubric: RUBRIC_V3, judge: 'claude-sonnet' },
  '2.2': { name: 'grok', promptKey: 'storyScorecardJudgeV2', rubric: RUBRIC_V3, judge: 'grok-4.6' },
  '2.3': { name: 'gemini', promptKey: 'storyScorecardJudgeV2', rubric: RUBRIC_V3, judge: 'gemini-3.1-pro' },
  // Generation 3 = premise-aware. 2.x judged the artifacts with no brief, so a
  // judge could not tell a commissioned premise from a plot hole: on the
  // moon-landing stories two judges independently reported the child-crew
  // casting as a defect when it is the product concept, stated verbatim in
  // storyDetails ("ROLES: <child>: <historical figure>"). A new generation
  // rather than an edit to 2.x, because changing what a judge sees changes every
  // score it produces — 2.x rows stay comparable among themselves.
  '3.1': { name: 'sonnet', promptKey: 'storyScorecardJudgeV3', rubric: RUBRIC_V3, judge: 'claude-sonnet' },
  '3.2': { name: 'grok', promptKey: 'storyScorecardJudgeV3', rubric: RUBRIC_V3, judge: 'grok-4.6' },
  '3.3': { name: 'gemini', promptKey: 'storyScorecardJudgeV3', rubric: RUBRIC_V3, judge: 'gemini-3.1-pro' },
  // Generation 4 = shape-aware. 3.x had no dimension for any of the things that
  // decide whether a book fits its format: complexity against length, one
  // character owning the arc, staggered entrances, difficulty against reading
  // level, and whether the subject the book is named for is actually on the
  // page. A judge blind to those scored a dragon story 9.0 while its dragon was
  // eyes in the dark. New generation, not an edit, for the same reason as 3.x.
  '4.1': { name: 'sonnet', promptKey: 'storyScorecardJudgeV4', rubric: RUBRIC, judge: 'claude-sonnet' },
  '4.2': { name: 'grok', promptKey: 'storyScorecardJudgeV4', rubric: RUBRIC, judge: 'grok-4.6' },
  '4.3': { name: 'gemini', promptKey: 'storyScorecardJudgeV4', rubric: RUBRIC, judge: 'gemini-3.1-pro' },
};
// back-compat shapes for anything that read these directly
const EVALUATOR_PROMPT_KEYS = Object.fromEntries(Object.entries(EVALUATORS).map(([v, e]) => [v, e.promptKey]));
const EVALUATOR_RUBRICS = Object.fromEntries(Object.entries(EVALUATORS).map(([v, e]) => [v, e.rubric]));
const DEFAULT_EVALUATOR_VERSION = '4.1'; // prompt gen 4 (shape-aware), judged by sonnet
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
// `outlineExtract` means different things per pipeline: in beats mode it holds
// "BEAT: …/SCENE: …" (a narrative plan), in unified mode it holds the scene
// expansion's own JSON ({"sceneIntent": …}). The old fallback chain never checked,
// so a unified story was scored on scene-intent JSON under the header "# BEATS
// (narrative skeleton)" and rated for arc, pacing and loose threads — grading the
// wrong artifact and making beats scores look comparable across pipelines when
// they were not. Return null instead: a missing artifact is omitted by
// scoreFromDims({partial}), which reports honestly that this story has no beats.
function finalBeats(d) {
  const looksLikeBeats = (t) => /(^|\n)\s*BEAT\s*:/i.test(String(t || ''));
  const scenes = (d.sceneDescriptions || []).filter(s => s && s.outlineExtract);
  if (scenes.length) {
    const text = scenes
      .sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0))
      .map(s => `--- Page ${s.pageNumber} ---\n${String(s.outlineExtract).trim()}`)
      .join('\n\n');
    if (looksLikeBeats(text)) return text;
  }
  const m = (d.outline || '').match(/---\s*BEATS\s*---([\s\S]*?)(?:\n---|$)/i);
  if (m && looksLikeBeats(m[1])) return m[1].trim();
  return null;
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
function buildJudgeInputFromArtifacts(artifacts, context = null) {
  const body = Object.keys(RUBRIC)
    .filter(k => artifacts[k] != null && String(artifacts[k]).trim())
    .map(k => `${SECTION_TITLES[k]}\n${artifacts[k]}`)
    .join('\n\n===\n\n');
  // The brief goes FIRST and is never a rubric key, so it can never be scored as
  // an artifact — it only stops a judge reporting the commission as a defect.
  return context && String(context).trim()
    ? `# BRIEF (the commission — context only, not scored)\n${String(context).trim()}\n\n===\n\n${body}`
    : body;
}

/**
 * The commission, as the judge should see it: what the story was asked to be.
 * `storyDetails` is the payload — it carries the role casting for historical
 * stories ("ROLES: <child>: <historical figure>"), which a premise-blind judge
 * reads as a plot hole. Everything here comes from the stored story row.
 */
function buildBriefContext(d = {}) {
  const lines = [
    d.title ? `Title: ${d.title}` : null,
    d.storyCategory ? `Category: ${d.storyCategory}` : null,
    d.storyTypeName || d.storyType ? `Type: ${d.storyTypeName || d.storyType}` : null,
    d.storyTopic ? `Topic: ${d.storyTopic}` : null,
    d.storyTheme ? `Theme: ${d.storyTheme}` : null,
    d.language ? `Language: ${d.language}` : null,
    d.languageLevel ? `Reading level: ${d.languageLevel}` : null,
    d.pages ? `Pages: ${d.pages}` : null,
    Array.isArray(d.characters) && d.characters.length
      // Ages included: the shape-aware dims (fit, difficulty, subject) are
      // scored against the cast's ages — without them the judge grades against
      // facts it has to invent.
      ? `Cast: ${d.characters.map(c => c && (c.age ? `${c.name} (${c.age})` : c.name)).filter(Boolean).join(', ')}` : null,
    d.storyDetails ? `\nCommissioned idea:\n${String(d.storyDetails).slice(0, 3000)}` : null,
  ].filter(Boolean);
  // The computed allowance the artifacts were written under, so `fit` is judged
  // against the real budget rather than a guess. Lazy require: promptBuilders
  // does not require this module, so there is no cycle.
  try {
    const { buildStoryShapeSection } = require('./promptBuilders');
    const pages = parseInt(d.pages, 10) || (Array.isArray(d.sceneImages) ? d.sceneImages.length : 0);
    if (pages) {
      const shape = buildStoryShapeSection(d, pages);
      if (shape) lines.push(`\n${shape}`);
    }
  } catch { /* judge context degrades to the plain brief */ }
  return lines.length ? lines.join('\n') : '';
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
  RUBRIC, RUBRIC_V1, ARC_RUBRIC, EVALUATOR_RUBRICS, mean, finalBeats, finalScenes, extractArtifacts,
  buildJudgeInput, buildJudgeInputFromArtifacts, buildBriefContext, provenanceOf,
  scoreFromDims, parseJudgeJson,
  EVALUATOR_VERSION, DEFAULT_EVALUATOR_VERSION, EVALUATOR_PROMPT_KEYS, EVALUATORS,
  resolveEvaluator, findEvaluatorForJudge, listScorers, evaluatorStamp,
};

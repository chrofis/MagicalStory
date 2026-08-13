/**
 * Story scorecard — the ONE source of truth for the model-comparison rubric,
 * the four final-artifact extractors, and the dim→score math. Used by both the
 * CLI (scripts/analysis/score-story.js) and the Test Lab `story_scorecard`
 * stage (server/lib/testlab.js) so they always agree on what is scored and how.
 *
 * Reviewer-judged, final outputs only. See docs/model-comparison/README.md.
 */

const crypto = require('crypto');

// artifact -> ordered dimension keys. The judge prompt
// (prompts/story-scorecard-judge.txt) mirrors these exactly.
const RUBRIC = {
  beats:       ['arc', 'pacing', 'emotion', 'causality', 'themeFit'],
  scene:       ['clarity', 'variety', 'grounding', 'setting', 'composition'],
  storyText:   ['language', 'readability', 'voice', 'alignment', 'dialogue'],
  visualBible: ['completeness', 'wardrobe', 'world', 'anchors', 'consistency'],
};

// Evaluator version — BUMP when the rubric dims or the judge prompt change so
// scores from different evaluators never get silently compared. The semver is
// for humans ("why did scores move"); the hash is tamper-evidence — it folds in
// the rubric AND the judge-prompt text, so a silent prompt edit that forgot to
// bump the semver still shows a changed hash. Every score record carries both.
const EVALUATOR_VERSION = '1.0';
function evaluatorStamp(judgePromptText) {
  const basis = JSON.stringify(RUBRIC) + '\n' + (judgePromptText || '');
  return {
    evaluatorVersion: EVALUATOR_VERSION,
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
function scoreFromDims(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') throw new Error('scorecard input is not an object');
  const artifacts = {};
  const artScores = [];
  for (const [artifact, dims] of Object.entries(RUBRIC)) {
    const given = input[artifact];
    if (!given || typeof given.dims !== 'object') {
      if (partial) continue; // partial: score only the artifacts the judge returned
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
  if (partial && artScores.length === 0) throw new Error('partial scorecard scored no artifacts');
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
  RUBRIC, mean, finalBeats, finalScenes, extractArtifacts,
  buildJudgeInput, buildJudgeInputFromArtifacts, provenanceOf,
  scoreFromDims, parseJudgeJson,
  EVALUATOR_VERSION, evaluatorStamp,
};

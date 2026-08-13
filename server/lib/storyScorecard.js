/**
 * Story scorecard — the ONE source of truth for the model-comparison rubric,
 * the four final-artifact extractors, and the dim→score math. Used by both the
 * CLI (scripts/analysis/score-story.js) and the Test Lab `story_scorecard`
 * stage (server/lib/testlab.js) so they always agree on what is scored and how.
 *
 * Reviewer-judged, final outputs only. See docs/model-comparison/README.md.
 */

// artifact -> ordered dimension keys. The judge prompt
// (prompts/story-scorecard-judge.txt) mirrors these exactly.
const RUBRIC = {
  beats:       ['arc', 'pacing', 'emotion', 'causality', 'themeFit'],
  scene:       ['clarity', 'variety', 'grounding', 'setting', 'composition'],
  storyText:   ['language', 'readability', 'voice', 'alignment', 'dialogue'],
  visualBible: ['completeness', 'wardrobe', 'world', 'anchors', 'consistency'],
};

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

// The single-message input handed to the judge (the four final artifacts).
function buildJudgeInput(d) {
  const a = extractArtifacts(d);
  return [
    `# BEATS (narrative skeleton)\n${a.beats}`,
    `# SCENE BRIEFS (illustration descriptions)\n${a.scene}`,
    `# STORY TEXT (child-facing prose)\n${a.storyText}`,
    `# VISUAL BIBLE (entity / consistency spec)\n${a.visualBible}`,
  ].join('\n\n===\n\n');
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
function scoreFromDims(input) {
  if (!input || typeof input !== 'object') throw new Error('scorecard input is not an object');
  const artifacts = {};
  const artScores = [];
  for (const [artifact, dims] of Object.entries(RUBRIC)) {
    const given = input[artifact];
    if (!given || typeof given.dims !== 'object') throw new Error(`missing scores for artifact "${artifact}"`);
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
  buildJudgeInput, provenanceOf, scoreFromDims, parseJudgeJson,
};

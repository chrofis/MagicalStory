/**
 * Story TEXT quality judge (Test Lab text-only harness).
 *
 * Scores a generated story's TEXT ONLY on five text-only criteria (coherence,
 * age-appropriateness, character consistency, emotional arc, language quality).
 * Deliberately NO picturability/image criterion — this harness exists to judge
 * writing in isolation from illustration (owner decision, see docs/decisions.md).
 *
 * Cross-model by design: the default judge model is intentionally NOT the model
 * that writes the story text (which is Claude in the unified pipeline), to avoid
 * self-grading bias. Default judge = gemini-2.5-flash, overridable via
 * opts.judgeModel or the TEXT_JUDGE_MODEL env var.
 */

// NOTE: ./textModels is required LAZILY inside the functions that call the model
// (resolveJudgeModel, judgeStoryText). It pulls in the AI concurrency stack
// (p-limit etc.); keeping it out of module top-level lets the pure, deterministic
// helpers below (parseJudgeResponse, formatStoryText) be unit-tested with no
// heavy deps or live API. prompts.js + logger are light and safe at top-level.
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { log } = require('../utils/logger');

// Cross-model default: judge with a different provider than the story writer
// (Claude) so the grader is not marking its own homework.
const DEFAULT_JUDGE_MODEL = 'gemini-2.5-flash';

const CRITERIA = ['coherence', 'ageAppropriateness', 'characterConsistency', 'emotionalArc', 'languageQuality'];

/**
 * Resolve the judge model key: explicit opt → env → default. Falls back to the
 * default if the requested key isn't a known TEXT_MODELS entry (fail safe, not
 * fail silent — we warn).
 */
function resolveJudgeModel(judgeModel) {
  const { TEXT_MODELS } = require('./textModels');
  const requested = judgeModel || process.env.TEXT_JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
  if (!TEXT_MODELS[requested]) {
    log.warn(`[TEXT-JUDGE] Unknown judge model "${requested}" — falling back to ${DEFAULT_JUDGE_MODEL}`);
    return DEFAULT_JUDGE_MODEL;
  }
  return requested;
}

/**
 * Format the story pages into a single labelled block for the judge prompt.
 * Skips pages with no text so the judge only sees real content.
 */
function formatStoryText(pages) {
  return (pages || [])
    .filter(p => p && typeof p.text === 'string' && p.text.trim().length > 0)
    .map(p => `--- Page ${p.pageNumber != null ? p.pageNumber : '?'} ---\n${p.text.trim()}`)
    .join('\n\n');
}

/**
 * Parse + validate the judge's JSON response. Robust to models that wrap the
 * JSON in prose or code fences (regex-extract the first {...} block, matching
 * sceneValidator.repairScene's approach). Returns { ok, data } or { ok:false, error }.
 */
function parseJudgeResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { ok: false, error: 'Empty judge response' };
  }
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { ok: false, error: 'No JSON object found in judge response', raw: rawText.slice(0, 500) };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return { ok: false, error: `JSON parse error: ${err.message}`, raw: jsonMatch[0].slice(0, 500) };
  }

  if (!parsed.scores || typeof parsed.scores !== 'object') {
    return { ok: false, error: 'Judge response missing "scores" object', raw: parsed };
  }

  // Validate every criterion is present and an integer in [1,5].
  const cleanScores = {};
  for (const key of CRITERIA) {
    const v = parsed.scores[key];
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n) || n < 1 || n > 5) {
      return { ok: false, error: `Invalid or missing score for "${key}": ${JSON.stringify(v)}`, raw: parsed };
    }
    cleanScores[key] = Math.round(n);
  }

  // Recompute overall from the validated scores rather than trusting the model's
  // arithmetic (models frequently mis-average).
  const overall = Number(
    (CRITERIA.reduce((sum, k) => sum + cleanScores[k], 0) / CRITERIA.length).toFixed(1)
  );

  const justifications = {};
  if (parsed.justifications && typeof parsed.justifications === 'object') {
    for (const key of CRITERIA) {
      if (typeof parsed.justifications[key] === 'string') justifications[key] = parsed.justifications[key];
    }
  }

  return {
    ok: true,
    data: {
      scores: cleanScores,
      justifications,
      overall,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    },
  };
}

/**
 * Judge a story's text.
 *
 * @param {Object} story
 * @param {string} story.title
 * @param {Array<{pageNumber:number, text:string}>} story.pages
 * @param {string} [story.language]
 * @param {string} [story.readingLevel]
 * @param {string} [story.ageRange]
 * @param {Object} [opts]
 * @param {string} [opts.judgeModel]  - TEXT_MODELS key override for the judge.
 * @param {string} [opts.usageLabel]  - accounting label (default 'text_quality_judge').
 * @returns {Promise<Object>} On success: { success:true, judgeModel, ...scoreObject }.
 *                            On failure: { success:false, error, judgeModel, raw? }.
 */
async function judgeStoryText(story = {}, opts = {}) {
  const { title, pages, language, readingLevel, ageRange } = story;

  // Input guards — fail loudly.
  if (!Array.isArray(pages) || pages.length === 0) {
    return { success: false, error: 'judgeStoryText: no pages provided' };
  }
  const storyText = formatStoryText(pages);
  if (!storyText || storyText.trim().length === 0) {
    return { success: false, error: 'judgeStoryText: pages contain no text' };
  }

  const template = PROMPT_TEMPLATES.storyTextQualityJudge;
  if (!template) {
    return { success: false, error: 'judgeStoryText: story-text-quality-judge template not loaded' };
  }

  const judgeModel = resolveJudgeModel(opts.judgeModel);

  const prompt = fillTemplate(template, {
    LANGUAGE: language || 'unspecified',
    READING_LEVEL: readingLevel || 'unspecified',
    AGE_RANGE: ageRange || 'unspecified',
    TITLE: title || 'Untitled',
    STORY_TEXT: storyText,
  });

  const { callTextModel } = require('./textModels');
  let result;
  try {
    result = await callTextModel(prompt, 2048, judgeModel, {
      usageLabel: opts.usageLabel || 'text_quality_judge',
      // prefill nudges the model straight into the JSON object (supported on
      // anthropic + google providers). The parser prepends nothing, so the
      // regex-extract handles either a prefilled or a bare response.
      prefill: '{',
    });
  } catch (err) {
    log.error(`[TEXT-JUDGE] Model call failed (${judgeModel}): ${err.message}`);
    return { success: false, error: `Judge model call failed: ${err.message}`, judgeModel };
  }

  // If prefill was applied, the returned text may start mid-object without the
  // leading brace — re-attach it before parsing so the {...} regex matches.
  let text = result.text || '';
  if (!text.trim().startsWith('{') && text.includes('"scores"')) {
    text = `{${text}`;
  }

  const parsed = parseJudgeResponse(text);
  if (!parsed.ok) {
    log.warn(`[TEXT-JUDGE] Parse failed (${judgeModel}): ${parsed.error}`);
    return { success: false, error: parsed.error, judgeModel, raw: parsed.raw };
  }

  return { success: true, judgeModel, modelId: result.modelId, ...parsed.data };
}

module.exports = {
  judgeStoryText,
  parseJudgeResponse,
  formatStoryText,
  resolveJudgeModel,
  DEFAULT_JUDGE_MODEL,
  CRITERIA,
};

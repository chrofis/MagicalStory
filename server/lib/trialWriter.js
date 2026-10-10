/**
 * The trial story writer: TWO calls.
 *
 *   A  planner (MODEL_DEFAULTS.trialArcModel, reasoning low): ARC + TITLE + VISUAL BIBLE + COVER SCENE.
 *   B  pages writer (the job's outline model, MODEL_DEFAULTS.trialStoryEffort): page texts + scene hints,
 *      bound to A's arc and bible.
 *
 * A's text is handed to the progressive parser the moment it lands, so the title, bible and cover fire
 * (plates, reference sheets, cover) ~13 s in while B is still writing; B then streams the pages.
 * The merged transcript (A + B) is what every downstream parser and the stored `outline` read: it has the
 * shape the former single-call writer produced, plus the extra ---STORY ARC--- section.
 *
 * Shared by the trial pipeline (storyJobPipeline.js) and the Test Lab trial stage (testlab.js), so the
 * two cannot drift. docs/decisions.md 2026-10-10 "Trial writer: Flash arc+bible v4".
 */
const { buildTrialArcPrompt, buildTrialPagesPrompt } = require('./promptBuilders');
const { callTextModelStreaming, describeTruncation } = require('./textModels');
const { MODEL_DEFAULTS } = require('../config/models');

const PAGES_MARKER = '---STORY PAGES---';

function addUsage(a, b) {
  const sum = k => (a?.[k] || 0) + (b?.[k] || 0);
  return { ...a, ...b, input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens') };
}

/**
 * @param {object} p
 * @param {object} p.inputData
 * @param {number} p.sceneCount
 * @param {string} p.pagesModel         model key of call B
 * @param {string} [p.arcSuffix]        extra text appended to call A's prompt (Lab: the challenge draw)
 * @param {Function} [p.onArcText]      (arcText, mergedSoFar) once call A is done; mergedSoFar ends on the pages marker
 * @param {Function} [p.onPagesChunk]   (chunk, mergedText) for every chunk of call B
 * @param {Function} [p.heartbeat]      called on every streamed chunk of either call
 * @param {Function} [p.callText]       the model call (tests inject a fake); defaults to callTextModelStreaming
 * @returns {Promise<{text, arcText, pagesText, arcPrompt, pagesPrompt, modelId, usage, arcResult, pagesResult}>}
 */
async function runTrialWriter({ inputData, sceneCount, pagesModel, arcSuffix = '', onArcText, onPagesChunk, heartbeat, callText = callTextModelStreaming }) {
  const arcPrompt = buildTrialArcPrompt(inputData, sceneCount) + arcSuffix;
  const arcResult = await callText(arcPrompt, null, () => heartbeat && heartbeat(), MODEL_DEFAULTS.trialArcModel,
    { usageLabel: 'unified_story', reasoning: { effort: MODEL_DEFAULTS.trialArcEffort } });
  if (arcResult.truncation?.suspected) throw new Error('trial planner reply was cut off: ' + describeTruncation(arcResult.truncation));
  const arcText = String(arcResult.text || '').trim();
  // No fallback: a plan without its arc or bible cannot bind the pages writer; fail the job loudly.
  for (const section of ['---STORY ARC---', '---VISUAL BIBLE---']) {
    if (!arcText.includes(section)) throw new Error(`trial planner ${arcResult.modelId || MODEL_DEFAULTS.trialArcModel} returned no ${section} section (${arcText.length} chars)`);
  }
  // Ends on the marker B's output starts with, so the progressive parser closes the cover scene now.
  if (onArcText) onArcText(arcText, `${arcText}\n\n${PAGES_MARKER}\n`);

  const pagesPrompt = buildTrialPagesPrompt(inputData, sceneCount, arcText);
  const pagesResult = await callText(pagesPrompt, null, (chunk, fullText) => {
    if (onPagesChunk) onPagesChunk(chunk, `${arcText}\n\n${fullText}`);
    if (heartbeat) heartbeat();
  }, pagesModel, { usageLabel: 'unified_story', effort: MODEL_DEFAULTS.trialStoryEffort });
  if (pagesResult.truncation?.suspected) throw new Error('trial pages reply was cut off: ' + describeTruncation(pagesResult.truncation));
  const pagesText = String(pagesResult.text || '').trim();
  if (!pagesText.includes(PAGES_MARKER)) throw new Error(`trial pages writer ${pagesResult.modelId || pagesModel} returned no ${PAGES_MARKER} section (${pagesText.length} chars)`);

  return {
    text: `${arcText}\n\n${pagesText}`,
    arcText, pagesText, arcPrompt, pagesPrompt,
    modelId: pagesResult.modelId,
    usage: addUsage(arcResult.usage, pagesResult.usage),
    arcResult, pagesResult,
  };
}

module.exports = { runTrialWriter, PAGES_MARKER };

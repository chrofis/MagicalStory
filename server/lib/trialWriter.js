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
const { UnifiedStoryParser } = require('./outlineParser');
const { log } = require('../utils/logger');
const { MODEL_DEFAULTS } = require('../config/models');

const PAGES_MARKER = '---STORY PAGES---';

function addUsage(a, b) {
  const sum = k => (a?.[k] || 0) + (b?.[k] || 0);
  return { ...a, ...b, input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens') };
}

/**
 * Call B owes a scene hint (a JSON `scene` object) for EVERY page. The model returned text-only pages once
 * (staging job_1792476898085_zdswtvv9v: pages 1-5 TEXT only, page 6 "SCENE HINT: placeholder") and the picture
 * model was then given the page text as the scene. Never a page-text stand-in: the pages without a hint are
 * re-asked once (runTrialWriter), and a second miss throws. docs/decisions.md 2026-10-20.
 * @returns {number[]} page numbers 1..sceneCount without a parseable scene hint
 */
function pagesMissingSceneHint(text, sceneCount) {
  const pages = new UnifiedStoryParser(text, { isTrial: true }).extractPages();
  const bad = [];
  for (let n = 1; n <= sceneCount; n++) {
    const page = pages.find(p => p.pageNumber === n);
    let ok = false;
    if (page && page.sceneHint) {
      try { ok = !!JSON.parse(page.sceneHint)?.scene; } catch { ok = false; }
    }
    if (!ok) bad.push(n);
  }
  return bad;
}

/** The `--- Page N ---` blocks of a pages section, keyed by page number. */
function pageBlocks(pagesText) {
  const blocks = new Map();
  for (const part of String(pagesText).split(/^(?=--- Page \d+ ---)/m)) {
    const m = part.match(/^--- Page (\d+) ---/);
    if (m) blocks.set(Number(m[1]), part.trim());
  }
  return blocks;
}

/** The fed-back correction appended to call B's prompt on its one re-ask (generic: names pages, no story content). */
function reaskNote(badPages) {
  return `\n\n# CORRECTION\n\nYour previous reply gave no usable SCENE HINT for page(s) ${badPages.join(', ')}. Every page needs its SCENE HINT block: the words "SCENE HINT:" followed by a fenced json object that starts {"scene":{...}}, exactly as in the OUTPUT FORMAT. Write the complete pages section again, all pages, each with its TEXT and its JSON SCENE HINT.`;
}

/**
 * @param {object} p
 * @param {object} p.inputData
 * @param {number} p.sceneCount
 * @param {string} p.pagesModel         model key of call B
 * @param {string} [p.arcSuffix]        extra text appended to call A's prompt (Lab: the challenge draw)
 * @param {Function} [p.onArcText]      (arcText, mergedSoFar) once call A is done; mergedSoFar ends on the pages marker
 * @param {Function} [p.onPagesChunk]   (chunk, mergedText) for every chunk of call B's first attempt (a re-ask is not streamed)
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
  let pagesText = String(pagesResult.text || '').trim();
  if (!pagesText.includes(PAGES_MARKER)) throw new Error(`trial pages writer ${pagesResult.modelId || pagesModel} returned no ${PAGES_MARKER} section (${pagesText.length} chars)`);
  let usage = addUsage(arcResult.usage, pagesResult.usage);
  let modelId = pagesResult.modelId;

  const bad = pagesMissingSceneHint(`${arcText}\n\n${pagesText}`, sceneCount);
  if (bad.length) {
    // ONE fed-back re-ask naming the pages that fell short (a paid generation is not aborted while a retry can fix
    // it). Its chunks are NOT streamed: the progressive parser has already seen attempt 1. A page that came with a
    // valid hint keeps attempt 1's block (its picture may already be drawing from it); only the missing pages take
    // the re-ask's block. A second miss throws; the page text is never a stand-in.
    log.warn(`[TRIAL-WRITER] pages writer ${modelId || pagesModel} gave no usable scene hint for page(s) ${bad.join(', ')} of ${sceneCount}; re-asking once`);
    const retry = await callText(pagesPrompt + reaskNote(bad), null, () => heartbeat && heartbeat(), pagesModel,
      { usageLabel: 'unified_story', effort: MODEL_DEFAULTS.trialStoryEffort });
    if (retry.truncation?.suspected) throw new Error('trial pages re-ask reply was cut off: ' + describeTruncation(retry.truncation));
    usage = addUsage(usage, retry.usage);
    modelId = retry.modelId || modelId;
    const first = pageBlocks(pagesText);
    const second = pageBlocks(String(retry.text || ''));
    const merged = [];
    for (let n = 1; n <= sceneCount; n++) {
      const block = bad.includes(n) ? (second.get(n) || first.get(n)) : first.get(n);
      if (block) merged.push(block);
    }
    pagesText = [PAGES_MARKER, ...merged].join('\n\n');
    const stillBad = pagesMissingSceneHint(`${arcText}\n\n${pagesText}`, sceneCount);
    if (stillBad.length) throw new Error(`trial pages writer ${modelId || pagesModel} returned no usable scene hint (JSON "scene" block) for page(s) ${stillBad.join(', ')} of ${sceneCount}, after one re-ask`);
  }

  return {
    text: `${arcText}\n\n${pagesText}`,
    arcText, pagesText, arcPrompt, pagesPrompt,
    modelId,
    usage,
    arcResult, pagesResult,
  };
}

module.exports = { runTrialWriter, pagesMissingSceneHint, PAGES_MARKER };

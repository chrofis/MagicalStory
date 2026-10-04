'use strict';

/**
 * THE SCENE IS SHORTENED WHEN NOTHING ELSE FITS THE PROMPT (owner, 2026-09-30:
 * "They must be shortened. One try. If not cut enough mechanically cut things
 * till it fits.").
 *
 * The last two steps of images.js shrinkPromptForModel, after the ranked block
 * drops. Before this date a page whose scene + must-keep blocks overran Grok's
 * cap threw PromptFitError and shipped with NO image (smoke
 * job_1790529840433_ar4u7qry3 p1/p4, dragon job_1790539784661_6mjcny1c7 front
 * cover and p18 repair). Now:
 *
 *   1. ONE LLM try shortens the scene prose to the room the page has
 *      (MODEL_DEFAULTS.promptCompress). A failed or unusable answer counts as
 *      the try — never a second call.
 *   2. Whatever is still over is cut from the END of the scene prose, at a
 *      sentence boundary, until the prompt fits.
 *
 * Only the scene prose is touched. Every labelled block around it — THIS IMAGE
 * DEPICTS, HEIGHT ORDER, AGE & PROPORTIONS, DISTINCTIVE FEATURES, the card
 * frames, WORN ITEMS and the whole protected tail — stays byte-exact, so the
 * cast, clothing, proportions and style survive by construction, not by model
 * obedience (the retired 2026-08 compressor rewrote the whole head and was
 * measured deleting four characters' hats).
 *
 * The judges read the scene that was SENT: shrinkPromptForModel stamps the
 * shortened head as `compressedScene` (decisions.md 2026-09-26).
 */

const { log } = require('../utils/logger');

/**
 * A paragraph that is one of the prompt's labelled blocks, never scene prose:
 * a `**BOLD:**` heading, an ALL-CAPS heading (`AGE & PROPORTIONS (`,
 * `REFERENCE CARD FRAMES (`, `EXACT POSES:`), a bullet list, or one of the two
 * fixed rendering paragraphs of prompts/image-generation.txt.
 */
function isLabelledBlock(paragraph) {
  const p = paragraph.trimStart();
  return p === ''
    || p.startsWith('**')
    || p.startsWith('- ')
    || /^[A-Z][A-Z0-9 &/'’,-]{2,}\s*[:(]/.test(p)
    || p.startsWith('Generate a SINGLE')
    || p.startsWith('When the FIRST reference');
}

/**
 * The scene prose of a prompt's head: the paragraphs that are not a labelled
 * block. Returned as indices into `head.split('\n\n')` so the caller can put
 * the rewritten prose back exactly where it was.
 */
function sceneParagraphIndices(head) {
  return head.split('\n\n').map((p, i) => (isLabelledBlock(p) ? -1 : i)).filter(i => i >= 0);
}

/**
 * Cut `text` from the end to at most `maxLen` chars, at the last sentence end
 * that fits. Falls to the last word boundary when no sentence end does.
 */
function cutAtSentence(text, maxLen) {
  if (text.length <= maxLen) return text;
  if (maxLen <= 0) return '';
  const keep = text.slice(0, maxLen);
  const stop = Math.max(keep.lastIndexOf('. '), keep.lastIndexOf('.\n'), keep.endsWith('.') ? keep.length - 1 : -1);
  if (stop > 0) return keep.slice(0, stop + 1).trim();
  const space = keep.lastIndexOf(' ');
  return (space > 0 ? keep.slice(0, space) : keep).trim();
}

/**
 * The one LLM try. Returns the shortened prose, or null when the call failed or
 * the answer is unusable (empty, not shorter, or a stub under half the room —
 * a model that writes far under its allowance silently deletes scene facts).
 */
async function shortenSceneOnce(prose, targetChars, logLabel) {
  const { callTextModel } = require('./textModels');
  const { resolvePromptCompressModel } = require('../config/models');
  const model = resolvePromptCompressModel();
  const cutPct = Math.max(5, Math.round((1 - targetChars / prose.length) * 100));
  // TWO targets, both from this page (owner, 2026-08-12): the relative cut
  // says how hard to squeeze, the absolute cap in characters is the unit that
  // binds. And WHAT to keep is the main points, ranked, not "every fact": a
  // "keep every fact" + "cut 26%" ask has no solution on a dense page, and
  // models resolved it by deleting garments or returning a near-copy.
  const instruction = `Shorten the scene description below to at most ${targetChars} characters `
    + `(roughly ${Math.floor(targetChars / 6.5)} words). It is ${prose.length} characters now, so about ${cutPct}% has to go. `
    + 'Keep all the main points: every character named, where each one is, what each one is doing and facing, '
    + 'what each one wears, and every object named. Say them in fewer words. '
    + 'Cut in this order, and stop as soon as it fits: 1. mood, atmosphere and lighting adjectives; '
    + '2. background and setting detail; 3. repeated wording. '
    + `Output ONLY the rewritten description, as plain prose.\n\n${prose}`;
  try {
    // reasoning OFF is required: with it on, deepseek-v4-pro spent its whole
    // output budget thinking and returned an empty string (Lab #530).
    const res = await callTextModel(instruction, null, model,
      { usageLabel: 'prompt_compress', temperature: 0, reasoning: { enabled: false } });
    const text = String(res?.text || '').trim();
    if (!text || text.length >= prose.length || text.length < targetChars * 0.5) {
      log.warn(`✂️ [${logLabel}] Scene shortening by ${model} unusable: ${text.length} chars for ${targetChars} allowed (was ${prose.length}) — cutting instead`);
      return null;
    }
    log.info(`✂️ [${logLabel}] Scene shortened by ${model}: ${prose.length}→${text.length} chars (${targetChars} allowed)`);
    return text;
  } catch (err) {
    log.warn(`✂️ [${logLabel}] Scene shortening by ${model} failed (${err.message}) — cutting instead`);
    return null;
  }
}

/**
 * Bring `prompt` under `maxLen` by shortening its scene prose: one LLM try,
 * then a sentence cut from the end of the prose. `tailStart` is where the
 * protected tail begins (images.js protectedTailStart); nothing from there on
 * is touched, nor any labelled block of the head.
 *
 * @returns {Promise<{ text: string, llmChars: number, proseCut: number } | null>}
 *   null when the prompt has no scene prose, or cannot fit even with the prose
 *   gone — the caller then fails loudly.
 */
async function shortenSceneToFit(prompt, maxLen, tailStart, logLabel) {
  const head = prompt.slice(0, tailStart);
  const tail = prompt.slice(tailStart);
  const paras = head.split('\n\n');
  const idx = sceneParagraphIndices(head);
  if (!idx.length) return null;

  const proseOf = () => idx.map(i => paras[i]).join('\n\n');
  const excess = () => paras.join('\n\n').length + tail.length - maxLen;
  const prose = proseOf();
  if (excess() >= prose.length) return null; // even no prose at all would not fit

  // 1. One LLM try, into the first scene paragraph's slot.
  let llmChars = 0;
  // Through module.exports so a test can stand in for the model call.
  const shortened = await module.exports.shortenSceneOnce(prose, prose.length - excess() - 20, logLabel);
  if (shortened) {
    llmChars = prose.length - shortened.length;
    paras[idx[0]] = shortened;
    for (const i of idx.slice(1)) paras[i] = '';
  }

  // 2. Mechanical: cut from the end of the prose until it fits.
  let proseCut = 0;
  for (let k = idx.length - 1; k >= 0 && excess() > 0; k--) {
    const i = idx[k];
    const before = paras[i].length;
    paras[i] = cutAtSentence(paras[i], Math.max(0, before - excess()));
    proseCut += before - paras[i].length;
  }
  const text = paras.filter((p, i) => p !== '' || !idx.includes(i)).join('\n\n').replace(/\n{3,}/g, '\n\n') + tail;
  if (text.length > maxLen) return null;
  if (proseCut) log.warn(`✂️ [${logLabel}] Scene prose cut by ${proseCut} chars at sentence ends to fit ${maxLen}`);
  return { text, llmChars, proseCut };
}

module.exports = { shortenSceneToFit, shortenSceneOnce, sceneParagraphIndices, cutAtSentence, isLabelledBlock };

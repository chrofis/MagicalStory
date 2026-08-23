/**
 * Iterative text refinement — full text in, rewritten pages out.
 *
 * ONE implementation, two callers: the Test Lab stage (`text_refine`) and the
 * production pipeline, which runs it in parallel with image generation. Keeping
 * the loop here rather than inside the Lab stage is the point — a second copy in
 * server.js would drift the moment either side changed.
 *
 * The contract each round: the model receives the brief, the scene outlines
 * (READ-ONLY) and the CURRENT text, writes an analysis, then returns only the
 * pages it rewrote. Round N+1's input is round N's output; no critique is
 * carried forward. Pages the model omits keep their text, so a page can never be
 * lost by being skipped.
 *
 * Scene outlines being read-only is what makes the production parallelism safe:
 * illustrations are already rendering from those scenes, and the refiner may
 * only change prose, never events.
 */

const { log } = require('../utils/logger');

/**
 * @param {Object} storyData - story record fields (language, characters, brief, …)
 * @param {Array<{pageNumber:number,text:string,sceneIntent:string}>} pages
 * @param {Object} [opts]
 * @param {number} [opts.rounds=4]      ceiling, not a target — stops when a round rewrites nothing
 * @param {string} [opts.model]         model for every round
 * @param {string[]} [opts.roundModels] per-round model override
 * @param {string} [opts.promptOverride] replaces the round-1 prompt (Lab A/B only)
 * @param {string} [opts.usageLabel]
 * @returns {Promise<{pages, rounds, changed}>}
 */
async function refineStoryText(storyData, pages, opts = {}) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildTextRefinePrompt, parseRefinedText } = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { TEXT_MODELS, MODEL_DEFAULTS, calculateTextCost } = require('../config/models');

  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('refineStoryText: no page text to refine');
  }
  const expected = pages.map(p => p.pageNumber);

  const roundCount = Math.max(1, Math.min(8, parseInt(opts.rounds, 10) || 4));
  const perRound = Array.isArray(opts.roundModels) ? opts.roundModels : [];
  // opts.model still wins (Lab A/B). Default is the dedicated text key — NOT the
  // beats reviewer: this stage is time-boxed against the image phase.
  const defaultModel = opts.model || MODEL_DEFAULTS.textRefineModel || MODEL_DEFAULTS.outlineReviewModel;
  const usageLabel = opts.usageLabel || 'text_refine';

  const original = pages.map(p => ({ ...p }));
  let current = pages.map(p => ({ ...p }));
  const rounds = [];

  // Blind audit of the text as delivered: a reader with only the back cover,
  // the pages and what each picture shows names faults. Round 1's fix ledger
  // must answer every one. Never blocks — a failed audit just means the
  // refiner runs on its own checks alone.
  let auditFindings = '';
  const auditModel = opts.auditModel || MODEL_DEFAULTS.arcReviewModel || defaultModel;
  try {
    const { buildTextAuditPrompt } = require('./storyHelpers');
    const auditPrompt = buildTextAuditPrompt(storyData, current);
    if (auditPrompt && TEXT_MODELS[auditModel]) {
      const t0 = Date.now();
      const a = await callTextModelStreaming(auditPrompt, 12000, null, auditModel, { usageLabel: 'text_audit' });
      auditFindings = String(a.text || '').trim();
      log.info(`🔎 [TEXT-AUDIT] ${auditModel}: ${(auditFindings.match(/^FAULT:/gm) || []).length} fault(s) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  } catch (auditErr) {
    log.warn(`⚠️ [TEXT-AUDIT] failed (${auditErr.message}) — refinement runs without audit findings`);
  }

  for (let i = 0; i < roundCount; i++) {
    const modelKey = perRound[i] || defaultModel;
    if (!TEXT_MODELS[modelKey]) throw new Error(`Unknown model "${modelKey}"`);

    // Built fresh from CURRENT text each round — that is the whole mechanism.
    // Audit findings go to round 1 only: they were found on the delivered text,
    // and later rounds would mis-flag pages round 1 already fixed.
    let prompt = buildTextRefinePrompt(storyData, current, i === 0 ? auditFindings : '');
    if (!prompt) throw new Error('text-refine template unavailable');
    if (opts.promptOverride && i === 0) prompt = opts.promptOverride;

    const t0 = Date.now();
    try {
      // 64000, raised from 16000 (2026-08-23): a 16-page long-text run's
      // mandatory analysis plus rewrites hit the old cap exactly, and a
      // truncated reply parses as zero page blocks — reported as "nothing to
      // rewrite" while dash-carrying pages shipped (job_1787423677246 p1/p12).
      // Worst measured rate is ~1350 output tokens/page, so a 25-page book
      // (the wizard maximum) needs ~34k. The guard clamps to the model's own
      // limit so a smaller override model still trips it, and makes any cap
      // hit a loud round failure instead of a silent convergence.
      const MAX_OUT = Math.min(64000, TEXT_MODELS[modelKey].maxOutputTokens || 64000);
      const r = await callTextModelStreaming(prompt, MAX_OUT, null, modelKey, { usageLabel });
      const elapsedMs = Date.now() - t0;
      if ((r.usage?.output_tokens || 0) >= MAX_OUT) {
        throw new Error(`output hit the ${MAX_OUT}-token cap — reply truncated, rewrites unusable`);
      }
      const parsed = parseRefinedText(r.text || '', expected);

      // Omission is the CONTRACT: only rewritten pages come back, everything else
      // keeps its current text.
      const byPage = new Map(parsed.pages.map(p => [p.pageNumber, p.text]));
      const strayPages = parsed.pages.map(p => p.pageNumber).filter(n => !expected.includes(n));
      const next = current.map(p => ({ ...p, text: byPage.get(p.pageNumber) || p.text }));

      const changed = next.filter((p, idx) => p.text !== current[idx].text).map(p => p.pageNumber);
      const changedFromOriginal = next.filter((p, idx) => p.text !== original[idx].text).map(p => p.pageNumber);

      rounds.push({
        round: i + 1,
        ok: true,
        modelKey,
        modelId: r.modelId || TEXT_MODELS[modelKey].modelId,
        provider: r.provider || null,
        elapsedMs,
        // ttft separates a QUEUE wait from slow streaming — without it a slow
        // call is unexplainable (same model+provider has measured 60 vs 137 tok/s).
        ttftMs: r.ttft ?? null,
        usage: { input_tokens: r.usage?.input_tokens || 0, output_tokens: r.usage?.output_tokens || 0 },
        cost: r.usage?.direct_cost ?? calculateTextCost(r.modelId || TEXT_MODELS[modelKey].modelId, r.usage || {}),
        promptChars: prompt.length,
        prompt,
        rawResponse: (r.text || '').slice(0, 40000),
        analysis: (parsed.analysis || '').slice(0, 40000),
        returnedPages: parsed.pages.map(p => p.pageNumber),
        strayPages,
        changedPages: changed,
        changedFromOriginal,
        converged: changed.length === 0,
        pages: next.map((p, idx) => ({
          pageNumber: p.pageNumber,
          before: current[idx].text,
          after: p.text,
          original: original[idx].text,
          sceneIntent: p.sceneIntent,
        })),
      });
      current = next;
      if (changed.length === 0) break;   // converged
    } catch (err) {
      rounds.push({ round: i + 1, ok: false, modelKey, elapsedMs: Date.now() - t0, error: err.message });
      break;   // later rounds depend on this one's text
    }
  }

  const changed = current
    .map((p, idx) => (p.text !== original[idx].text ? p.pageNumber : null))
    .filter(n => n !== null);

  return { pages: current, original, rounds, changed, audit: auditFindings };
}

/**
 * Pull the refiner's input out of a story record: page text plus the COMPACT
 * scene intent. The full sceneDescription is Art Director prose — ~10x longer
 * and mostly rendering instructions the writer must not be steered by.
 *
 * Works on both shapes: a stored story (sceneImages[]) and the in-flight
 * pipeline's expanded scenes.
 */
function extractRefinablePages(sceneLike = []) {
  return sceneLike
    .filter(s => s && (s.text || '').trim())
    .map(s => {
      let sceneIntent = '';
      try { sceneIntent = JSON.parse(s.outlineExtract || '{}').sceneIntent || ''; } catch { /* not JSON */ }
      if (!sceneIntent) sceneIntent = (s.sceneDescription || s.description || '').slice(0, 600);
      // The BRIEF as well as the one-line intent (2026-08-10). The compact
      // intent alone was chosen to avoid steering the prose with rendering
      // detail — a good instinct that produced a worse failure: the refiner
      // could not see the page's EVENTS, so it rewrote them. Measured on
      // job_1786309527338 p6, where the brief has Daniel easing the cork free
      // and Sarah unrolling the map, and refinement produced text in which the
      // cork is still stuck and neither happens.
      //
      // The stage's founding invariant (decisions.md 2026-08-05) is "rewrites
      // page prose only, never events" — it cannot honour that while blind to
      // what the events are. METADATA is stripped here and the template is
      // explicit that appearance and staging are not the prose's business.
      const briefRaw = String(s.sceneDescription || s.description || '');
      const sceneBrief = briefRaw.split(/---\s*METADATA/i)[0].trim();
      return { pageNumber: s.pageNumber, text: String(s.text).trim(), sceneIntent, sceneBrief };
    })
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

/**
 * Fire-and-forget wrapper for the production pipeline: never throws, never
 * blocks a story. A refinement failure must leave the original text intact and
 * the generation unaffected — this is a polish pass, not a gate.
 */
function startBackgroundRefine(storyData, pages, opts = {}) {
  return refineStoryText(storyData, pages, opts)
    .then(res => {
      const rounds = res.rounds.filter(r => r.ok).length;
      const ms = res.rounds.reduce((n, r) => n + (r.elapsedMs || 0), 0);
      log.info(`✍️  [TEXT-REFINE] ${rounds} round(s) in ${(ms / 1000).toFixed(1)}s — rewrote page(s) ${res.changed.join(', ') || 'none'}`);
      return res;
    })
    .catch(err => {
      log.warn(`⚠️ [TEXT-REFINE] skipped: ${err.message} — original text kept`);
      return null;
    });
}

module.exports = { refineStoryText, extractRefinablePages, startBackgroundRefine };

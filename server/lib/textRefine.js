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

// Proofread fault-line hygiene (2026-08-31, job_1788123310558). The proofread
// model leaks reasoning prose between findings ("Let me work through this
// carefully page by page.") and sometimes WITHDRAWS a finding mid-line
// ("… but «weisses Möwensegel» as a compound image is fine — withdraw. Let me
// re-examine.") while the line still starts with FAULT[...]: and so still
// matches FAULT_LINE_RE. Both used to be merged raw into the corrective
// round's findings block. Keep only genuine FAULT lines; a FAULT line that
// withdraws itself is discarded.
const PROOFREAD_FAULT_RE = /^FAULT(?:\[[A-Z]+\])*:/;
const PROOFREAD_WITHDRAW_RE = /\bwithdraw\b|—\s*fine\b|\bre-?examine\b/i;
/**
 * Match the re-audit's "RULING: <fault> — fixed|stands|withdrawn (reason)" lines
 * back onto the previous round's FAULT lines.
 *
 * Matching is by the fault's page tag plus a normalised prefix of its text, not
 * by exact string equality — the auditor quotes a fault, it does not echo the
 * line byte for byte. Deliberately tolerant: an unmatched ruling is reported
 * rather than dropped, and `unruled` is the list this exists to surface.
 *
 * @returns {{rulings: Array<{ruling: string, verdict: string, reason: string}>,
 *            unruled: string[], stands: number, fixed: number, withdrawn: number}}
 */
function parseAuditRulings(reauditText, priorFaults) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const prior = String(priorFaults || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^FAULT(\[[A-Z]+\])?:/.test(l));

  const rulings = [];
  const matched = new Set();
  for (const raw of String(reauditText || '').split('\n')) {
    const line = raw.trim();
    const m = line.match(/^RULING:\s*([\s\S]*?)\s*[—–-]\s*(fixed|stands|withdrawn)\b\s*(?:\((.*)\))?\s*$/i);
    if (!m) continue;
    const quoted = norm(m[1]);
    const verdict = m[2].toLowerCase();
    // Best match = the prior fault sharing the longest normalised prefix.
    let best = -1;
    let bestLen = 0;
    prior.forEach((f, i) => {
      const nf = norm(f);
      let k = 0;
      while (k < Math.min(nf.length, quoted.length) && nf[k] === quoted[k]) k++;
      // A page tag alone ("p7") is not a match; require real overlap.
      if (k > bestLen && k >= 12) { bestLen = k; best = i; }
    });
    if (best >= 0) matched.add(best);
    rulings.push({ ruling: m[1].trim(), verdict, reason: (m[3] || '').trim(), matchedFault: best >= 0 ? prior[best] : null });
  }

  const tally = v => rulings.filter(r => r.verdict === v).length;
  return {
    rulings,
    unruled: prior.filter((_, i) => !matched.has(i)),
    priorCount: prior.length,
    fixed: tally('fixed'),
    stands: tally('stands'),
    withdrawn: tally('withdrawn'),
  };
}

function sanitizeProofreadFindings(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => PROOFREAD_FAULT_RE.test(l) && !PROOFREAD_WITHDRAW_RE.test(l))
    .join('\n');
}

/**
 * @param {Object} storyData - story record fields (language, characters, brief, …)
 * @param {Array<{pageNumber:number,text:string,sceneIntent:string}>} pages
 * @param {Object} [opts]
 * @param {number} [opts.rounds=1]      ceiling, not a target — stops when a round rewrites nothing
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

  const roundCount = Math.max(1, Math.min(8, parseInt(opts.rounds, 10) || 1));
  const perRound = Array.isArray(opts.roundModels) ? opts.roundModels : [];
  // opts.model still wins (Lab A/B). Default is the dedicated text key — NOT the
  // beats reviewer: this stage is time-boxed against the image phase.
  const defaultModel = opts.model || MODEL_DEFAULTS.textRefineModel || MODEL_DEFAULTS.outlineReviewModel;
  const usageLabel = opts.usageLabel || 'text_refine';
  // The whole story, read-only (owner redesign 2026-08-31): the refiner judges
  // each page against the arc the beats divided, never against staging alone.
  const arc = String(opts.arc || '').trim();

  const original = pages.map(p => ({ ...p }));
  let current = pages.map(p => ({ ...p }));
  const rounds = [];
  // Declared HERE, above the snapshot closure that reads it. Same lesson as the
  // evaluator's expectedAgesBlock (2026-08-24): a `let` below its reader is a
  // temporal-dead-zone throw waiting for the first call that reaches it.
  let auditFindings = '';
  // Declared with auditFindings, ABOVE the snapshot closure that reads them —
  // a `let` below its reader is the TDZ throw that killed the evaluator on
  // 2026-08-24. The re-audit at the bottom fills it.
  let audit2 = '';
  // Per-fault rulings the re-audit gave on round 1's faults (addendum 2026-09-01).
  let roundsDetail = null;
  // Proofread findings on their own — audit2 merges them for the corrective
  // round, but traceability needs the two streams separable, and an empty
  // string here still proves the proofread ran.
  let proofread = '';

  // PUBLISH AS WE GO (2026-08-24). This function used to return all-or-nothing,
  // and its caller races it against a join deadline — so a finished audit and a
  // finished round 1 were worth NOTHING if round 2 was still in flight when the
  // clock ran out. Staging job_1787514666616_yw9qsv1vf threw away $0.236 of
  // completed grok audit and deepseek rewriting that way, and shipped the
  // unrefined text. Every completed step is now handed to the caller
  // immediately, in the same shape as the final return, so the deadline can
  // only ever cost the round still running.
  const snapshot = () => ({
    pages: current.map(p => ({ ...p })),
    original,
    rounds: rounds.slice(),
    changed: current
      .map((p, idx) => (p.text !== original[idx].text ? p.pageNumber : null))
      .filter(n => n !== null),
    audit: auditFindings,
    audit2,
    roundsDetail,
    proofread,
    partial: true,
  });
  const publish = () => {
    if (typeof opts.onProgress !== 'function') return;
    try { opts.onProgress(snapshot()); } catch (e) {
      log.warn(`⚠️ [TEXT-REFINE] onProgress threw (${e.message}) — ignored`);
    }
  };

  // Blind audit of the text as delivered: a reader with only the back cover,
  // the pages and what each picture shows names faults. Round 1's fix ledger
  // must answer every one. Never blocks — a failed audit just means the
  // refiner runs on its own checks alone.
  const auditModel = opts.auditModel || MODEL_DEFAULTS.textAuditModel || MODEL_DEFAULTS.arcReviewModel || defaultModel;
  try {
    const { buildTextAuditPrompt, countFaults, faultsByCategory } = require('./storyHelpers');
    // The arc travels into the audit (2026-09-02): its LOADBEARING question
    // asks what the story treats as load-bearing, and the audit was never shown
    // the story — the question could not fire.
    const auditPrompt = buildTextAuditPrompt(storyData, current, '', arc);
    if (auditPrompt && TEXT_MODELS[auditModel]) {
      const t0 = Date.now();
      // gemini-3.1-pro occasionally returns an empty body (see models.js) — one
      // retry, same call; a second empty falls through to the no-findings path.
      let a = await callTextModelStreaming(auditPrompt, 12000, null, auditModel, { usageLabel: 'text_audit' });
      if (!String(a.text || '').trim()) {
        log.warn(`⚠️ [TEXT-AUDIT] ${auditModel} returned empty output — retrying once`);
        a = await callTextModelStreaming(auditPrompt, 12000, null, auditModel, { usageLabel: 'text_audit' });
      }
      auditFindings = String(a.text || '').trim();
      log.info(`🔎 [TEXT-AUDIT] ${auditModel}: ${countFaults(auditFindings)} fault(s) ${JSON.stringify(faultsByCategory(auditFindings))} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  } catch (auditErr) {
    log.warn(`⚠️ [TEXT-AUDIT] failed (${auditErr.message}) — refinement runs without audit findings`);
  }
  publish();   // the audit survives even if no round finishes

  for (let i = 0; i < roundCount; i++) {
    const modelKey = perRound[i] || defaultModel;
    if (!TEXT_MODELS[modelKey]) throw new Error(`Unknown model "${modelKey}"`);

    // Built fresh from CURRENT text each round — that is the whole mechanism.
    // Audit findings go to round 1 only: they were found on the delivered text,
    // and later rounds would mis-flag pages round 1 already fixed.
    let prompt = buildTextRefinePrompt(storyData, current, i === 0 ? auditFindings : '', arc);
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
      publish();                         // this round's rewrites are now safe
      if (changed.length === 0) break;   // converged
    } catch (err) {
      rounds.push({ round: i + 1, ok: false, modelKey, elapsedMs: Date.now() - t0, error: err.message });
      break;   // later rounds depend on this one's text
    }
  }

  // FRESH JUDGMENT (owner, 2026-08-26). The refiner is the last thing to touch
  // the prose and nothing used to read its output — its two failures on
  // job_1787689073034 (embellishing the flagged flying, pluperfect backfill)
  // shipped precisely because of that. The SAME blind audit re-reads the final
  // text: same template, same judge, so the two counts are one yardstick.
  // Faults found get ONE more corrective round; no loop. Non-blocking, and the
  // publish() below means the join-deadline salvage can only ever cost this
  // step, never the rounds already done.
  if (auditFindings) {
    try {
      const { buildTextAuditPrompt, buildTextProofreadPrompt, countFaults, faultsByCategory } = require('./storyHelpers');
      // The re-audit receives round 1's faults and must rule on each BY
      // IDENTITY (fixed / stands / withdrawn) before naming a new one —
      // comparing counts alone let faults disappear silently. See
      // buildTextAuditPrompt's note for the run that exposed it.
      const audit2Prompt = buildTextAuditPrompt(storyData, current, auditFindings, arc);
      if (audit2Prompt && TEXT_MODELS[auditModel]) {
        const t0 = Date.now();
        // Proofread runs alongside the re-audit: a narrow sentence-level pass
        // (article/gender, quote nesting, spelling, self-contradiction,
        // non-words) on a model that is not the refiner, merged into the same
        // corrective round. Never blocks — a failure contributes nothing.
        const proofModel = MODEL_DEFAULTS.textProofreadModel;
        const proofPrompt = buildTextProofreadPrompt(storyData, current);
        const proofPromise = (proofPrompt && TEXT_MODELS[proofModel])
          ? callTextModelStreaming(proofPrompt, 8000, null, proofModel, { usageLabel: 'text_proofread' })
            .then(r => String(r.text || '').trim())
            .catch(e => { log.warn(`⚠️ [PROOFREAD] failed (${e.message}) — skipped`); return ''; })
          : Promise.resolve('');
        let a2 = await callTextModelStreaming(audit2Prompt, 12000, null, auditModel, { usageLabel: 'text_audit2' });
        if (!String(a2.text || '').trim()) {
          log.warn(`⚠️ [TEXT-AUDIT2] ${auditModel} returned empty output — retrying once`);
          a2 = await callTextModelStreaming(audit2Prompt, 12000, null, auditModel, { usageLabel: 'text_audit2' });
        }
        const proofRaw = await proofPromise;
        // Raw stream persisted for traceability; the CORRECTIVE round gets the
        // sanitized form only (no leaked reasoning, no withdrawn findings).
        proofread = proofRaw;
        const proofFindings = sanitizeProofreadFindings(proofRaw);
        const proofFaults = countFaults(proofFindings);
        const withdrawn = countFaults(proofRaw) - proofFaults;
        if (withdrawn > 0) log.info(`🔎 [PROOFREAD] ${withdrawn} withdrawn/leaked FAULT line(s) discarded before the corrective round`);
        if (proofFaults > 0) log.info(`🔎 [PROOFREAD] ${proofModel}: ${proofFaults} sentence-level fault(s)`);
        audit2 = [String(a2.text || '').trim(), proofFaults > 0 ? proofFindings : ''].filter(Boolean).join('\n');
        // One entry per prior fault the re-audit ruled on. A prior round's
        // fault that appears in NEITHER the rulings nor the new fault list
        // is the disappearance this mechanism exists to make visible.
        roundsDetail = parseAuditRulings(String(a2.text || ''), auditFindings);
        if (roundsDetail.unruled.length > 0) {
          log.warn(`\u26a0\ufe0f [TEXT-AUDIT2] ${roundsDetail.unruled.length} fault(s) from round 1 were never ruled on by the re-audit`);
        }
        const n1 = countFaults(auditFindings);
        const n2 = countFaults(audit2);
        log.info(`🔎 [TEXT-AUDIT2] ${auditModel}: ${n1} → ${n2} fault(s) ${JSON.stringify(faultsByCategory(audit2))} after ${rounds.filter(r => r.ok).length} round(s), ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        if (n2 > 0) {
          const modelKey = perRound[rounds.length] || defaultModel;
          const withRulings = `${audit2}\n\nEarlier rounds answered a previous audit in their ledgers. A fault ruled to stand, with a reason, stays as ruled — answer it by citing that ruling.`;
          const prompt2 = buildTextRefinePrompt(storyData, current, withRulings, arc);
          const t1 = Date.now();
          const MAX_OUT = Math.min(64000, TEXT_MODELS[modelKey].maxOutputTokens || 64000);
          const r2 = await callTextModelStreaming(prompt2, MAX_OUT, null, modelKey, { usageLabel });
          const parsed2 = parseRefinedText(r2.text || '', expected);
          const byPage2 = new Map(parsed2.pages.map(p => [p.pageNumber, p.text]));
          const next2 = current.map(p => ({ ...p, text: byPage2.get(p.pageNumber) || p.text }));
          const changed2 = next2.filter((p, idx) => p.text !== current[idx].text).map(p => p.pageNumber);
          rounds.push({
            round: rounds.length + 1,
            ok: true,
            reAudit: true,
            modelKey,
            modelId: r2.modelId || TEXT_MODELS[modelKey].modelId,
            elapsedMs: Date.now() - t1,
            usage: { input_tokens: r2.usage?.input_tokens || 0, output_tokens: r2.usage?.output_tokens || 0 },
            analysis: (parsed2.analysis || '').slice(0, 40000),
            rawResponse: (r2.text || '').slice(0, 40000),
            changedPages: changed2,
            converged: changed2.length === 0,
          });
          current = next2;
          publish();
          log.info(`✍️  [TEXT-AUDIT2] corrective round rewrote page(s) ${changed2.join(', ') || 'none'}`);
        }
      }
    } catch (e2) {
      log.warn(`⚠️ [TEXT-AUDIT2] re-audit failed (${e2.message}) — refined text kept as-is`);
    }
  }

  const changed = current
    .map((p, idx) => (p.text !== original[idx].text ? p.pageNumber : null))
    .filter(n => n !== null);

  return { pages: current, original, rounds, changed, audit: auditFindings, audit2, roundsDetail, proofread, partial: false };
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
      // sceneMetadata.sceneIntent is where the one-line picture summary lives
      // (sceneMetadata.js). The old outlineExtract JSON.parse never matched —
      // outlineExtract holds "BEAT: …" prose — so every page silently fell to
      // the brief slice and the text audit compared words against nothing.
      let sceneIntent = String(s.sceneMetadata?.sceneIntent || '').trim();
      if (!sceneIntent) { try { sceneIntent = JSON.parse(s.outlineExtract || '{}').sceneIntent || ''; } catch { /* not JSON */ } }
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
      // The page's own LOCKED PLAN LINE (beats pipeline only). outlineExtract
      // holds "PLAN: …" in beats mode — older stored stories carry
      // "BEAT: …/PLAN: …" — but the scene expansion's own JSON in unified mode
      // (storyScorecard.js finalBeats() draws the same distinction); guard on
      // the marker so a unified story never mistakes its own JSON for a plan
      // line. The arc is the story (owner ruling 2026-09-02, Lab #973); the
      // plan line says which picture this page carries, and the refiner may
      // not write text that contradicts it.
      const extractRaw = String(s.outlineExtract || '');
      const planLine = /(^|\n)\s*(?:PLAN|BEAT)\s*:/i.test(extractRaw)
        ? ((extractRaw.match(/(?:^|\n)\s*PLAN\s*:\s*([\s\S]*)$/i) || [, ''])[1] || '').trim()
        : '';
      return { pageNumber: s.pageNumber, text: String(s.text).trim(), sceneIntent, sceneBrief, planLine };
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

module.exports = { refineStoryText, extractRefinablePages, startBackgroundRefine, sanitizeProofreadFindings };

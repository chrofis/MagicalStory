/**
 * The text-review chain — full text in, corrected pages out.
 *
 * ONE implementation, two callers: the Test Lab stage (`text_refine`) and the
 * production pipeline, which runs it in parallel with image generation. Keeping
 * the chain here rather than inside the Lab stage is the point — a second copy
 * in server.js would drift the moment either side changed.
 *
 * THE CHAIN (owner ruling 2026-09-03, verbatim: "Do we actually need 2 rounds?
 * Run 2 audits: the gemini we have today and a grok that is blind. Combine all
 * the findings and then do a single repair. Then one lector round — have the
 * lector output the pages that need correction directly, so we don't need a 2nd
 * round."):
 *
 *   1. TWO AUDITS, in parallel, on the writer's text
 *        a. arc-informed  — gemini-3.1-pro, story-text-audit.txt (back cover,
 *           arc, page plan, page text, what each picture shows)
 *        b. blind         — grok-4.6, story-text-audit-blind.txt (page text and
 *           nothing else)
 *   2. MERGE + DEDUPE the two fault lists in code (mergeAuditFindings)
 *   3. ONE REPAIR PASS over the merged findings (textRefineModel)
 *   4. ONE LECTOR PASS which returns the corrected pages itself, screened by a
 *      per-page edit-distance cap (screenLectorPages)
 *
 * What this replaced: audit → fix → re-audit → corrective fix → lector →
 * separate apply pass. The multi-round convergence loop, the re-audit and the
 * apply call are DELETED, not bridged. Two independent finders up front beat
 * sequential re-audits of one; the accepted cost is that a fault the repair
 * pass introduces has nothing behind it, which is what the lector's diff cap
 * bounds. A second bounded repair pass would slot in as one more
 * `runRepairPass` call — nothing here loops, and nothing here is dormant
 * machinery waiting for one.
 *
 * Scene outlines and the arc are read-only, which is what makes the production
 * parallelism safe: illustrations are already rendering from those scenes, and
 * this stage may only change prose, never events.
 */

const { log } = require('../utils/logger');

// ─────────────────────────── FAULT LINES: PARSE + MERGE ───────────────────────

/**
 * Both audit templates emit `FAULT[<CATEGORY>]: p<N> — <one sentence>`. Older
 * stored reports carry the bare `FAULT: ...` form, so both parse forever.
 */
const FAULT_LINE = /^FAULT(?:\[([A-Z]+)\])?(?:\[([A-Z]+)\])?:\s*([\s\S]*)$/i;
const PAGE_TAG = /^p(?:age)?\s*(\d+)\s*(?:[—–:.-]\s*)?/i;

/**
 * Parse one audit's raw output into findings, tagged with which audit found
 * them. Everything that is not a FAULT line is ignored — that subsumes a
 * model's musings, its `FAULTS: n` total and any leaked reasoning.
 *
 * @param {string} raw
 * @param {string} source 'arc-informed' | 'blind'
 * @returns {Array<{category:string,pageNumber:number|null,text:string,line:string,sources:string[]}>}
 */
function parseFaultLines(raw, source = '') {
  const out = [];
  for (const rawLine of String(raw || '').split('\n')) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '');
    const m = line.match(FAULT_LINE);
    if (!m) continue;
    const category = (m[1] || 'UNTAGGED').toUpperCase();
    let rest = String(m[3] || '').trim();
    const pm = rest.match(PAGE_TAG);
    const pageNumber = pm ? parseInt(pm[1], 10) : null;
    if (pm) rest = rest.slice(pm[0].length).trim();
    if (!rest) continue;
    out.push({ category, pageNumber, text: rest, line, sources: source ? [source] : [] });
  }
  return out;
}

/** Content words of a finding, for overlap scoring. Short words carry no signal. */
function contentWords(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
  );
}

/** Jaccard overlap of two findings' content words, 0..1. */
function wordOverlap(a, b) {
  const A = contentWords(a);
  const B = contentWords(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hits = 0;
  for (const w of A) if (B.has(w)) hits++;
  return hits / (A.size + B.size - hits);
}

/**
 * Two independent auditors name the same defect in different words, so a
 * duplicate cannot be found by string equality — measured on the two prompts'
 * own wording, "the main character is on the far bank with no page showing the
 * crossing" and "suddenly on the far bank, nothing says how the crossing
 * happened" share two content words out of twelve. Word overlap alone
 * therefore cannot carry the decision.
 *
 * What carries it is the CATEGORY TAG. Both templates label every fault with
 * the question that found it, and the two question sets overlap exactly where
 * the audits overlap by design (TRANSITION, PAYOFF) and nowhere else — the
 * blind reader's CONFUSION/CONTRADICTION/IDLE and the arc-informed auditor's
 * nine others are each its own. So: SAME PAGE + SAME CATEGORY + DIFFERENT
 * AUDITOR = one fault, and word overlap is only the fallback for a pair that
 * agrees on the page but filed it under different questions.
 *
 * Deduping only ACROSS auditors is deliberate: two TRANSITION faults on one
 * page from the SAME auditor are two faults — each audit is instructed to state
 * a fault once, so a repeat inside one list is not a repeat of meaning.
 */
const DUPLICATE_OVERLAP = 0.4;

/**
 * Merge the audits' fault lists into the single list the repair pass answers.
 *
 * The FIRST list wins a duplicate (the arc-informed audit is passed first: its
 * wording names what the book had to deliver), and the loser's source is
 * recorded on the survivor — the ledger has to be able to answer "which audit
 * found this" and "what did the second audit add".
 *
 * @param {Array<{source:string,raw:string}>} lists
 * @returns {{findings:Array, duplicates:Array, bySource:Object, text:string}}
 */
function mergeAuditFindings(lists = []) {
  const findings = [];
  const duplicates = [];
  const bySource = {};
  for (const { source, raw } of lists) {
    const parsed = parseFaultLines(raw, source);
    bySource[source] = parsed.length;
    for (const f of parsed) {
      const twin = findings.find(k =>
        k.pageNumber != null && f.pageNumber != null &&
        k.pageNumber === f.pageNumber &&
        !k.sources.includes(source) &&
        (k.category === f.category || wordOverlap(k.text, f.text) >= DUPLICATE_OVERLAP)
      );
      if (twin) {
        if (!twin.sources.includes(source)) twin.sources.push(source);
        duplicates.push({ ...f, mergedInto: twin.line });
        continue;
      }
      findings.push(f);
    }
  }
  findings.sort((a, b) => (a.pageNumber ?? 1e9) - (b.pageNumber ?? 1e9));
  // Verbatim FAULT lines for the prompt: the repair template already knows this
  // format, and re-rendering them would re-word findings. Source tags stay in
  // the ledger only — they are provenance, not instructions to the fixer.
  const text = findings.map(f => f.line).join('\n');
  return { findings, duplicates, bySource, text };
}

// ────────────────────── LECTOR: PER-PAGE EDIT-DISTANCE CAP ────────────────────

/**
 * The lector returns corrected pages rather than quoted spans (owner ruling
 * 2026-09-03), which removes the verbatim-quote check that used to be the
 * hallucination guard. This replaces it: a page whose returned text differs
 * from its input by more than this fraction of its characters is REJECTED and
 * the input page kept.
 *
 * 0.15 is chosen against both failure sizes. A real language fix is a span: the
 * measured lector output on a shipped 16-page German text (six findings, the
 * largest "war einen Moment lang traurig für sie" → "hatte einen Moment lang
 * Mitleid mit ihr") moves 10-25 characters on a 300-800 character page — under
 * 8% even when two findings land on one page. A page the lector re-narrates
 * instead of correcting moves well past half its characters. 15% sits roughly
 * twice above the worst legitimate case and far below any rewrite, and it is a
 * cap on WHAT the lector may change, never on how many pages it may fix.
 */
const LECTOR_MAX_DIFF_RATIO = 0.15;

/** Whitespace-normalised, so a re-wrapped page is not a change. */
function normalizeForDiff(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Levenshtein distance, two-row DP. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[b.length];
}

/**
 * Normalised edit distance between two versions of one page, 0..1.
 * 0 = identical (ignoring whitespace), 1 = nothing in common.
 */
function pageDiffRatio(before, after) {
  const a = normalizeForDiff(before);
  const b = normalizeForDiff(after);
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  // A length difference is a lower bound on the edit distance, so an overhaul
  // is rejected without running the DP over it. The bound itself is returned,
  // not 1 — the logged ratio has to stay a real measurement.
  const bound = Math.abs(a.length - b.length) / max;
  if (bound > LECTOR_MAX_DIFF_RATIO) return bound;
  return editDistance(a, b) / max;
}

/**
 * Screen the lector's returned pages against the text it was given.
 *
 * Three outcomes per returned page: ACCEPTED (a bounded correction), REJECTED
 * (changed more than the cap — the input page is kept, and the ratio is logged
 * so an over-tight cap is visible rather than silent), STRAY (a page number the
 * story does not have).
 *
 * @param {Array<{pageNumber:number,text:string}>} inputPages the text sent
 * @param {Array<{pageNumber:number,text:string}>} returned parseRefinedText output
 */
function screenLectorPages(inputPages = [], returned = []) {
  const byPage = new Map(inputPages.map(p => [p.pageNumber, String(p.text || '')]));
  const accepted = [];
  const rejected = [];
  const stray = [];
  for (const r of returned) {
    const before = byPage.get(r.pageNumber);
    if (before === undefined) { stray.push(r.pageNumber); continue; }
    const ratio = pageDiffRatio(before, r.text);
    if (ratio === 0) continue;                       // returned unchanged
    const entry = { pageNumber: r.pageNumber, ratio: Math.round(ratio * 1000) / 1000, text: r.text };
    (ratio <= LECTOR_MAX_DIFF_RATIO ? accepted : rejected).push(entry);
  }
  return { accepted, rejected, stray };
}

// ───────────────────────────────── THE CHAIN ──────────────────────────────────

/**
 * @param {Object} storyData - story record fields (language, characters, brief, …)
 * @param {Array<{pageNumber:number,text:string,sceneIntent:string}>} pages
 * @param {Object} [opts]
 * @param {string} [opts.model]          repair model (default MODEL_DEFAULTS.textRefineModel)
 * @param {string} [opts.auditModel]     arc-informed auditor override
 * @param {string} [opts.blindAuditModel] blind auditor override
 * @param {string} [opts.proofreadModel] lector override
 * @param {string} [opts.arc]            the final arc, read-only
 * @param {string} [opts.promptOverride] replaces the repair prompt (Lab A/B only)
 * @param {Function} [opts.onProgress]   called with a snapshot after every step
 * @param {string} [opts.usageLabel]
 */
async function refineStoryText(storyData, pages, opts = {}) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const {
    buildTextRefinePrompt, parseRefinedText, buildTextAuditPrompt,
    buildTextAuditBlindPrompt, buildTextProofreadPrompt, countFaults, faultsByCategory,
  } = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { TEXT_MODELS, MODEL_DEFAULTS, calculateTextCost } = require('../config/models');

  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('refineStoryText: no page text to refine');
  }
  const expected = pages.map(p => p.pageNumber);

  // One config read per role. Swapping any of the four models is a one-line
  // change in server/config/models.js — nothing else resolves a model.
  const repairModel = opts.model || MODEL_DEFAULTS.textRefineModel;
  const auditModel = opts.auditModel || MODEL_DEFAULTS.textAuditModel;
  const blindAuditModel = opts.blindAuditModel || MODEL_DEFAULTS.textAuditBlindModel;
  const lectorModel = opts.proofreadModel || MODEL_DEFAULTS.textProofreadModel;
  if (!TEXT_MODELS[repairModel]) throw new Error(`Unknown model "${repairModel}"`);
  const usageLabel = opts.usageLabel || 'text_refine';
  // The whole story, read-only (owner redesign 2026-08-31): the audits and the
  // repair judge each page against the arc the beats divided, never against
  // staging alone.
  const arc = String(opts.arc || '').trim();

  const original = pages.map(p => ({ ...p }));
  let current = pages.map(p => ({ ...p }));
  const rounds = [];
  // Every `let` the snapshot closure reads is declared ABOVE it. Same lesson as
  // the evaluator's expectedAgesBlock (2026-08-24): a `let` below its reader is
  // a temporal-dead-zone throw waiting for the first call that reaches it.
  let audits = [];
  let mergedFindings = [];
  let mergeStats = { bySource: {}, duplicates: 0 };
  let proofread = '';
  let lectorAccepted = [];
  let lectorRejected = [];

  // PUBLISH AS WE GO (2026-08-24). This function used to return all-or-nothing,
  // and its caller races it against a join deadline — so finished audits and a
  // finished repair were worth NOTHING if the lector was still in flight when
  // the clock ran out. Staging job_1787514666616_yw9qsv1vf threw away $0.236 of
  // completed audit and rewriting that way, and shipped the unrefined text.
  // Every completed step is handed to the caller immediately, in the same shape
  // as the final return, so the deadline can only ever cost the step running.
  const snapshot = () => ({
    pages: current.map(p => ({ ...p })),
    original,
    rounds: rounds.slice(),
    changed: current
      .map((p, idx) => (p.text !== original[idx].text ? p.pageNumber : null))
      .filter(n => n !== null),
    audits: audits.slice(),
    mergedFindings: mergedFindings.slice(),
    mergeStats,
    proofread,
    lectorAccepted: lectorAccepted.slice(),
    lectorRejected: lectorRejected.slice(),
    partial: true,
  });
  const publish = () => {
    if (typeof opts.onProgress !== 'function') return;
    try { opts.onProgress(snapshot()); } catch (e) {
      log.warn(`⚠️ [TEXT-REFINE] onProgress threw (${e.message}) — ignored`);
    }
  };

  /**
   * One audit. Never throws — a failed audit just means its findings are
   * missing from the merge, and the chain runs on the other auditor's.
   */
  const runAudit = async (source, modelKey, prompt, label) => {
    if (!prompt) return { source, modelKey, ok: false, error: 'template unavailable' };
    if (!TEXT_MODELS[modelKey]) return { source, modelKey, ok: false, error: `unknown model "${modelKey}"` };
    const t0 = Date.now();
    // The model's OWN limit, never a hand-picked number (owner rule: no output
    // caps). A reasoning model spends the budget on reasoning tokens first, so
    // an undersized cap does not truncate the fault list, it returns ZERO
    // visible text — the measured failure of deepseek-v4-pro and qwen3.8-max as
    // auditors at 16384 (models.js, 2026-08-27), and the trap a fixed 12000
    // would have set for the blind grok auditor.
    const MAX_OUT = TEXT_MODELS[modelKey].maxOutputTokens || 32000;
    try {
      // gemini-3.1-pro occasionally returns an empty body (see models.js) — one
      // retry, same call; a second empty is reported as a failed audit.
      let r = await callTextModelStreaming(prompt, MAX_OUT, null, modelKey, { usageLabel: label });
      if (!String(r.text || '').trim()) {
        log.warn(`⚠️ [TEXT-AUDIT/${source}] ${modelKey} returned empty output — retrying once`);
        r = await callTextModelStreaming(prompt, MAX_OUT, null, modelKey, { usageLabel: label });
      }
      const raw = String(r.text || '').trim();
      const elapsedMs = Date.now() - t0;
      log.info(`🔎 [TEXT-AUDIT/${source}] ${modelKey}: ${countFaults(raw)} fault(s) ${JSON.stringify(faultsByCategory(raw))} in ${(elapsedMs / 1000).toFixed(0)}s`);
      return {
        source, modelKey, ok: raw.length > 0,
        modelId: r.modelId || TEXT_MODELS[modelKey].modelId,
        raw, faults: countFaults(raw), byCategory: faultsByCategory(raw), elapsedMs,
        usage: { input_tokens: r.usage?.input_tokens || 0, output_tokens: r.usage?.output_tokens || 0 },
        cost: r.usage?.direct_cost ?? calculateTextCost(r.modelId || TEXT_MODELS[modelKey].modelId, r.usage || {}),
      };
    } catch (e) {
      log.warn(`⚠️ [TEXT-AUDIT/${source}] failed (${e.message}) — its findings are missing from the merge`);
      return { source, modelKey, ok: false, error: e.message, elapsedMs: Date.now() - t0 };
    }
  };

  // TWO AUDITS IN PARALLEL (owner ruling 2026-09-03). Independent on purpose:
  // one sees the arc and the page plan and judges what the book dropped, the
  // other sees only the pages and judges what a listener cannot follow. Running
  // them together costs the slower of the two, not their sum.
  //
  // PER-AUDIT DEADLINE. "The slower of the two" is only true if one auditor
  // cannot hold the chain hostage: a `Promise.all` with no deadline means a
  // stalled auditor blocks the merge, the repair and the lector, and the
  // pipeline's join then salvages NOTHING because the first publish() happens
  // after the merge. Measured on Lab #984, a 4-page story: the arc-informed
  // audit answered in 101s while grok-4.6 streamed reasoning past 20 minutes —
  // textModels' own ceiling for a streaming call is 25 min and its inactivity
  // abort never fires while reasoning tokens keep arriving.
  //
  // 900s, and it is a HOSTAGE guard, not a latency policy. The measured healthy
  // numbers on that 4-page run are gemini 101s and grok-4.6 386s — a 360s cap
  // would have thrown away a blind audit that answered, so the ceiling has to
  // sit well above the slow-but-working case and only catch the pathological
  // one (textModels' own streaming ceiling is 25 min, and its 120s inactivity
  // abort never fires while reasoning tokens keep arriving). The audits run in
  // parallel with image generation, so this wall clock is normally hidden
  // behind the image phase; the pipeline's join deadline decides how long a
  // user waits, and its salvage keeps every step that finished. A timed-out
  // audit is simply absent from the merge, exactly like a failed one. The
  // abandoned call keeps streaming until the provider ends it — its tokens are
  // spent either way, and waiting for them costs the whole stage instead.
  const AUDIT_DEADLINE_MS = Number(opts.auditTimeoutMs) || 900000;
  const withDeadline = (p, source) => {
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({
        source,
        ok: false,
        error: `no answer within ${Math.round(AUDIT_DEADLINE_MS / 1000)}s — abandoned`,
      }), AUDIT_DEADLINE_MS);
    });
    // NOT unref'd, for the same reason as the pipeline's join timer: an unref'd
    // timer does not keep the loop alive, so the race could never settle.
    // clearTimeout below is what stops it leaking, and it runs on both branches.
    return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
  };
  audits = await Promise.all([
    withDeadline(runAudit('arc-informed', auditModel, buildTextAuditPrompt(storyData, current, arc), 'text_audit'), 'arc-informed'),
    withDeadline(runAudit('blind', blindAuditModel, buildTextAuditBlindPrompt(storyData, current), 'text_audit_blind'), 'blind'),
  ]);
  for (const a of audits) {
    if (!a.ok && a.error) log.warn(`⚠️ [TEXT-AUDIT/${a.source}] ${a.error}`);
  }
  const merged = mergeAuditFindings(audits.filter(a => a.ok).map(a => ({ source: a.source, raw: a.raw })));
  mergedFindings = merged.findings;
  mergeStats = { bySource: merged.bySource, duplicates: merged.duplicates.length };
  log.info(`🔀 [TEXT-AUDIT] merged ${JSON.stringify(merged.bySource)} → ${merged.findings.length} finding(s), ${merged.duplicates.length} duplicate(s) folded`);
  publish();   // the audits survive even if nothing else finishes

  /**
   * ONE REPAIR PASS: findings in, rewritten pages out. Pure with respect to
   * `current` — it returns the next text and its ledger entry, and the caller
   * decides whether to adopt it. Invoked exactly ONCE below; a second bounded
   * pass after a re-audit would be one more call here, never a loop.
   */
  const runRepairPass = async (findingsText, base) => {
    let prompt = buildTextRefinePrompt(storyData, base, findingsText, arc);
    if (!prompt) throw new Error('text-refine template unavailable');
    if (opts.promptOverride) prompt = opts.promptOverride;
    const t0 = Date.now();
    // The model's OWN limit, never a hand-picked number (owner rule: no output
    // caps). History: 16000 truncated a 16-page long-text run's mandatory
    // analysis plus rewrites, and a truncated reply parses as ZERO page blocks
    // — reported as "nothing to rewrite" while dash-carrying pages shipped
    // (job_1787423677246 p1/p12). It was then clamped to 64000, which is the
    // same hand-picked cap one size up; the real bound is the model. The
    // throw below still turns any cap hit into a loud failure rather than a
    // silent "nothing to do".
    const MAX_OUT = TEXT_MODELS[repairModel].maxOutputTokens || 64000;
    const r = await callTextModelStreaming(prompt, MAX_OUT, null, repairModel, { usageLabel });
    const elapsedMs = Date.now() - t0;
    if ((r.usage?.output_tokens || 0) >= MAX_OUT) {
      throw new Error(`output hit the ${MAX_OUT}-token cap — reply truncated, rewrites unusable`);
    }
    const parsed = parseRefinedText(r.text || '', expected);
    // Omission is the CONTRACT: only rewritten pages come back, everything else
    // keeps its current text.
    const byPage = new Map(parsed.pages.map(p => [p.pageNumber, p.text]));
    const strayPages = parsed.pages.map(p => p.pageNumber).filter(n => !expected.includes(n));
    const next = base.map(p => ({ ...p, text: byPage.get(p.pageNumber) || p.text }));
    const changedPages = next.filter((p, idx) => p.text !== base[idx].text).map(p => p.pageNumber);
    return {
      next,
      entry: {
        round: rounds.length + 1,
        kind: 'repair',
        ok: true,
        modelKey: repairModel,
        modelId: r.modelId || TEXT_MODELS[repairModel].modelId,
        provider: r.provider || null,
        elapsedMs,
        // ttft separates a QUEUE wait from slow streaming — without it a slow
        // call is unexplainable (same model+provider has measured 60 vs 137 tok/s).
        ttftMs: r.ttft ?? null,
        usage: { input_tokens: r.usage?.input_tokens || 0, output_tokens: r.usage?.output_tokens || 0 },
        cost: r.usage?.direct_cost ?? calculateTextCost(r.modelId || TEXT_MODELS[repairModel].modelId, r.usage || {}),
        promptChars: prompt.length,
        prompt,
        rawResponse: (r.text || '').slice(0, 40000),
        analysis: (parsed.analysis || '').slice(0, 40000),
        findingsCount: parseFaultLines(findingsText).length,
        returnedPages: parsed.pages.map(p => p.pageNumber),
        strayPages,
        changedPages,
        pages: next.map((p, idx) => ({
          pageNumber: p.pageNumber,
          before: base[idx].text,
          after: p.text,
          original: original[idx].text,
          sceneIntent: p.sceneIntent,
        })),
      },
    };
  };

  try {
    const { next, entry } = await runRepairPass(merged.text, current);
    rounds.push(entry);
    current = next;
    publish();
    log.info(`✍️  [TEXT-REPAIR] ${repairModel} closed ${entry.findingsCount} finding(s), rewrote page(s) ${entry.changedPages.join(', ') || 'none'}`);
  } catch (err) {
    // Non-blocking like every step: the lector still reads the writer's text.
    rounds.push({ round: rounds.length + 1, kind: 'repair', ok: false, modelKey: repairModel, error: err.message });
    log.warn(`⚠️ [TEXT-REPAIR] failed (${err.message}) — the audits' findings are unclosed`);
    publish();
  }

  // THE LECTOR — LAST, and it returns the corrected pages itself (owner ruling
  // 2026-09-03). It reads the text the repair pass left, so a grammar fault the
  // repair introduced is still caught, and there is no second model in the loop
  // re-typing its findings. What keeps it from becoming a second refiner is
  // screenLectorPages: a returned page that moved more than
  // LECTOR_MAX_DIFF_RATIO of its characters is discarded and the input kept.
  //
  // Non-blocking, and the publish() above means a join deadline can only cost
  // this pass.
  try {
    const lectorPrompt = buildTextProofreadPrompt(storyData, current);
    if (lectorPrompt && TEXT_MODELS[lectorModel]) {
      const t0 = Date.now();
      // Full pages come back now, not quoted spans, so the lector needs the
      // same output room as the repair pass.
      const MAX_OUT = Math.min(64000, TEXT_MODELS[lectorModel].maxOutputTokens || 64000);
      // temperature 0: the A/B measured this prompt at 0, and a lector must not
      // paraphrase the page it is correcting.
      let lr = await callTextModelStreaming(lectorPrompt, MAX_OUT, null, lectorModel, { temperature: 0, usageLabel: 'text_lector' });
      if (!String(lr.text || '').trim()) {
        log.warn(`⚠️ [LECTOR] ${lectorModel} returned empty output — retrying once`);
        lr = await callTextModelStreaming(lectorPrompt, MAX_OUT, null, lectorModel, { temperature: 0, usageLabel: 'text_lector' });
      }
      proofread = String(lr.text || '').trim();
      const parsed = parseRefinedText(proofread, expected);
      const screened = screenLectorPages(current, parsed.pages);
      lectorAccepted = screened.accepted;
      lectorRejected = screened.rejected;
      for (const r of lectorRejected) {
        log.warn(`⚠️ [LECTOR] page ${r.pageNumber} changed ${(r.ratio * 100).toFixed(1)}% of its characters (cap ${(LECTOR_MAX_DIFF_RATIO * 100).toFixed(0)}%) — rejected, original kept`);
      }
      if (screened.stray.length > 0) {
        log.warn(`⚠️ [LECTOR] returned page(s) ${screened.stray.join(', ')} the story does not have — discarded`);
      }
      const byPage = new Map(lectorAccepted.map(p => [p.pageNumber, p.text]));
      const next = current.map(p => ({ ...p, text: byPage.get(p.pageNumber) || p.text }));
      const changedPages = next.filter((p, idx) => p.text !== current[idx].text).map(p => p.pageNumber);
      rounds.push({
        round: rounds.length + 1,
        kind: 'lector',
        ok: true,
        modelKey: lectorModel,
        modelId: lr.modelId || TEXT_MODELS[lectorModel].modelId,
        elapsedMs: Date.now() - t0,
        usage: { input_tokens: lr.usage?.input_tokens || 0, output_tokens: lr.usage?.output_tokens || 0 },
        cost: lr.usage?.direct_cost ?? calculateTextCost(lr.modelId || TEXT_MODELS[lectorModel].modelId, lr.usage || {}),
        rawResponse: proofread.slice(0, 40000),
        acceptedPages: lectorAccepted.map(p => ({ pageNumber: p.pageNumber, ratio: p.ratio })),
        rejectedPages: lectorRejected.map(p => ({ pageNumber: p.pageNumber, ratio: p.ratio })),
        strayPages: screened.stray,
        changedPages,
        // Same per-page shape as the repair entry, so the Lab renders both
        // steps in one column set instead of special-casing this one.
        pages: next.map((p, idx) => ({
          pageNumber: p.pageNumber,
          before: current[idx].text,
          after: p.text,
          original: original[idx].text,
          sceneIntent: p.sceneIntent,
        })),
      });
      current = next;
      publish();
      log.info(`✍️  [LECTOR] ${lectorModel}: corrected page(s) ${changedPages.join(', ') || 'none'}, rejected ${lectorRejected.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  } catch (le) {
    log.warn(`⚠️ [LECTOR] failed (${le.message}) — text kept as the repair pass left it`);
  }

  const changed = current
    .map((p, idx) => (p.text !== original[idx].text ? p.pageNumber : null))
    .filter(n => n !== null);

  return {
    pages: current, original, rounds, changed,
    audits, mergedFindings, mergeStats,
    proofread, lectorAccepted, lectorRejected,
    partial: false,
  };
}

/**
 * Pull the chain's input out of a story record: page text plus the COMPACT
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
      // job_1786309527338 p6, where the brief has the main character easing a
      // cork free and a second character unrolling a map, and refinement
      // produced text in which the cork is still stuck and neither happens.
      //
      // The stage's founding invariant (decisions.md 2026-08-05) is "rewrites
      // page prose only, never events" — it cannot honour that while blind to
      // what the events are. METADATA is stripped here and the template is
      // explicit that appearance and staging are not the prose's business.
      const briefRaw = String(s.sceneDescription || s.description || '');
      const sceneBrief = briefRaw.split(/---\s*METADATA/i)[0].trim();
      // The page's own LOCKED PLAN LINE (beats pipeline only). outlineExtract
      // holds "PLAN: …" in beats mode and the scene expansion's own JSON in
      // unified mode (storyScorecard.js finalBeats() draws the same
      // distinction); matching the marker is what keeps a unified story from
      // mistaking its own JSON for a plan line. The arc is the story (owner
      // ruling 2026-09-02, Lab #973); the plan line says which picture this
      // page carries, and the prose may not contradict it.
      const extractRaw = String(s.outlineExtract || '');
      const planLine = ((extractRaw.match(/(?:^|\n)\s*PLAN\s*:\s*([\s\S]*)$/i) || [, ''])[1] || '').trim();
      return { pageNumber: s.pageNumber, text: String(s.text).trim(), sceneIntent, sceneBrief, planLine };
    })
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

/**
 * Fire-and-forget wrapper for the production pipeline: never throws, never
 * blocks a story. A failure must leave the original text intact and the
 * generation unaffected — this is a polish pass, not a gate.
 */
function startBackgroundRefine(storyData, pages, opts = {}) {
  return refineStoryText(storyData, pages, opts)
    .then(res => {
      const ms = res.rounds.reduce((n, r) => n + (r.elapsedMs || 0), 0);
      log.info(`✍️  [TEXT-REFINE] chain done in ${(ms / 1000).toFixed(1)}s — rewrote page(s) ${res.changed.join(', ') || 'none'}`);
      return res;
    })
    .catch(err => {
      log.warn(`⚠️ [TEXT-REFINE] skipped: ${err.message} — original text kept`);
      return null;
    });
}

module.exports = {
  refineStoryText,
  extractRefinablePages,
  startBackgroundRefine,
  parseFaultLines,
  mergeAuditFindings,
  pageDiffRatio,
  screenLectorPages,
  LECTOR_MAX_DIFF_RATIO,
  DUPLICATE_OVERLAP,
};

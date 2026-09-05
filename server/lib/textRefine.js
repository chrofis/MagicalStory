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
 *   4. ONE LECTOR PASS emitting quoted-span findings, applied by
 *      code-side substitution of its quoted spans (applyLectorFindings)
 *
 * What this replaced: audit → fix → re-audit → corrective fix → lector →
 * separate apply pass. The multi-round convergence loop, the re-audit and the
 * apply call are DELETED, not bridged. Two independent finders up front beat
 * sequential re-audits of one; the accepted cost is that a fault the repair
 * pass introduces has nothing reading its output, which is why the repair slot
 * went to the model that invented nothing in the bake-off (claude-opus, owner
 * ruling 2026-09-03). A second bounded repair pass would slot in as one more
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

// ──────────── WORD-BUDGET COUNTER: THE DETERMINISTIC THIRD AUDITOR ────────────

/** Whitespace-token word count — deterministic, no model involved. */
function countPageWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Count each page against the reading level's word budget and emit violations
 * as FAULT lines (owner ruling 2026-09-05: "count the words in code, no AI
 * call, give it to the reviewer"). The budget comes from the SAME
 * LANGUAGE_LEVELS table the writer prompt renders (promptBuilders) — one source
 * of truth, never a duplicated number. The lines feed mergeAuditFindings as a
 * third source ('counter'), so the one existing repair pass shortens the pages;
 * no extra model call for counting and no extra repair round.
 *
 * Motivating evidence: job_1788551692337_bc479p945 (1st-grade, budget 25-50)
 * averaged 71 words/page, 14/18 pages over budget, finale at 149 — and neither
 * AI auditor flagged length.
 *
 * @param {Array<{pageNumber:number,text:string}>} pages
 * @param {string} languageLevel
 * @returns {string} newline-joined FAULT[LENGTH] lines ('' when all pages fit)
 */
function buildWordBudgetFindings(pages = [], languageLevel) {
  const { LANGUAGE_LEVELS } = require('./promptBuilders');
  const level = LANGUAGE_LEVELS[languageLevel] || LANGUAGE_LEVELS['standard'];
  const min = level.wordsPerPageMin;
  const max = level.wordsPerPageMax;
  const lines = [];
  for (const p of pages) {
    const n = countPageWords(p.text);
    if (n > max) {
      lines.push(`FAULT[LENGTH]: p${p.pageNumber} — page has ${n} words, budget ${min}-${max} — shorten without losing content`);
    } else if (n < min) {
      lines.push(`FAULT[LENGTH]: p${p.pageNumber} — page has ${n} words, budget ${min}-${max} — expand without padding`);
    }
  }
  return lines.join('\n');
}

// ─────────────── LECTOR: FINDINGS PARSED, CORRECTIONS APPLIED IN CODE ──────────

/**
 * Lector findings: `PAGE <n>: '<faulty words>' → '<corrected words>'`, one per
 * line (see prompts/story-text-proofread.txt).
 *
 * A quoted-span-plus-replacement format is what makes the application step
 * mechanical — it is string substitution, done below in code, with no second
 * model call — and it is also the hallucination guard: a finding whose quote is
 * not on the page it names cannot be applied and is dropped. That is the whole
 * class a free-prose or whole-page format cannot filter; the previous
 * proofreader's two false faults on job_1788380714660 were a claim about two
 * distinct cast members being "the same person" and a suggestion to write ß,
 * neither of which quotes anything the page contains.
 *
 * Everything that is not a parseable finding line is ignored, which subsumes the
 * old withdraw/leaked-reasoning filter (2026-08-31, job_1788123310558): a model
 * musing between findings simply produces no line.
 */
const LECTOR_LINE_RE = /^(?:[-*]\s*)?PAGE\s+(\d+)\s*[:.–—-]\s*(.+?)\s*(?:→|->|=>)\s*(.+)$/i;
const QUOTE_PAIRS = { "'": "'", '"': '"', '«': '»', '‹': '›', '„': '“', '“': '”', '‘': '’', '`': '`' };

/** The first quoted run of a fragment, or null when it does not open with a quote. */
function firstQuoted(s) {
  const t = String(s || '').trim();
  const close = QUOTE_PAIRS[t[0]];
  if (!close) return null;
  const end = t.indexOf(close, 1);
  return end > 1 ? t.slice(1, end) : null;
}

/**
 * Unquoted fallback: strip a trailing parenthetical alternative ("(oder …)").
 * Both halves need it — the measured output quotes the faulty span but often
 * leaves the correction bare (grok-4.6 did so on every line of the A/B).
 */
function bareSpan(s) {
  return String(s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function parseLectorFindings(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const m = raw.trim().match(LECTOR_LINE_RE);
    if (!m) continue;
    const pageNumber = parseInt(m[1], 10);
    const quote = firstQuoted(m[2]) ?? bareSpan(m[2]);
    const correction = firstQuoted(m[3]) ?? bareSpan(m[3]);
    if (!Number.isFinite(pageNumber) || !quote || !correction || quote === correction) continue;
    out.push({ pageNumber, quote, correction, raw: raw.trim() });
  }
  return out;
}

/** Collapse whitespace runs to one space, keeping a map back to source indices. */
function normalizeWithMap(s) {
  const src = String(s || '');
  let norm = '';
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < src.length; i++) {
    if (/\s/.test(src[i])) { if (norm.length > 0) pendingSpace = true; continue; }
    if (pendingSpace) { norm += ' '; map.push(i); pendingSpace = false; }
    norm += src[i];
    map.push(i);
  }
  return { norm, map };
}

/**
 * Locate a finding's quoted span in its page and return the SOURCE offsets.
 *
 * Whitespace is normalised on both sides before matching, because a model
 * re-wraps a quote across a line break; nothing else is. The index map is what
 * turns a normalised hit back into a slice of the original text, so the
 * replacement lands on the real characters — a plain `includes` check could
 * verify a quote but not replace it.
 *
 * The FIRST occurrence wins when a page repeats the quoted span: the lector
 * quotes "the shortest span that contains the fault", so a repeat is the same
 * fault twice and a second finding for it will be dropped as overlapping or
 * applied on the next pass over the text.
 */
function locateQuote(pageText, quote) {
  const { norm, map } = normalizeWithMap(pageText);
  const nq = String(quote || '').replace(/\s+/g, ' ').trim();
  if (!nq) return null;
  const at = norm.indexOf(nq);
  if (at < 0) return null;
  return { start: map[at], end: map[at + nq.length - 1] + 1 };
}

/**
 * Apply the lector's findings to the page text. No model call: each finding is a
 * quoted span and its replacement, so this is substitution.
 *
 * Three drop reasons, all logged by the caller:
 *   `no-such-page`  the finding names a page the story does not have
 *   `quote-absent`  the quoted words are not on that page — the hallucination guard
 *   `overlap`       its span overlaps a finding already applied to that page
 *
 * Spans are applied in DESCENDING position order so an earlier replacement
 * cannot shift a later one's offsets. Overlaps are resolved in the model's own
 * listing order: the first finding wins, the second is dropped.
 *
 * @param {Array<{pageNumber:number,text:string}>} pages
 * @param {Array<{pageNumber:number,quote:string,correction:string}>} findings
 * @returns {{pages:Array, applied:Array, dropped:Array}}
 */
function applyLectorFindings(pages = [], findings = []) {
  const byPage = new Map(pages.map(p => [p.pageNumber, String(p.text || '')]));
  const applied = [];
  const dropped = [];
  // Page -> the spans already claimed on it, in listing order.
  const claimed = new Map();

  for (const f of findings) {
    const pageText = byPage.get(f.pageNumber);
    if (pageText === undefined) { dropped.push({ ...f, reason: 'no-such-page' }); continue; }
    const span = locateQuote(pageText, f.quote);
    if (!span) { dropped.push({ ...f, reason: 'quote-absent' }); continue; }
    const taken = claimed.get(f.pageNumber) || [];
    if (taken.some(s => span.start < s.end && s.start < span.end)) {
      dropped.push({ ...f, reason: 'overlap' });
      continue;
    }
    taken.push(span);
    claimed.set(f.pageNumber, taken);
    applied.push({ ...f, ...span });
  }

  const next = pages.map((p) => {
    const spans = applied.filter(a => a.pageNumber === p.pageNumber);
    if (spans.length === 0) return { ...p };
    let text = String(p.text || '');
    for (const a of spans.slice().sort((x, y) => y.start - x.start)) {
      text = text.slice(0, a.start) + a.correction + text.slice(a.end);
    }
    return { ...p, text };
  });

  return { pages: next, applied, dropped };
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
  let lectorFindings = [];
  let lectorApplied = [];
  let lectorDropped = [];

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
    lectorFindings: lectorFindings.slice(),
    lectorApplied: lectorApplied.slice(),
    lectorDropped: lectorDropped.slice(),
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
  // THE COUNTER — third finding source, deterministic and free. Runs on the
  // writer's text (`current` is untouched here), and its LENGTH category
  // matches no audit category, so the merge treats it as its own auditor: the
  // AI audits are passed first and win any (unlikely) duplicate.
  const counterRaw = buildWordBudgetFindings(current, storyData?.languageLevel);
  if (counterRaw) {
    log.info(`🔢 [TEXT-COUNTER] ${counterRaw.split('\n').length} page(s) outside the '${storyData?.languageLevel || 'standard'}' word budget`);
  }
  const merged = mergeAuditFindings([
    ...audits.filter(a => a.ok).map(a => ({ source: a.source, raw: a.raw })),
    ...(counterRaw ? [{ source: 'counter', raw: counterRaw }] : []),
  ]);
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

  // THE LECTOR — LAST. It reads the text the repair pass left, so a grammar
  // fault the repair introduced is still caught, and it emits FINDINGS: quoted
  // span + replacement, one line each. The corrections are applied HERE, in
  // code (applyLectorFindings) — no second model call.
  //
  // Reverted from returning whole pages (owner ruling 2026-09-03, measured):
  // page-return handed the lector the repair pass's output room and
  // gemini-3.1-pro reasons into whatever room it is given — $0.30 and 201s for
  // FOUR pages on Lab #984, against $0.10 for a whole 16-page book in this
  // findings format (the A/B where its 4/4 accuracy was measured). The
  // verbatim-quote check comes back with the format and is again the
  // hallucination guard, which is why the diff-ratio cap that stood in for it
  // is deleted rather than kept alongside.
  //
  // Non-blocking, and the publish() above means a join deadline can only cost
  // this pass.
  try {
    const lectorPrompt = buildTextProofreadPrompt(storyData, current);
    if (lectorPrompt && TEXT_MODELS[lectorModel]) {
      const t0 = Date.now();
      // The model's own limit (owner rule: no output caps). A finding list is a
      // few hundred tokens — the cost of this call is decided by the output
      // CONTRACT, not by the ceiling.
      const MAX_OUT = TEXT_MODELS[lectorModel].maxOutputTokens || 16000;
      // temperature 0: the A/B measured this prompt at 0, and a lector must not
      // paraphrase the page it quotes.
      let lr = await callTextModelStreaming(lectorPrompt, MAX_OUT, null, lectorModel, { temperature: 0, usageLabel: 'text_lector' });
      if (!String(lr.text || '').trim()) {
        log.warn(`⚠️ [LECTOR] ${lectorModel} returned empty output — retrying once`);
        lr = await callTextModelStreaming(lectorPrompt, MAX_OUT, null, lectorModel, { temperature: 0, usageLabel: 'text_lector' });
      }
      proofread = String(lr.text || '').trim();
      lectorFindings = parseLectorFindings(proofread);
      const result = applyLectorFindings(current, lectorFindings);
      lectorApplied = result.applied;
      lectorDropped = result.dropped;
      for (const d of lectorDropped) {
        const why = d.reason === 'quote-absent'
          ? `the quoted words are not on page ${d.pageNumber}`
          : d.reason === 'overlap'
            ? `its span overlaps a correction already applied to page ${d.pageNumber}`
            : `page ${d.pageNumber} is not in this story`;
        log.warn(`⚠️ [LECTOR] dropped "${d.quote}" — ${why}`);
      }
      const next = result.pages;
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
        findings: lectorFindings.map(f => ({ pageNumber: f.pageNumber, quote: f.quote, correction: f.correction })),
        appliedCount: lectorApplied.length,
        droppedCount: lectorDropped.length,
        droppedFindings: lectorDropped.map(d => ({ pageNumber: d.pageNumber, quote: d.quote, reason: d.reason })),
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
      log.info(`✍️  [LECTOR] ${lectorModel}: ${lectorFindings.length} finding(s), ${lectorApplied.length} applied to page(s) ${changedPages.join(', ') || 'none'}, ${lectorDropped.length} dropped, in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
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
    proofread, lectorFindings, lectorApplied, lectorDropped,
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
  countPageWords,
  buildWordBudgetFindings,
  parseLectorFindings,
  applyLectorFindings,
  locateQuote,
  DUPLICATE_OVERLAP,
};

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
 *        a. arc-informed  — gemini-3.1-pro, story-text-audit.txt (final arc
 *           and its hints, page plan, page text, each page's whole picture
 *           brief; no back cover, no commission — corrected 2026-09-23)
 *        b. blind         — grok-4.6, story-text-audit-blind.txt (page text and
 *           nothing else)
 *   2. MERGE + DEDUPE the two fault lists in code (mergeAuditFindings)
 *   3. ONE REPAIR PASS over the merged findings (textRefineModel)
 *   4. ONE DIFF PASS over the pages the repair rewrote — BEFORE/AFTER, judging
 *      only what the rewrite damaged (textDiffModel, 2026-09-06)
 *   5. ONE LECTOR PASS emitting quoted-span findings, applied by
 *      code-side substitution of its quoted spans (applyLectorFindings)
 *
 * Steps 4 and 5 share ONE output contract and ONE applier; they differ only in
 * what they see. The diff pass exists because "a fault the repair pass
 * introduces has nothing reading its output" (below) turned out to be a real,
 * measured cost, not a theoretical one — the cold-read lector missed two
 * rewrite-introduced corruptions that the diff caught for a tenth of the price.
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
 * The one such second pass that exists (2026-09-10): a $0 cross-page
 * REPETITION check runs on the repair pass's output (findRepeatedPassages —
 * shared 5-word shingles, string equality, no model). If two pages carry the
 * same passage, ONE corrective `runRepairPass` carries the duplicated words and
 * both plan lines back to the repairer; the check re-runs once and a still-
 * tripping result ships with a WARN. Measured origin: job_1788983823620 p12/p13
 * shipped one paragraph twice (11 shared shingles) after the repair copied a
 * scene onto the page whose picture shows it instead of moving it, and
 * self-reported the copy as a split. The re-audit stays deleted; this is the
 * mechanical replacement for that one failure class.
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
 * nine others are each its own. STYLE (2026-09-23) is the blind reader's
 * alone: a STYLE_RULEBOOK breach quoted sentence by sentence, routed to the
 * repair like any other finding — its page becomes rewritable. So: SAME PAGE + SAME CATEGORY + DIFFERENT
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

// ───────────────── FINDING LEDGER: EVERY FINDING ENDS SOMEWHERE ───────────────

/**
 * What became of one finding a whole-page pass was given.
 *
 * WHY THIS EXISTS (staging job_1789584708605_rts4wqupm, 2026-09-17). The blind
 * audit's single finding was correct, was merged, and the shipped book still
 * carries the fault. Asked what happened to it, the stored report could not
 * answer: the lector and the diff have a code-side applier that records
 * applied/dropped per finding (applyLectorFindings), and the repair pass — the
 * ONLY step the merged audit findings are ever handed to — had none. It
 * recorded `findingsCount` going in and `changedPages` coming out, with nothing
 * joining the two. A merged finding could therefore be neither applied nor
 * dropped, and leave no trace at all.
 *
 * WHAT THIS IS NOT: a claim that a finding was CLOSED. A whole-page pass
 * rewrites wholesale, so the strongest mechanical statement available is
 * whether the page the finding names came back rewritten. `page-rewritten` says
 * the pass touched what the finding named, nothing more — on that same run the
 * repair pass rewrote p18 and its own analysis claimed it had dropped the
 * page's contradicted claim, which still ships. A self-report is not an
 * outcome, which is also why the repairer's prose ledger is not parsed here.
 *
 * WHAT IT GUARANTEES: every finding in, exactly one outcome out, and every
 * outcome that is not `page-rewritten` carries a reason. That is what makes the
 * silent third state impossible.
 */
const FINDING_OUTCOME = {
  /** The pass returned the page this finding names, rewritten. */
  PAGE_REWRITTEN: 'page-rewritten',
  /** The pass never returned that page — the finding went unanswered. */
  PAGE_UNCHANGED: 'page-unchanged',
  /**
   * The pass RETURNED that page and the text it returned is identical to the
   * one it was given. A rewrite claimed and not delivered — the only self-report
   * this step makes that the diff can check, and the two used to collapse into
   * one `page-unchanged` with no way to tell them apart.
   */
  PAGE_RETURNED_IDENTICAL: 'page-returned-identical',
  /** The finding names a page the story does not have (the lector's guard, one level up). */
  NO_SUCH_PAGE: 'no-such-page',
  /** The auditor filed the fault without a page number — nothing can be matched to it. */
  NO_PAGE_NAMED: 'no-page-named',
  /** The pass itself failed, so no finding it held was answered. */
  PASS_FAILED: 'pass-failed',
  /**
   * The pass rewrote the page, and the diff pass then put the writer's own
   * sentences back on it. Whether the fix survived is not knowable in code, so
   * the ledger stops claiming it (settleLedgerAfterDiff).
   */
  REWRITE_RESTORED: 'rewrite-restored',
};

/**
 * Resolve every finding to exactly one outcome.
 *
 * @param {Array<{category:string,pageNumber:number|null,text:string,line:string,sources:string[]}>} findings
 * @param {Array<{pageNumber:number}>} pages   the pages the pass was given
 * @param {number[]} changedPages              the pages whose text actually differs
 * @param {number[]} [returnedPages]           the pages the pass CHOSE to return —
 *        its own structural self-report. Passed, a returned page whose text did
 *        not move is separated from one the pass never answered. Omitted, both
 *        stay `page-unchanged`, which is what every earlier caller meant.
 * @returns {Array<Object>} one entry per finding, each with `outcome` and `reason`
 */
function resolveFindingOutcomes(findings = [], pages = [], changedPages = [], returnedPages = null) {
  const known = new Set((pages || []).map(p => p.pageNumber));
  const changed = new Set(changedPages || []);
  const returned = Array.isArray(returnedPages) ? new Set(returnedPages) : null;
  return (findings || []).map((f) => {
    if (f.pageNumber == null) {
      return { ...f, outcome: FINDING_OUTCOME.NO_PAGE_NAMED, reason: 'the fault line names no page, so no rewrite can be matched to it' };
    }
    if (!known.has(f.pageNumber)) {
      return { ...f, outcome: FINDING_OUTCOME.NO_SUCH_PAGE, reason: `page ${f.pageNumber} is not in this story` };
    }
    if (!changed.has(f.pageNumber)) {
      if (returned && returned.has(f.pageNumber)) {
        return {
          ...f,
          outcome: FINDING_OUTCOME.PAGE_RETURNED_IDENTICAL,
          reason: `the pass returned page ${f.pageNumber} as a rewrite and its text is identical to the one it was given`,
        };
      }
      return { ...f, outcome: FINDING_OUTCOME.PAGE_UNCHANGED, reason: `the pass did not return page ${f.pageNumber}` };
    }
    return { ...f, outcome: FINDING_OUTCOME.PAGE_REWRITTEN, reason: null };
  });
}

/** The ledger entries that did NOT reach a rewritten page. */
function unresolvedFindings(ledger = []) {
  return (ledger || []).filter(f => f.outcome !== FINDING_OUTCOME.PAGE_REWRITTEN);
}

/**
 * The sentences of one diff correction that the WRITER's page carried and the
 * rewrite it corrected did not — i.e. what the correction restored. Provenance
 * only, by verbatim containment (whitespace-normalised); it says nothing about
 * whether restoring was right.
 *
 * @param {string} correction  the diff pass's replacement text
 * @param {string} writerText  the page before any whole-page pass (BEFORE)
 * @param {string} rewritten   the page as the diff pass read it (AFTER)
 * @returns {string[]}
 */
function restoredSentences(correction, writerText, rewritten) {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const before = norm(writerText);
  const after = norm(rewritten);
  const whole = norm(correction);
  if (!whole) return [];
  if (before.includes(whole) && !after.includes(whole)) return [whole];
  return whole
    .split(/(?<=[.!?…»“”"])\s+/)
    .map(s => s.trim())
    .filter(s => s.split(' ').length >= 3 && before.includes(s) && !after.includes(s));
}

/**
 * THE LEDGER AFTER THE DIFF PASS (2026-09-23). The ledger is resolved when the
 * whole-page passes settle, and the diff pass runs after them. On
 * job_1790100385959_1nitlympp the diff put the writer's sentences back on p11
 * and p16 — the very text the repair had removed to close three findings — and
 * the stored ledger still said `page-rewritten` for all of them.
 *
 * A finding whose page received a restoring diff correction is re-marked
 * `rewrite-restored`, with the restored sentences as its reason. That is a
 * provenance fact, not a verdict: the restoration may be the right call (a fact
 * the rewrite dropped) or it may undo the fix. The ledger no longer claims
 * either way, so `unresolvedFindings` counts it.
 *
 * @param {Array<Object>} ledger
 * @param {Array<{pageNumber:number,restored?:string[]}>} diffApplied
 * @returns {Array<Object>}
 */
function settleLedgerAfterDiff(ledger = [], diffApplied = []) {
  const restoredOn = new Map();
  for (const a of diffApplied || []) {
    if (!a.restored?.length) continue;
    restoredOn.set(a.pageNumber, [...(restoredOn.get(a.pageNumber) || []), ...a.restored]);
  }
  return (ledger || []).map((f) => {
    const restored = f.outcome === FINDING_OUTCOME.PAGE_REWRITTEN ? restoredOn.get(f.pageNumber) : null;
    if (!restored) return f;
    return {
      ...f,
      outcome: FINDING_OUTCOME.REWRITE_RESTORED,
      reason: `the diff pass put the writer's words back on page ${f.pageNumber}: ${restored.map(s => `"${s}"`).join('; ')}`,
    };
  });
}

// ──────────── WORD-BUDGET COUNTER: THE DETERMINISTIC THIRD AUDITOR ────────────

/**
 * Grace band around the reading level's word budget — ASYMMETRIC (2026-09-07).
 * A rewrite is never worth its risk for a few words: only a page more than this
 * far outside the band is reported as a fault. The two directions do not carry
 * the same risk, so they do not share a number: cutting is destructive, padding
 * is not. See buildWordBudgetFindings for the evidence.
 */
const WORD_BUDGET_TOLERANCE_OVER = 0.5;
const WORD_BUDGET_TOLERANCE_UNDER = 0.2;

/** Whitespace-token word count — deterministic, no model involved. */
function countPageWords(text) {
  return require('./promptBuilders').measurePageText(text).words;
}

/** Words, sentences and paragraphs of every page, for the stored report. */
function measurePages(pages = []) {
  const { measurePageText } = require('./promptBuilders');
  return pages.map(p => ({ pageNumber: p.pageNumber, ...measurePageText(p.text) }));
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
 * A page only counts as a violation when it is more than the tolerance outside
 * the band (2026-09-06): job_1788681313413_xqmtk2gcs was 157 words against a
 * 150 ceiling — a 4.7% overage — and the forced rewrite corrupted a verb
 * collocation. The finding text still names the TRUE budget, so a page that
 * does trip the band is rewritten toward the real target, not the tolerated
 * one.
 *
 * The tolerance is ASYMMETRIC — 0.5 over, 0.2 under (2026-09-07, superseding
 * the single 0.2 of 2026-09-06). Meaning outranks word count: a page that runs
 * a few words long costs nothing, while forcing a 60% cut costs an action, a
 * line of dialogue or the causal link a later page depends on. Evidence:
 * job_1788727233899_1dpnym94p (18 pages, 1st-grade, budget 25-50) carried 66
 * action clauses against a 6-event budget it did meet; 13 of 18 pages ran
 * 61-128 words, 11 drew a LENGTH fault, and the refiner obeyed by deleting
 * causality. The real fix is upstream — the arc's action budget
 * (buildArcBudgetSection) — so this stage no longer forces the impossible cut;
 * it may overrun by a few words rather than delete an action.
 *
 * SENTENCES AND PARAGRAPHS (2026-09-23). The reading level also sets a
 * sentence count and the page a paragraph shape, and nothing counted either:
 * on job_1790100385959_1nitlympp (1st-grade, 3-6 sentences) most pages ran
 * 6-12 sentences and p18 had five paragraphs, with no finding. A page past the
 * sentence ceiling by the same OVER tolerance the words get, or past the
 * paragraph maximum, is reported in the SAME one line per page, so the merge
 * and the ledger see one length fault per page, never two. Over only: a short
 * page is judged on its words.
 *
 * @param {Array<{pageNumber:number,text:string}>} pages
 * @param {string} languageLevel
 * @returns {string} newline-joined FAULT[LENGTH] lines ('' when all pages fit)
 */
function buildWordBudgetFindings(pages = [], languageLevel) {
  const { LANGUAGE_LEVELS, PAGE_PARAGRAPHS, measurePageText } = require('./promptBuilders');
  const level = LANGUAGE_LEVELS[languageLevel] || LANGUAGE_LEVELS['standard'];
  const min = level.wordsPerPageMin;
  const max = level.wordsPerPageMax;
  const hi = max * (1 + WORD_BUDGET_TOLERANCE_OVER);
  const lo = min * (1 - WORD_BUDGET_TOLERANCE_UNDER);
  const sentenceRange = String(level.sentencesPerPage);
  const sentenceMax = Number(sentenceRange.split('-').pop());
  const sentenceHi = sentenceMax * (1 + WORD_BUDGET_TOLERANCE_OVER);
  const lines = [];
  for (const p of pages) {
    const m = measurePageText(p.text);
    const over = [];
    if (m.words > hi) over.push(`${m.words} words, budget ${min}-${max}`);
    if (m.sentences > sentenceHi) over.push(`${m.sentences} sentences, budget ${sentenceRange}`);
    if (m.paragraphs > PAGE_PARAGRAPHS.maxPerPage) over.push(`${m.paragraphs} paragraphs, at most ${PAGE_PARAGRAPHS.maxPerPage}`);
    if (over.length) {
      lines.push(`FAULT[LENGTH]: p${p.pageNumber} — page has ${over.join('; ')} — tighten the wording; keep every action, line of dialogue and feeling. Losing one is a fault.`);
    } else if (m.words < lo) {
      lines.push(`FAULT[LENGTH]: p${p.pageNumber} — page has ${m.words} words, budget ${min}-${max} — expand without padding`);
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

/**
 * The quoted span of ONE SIDE of a finding line — the text between the first
 * quote character and the LAST matching close on that side.
 *
 * FIRST-TO-LAST, not first-to-next (fixed 2026-09-06). A side is one span by
 * construction: the line format is `PAGE n: '<a>' -> '<b>'` and the arrow has
 * already split the two halves, so the last close character on a half IS that
 * half's closing quote. First-to-next silently truncated every span containing
 * an apostrophe — the closing `'` of `'the boy's pole lantern'` was read as the
 * one inside `boy's`, the quote became `the boy`, and the
 * `quote === correction` guard in parseLectorFindings then DISCARDED the whole
 * finding. Measured on job_1788681313413_xqmtk2gcs: a valid lector correction
 * was dropped at the PARSE step, and `'everyone's' -> 'everyone else's'`
 * survived only because its truncations happened to differ.
 *
 * Three outcomes, all meaningful to the caller:
 *   string  the span (may be empty for `''`)
 *   null    the side is not quoted at all — fall back to bareSpan
 *   false   the side OPENS a quote it never closes — malformed, reject the line
 *           rather than half-parse it into an unlocatable quote
 */
function quotedSpan(s) {
  const t = String(s || '').trim();
  const close = QUOTE_PAIRS[t[0]];
  if (!close) return null;
  const end = t.lastIndexOf(close);
  if (end <= 0) return false;
  return t.slice(1, end);
}

/**
 * Unquoted fallback: strip a trailing parenthetical alternative ("(oder …)").
 * Both halves need it — the measured output quotes the faulty span but often
 * leaves the correction bare (grok-4.6 did so on every line of the A/B).
 */
function bareSpan(s) {
  return String(s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * A line that ANNOUNCES itself as a finding: it opens with the `PAGE <n>` marker
 * the format requires, or carries the arrow that separates a quote from its
 * correction. Ordinary prose between findings does neither, which is what keeps
 * the unparsed count below a measurement rather than a tally of the model's
 * thinking.
 */
const LECTOR_FINDING_SHAPED_RE = /^(?:[-*]\s*)?PAGE\s+\d+|→|->|=>/i;

/**
 * ONE classification of ONE line, so the parser and the unparsed count can
 * never disagree about what a finding is.
 *
 * @returns {{finding:Object}|{rejected:string}|null}  null = not a finding line at all
 */
function classifyLectorLine(rawLine) {
  const raw = String(rawLine || '').trim();
  if (!raw) return null;
  const m = raw.match(LECTOR_LINE_RE);
  if (!m) return LECTOR_FINDING_SHAPED_RE.test(raw) ? { rejected: 'not in the PAGE n: \'quote\' → \'correction\' format' } : null;
  const pageNumber = parseInt(m[1], 10);
  // Strip a trailing parenthetical alternative BEFORE reading the span: the
  // measured output writes `'x' → 'y' (oder 'z')`, and a first-to-last read
  // would otherwise swallow `y' (oder 'z`.
  const lhs = bareSpan(m[2]);
  const rhs = bareSpan(m[3]);
  const qs = quotedSpan(lhs);
  const cs = quotedSpan(rhs);
  // An unbalanced quote on either side is a malformed line, not a finding.
  if (qs === false || cs === false) return { rejected: 'a quote is opened and never closed' };
  const quote = qs ?? lhs;
  const correction = cs ?? rhs;
  if (!Number.isFinite(pageNumber)) return { rejected: 'the page number is not a number' };
  // An explicitly EMPTY correction (`''`) lands here and is rejected: this apply
  // path substitutes text, it does not delete spans, and a deletion would leave
  // the surrounding spacing and punctuation broken.
  if (!quote || !correction) return { rejected: 'one side of the arrow is empty' };
  if (quote === correction) return { rejected: 'the correction is identical to the quote' };
  return { finding: { pageNumber, quote, correction, raw } };
}

/**
 * Findings AND the finding-shaped lines the parser could not read.
 *
 * WHY THE SECOND HALF EXISTS (owner, 2026-09-17). Everything that does not
 * parse is skipped, and that is correct for a model musing between findings —
 * but it made a MALFORMED finding indistinguishable from an absent one. The
 * same class the repair pass's ledger closed one level up: the lector and the
 * diff would report "7 findings" over a reply that offered nine, and the two
 * the parser choked on left no trace anywhere.
 *
 * Measured before building it: 33 staging stories with a stored proofread reply,
 * 83 finding-shaped lines, 0 unreadable. So this is a tripwire on a path that is
 * clean today, not a repair — which is exactly why it must count out loud rather
 * than be trusted to stay clean.
 *
 * @returns {{findings:Array, unparsed:Array<{line:string,reason:string}>}}
 */
function parseLectorLines(text) {
  const findings = [];
  const unparsed = [];
  for (const raw of String(text || '').split('\n')) {
    const verdict = classifyLectorLine(raw);
    if (!verdict) continue;
    if (verdict.finding) findings.push(verdict.finding);
    else unparsed.push({ line: String(raw).trim().slice(0, 300), reason: verdict.rejected });
  }
  return { findings, unparsed };
}

/** The findings alone — the shape every existing caller and test reads. */
function parseLectorFindings(text) {
  return parseLectorLines(text).findings;
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
 * The FIRST occurrence wins when a page repeats the quoted span. The lector
 * quotes the WHOLE SENTENCE the fault stands in (2026-09-13), so a repeat means
 * the page carries that sentence twice and a second finding for it will be
 * dropped as overlapping or applied on the next pass over the text.
 *
 * WHY THE SENTENCE AND NOT THE FAULT (prod job_1789227389389_z18dmvnt6 p15):
 * the contract used to ask for "the shortest span that contains the fault",
 * with agreement corrected only INSIDE that span. The lector quoted
 * `la doudou toute degoulinante` -> `le doudou tout degoulinant`, a correct
 * gender fix, and the preposition one word to its LEFT was outside the span:
 * `de la doudou` became `de le doudou`, which French contracts to `du`. The
 * substitution was applied exactly as asked and shipped a NEW error. A span
 * that stops short of the words agreement reaches cannot be applied safely,
 * so the span is now the sentence. One line per sentence, all its faults in
 * one correction -- several findings inside one sentence would collide on the
 * overlap guard below and all but the first would be dropped.
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

/** The passes that rewrite whole pages from a finding list (runRepairPass). */
const WHOLE_PAGE_PASS_KINDS = new Set(['repair', 'repetition_fix', 'length_fix']);

// ─────────────────────── CROSS-PAGE REPETITION (mechanical) ───────────────────

const SHINGLE_WORDS = 5;

/**
 * Words of a page for shingling: lowercase, punctuation and quote marks
 * (including «» and every dash) stripped, whitespace collapsed. Letters and
 * digits of any script survive, so German umlauts and ß compare as themselves.
 */
function normalizeForShingles(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Ordered list of 5-word shingles for one page (positions matter for passage rebuild). */
function shinglesOf(text, n = SHINGLE_WORDS) {
  const words = normalizeForShingles(text);
  const out = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(' '));
  return out;
}

/**
 * Every pair of pages sharing at least `minShared` identical 5-word shingles.
 * String equality on the pages' own words — no interpretation. Each hit carries
 * the shared shingles and the duplicated passages rebuilt from consecutive
 * shared shingles on the first page, so a prompt or a log can quote them.
 *
 * @param {Array<{pageNumber:number,text:string}>} pages
 * @param {number} minShared
 * @returns {Array<{pages:[number,number], sharedCount:number, shingles:string[], passages:string[]}>}
 */
function findRepeatedPassages(pages, minShared) {
  const list = (pages || []).map(p => ({ pageNumber: p.pageNumber, shingles: shinglesOf(p.text) }));
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    const setI = new Set(list[i].shingles);
    for (let j = i + 1; j < list.length; j++) {
      const shared = new Set(list[j].shingles.filter(sh => setI.has(sh)));
      if (shared.size < minShared) continue;
      // Rebuild passages: a run of consecutive shared shingles on page i is one
      // copied stretch; each further shingle in the run appends its last word.
      const passages = [];
      let run = null;
      for (const sh of list[i].shingles) {
        if (!shared.has(sh)) { if (run) passages.push(run.join(' ')); run = null; continue; }
        const words = sh.split(' ');
        if (run) run.push(words[words.length - 1]); else run = words.slice();
      }
      if (run) passages.push(run.join(' '));
      hits.push({
        pages: [list[i].pageNumber, list[j].pageNumber],
        sharedCount: shared.size,
        shingles: Array.from(shared),
        passages,
      });
    }
  }
  return hits;
}

/**
 * The corrective pass's findings, in the FAULT-line contract the repair prompt
 * already reads — so the fed-back retry carries the failure itself: the exact
 * duplicated words, both page numbers and both pages' plan lines.
 */
function buildRepetitionFindings(hits, pages) {
  const byPage = new Map((pages || []).map(p => [p.pageNumber, p]));
  const plan = n => (byPage.get(n)?.planLine || '').trim() || '(no plan line)';
  return hits.map(h => {
    const [a, b] = h.pages;
    const quoted = h.passages.map(x => `"${x}"`).join('; ');
    return `FAULT[REPETITION]: p${a} — pages ${a} and ${b} carry the same passage (${h.sharedCount} shared 5-word sequences): ${quoted}. `
      + `Plan p${a}: ${plan(a)} Plan p${b}: ${plan(b)} `
      + 'Keep the passage on the one page whose plan line and picture it belongs to, rewrite the other page without it, change nothing else.';
  }).join('\n');
}

// ─────────────────── POST-AUDIT TEXT ROUND (A8, 2026-09-21) ───────────────────

/**
 * The scope note the book audit's findings carry into the refine template.
 *
 * WHY IT IS NEEDED. Every other caller of that template runs BEFORE the
 * pictures exist, so its one permitted structural move — a MISMATCH finding
 * lets a passage move to the page whose picture shows it — is safe there. Here
 * it is not: this round runs after the repair loop, on the book that ships, so
 * a moved passage lands under a picture already drawn for something else. The
 * picture cannot answer back any more, so the text may only change inside the
 * page the fault names.
 */
const POST_AUDIT_SCOPE_NOTE = [
  "These findings come from a reader of the FINISHED book: each page's shipped picture read beside its shipped text.",
  'The pictures are final and no illustration round follows this one, so every fault below is fixed in the words.',
  'Rewrite only the pages these findings name. Never move a passage from one page to another — the destination page\'s picture is already drawn and does not show it. Fix each fault inside the page it names, or say in the ledger why it stands.',
].join('\n');

/**
 * ONE corrective text round on the book audit's TEXT route.
 *
 * WHY (owner decision 2026-09-21, finding A8). The audit routes a fault to
 * TEXT when different prose would fix it, and nothing read that route: the only
 * prose-editing stage (the chain above) runs before the repair loop and has
 * gone home by the time the audit happens, so a TEXT fault was stored evidence
 * and nothing else. This is the fixer the route always named.
 *
 * WHAT IT IS NOT: a loop, and not a second refine chain. ONE call, and only
 * when the audit produced a TEXT fault — happy-path latency is sacred, so a
 * book with no TEXT fault makes no extra model call at all.
 *
 * SCOPE IS ENFORCED IN CODE, not merely asked for. A returned page that no
 * finding names is RECORDED and DROPPED: every page's picture is final here,
 * and a rewrite of a page the audit passed buys nothing worth the risk.
 *
 * Never throws — it runs after the whole book is already paid for.
 *
 * @param {Object} storyData      story record (characters, language, visualBible …)
 * @param {Array<{pageNumber:number,text:string}>} pages  the FINAL pages (extractRefinablePages)
 * @param {Array<{page:number|null,severity:string|null,line:string}>} textFaults
 *        the audit's TEXT route, verbatim (bookAudit.parseRoutes)
 * @param {Object} [opts] {model, arc, arcHints, usageLabel}
 * @returns {Promise<{pages:Array, entry:Object}|null>} null when there is nothing to do
 */
async function runPostAuditTextRound(storyData, pages, textFaults = [], opts = {}) {
  const { loadPromptTemplates } = require('../services/prompts');
  const { buildTextRefinePrompt, parseRefinedText, stripTrailingSeparator } = require('./storyHelpers');
  const { callTextModelStreaming, describeTruncation } = require('./textModels');
  const { TEXT_MODELS, MODEL_DEFAULTS, calculateTextCost } = require('../config/models');

  const lines = (textFaults || []).map(f => String(f?.line || '').trim()).filter(Boolean);
  if (lines.length === 0) return null;          // the only silent exit: nothing was routed here
  if (!Array.isArray(pages) || pages.length === 0) {
    log.error('❌ [TEXT-POST-AUDIT] the audit routed TEXT fault(s) and no page text was passed — they go unanswered');
    return null;
  }
  await loadPromptTemplates();

  // The audit's own FAULT lines, read by the SAME parser the text audits feed.
  const findings = parseFaultLines(lines.join('\n'), 'book-audit');
  const known = new Set(pages.map(p => p.pageNumber));
  const scope = [...new Set(findings.map(f => f.pageNumber).filter(n => n != null && known.has(n)))].sort((a, b) => a - b);
  const fail = (error, prompt = '') => ({
    pages,
    entry: {
      kind: 'post_audit', ok: false, error, faults: lines, scopedPages: scope,
      findingOutcomes: resolveFindingOutcomes(findings, pages, []),
      changedPages: [], outOfScopePages: [], prompt, rawResponse: '',
    },
  });
  if (scope.length === 0) {
    log.error(`❌ [TEXT-POST-AUDIT] ${lines.length} TEXT fault(s) name no page this book has — nothing can be scoped, they go unanswered`);
    return fail('no fault names a page of this book');
  }

  const model = opts.model || MODEL_DEFAULTS.textRefineModel;
  if (!TEXT_MODELS[model]) {
    log.error(`❌ [TEXT-POST-AUDIT] unknown model "${model}" — ${lines.length} TEXT fault(s) go unanswered`);
    return fail(`unknown model "${model}"`);
  }

  // The WHOLE book goes into the prompt — a page cannot be judged for what the
  // pages around it established if it is shown alone. What is scoped is the
  // REWRITE, not the reading.
  const findingsText = `${POST_AUDIT_SCOPE_NOTE}\n\n${lines.join('\n')}`;
  const prompt = buildTextRefinePrompt(storyData, pages, findingsText, String(opts.arc || '').trim(), { arcHints: opts.arcHints });
  if (!prompt) {
    log.error('❌ [TEXT-POST-AUDIT] text-refine template unavailable — the TEXT route goes unanswered');
    return fail('text-refine template unavailable');
  }

  const t0 = Date.now();
  try {
    // null = the model's own limit (owner rule: no output caps).
    const r = await callTextModelStreaming(prompt, null, null, model, { usageLabel: opts.usageLabel || 'text_refine_post_audit' });
    if (r.truncation?.suspected) throw new Error(`reply ${describeTruncation(r.truncation)} — rewrites unusable`);
    const parsed = parseRefinedText(r.text || '', pages.map(p => p.pageNumber));
    const returnedPages = parsed.pages.map(p => p.pageNumber);
    // SCOPE, ENFORCED. A page no finding names keeps the text it shipped with.
    const outOfScopePages = returnedPages.filter(n => !scope.includes(n));
    const byPage = new Map(parsed.pages.filter(p => scope.includes(p.pageNumber)).map(p => [p.pageNumber, stripTrailingSeparator(p.text)]));
    const next = pages.map(p => ({ ...p, text: byPage.get(p.pageNumber) || p.text }));
    const changedPages = next.filter((p, idx) => p.text !== pages[idx].text).map(p => p.pageNumber);
    const findingOutcomes = resolveFindingOutcomes(findings, pages, changedPages, returnedPages);
    for (const f of unresolvedFindings(findingOutcomes)) {
      log.warn(`⚠️ [TEXT-POST-AUDIT] UNANSWERED p${f.pageNumber ?? '?'} — ${f.reason}: ${f.text}`);
    }
    if (outOfScopePages.length) {
      log.warn(`⚠️ [TEXT-POST-AUDIT] the pass returned page(s) ${outOfScopePages.join(', ')} that no TEXT fault names — dropped, their pictures are final`);
    }
    const elapsedMs = Date.now() - t0;
    log.info(`📖✍️  [TEXT-POST-AUDIT] ${model}: ${lines.length} TEXT fault(s) on page(s) ${scope.join(', ')} → rewrote page(s) ${changedPages.join(', ') || 'none'} in ${(elapsedMs / 1000).toFixed(0)}s`);
    const beforeByPage = new Map(pages.map(p => [p.pageNumber, p.text]));
    return {
      pages: next,
      entry: {
        kind: 'post_audit',
        ok: true,
        modelKey: model,
        modelId: r.modelId || TEXT_MODELS[model].modelId,
        elapsedMs,
        usage: { input_tokens: r.usage?.input_tokens || 0, output_tokens: r.usage?.output_tokens || 0 },
        cost: r.usage?.direct_cost ?? calculateTextCost(r.modelId || TEXT_MODELS[model].modelId, r.usage || {}),
        faults: lines,
        scopedPages: scope,
        returnedPages,
        outOfScopePages,
        changedPages,
        findingOutcomes,
        unresolvedCount: unresolvedFindings(findingOutcomes).length,
        prompt,
        rawResponse: String(r.text || '').slice(0, 40000),
        analysis: (parsed.analysis || '').slice(0, 40000),
        pages: next
          .filter(p => changedPages.includes(p.pageNumber))
          .map(p => ({ pageNumber: p.pageNumber, before: beforeByPage.get(p.pageNumber) || '', after: p.text })),
      },
    };
  } catch (e) {
    log.error(`❌ [TEXT-POST-AUDIT] failed (${e.message}) — ${lines.length} TEXT fault(s) ship unanswered`);
    const f = fail(e.message, prompt);
    f.entry.modelKey = model;
    f.entry.elapsedMs = Date.now() - t0;
    return f;
  }
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
/**
 * A15 — pages whose refined text dropped a character its LOCKED PLAN LINE
 * stages in frame.
 *
 * Free and mechanical: `whoColumn` + `namesIn` from planCounters, the same
 * pair the plan counters and the re-plan guard use. A page is reported only
 * when all three hold —
 * the plan stages the name, the text BEFORE the refine carried it, and the
 * text AFTER does not — which makes the refine the cause and rules out a page
 * the plan and the writer never agreed on in the first place.
 *
 * This is a FLAG, not a repair: nothing re-derives the plan (the picture is
 * already drawn from it). It exists so the stored record says where the plan
 * and the shipped prose disagree instead of leaving it to be discovered by a
 * reader of the finished book.
 *
 * @param {Object} storyData story record (characters)
 * @param {Array<{pageNumber:number,text:string,planLine:string}>} original pre-refine pages
 * @param {Array<{pageNumber:number,text:string}>} current post-refine pages
 * @returns {Array<{pageNumber:number, dropped:string[], planLine:string}>}
 */
function computePlanTextDrift(storyData, original = [], current = []) {
  const { namesIn, whoColumn } = require('./planCounters');
  const { refineCast } = require('./promptBuilders');
  // The SAME cast the refiner's own criteria enumerate — commissioned plus the
  // story's invented secondaries. A drift check that counted only the
  // commissioned roster would be blind to exactly the figures the plan most
  // often stages and the prose most often drops.
  const roster = refineCast(storyData || {}).names;
  if (roster.length === 0) return [];
  const afterByPage = new Map(current.map(p => [p.pageNumber, String(p.text || '')]));
  const out = [];
  for (const before of original) {
    const planLine = String(before.planLine || '').trim();
    if (!planLine) continue;                       // unified mode: no plan lines
    const after = afterByPage.get(before.pageNumber);
    if (after === undefined || after === String(before.text || '')) continue;  // untouched page
    const staged = namesIn(whoColumn(planLine), roster);
    if (staged.length === 0) continue;
    const stillThere = new Set(namesIn(after, staged));
    const wasThere = new Set(namesIn(String(before.text || ''), staged));
    const dropped = staged.filter(n => wasThere.has(n) && !stillThere.has(n));
    if (dropped.length > 0) out.push({ pageNumber: before.pageNumber, dropped, planLine });
  }
  return out;
}

async function refineStoryText(storyData, pages, opts = {}) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const {
    buildTextRefinePrompt, parseRefinedText, stripTrailingSeparator, buildTextAuditPrompt,
    buildTextAuditBlindPrompt, buildTextProofreadPrompt, buildTextDiffPrompt,
    countFaults, faultsByCategory,
  } = require('./storyHelpers');
  const { callTextModelStreaming, describeTruncation } = require('./textModels');
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
  const diffModel = opts.diffModel || MODEL_DEFAULTS.textDiffModel;
  if (!TEXT_MODELS[repairModel]) throw new Error(`Unknown model "${repairModel}"`);
  const usageLabel = opts.usageLabel || 'text_refine';
  // The whole story, read-only (owner redesign 2026-08-31): the audits and the
  // repair judge each page against the arc the beats divided, never against
  // staging alone.
  const arc = String(opts.arc || '').trim();
  // The arc's hints — amendments the writer applied. The arc-informed audit and
  // the repair read the story with them applied (buildCriticArcHintsSection).
  const arcHints = String(opts.arcHints || '').trim();

  const original = pages.map(p => ({ ...p }));
  let current = pages.map(p => ({ ...p }));
  const rounds = [];
  // Every `let` the snapshot closure reads is declared ABOVE it. Same lesson as
  // the evaluator's expectedAgesBlock (2026-08-24): a `let` below its reader is
  // a temporal-dead-zone throw waiting for the first call that reaches it.
  let audits = [];
  let mergedFindings = [];
  let mergeStats = { bySource: {}, duplicates: 0 };
  // One entry per merged finding, filled the moment the repair pass settles —
  // see resolveFindingOutcomes — and re-settled after the diff pass
  // (settleLedgerAfterDiff). Empty only while the repair pass has not run.
  let findingLedger = [];
  let proofread = '';
  let lectorFindings = [];
  let lectorApplied = [];
  let lectorDropped = [];
  // Finding-shaped lines the parser could not read — counted, never skipped in
  // silence (parseLectorLines).
  let lectorUnparsed = [];
  let diffReview = '';
  let diffFindings = [];
  let diffApplied = [];
  let diffDropped = [];
  let diffUnparsed = [];
  // The prompts the diff and the lector were actually SENT. Hoisted out of
  // their try blocks so a FAILED round can store the prompt too: a round that
  // threw is exactly the one whose input needs reading, and the catch below
  // cannot see a `const` declared inside the try.
  let diffPromptSent = '';
  let lectorPromptSent = '';
  let repetition = null;
  let wordBudget = null;

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
    findingLedger: findingLedger.slice(),
    proofread,
    lectorFindings: lectorFindings.slice(),
    lectorApplied: lectorApplied.slice(),
    lectorDropped: lectorDropped.slice(),
    diffReview,
    diffFindings: diffFindings.slice(),
    diffApplied: diffApplied.slice(),
    diffDropped: diffDropped.slice(),
    repetition,
    wordBudget,
    partial: true,
    // IN FLIGHT (2026-09-14). Whether a model step is RUNNING right now.
    // `beginStep()` publishes the state so far with this set; the publish()
    // after the step clears it. The join no longer has a deadline to grace, so
    // this is now diagnostic: it says whether a slow join is waiting on a call
    // or on nothing.
    inFlight: stepInFlight,
  });
  // Set by beginStep(), cleared by every publish() that follows a completed step.
  let stepInFlight = false;
  const publish = () => {
    stepInFlight = false;
    if (typeof opts.onProgress !== 'function') return;
    try { opts.onProgress(snapshot()); } catch (e) {
      log.warn(`⚠️ [TEXT-REFINE] onProgress threw (${e.message}) — ignored`);
    }
  };
  // Announce that a model step is starting: same snapshot, flagged in flight.
  const beginStep = () => {
    stepInFlight = true;
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
    // null = the model's OWN limit, never a hand-picked number (owner rule: no
    // output caps). A reasoning model spends the budget on reasoning tokens
    // first, so an undersized cap does not truncate the fault list, it returns
    // ZERO visible text — the measured failure of deepseek-v4-pro and
    // qwen3.8-max as auditors at 16384 (models.js, 2026-08-27), and the trap a
    // fixed 12000 would have set for the blind grok auditor.
    try {
      // gemini-3.1-pro occasionally returns an empty body (see models.js) — one
      // retry, same call; a second empty is reported as a failed audit.
      let r = await callTextModelStreaming(prompt, null, null, modelKey, { usageLabel: label });
      if (!String(r.text || '').trim()) {
        log.warn(`⚠️ [TEXT-AUDIT/${source}] ${modelKey} returned empty output — retrying once`);
        r = await callTextModelStreaming(prompt, null, null, modelKey, { usageLabel: label });
      }
      const raw = String(r.text || '').trim();
      const elapsedMs = Date.now() - t0;
      // A cut fault list is not a shorter fault list: a truncated audit is
      // FAILED and its findings stay out of the merge (textReplyGuard.js).
      if (r.truncation?.suspected) {
        const error = `audit reply ${describeTruncation(r.truncation)} — findings unusable`;
        log.warn(`⚠️ [TEXT-AUDIT/${source}] ${modelKey}: ${error}`);
        return { source, modelKey, ok: false, error, modelId: r.modelId || TEXT_MODELS[modelKey].modelId, raw, prompt, elapsedMs, truncation: r.truncation,
          usage: { input_tokens: r.usage?.input_tokens || 0, output_tokens: r.usage?.output_tokens || 0 } };
      }
      log.info(`🔎 [TEXT-AUDIT/${source}] ${modelKey}: ${countFaults(raw)} fault(s) ${JSON.stringify(faultsByCategory(raw))} in ${(elapsedMs / 1000).toFixed(0)}s`);
      return {
        source, modelKey, ok: raw.length > 0,
        modelId: r.modelId || TEXT_MODELS[modelKey].modelId,
        raw, prompt, faults: countFaults(raw), byCategory: faultsByCategory(raw), elapsedMs,
        usage: { input_tokens: r.usage?.input_tokens || 0, output_tokens: r.usage?.output_tokens || 0 },
        cost: r.usage?.direct_cost ?? calculateTextCost(r.modelId || TEXT_MODELS[modelKey].modelId, r.usage || {}),
      };
    } catch (e) {
      log.warn(`⚠️ [TEXT-AUDIT/${source}] failed (${e.message}) — its findings are missing from the merge`);
      return { source, modelKey, ok: false, error: e.message, prompt, elapsedMs: Date.now() - t0 };
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
  beginStep();   // the audits are the first model step — see the join's grace period
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
    withDeadline(runAudit('arc-informed', auditModel, buildTextAuditPrompt(storyData, current, arc, { arcHints }), 'text_audit'), 'arc-informed'),
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
  const runRepairPass = async (findings, base, kind = 'repair') => {
    // The findings arrive STRUCTURED and the prompt text is rebuilt from their
    // own FAULT lines — the same verbatim lines mergeAuditFindings joined. That
    // is what lets the ledger below name each finding's outcome: a pass handed
    // a blob of text can count its lines and nothing else.
    const findingsText = findings.map(f => f.line).join('\n');
    let prompt = buildTextRefinePrompt(storyData, base, findingsText, arc, { arcHints });
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
    // silent "nothing to do" — the caller keeps the text it was given.
    const r = await callTextModelStreaming(prompt, null, null, repairModel, { usageLabel: kind === 'repair' ? usageLabel : `${usageLabel}_${kind}` });
    const elapsedMs = Date.now() - t0;
    if (r.truncation?.suspected) {
      throw new Error(`reply ${describeTruncation(r.truncation)} — rewrites unusable`);
    }
    const parsed = parseRefinedText(r.text || '', expected);
    // Omission is the CONTRACT: only rewritten pages come back, everything else
    // keeps its current text.
    // Same delimiter leak as the beats writer: a rewritten page can come back
    // with the model's "---" page rule glued to its last line, and that ships
    // under the illustration. See stripTrailingSeparator (sceneMetadata.js).
    const byPage = new Map(parsed.pages.map(p => [p.pageNumber, stripTrailingSeparator(p.text)]));
    const strayPages = parsed.pages.map(p => p.pageNumber).filter(n => !expected.includes(n));
    const next = base.map(p => ({ ...p, text: byPage.get(p.pageNumber) || p.text }));
    const changedPages = next.filter((p, idx) => p.text !== base[idx].text).map(p => p.pageNumber);
    const returnedPages = parsed.pages.map(p => p.pageNumber);
    const findingOutcomes = resolveFindingOutcomes(findings, base, changedPages, returnedPages);
    for (const f of unresolvedFindings(findingOutcomes)) {
      log.warn(`⚠️ [TEXT-REPAIR/${kind}] UNANSWERED [${f.category}] p${f.pageNumber ?? '?'} — ${f.reason}: ${f.text}`);
    }
    // THE PASS'S OWN REPORT, CHECKED AGAINST THE DIFF. A whole-page pass says
    // what it did in two ways: the page blocks it chose to return, and prose
    // this file deliberately does not parse. The block list IS checkable —
    // against the text that came back.
    //   returnedIdentical  it returned the page as a rewrite and changed nothing
    //   changedUnasked     it rewrote a page no finding named
    // Neither kills the run; both were invisible, and on the reference run the
    // second was three of seventeen pages.
    const askedPages = new Set(findings.map(f => f.pageNumber).filter(n => n != null));
    const returnedIdentical = returnedPages.filter(n => !changedPages.includes(n));
    const changedUnasked = changedPages.filter(n => !askedPages.has(n));
    if (returnedIdentical.length) {
      log.warn(`⚠️ [TEXT-REPAIR/${kind}] returned page(s) ${returnedIdentical.join(', ')} as rewritten and the text is unchanged — a claim the diff refutes`);
    }
    if (changedUnasked.length) {
      log.info(`✏️ [TEXT-REPAIR/${kind}] also rewrote page(s) ${changedUnasked.join(', ')}, which no finding named`);
    }
    return {
      next,
      entry: {
        round: rounds.length + 1,
        kind,
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
        findingsCount: findings.length,
        returnedPages,
        strayPages,
        changedPages,
        // The two diff-checked halves of this pass's own report (above).
        returnedIdentical,
        changedUnasked,
        // WHAT THIS ROUND APPLIED, in ITS unit.
        //
        // The whole-page passes (repair / repetition_fix / length_fix) rewrite
        // WHOLESALE: the findings go in as prose and whole page blocks come
        // back, so there is no per-finding applier to count the way the lector
        // and the diff have one (applyLectorFindings, which is where
        // appliedCount/droppedCount were born). Leaving the key unset made the
        // stored `textRefineReport.roundTrace` report `appliedCount: null` for
        // the single most expensive text call in the chain — on staging
        // job_1789506283204_3kxqshifx, $0.94 for round 1 with no record of what
        // it closed, beside rounds 2 and 3 reporting 7 and 0.
        //
        // The comparable unit for a wholesale rewrite is the page: how many
        // pages this round actually changed. `null` therefore keeps its one
        // meaning across the trace — "this round recorded nothing" — instead of
        // meaning "not applicable" on some rounds and "failed" on others.
        // Nothing is inferred: a returned page whose text is identical to the
        // base is not counted, exactly as a dropped lector finding is not.
        appliedCount: changedPages.length,
        // EVERY FINDING THIS PASS HELD, RESOLVED. The page count above says how
        // much the pass rewrote; this says what became of each thing it was
        // asked to fix. See resolveFindingOutcomes for what the outcomes mean
        // and, just as importantly, what they do not claim.
        findingOutcomes,
        unresolvedCount: unresolvedFindings(findingOutcomes).length,
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

  let repairEntry = null;
  try {
    beginStep();
    const { next, entry } = await runRepairPass(merged.findings, current);
    rounds.push(entry);
    repairEntry = entry;
    current = next;
    findingLedger = entry.findingOutcomes;
    publish();
    log.info(`✍️  [TEXT-REPAIR] ${repairModel} answered ${entry.findingsCount - entry.unresolvedCount}/${entry.findingsCount} finding(s), rewrote page(s) ${entry.changedPages.join(', ') || 'none'}`);
  } catch (err) {
    // Non-blocking like every step: the lector still reads the writer's text.
    rounds.push({ round: rounds.length + 1, kind: 'repair', ok: false, modelKey: repairModel, error: err.message });
    // A failed pass answers nothing, and that is an OUTCOME, not an absence:
    // the ledger stays total even when the only step that reads the merged
    // findings never ran.
    findingLedger = merged.findings.map(f => ({
      ...f, outcome: FINDING_OUTCOME.PASS_FAILED, reason: `the repair pass failed (${err.message})`,
    }));
    log.warn(`⚠️ [TEXT-REPAIR] failed (${err.message}) — all ${merged.findings.length} merged finding(s) are unanswered`);
    publish();
  }
  // THE LEDGER IS TOTAL, and it says so out loud. Anything short of one entry
  // per merged finding is a plumbing defect in this file, not a model outcome.
  if (findingLedger.length !== merged.findings.length) {
    log.error(`❌ [TEXT-REPAIR] finding ledger holds ${findingLedger.length} of ${merged.findings.length} merged finding(s) — the accounting is not total`);
  }
  {
    const open = unresolvedFindings(findingLedger);
    if (open.length) {
      log.warn(`🧾 [TEXT-REPAIR] ${open.length}/${findingLedger.length} merged finding(s) unanswered: ${open.map(f => `[${f.category}] p${f.pageNumber ?? '?'} — ${f.reason}`).join('; ')}`);
    } else if (findingLedger.length) {
      log.info(`🧾 [TEXT-REPAIR] all ${findingLedger.length} merged finding(s) reached a rewritten page`);
    }
  }

  // ── CROSS-PAGE REPETITION — right after the repair, before the diff ──────────
  //
  // The repair pass is the only step that writes whole pages, so it is the only
  // step that can put one passage on two pages (the diff and the lector
  // substitute quoted spans inside a page). Checked here, mechanically, and
  // fixed by EXACTLY ONE fed-back corrective pass — never a loop. Sitting
  // before the diff means the diff reviews the corrective rewrite as well and
  // the lector proofs its result. A still-tripping result ships with a WARN:
  // gates are guidelines, a paid run is never killed for this.
  const REP_MIN = MODEL_DEFAULTS.textRepetitionMinShingles;
  const summarize = hits => hits.map(h => ({ pages: h.pages, sharedCount: h.sharedCount, shingles: h.shingles.slice(0, 40), passages: h.passages }));
  let repetitionEntry = null;
  {
    const hits = findRepeatedPassages(current, REP_MIN);
    repetition = { minShingles: REP_MIN, pairs: summarize(hits), correctivePassRan: false, resolved: hits.length === 0, remaining: [], cost: 0 };
    if (hits.length) {
      log.warn(`🔁 [TEXT-REPETITION] ${hits.map(h => `p${h.pages[0]}/p${h.pages[1]} (${h.sharedCount} shared)`).join(', ')} — one corrective pass`);
      try {
        beginStep();
        const { next, entry } = await runRepairPass(parseFaultLines(buildRepetitionFindings(hits, current)), current, 'repetition_fix');
        rounds.push(entry);
        repetitionEntry = entry;
        current = next;
        repetition.correctivePassRan = true;
        repetition.cost = entry.cost || 0;
        log.info(`🔁 [TEXT-REPETITION] corrective pass rewrote page(s) ${entry.changedPages.join(', ') || 'none'} — $${(entry.cost || 0).toFixed(4)}`);
      } catch (err) {
        rounds.push({ round: rounds.length + 1, kind: 'repetition_fix', ok: false, modelKey: repairModel, error: err.message });
        log.warn(`⚠️ [TEXT-REPETITION] corrective pass failed (${err.message})`);
      }
      const after = findRepeatedPassages(current, REP_MIN);
      repetition.remaining = summarize(after);
      repetition.resolved = after.length === 0;
      if (!repetition.resolved) {
        for (const h of after) {
          log.warn(`⚠️ [TEXT-REPETITION] STILL DUPLICATED after the corrective pass: pages ${h.pages[0]} and ${h.pages[1]} share ${h.sharedCount} 5-word sequences: ${h.passages.map(x => `"${x}"`).join('; ')} — shipping as is`);
        }
      }
      publish();
    }
  }

  // ── WORD BUDGET, RE-MEASURED (2026-09-11) ──────────────────────────────────
  //
  // The counter above runs ONCE, on the writer's text, BEFORE the repair pass —
  // and nothing measured the result. Two failures followed on
  // job_1789147573901_m3uam0nxi, both invisible in the stored report:
  //
  //   1. The repairer reported closures it had not made. Its own ledger says
  //      "fixed on p10 — 65 words" (the shipped page is 126) and "fixed on p18
  //      — 82 words" (125). A self-report was taken as the outcome.
  //   2. A page INSIDE the budget was pushed outside it by the rewriting. p12
  //      went 82 → 112 words, past the tolerance, and drew no finding because
  //      it was inside the budget when the only measurement ran.
  //
  // So: measure again on the text as the whole-page passes left it, and give a
  // page that is still out ONE fed-back corrective pass — never a loop, the
  // same shape as the repetition check above, and placed before the diff so the
  // diff reviews this rewrite too.
  //
  // The findings are the counter's own, so the asymmetric tolerance and the
  // "keep every action, line of dialogue and feeling. Losing one is a fault"
  // wording travel with them: this re-measures, it does not tighten. A page
  // that is still over after the corrective pass SHIPS with a WARN — a paid run
  // is never killed for length, and forcing the cut is what deleted causality
  // before (2026-09-07).
  {
    const stillRaw = buildWordBudgetFindings(current, storyData?.languageLevel);
    wordBudget = {
      before: parseFaultLines(counterRaw || '').length,
      after: parseFaultLines(stillRaw || '').length,
      correctivePassRan: false,
      resolved: !stillRaw,
      remaining: [],
      counts: measurePages(current),
      cost: 0,
    };
    if (stillRaw) {
      const lines = stillRaw.split(/\n/);
      log.warn(`🔢 [TEXT-COUNTER] ${lines.length} page(s) still outside the word budget after the whole-page passes — one corrective pass`);
      try {
        beginStep();
        const { next, entry } = await runRepairPass(parseFaultLines(stillRaw), current, 'length_fix');
        rounds.push(entry);
        current = next;
        wordBudget.correctivePassRan = true;
        wordBudget.cost = entry.cost || 0;
        log.info(`🔢 [TEXT-COUNTER] corrective pass rewrote page(s) ${entry.changedPages.join(', ') || 'none'} — $${(entry.cost || 0).toFixed(4)}`);
      } catch (err) {
        rounds.push({ round: rounds.length + 1, kind: 'length_fix', ok: false, modelKey: repairModel, error: err.message });
        log.warn(`⚠️ [TEXT-COUNTER] corrective pass failed (${err.message})`);
      }
      const afterRaw = buildWordBudgetFindings(current, storyData?.languageLevel);
      wordBudget.after = parseFaultLines(afterRaw || '').length;
      wordBudget.remaining = afterRaw ? afterRaw.split(/\n/) : [];
      wordBudget.resolved = !afterRaw;
      wordBudget.counts = measurePages(current);
      for (const line of wordBudget.remaining) {
        log.warn(`⚠️ [TEXT-COUNTER] STILL OUTSIDE the budget after the corrective pass: ${line} — shipping as is`);
      }
      publish();
    }
  }

  // ── THE DIFF PASS — between the repair and the lector (2026-09-06) ──────────
  //
  // WHAT IT IS: the repair pass is the only step that rewrites whole pages, and
  // nothing read its output for damage. The lector does read the final text, but
  // it reads it COLD — it cannot know what the page said before, so a rewrite
  // that swapped a fact for a plausible other fact reads as ordinary prose. This
  // pass sees exactly the pages the repair changed, each as BEFORE and AFTER,
  // and judges only the change.
  //
  // MEASURED (job_1788681313413_xqmtk2gcs, 2026-09-06): the gemini-3.1-pro cold
  // read missed two rewrite-introduced corruptions across two runs, $0.26/165s
  // each. This pass caught BOTH for $0.019/69s — 2/2 real catches, 1 soft false
  // positive, every span located character-for-character, zero quote-absent
  // drops. gemini on the SAME diff task caught 0/2 with ~6 false positives, the
  // reverse of its 4/4 on the German cold read: cold read and diff are different
  // tasks and rank models differently. Hence two passes, not one — this ADDS to
  // the lector and does not replace it (models.js textDiffModel).
  //
  // ORDER — BEFORE the lector, and it must be. Its findings quote the repair
  // pass's AFTER text; the lector rewrites that text, so running it second would
  // invalidate its own quotes and every finding would drop as `quote-absent`.
  // Running it first also gives the lector the corrected text to proof.
  //
  // NO CONFLICT LOGIC IS ADDED. Each pass applies its own findings in its own
  // applyLectorFindings call, so an overlap can only happen INSIDE one pass, and
  // that path already answers it: first finding wins, second dropped as
  // `overlap`. Across passes the lector prompt is built from the already-
  // corrected text, so it cannot quote a span this pass has replaced.
  //
  // Non-blocking like every step — but LOUD. log.error, not warn: a total
  // outage of this pass would otherwise be invisible, which is exactly the trap
  // the session found. (The lector's own catch below logs at warn only; left as
  // it is rather than changed unasked — noted in the report.)
  try {
    // Every page either whole-page pass rewrote. BEFORE = the writer's text
    // (nothing changes a page before the repair), AFTER = the text as the
    // corrective pass left it.
    const changedPages = [...new Set([...(repairEntry?.changedPages || []), ...(repetitionEntry?.changedPages || [])])];
    // THE LEDGER (owner decision 2026-09-23): per page, every finding a
    // whole-page pass held for it or for a page next to it. Without it a
    // deliberate fix reads as a dropped fact and the diff pass restores it
    // (buildTextDiffPrompt). The neighbours are there because a repair answers
    // a finding where the fix belongs, not where the auditor filed it: on
    // job_1790100385959_1nitlympp a p17 TRANSITION finding (the picture shows
    // the wall, the text moved the egg to the tree) was fixed on p16, and the
    // diff pass reverted it.
    const answered = rounds
      .filter(r => r.ok && WHOLE_PAGE_PASS_KINDS.has(r.kind))
      .flatMap(r => r.findingOutcomes || []);
    const pairs = current
      .filter(p => changedPages.includes(p.pageNumber))
      .map(p => ({
        pageNumber: p.pageNumber,
        before: original.find(o => o.pageNumber === p.pageNumber)?.text,
        after: p.text,
        findings: answered
          .filter(f => f.pageNumber != null && Math.abs(f.pageNumber - p.pageNumber) <= 1)
          .map(f => ({ pageNumber: f.pageNumber, category: f.category, text: f.text })),
      }));
    const diffPrompt = pairs.length ? buildTextDiffPrompt(storyData, pairs) : null;
    diffPromptSent = diffPrompt || '';
    if (diffPrompt && TEXT_MODELS[diffModel]) {
      beginStep();
      const t0 = Date.now();
      // null = the model's own limit (owner rule: no output caps).
      // temperature 0, same reason as the lector: it must quote, not paraphrase.
      let dr = await callTextModelStreaming(diffPrompt, null, null, diffModel, { temperature: 0, usageLabel: 'text_diff' });
      if (!String(dr.text || '').trim()) {
        log.warn(`⚠️ [TEXT-DIFF] ${diffModel} returned empty output — retrying once`);
        dr = await callTextModelStreaming(diffPrompt, null, null, diffModel, { temperature: 0, usageLabel: 'text_diff' });
      }
      // A cut finding list would apply only the findings that fit — throw into
      // the catch below, which keeps the text as the repair pass left it.
      if (dr.truncation?.suspected) throw new Error(`diff reply ${describeTruncation(dr.truncation)} — findings unusable`);
      diffReview = String(dr.text || '').trim();
      // The SAME parser and the SAME applier as the lector — the output contract
      // is identical by design, so there is no parallel apply path.
      const diffParse = parseLectorLines(diffReview);
      diffFindings = diffParse.findings;
      diffUnparsed = diffParse.unparsed;
      for (const u of diffUnparsed) {
        log.warn(`⚠️ [TEXT-DIFF] unreadable finding line — ${u.reason}: ${u.line}`);
      }
      const result = applyLectorFindings(current, diffFindings);
      // What each applied correction put back from the writer's page — the
      // input settleLedgerAfterDiff needs to keep the ledger true.
      diffApplied = result.applied.map(a => ({
        ...a,
        restored: restoredSentences(
          a.correction,
          original.find(o => o.pageNumber === a.pageNumber)?.text,
          current.find(c => c.pageNumber === a.pageNumber)?.text,
        ),
      }));
      diffDropped = result.dropped;
      for (const d of diffDropped) {
        const why = d.reason === 'quote-absent'
          ? `the quoted words are not on page ${d.pageNumber}`
          : d.reason === 'overlap'
            ? `its span overlaps a correction already applied to page ${d.pageNumber}`
            : `page ${d.pageNumber} is not in this story`;
        log.warn(`⚠️ [TEXT-DIFF] dropped "${d.quote}" — ${why}`);
      }
      const next = result.pages;
      const diffChanged = next.filter((p, idx) => p.text !== current[idx].text).map(p => p.pageNumber);
      rounds.push({
        round: rounds.length + 1,
        kind: 'diff',
        ok: true,
        modelKey: diffModel,
        prompt: diffPrompt,
        modelId: dr.modelId || TEXT_MODELS[diffModel].modelId,
        elapsedMs: Date.now() - t0,
        reviewedPages: pairs.map(p => p.pageNumber),
        usage: { input_tokens: dr.usage?.input_tokens || 0, output_tokens: dr.usage?.output_tokens || 0 },
        cost: dr.usage?.direct_cost ?? calculateTextCost(dr.modelId || TEXT_MODELS[diffModel].modelId, dr.usage || {}),
        rawResponse: diffReview.slice(0, 40000),
        findings: diffFindings.map(f => ({ pageNumber: f.pageNumber, quote: f.quote, correction: f.correction })),
        appliedCount: diffApplied.length,
        droppedCount: diffDropped.length,
        droppedFindings: diffDropped.map(d => ({ pageNumber: d.pageNumber, quote: d.quote, reason: d.reason })),
        // Same tripwire as the lector: a finding-shaped line the parser could
        // not read is counted, never skipped in silence.
        unparsedCount: diffUnparsed.length,
        unparsedLines: diffUnparsed,
        changedPages: diffChanged,
        pages: next.map((p, idx) => ({
          pageNumber: p.pageNumber,
          before: current[idx].text,
          after: p.text,
          original: original[idx].text,
          sceneIntent: p.sceneIntent,
        })),
      });
      current = next;
      findingLedger = settleLedgerAfterDiff(findingLedger, diffApplied);
      for (const f of findingLedger.filter(x => x.outcome === FINDING_OUTCOME.REWRITE_RESTORED)) {
        log.warn(`🧾 [TEXT-DIFF] [${f.category}] p${f.pageNumber} is no longer counted as answered — ${f.reason}`);
      }
      publish();
      log.info(`🔬 [TEXT-DIFF] ${diffModel}: ${pairs.length} rewritten page(s) reviewed, ${diffFindings.length} finding(s), ${diffApplied.length} applied to page(s) ${diffChanged.join(', ') || 'none'}, ${diffDropped.length} dropped${diffUnparsed.length ? `, ${diffUnparsed.length} unreadable` : ''}, in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } else if (!pairs.length) {
      log.info('🔬 [TEXT-DIFF] the repair pass rewrote nothing — no diff to review');
    } else {
      log.error(`❌ [TEXT-DIFF] not run: ${diffPrompt ? `unknown model "${diffModel}"` : 'template unavailable'} — rewrite damage is unchecked`);
    }
  } catch (de) {
    log.error(`❌ [TEXT-DIFF] failed (${de.message}) — rewrite damage is unchecked, text kept as the repair pass left it`);
    rounds.push({ round: rounds.length + 1, kind: 'diff', ok: false, modelKey: diffModel, error: de.message, prompt: diffPromptSent, rawResponse: diffReview });
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
    lectorPromptSent = lectorPrompt || '';
    if (lectorPrompt && TEXT_MODELS[lectorModel]) {
      beginStep();
      const t0 = Date.now();
      // null = the model's own limit (owner rule: no output caps). A finding
      // list is a few hundred tokens — the cost of this call is decided by the
      // output CONTRACT, not by the ceiling.
      // temperature 0: the A/B measured this prompt at 0, and a lector must not
      // paraphrase the page it quotes.
      // reasoning effort 'medium': measured 2026-09-06 on job_1788380714660_4p9mr11xszu
      // (de-ch, 16 pages, 4 CORE faults). Default (no key) burned 12,764 reasoning
      // tokens / $0.1621 / 84s; 'medium' 7,135 / $0.0948 / 46s for the same 4/4 CORE
      // catch. 'low' (1,696 / $0.0281) collapsed to 0/4 CORE and 3-4 false positives,
      // so recall is a direct function of reasoning budget — do NOT lower this further.
      const LECTOR_OPTS = { temperature: 0, usageLabel: 'text_lector', reasoning: { effort: 'medium' } };
      let lr = await callTextModelStreaming(lectorPrompt, null, null, lectorModel, LECTOR_OPTS);
      if (!String(lr.text || '').trim()) {
        log.warn(`⚠️ [LECTOR] ${lectorModel} returned empty output — retrying once`);
        lr = await callTextModelStreaming(lectorPrompt, null, null, lectorModel, LECTOR_OPTS);
      }
      // Same rule as the diff: a cut finding list is not applied — the catch
      // below keeps the text as the repair pass left it.
      if (lr.truncation?.suspected) throw new Error(`lector reply ${describeTruncation(lr.truncation)} — findings unusable`);
      proofread = String(lr.text || '').trim();
      const lectorParse = parseLectorLines(proofread);
      lectorFindings = lectorParse.findings;
      lectorUnparsed = lectorParse.unparsed;
      for (const u of lectorUnparsed) {
        log.warn(`⚠️ [LECTOR] unreadable finding line — ${u.reason}: ${u.line}`);
      }
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
        prompt: lectorPrompt,
        modelId: lr.modelId || TEXT_MODELS[lectorModel].modelId,
        elapsedMs: Date.now() - t0,
        usage: { input_tokens: lr.usage?.input_tokens || 0, output_tokens: lr.usage?.output_tokens || 0 },
        cost: lr.usage?.direct_cost ?? calculateTextCost(lr.modelId || TEXT_MODELS[lectorModel].modelId, lr.usage || {}),
        rawResponse: proofread.slice(0, 40000),
        findings: lectorFindings.map(f => ({ pageNumber: f.pageNumber, quote: f.quote, correction: f.correction })),
        appliedCount: lectorApplied.length,
        droppedCount: lectorDropped.length,
        droppedFindings: lectorDropped.map(d => ({ pageNumber: d.pageNumber, quote: d.quote, reason: d.reason })),
        // Finding-shaped lines this reply offered that the parser could not
        // read. Zero on every measured run; a non-zero one means the reply and
        // the applied count disagree, and the difference is now visible.
        unparsedCount: lectorUnparsed.length,
        unparsedLines: lectorUnparsed,
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
      log.info(`✍️  [LECTOR] ${lectorModel}: ${lectorFindings.length} finding(s), ${lectorApplied.length} applied to page(s) ${changedPages.join(', ') || 'none'}, ${lectorDropped.length} dropped${lectorUnparsed.length ? `, ${lectorUnparsed.length} unreadable` : ''}, in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  } catch (le) {
    log.warn(`⚠️ [LECTOR] failed (${le.message}) — text kept as the repair pass left it`);
    // PARITY WITH THE DIFF (2026-09-20). This catch used to push no round at
    // all, so a lector that threw left no trace in `rounds` — the stored trace
    // showed a chain that simply had no lector step, indistinguishable from one
    // where the template or the model was absent. The diff's catch has always
    // recorded its failure; both do now.
    rounds.push({ round: rounds.length + 1, kind: 'lector', ok: false, modelKey: lectorModel, error: le.message, prompt: lectorPromptSent, rawResponse: proofread });
    publish();   // clears the in-flight flag the join's grace period reads
  }

  // THE COUNTER, ON THE TEXT THAT SHIPS (2026-09-23). The re-measure above runs
  // before the diff and the lector, and both edit pages: on
  // job_1790100385959_1nitlympp the diff put back p4's cut sentences (69 → 92
  // words) after the last count. Measured only — no further pass; a page out of
  // budget here ships with a WARN like every other length outcome.
  if (wordBudget) {
    const shippedRaw = buildWordBudgetFindings(current, storyData?.languageLevel);
    wordBudget.shipped = {
      counts: measurePages(current),
      remaining: shippedRaw ? shippedRaw.split(/\n/) : [],
    };
    for (const line of wordBudget.shipped.remaining) {
      log.warn(`⚠️ [TEXT-COUNTER] SHIPS OUTSIDE the budget after the diff and the lector: ${line}`);
    }
  }

  const changed = current
    .map((p, idx) => (p.text !== original[idx].text ? p.pageNumber : null))
    .filter(n => n !== null);

  // A15 — PLAN vs SHIPPED TEXT, measured for free after the chain.
  //
  // The plan line is handed to the refiner as what the page's prose may not
  // contradict, and it is NEVER re-derived afterwards: the picture is already
  // drawn from it, so it must stay as it was. That is correct for the picture
  // and silent for the record — a refined page can drop a character the plan
  // stages in frame and nothing says so, leaving a stored plan line that
  // disagrees with the text that ships beside it.
  //
  // No model call: the who-in-frame column of the plan line is re-counted with
  // the same `namesIn` the plan counters use. A name the plan stages, the
  // ORIGINAL text carried and the refined text no longer carries is reported.
  // A page the refiner left alone can never appear here.
  const planTextDrift = computePlanTextDrift(storyData, original, current);
  if (planTextDrift.length > 0) {
    log.warn(`⚠️ [TEXT-REFINE] plan/text drift on page(s) ${planTextDrift.map(d => d.pageNumber).join(', ')} — the stored plan line stages a character the refined text dropped; the plan is pre-refine by design and is not re-derived`);
  }

  return {
    pages: current, original, rounds, changed, planTextDrift,
    audits, mergedFindings, mergeStats, findingLedger,
    proofread, lectorFindings, lectorApplied, lectorDropped,
    diffReview, diffFindings, diffApplied, diffDropped,
    repetition, wordBudget,
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
  // The brief as every text-stage reader gets it — the SAME specs the writer
  // was given (sceneMetadata.buildTextStagePictureSpecs, 2026-09-23). Built over
  // the whole book at once: a repeated look is only recognised in page order.
  const { buildTextStagePictureSpecs } = require('./sceneMetadata');
  const withText = (sceneLike || []).filter(s => s && (s.text || '').trim());
  const specByPage = buildTextStagePictureSpecs(
    withText.map(s => ({ pageNumber: s.pageNumber, brief: s.sceneDescription || s.description || '' }))
  );
  return withText
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
      // what the events are. The brief arrives trimmed (METADATA, ids, repeated
      // looks) and the template is explicit that appearance
      // and staging are not the prose's business.
      const sceneBrief = specByPage.get(s.pageNumber) || '';
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

// ── THE PIPELINE'S JOIN ──────────────────────────────────────────────────────
//
// Extracted here (2026-09-14) because the join lives deep inside
// storyJobPipeline's generation function and could not be tested there.
//
// NO DEADLINE (owner, 2026-09-14). The join used to race the refine chain
// against a budget and take whatever had been published when the timer fired.
// Nothing cancels the refine when that race is lost, so the chain runs to
// completion and bills in full either way (staging job_1789348171785_9oxos7dwv
// billed $1.01 of text_refine AFTER its join had given up) — the deadline only
// ever discarded paid work, and with it the text audit's checks, the
// text/picture alignment one among them. The join now WAITS: the chain is
// never truncated, and every downstream consumer — the book audit inside the
// repair pipeline first among them — reads the FINAL refined text.
//
// It cannot wait forever: every model call in the chain is bounded by
// textModels' own streaming ceiling (>=1500s) plus its 120s inactivity abort,
// each audit additionally by AUDIT_DEADLINE_MS (900s), and every step catches
// its own failure, so the chain always settles. What is left is a LATENCY
// question, and that is answered with a warning, not a kill (a gate ships with
// a warning; it never destroys a paid run): once the wait passes the budget
// below, the join logs how long it has been waiting and keeps waiting.
const TEXT_REFINE_JOIN_BASE_MS = 600000;
const TEXT_REFINE_JOIN_PER_PAGE_MS = 10000;
const TEXT_REFINE_JOIN_FREE_PAGES = 10;

/**
 * After how long an unfinished refine chain is worth a warning. Measured
 * chains run 400-600s, with 743/770/841/878s all seen in one month, so this is
 * "slower than usual", not "too slow to keep".
 * @param {number} pageCount      pages in the book
 * @param {string|number} [envOverride]  TEXT_REFINE_JOIN_WARN_MS, wins outright
 * @returns {number} ms
 */
function computeTextRefineJoinWarnMs(pageCount, envOverride) {
  const override = Number(envOverride);
  if (override) return override;
  const pages = Number(pageCount) || 0;
  return TEXT_REFINE_JOIN_BASE_MS
    + Math.max(0, pages - TEXT_REFINE_JOIN_FREE_PAGES) * TEXT_REFINE_JOIN_PER_PAGE_MS;
}

/**
 * What the join ships. Pure.
 * @param {object|null} refined  the refiner's own result — null if the chain failed
 * @param {object|null} partial  the last snapshot the refiner published
 * @param {boolean} salvage      true when no complete result is available
 * @returns {{usable: object|null, source: 'complete'|'failed'|'partial'|'original'}}
 */
function selectJoinResult(refined, partial, salvage) {
  if (!salvage) return { usable: refined || null, source: refined ? 'complete' : 'failed' };
  if (partial?.changed?.length) return { usable: partial, source: 'partial' };
  return { usable: partial || null, source: 'original' };
}

/**
 * THE JOIN ITSELF — await the chain, never truncate it.
 *
 * Resolves only once the refiner has settled. A chain that outlives
 * `warnAfterMs` is reported through `onSlow` and then still awaited in full,
 * so the result is the COMPLETE run and never an intermediate snapshot. A
 * chain that fails (or, defensively, rejects) salvages the last published
 * snapshot instead of throwing the stage away.
 *
 * @param {Promise<object|null>} promise  startBackgroundRefine's promise
 * @param {function|object|null} getPartial  latest published snapshot, or a getter for it
 * @param {{warnAfterMs?: number, onSlow?: function}} [opts]
 * @returns {Promise<{usable: object|null, source: string, waitedMs: number, slow: boolean}>}
 */
async function awaitTextRefineJoin(promise, getPartial, opts = {}) {
  const t0 = Date.now();
  const warnAfterMs = Number(opts.warnAfterMs) || 0;
  let slow = false;
  let timer = null;
  if (warnAfterMs > 0) {
    // NOT unref'd: an unref'd timer does not keep the loop alive. clearTimeout
    // in the finally is what stops it leaking, and that runs on every branch.
    timer = setTimeout(() => {
      slow = true;
      if (typeof opts.onSlow === 'function') {
        try { opts.onSlow(warnAfterMs); } catch { /* a logging failure never breaks the join */ }
      }
    }, warnAfterMs);
  }
  let refined = null;
  try {
    refined = await promise;
  } catch (e) {
    // startBackgroundRefine already swallows; this is belt-and-braces so a
    // future caller cannot make a polish pass throw a paid story away.
    log.warn(`⚠️ [TEXT-REFINE] join saw a rejected chain (${e.message}) — salvaging the last published snapshot`);
    refined = null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const partial = typeof getPartial === 'function' ? getPartial() : getPartial;
  const sel = selectJoinResult(refined, partial, !refined);
  return { ...sel, waitedMs: Date.now() - t0, slow };
}

/**
 * Did the join lose the WHOLE text-quality gate? Pure — and it decides the log
 * LEVEL, not just the wording (owner, 2026-09-14): nothing published means the
 * two audits, the repair and the lector all failed to apply, including the
 * text/picture MISMATCH check, which ranks as an error the way a lost styled
 * avatar does. A snapshot with rewritten pages is a partial loss — a warning.
 * @param {object|null} partial  the last snapshot the refiner published
 */
function isTotalTextAuditLoss(partial) {
  return !partial?.changed?.length;
}

/**
 * PROJECT THE CHAIN'S RESULT ONTO THE STORY ROW. Pure — no I/O, no clock.
 *
 * Lifted verbatim out of storyJobPipeline.js (2026-09-20) so it can be replayed
 * over a stored run's shape in a test instead of only by running a story.
 *
 * WHEN IT IS CALLED (the guard that used to live here is gone): whenever the
 * chain produced a result AT ALL — a snapshot or a complete return — and NOT
 * only when it rewrote a page. A run that audited 18 pages, found faults and
 * closed none of them used to store nothing, which is precisely the run whose
 * ledger needs reading. "Did not run" stays unstored: the caller passes no
 * `usable` when the chain never started or never published a single snapshot.
 *
 * @param {object} usable   refineStoryText's return, or a published snapshot
 * @param {Map<number,string>} beforeByPage  the pre-refine page text
 * @returns {object} the textRefineReport
 */
function projectTextRefineReport(usable, beforeByPage = new Map()) {
  if (!usable) throw new Error('projectTextRefineReport: no chain result to project');
  const changed = usable.changed || [];
  // EVERY ROUND KEEPS ITS RAW REPLY (owner order 2026-09-23, superseding the
  // 2026-09-20 trim). A whole-page pass's reply was dropped as a duplicate of
  // `analysis` + `pages[].after`, but those are what the PARSER kept: a page
  // block under a heading it could not read, or analysis past the 15k cut,
  // existed nowhere after the run. ~27KB per story, capped at 40k per round.
  return {
    rounds: usable.rounds.length,
    roundTrace: usable.rounds.map(r => ({
      round: r.round,
      kind: r.kind || null,
      ok: r.ok,
      modelKey: r.modelKey || null,
      modelId: r.modelId || null,
      elapsedMs: r.elapsedMs || 0,
      cost: r.cost ?? null,
      changedPages: r.changedPages || [],
      appliedCount: r.appliedCount ?? null,
      droppedCount: r.droppedCount ?? null,
      returnedIdentical: r.returnedIdentical || [],
      changedUnasked: r.changedUnasked || [],
      unparsedCount: r.unparsedCount ?? null,
      unparsedLines: r.unparsedLines || [],
      droppedFindings: r.droppedFindings || [],
      findingOutcomes: (r.findingOutcomes || []).map(f => ({
        pageNumber: f.pageNumber, category: f.category, sources: f.sources || [],
        text: f.text, outcome: f.outcome, reason: f.reason || null,
      })),
      // THE FINDINGS THIS ROUND PARSED, not only the ones it applied. The
      // projection used to drop them, so a diff round's dropped finding could
      // be read while the applied ones could not.
      findings: (r.findings || []).map(f => ({ pageNumber: f.pageNumber, quote: f.quote, correction: f.correction })),
      reviewedPages: r.reviewedPages || [],
      // THE PROMPT THIS ROUND WAS SENT — every round, including a failed one.
      // Only the repair round's prompt was ever stored, so the diff's and the
      // lector's inputs were unreadable after the run.
      prompt: r.prompt || '',
      rawResponse: String(r.rawResponse || ''),
      // WHAT THE ROUND RETURNED, per page. `before` is not stored: for round N
      // it is round N-1's `after`, and for round 1 it is `briefsIn` — storing
      // it would double the bytes for no information.
      pages: (r.pages || []).map(p => ({ pageNumber: p.pageNumber, after: p.after })),
      error: r.error || null,
      analysis: (r.analysis || '').slice(0, 15000),
    })),
    changedPages: changed,
    // A15 — where the (deliberately pre-refine) plan line and the shipped text
    // disagree. Computed free in the chain; projected here because a value the
    // report drops is a measurement nobody can read back.
    planTextDrift: usable.planTextDrift || [],
    repetition: usable.repetition || null,
    audits: (usable.audits || []).map(a => ({
      source: a.source,
      ok: !!a.ok,
      modelKey: a.modelKey || null,
      modelId: a.modelId || null,
      faults: a.faults ?? 0,
      byCategory: a.byCategory || {},
      elapsedMs: a.elapsedMs || 0,
      cost: a.cost ?? null,
      error: a.error || null,
      raw: (a.raw || '').slice(0, 40000),
      // THE PROMPT THIS AUDIT WAS SENT (2026-09-23) — the audits were the one
      // text-chain call whose input could not be read back after a run.
      prompt: a.prompt || '',
    })),
    mergedFindings: (usable.mergedFindings || []).map(f => ({
      pageNumber: f.pageNumber,
      category: f.category,
      text: f.text,
      sources: f.sources,
    })),
    mergeStats: usable.mergeStats || null,
    findingLedger: (usable.findingLedger || []).map(f => ({
      pageNumber: f.pageNumber, category: f.category, sources: f.sources || [],
      text: f.text, outcome: f.outcome, reason: f.reason || null,
    })),
    // Recomputable from the ledger, and recomputed by nobody: the count is the
    // headline the dev panel leads with, and deriving it in the client would be
    // a second implementation of unresolvedFindings.
    unresolvedCount: unresolvedFindings(usable.findingLedger || []).length,
    wordBudget: usable.wordBudget || null,
    proofread: usable.proofread || '',
    lectorFindings: (usable.lectorFindings || []).map(f => ({ pageNumber: f.pageNumber, quote: f.quote, correction: f.correction })),
    lectorApplied: (usable.lectorApplied || []).map(f => ({ pageNumber: f.pageNumber, quote: f.quote, correction: f.correction })),
    lectorDropped: (usable.lectorDropped || []).map(f => ({ pageNumber: f.pageNumber, quote: f.quote, correction: f.correction, reason: f.reason })),
    // THE DIFF'S FOUR, stored the way the lector's four always were. They were
    // returned by the chain and projected by nobody, so the pass that catches
    // rewrite damage was the one pass whose output could not be read back.
    diffReview: usable.diffReview || '',
    diffFindings: (usable.diffFindings || []).map(f => ({ pageNumber: f.pageNumber, quote: f.quote, correction: f.correction })),
    diffApplied: (usable.diffApplied || []).map(f => ({ pageNumber: f.pageNumber, quote: f.quote, correction: f.correction, restored: f.restored || [] })),
    diffDropped: (usable.diffDropped || []).map(f => ({ pageNumber: f.pageNumber, quote: f.quote, correction: f.correction, reason: f.reason })),
    durationMs: usable.rounds.reduce((n, r) => n + (r.elapsedMs || 0), 0),
    model: usable.rounds[0]?.modelId || usable.rounds[0]?.modelKey || null,
    prompt: usable.rounds.find(r => r.kind === 'repair' && r.prompt)?.prompt || '',
    briefsIn: (usable.original || []).map(p => ({ pageNumber: p.pageNumber, brief: p.text || '' })),
    analysis: usable.rounds
      .filter(r => (r.analysis || '').trim())
      .map(r => `--- Round ${r.round} (${r.kind || 'repair'}${r.modelId ? `, ${r.modelId}` : ''}) ---\n${r.analysis.trim()}`)
      .join('\n\n'),
    pages: (usable.pages || [])
      .filter(p => changed.includes(p.pageNumber))
      .map(p => ({
        pageNumber: p.pageNumber,
        before: beforeByPage.get(p.pageNumber) || '',
        after: p.text,
      })),
  };
}

module.exports = {
  refineStoryText,
  runPostAuditTextRound,
  POST_AUDIT_SCOPE_NOTE,
  projectTextRefineReport,
  computePlanTextDrift,
  extractRefinablePages,
  startBackgroundRefine,
  parseFaultLines,
  mergeAuditFindings,
  FINDING_OUTCOME,
  resolveFindingOutcomes,
  unresolvedFindings,
  restoredSentences,
  settleLedgerAfterDiff,
  countPageWords,
  measurePages,
  buildWordBudgetFindings,
  parseLectorFindings,
  parseLectorLines,
  classifyLectorLine,
  quotedSpan,
  applyLectorFindings,
  locateQuote,
  DUPLICATE_OVERLAP,
  normalizeForShingles,
  shinglesOf,
  findRepeatedPassages,
  buildRepetitionFindings,
  SHINGLE_WORDS,
  computeTextRefineJoinWarnMs,
  awaitTextRefineJoin,
  selectJoinResult,
  isTotalTextAuditLoss,
  TEXT_REFINE_JOIN_BASE_MS,
  TEXT_REFINE_JOIN_PER_PAGE_MS,
};

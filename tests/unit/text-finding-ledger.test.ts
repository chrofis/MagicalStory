import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  mergeAuditFindings, resolveFindingOutcomes, unresolvedFindings, FINDING_OUTCOME,
} = require('../../server/lib/textRefine.js');

/**
 * THE RUN THIS IS BUILT ON — staging job_1789584708605_rts4wqupm, 2026-09-17,
 * 18 pages, de-ch, 1st-grade. Its stored textRefineReport says:
 *
 *   mergeStats  { bySource: { 'arc-informed': 18, blind: 1, counter: 1 }, duplicates: 0 }
 *   round 1     repair,  claude-opus,       changedPages 1,3..18   appliedCount null
 *   round 2     diff,    gpt-5.6-luna-pro,  changedPages 11,12,15,17,18  applied 5, dropped 0
 *   round 3     lector,  gemini-3.1-pro,    changedPages []        applied 0, dropped 0
 *
 * The blind auditor's ONE finding was correct and the shipped book still
 * carries the fault. Asked what became of it, the report could not answer: the
 * repair pass is the only step the merged findings are handed to, and it
 * recorded a count going in, a page list coming out, and nothing joining them.
 * A merged finding could be neither applied nor dropped and leave no trace.
 *
 * These are the two auditors' RAW replies from that run, verbatim, plus the
 * word counter's own line. They are the fixture on purpose: the merge and the
 * ledger are asserted on real auditor output, not on invented fault lines.
 */
const ARC_INFORMED_RAW = [
  'FAULT[PULL]: p1 — The text ends with a static description of the autumn smell, leaving nothing open to hook the next page.',
  'FAULT[MISMATCH]: p3 — The text describes the main character kneeling and swallowing, but the picture shows only the object alone in the hollow.',
  'FAULT[ASSUMED]: p3 — The text states the main character knows the object is much too warm before he has touched it.',
  'FAULT[MISMATCH]: p4 — The text states the main character lay flat on the ground, but the picture shows him kneeling.',
  'FAULT[ENTRANCE]: p5 — Two friends arrive exactly where the object is purely by chance while chasing a rolling ball.',
  'FAULT[PULL]: p7 — The text ends on a concluding thought about ownership with nothing left open for the next page.',
  'FAULT[MISMATCH]: p8 — The text describes a friend pointing up and stepping back, but the picture shows him leaning forward looking down.',
  'FAULT[MISMATCH]: p10 — The text says a friend pulled the bag out and chewed until it became flat, but the picture shows an already flat bag.',
  'FAULT[LANGUAGE]: p11 — The sentence doubles the demonstrative.',
  'FAULT[PULL]: p12 — The text ends with a friend simply stepping back from the railing, leaving no open question or hook.',
  'FAULT[CAUSE]: p13 — The bag leaves a friend\'s grip when the rival grabs the object from the main character, with no physical cause linking the two.',
  'FAULT[LOADBEARING]: p13 — The story requires the rival to abandon the object because his hands are cold, but the text omits this reason entirely.',
  'FAULT[PULL]: p14 — The text ends with a conclusion, leaving nothing open to hook the next page.',
  'FAULT[LOADBEARING]: p16 — The story requires all four to press the bundle between them for warmth, but the text sends one ahead and leaves one behind.',
  'FAULT[UNFORCED]: p16 — Nothing closes the option of the main character running ahead while another brings the slow one up the stairs.',
  'FAULT[ASSUMED]: p17 — The text relies on the rival having seen the bundle wrapped, but he had ridden away on page 13 before it was wrapped on page 15.',
  'FAULT[INFERRED]: p17 — The reader must supply why the one who went ahead to keep the path clear failed to stop the rival blocking it.',
  'FAULT[UNFORCED]: p18 — The main character is stated to have no coat left, but his empty coat lies right on the ground beside him.',
  '',
  'FAULTS: 18',
].join('\n');

/** The blind auditor's whole reply. One fault, and it was right. */
const BLIND_RAW = [
  'FAULT[CONTRADICTION]: p13 — The consumable rolls from the bag into the river even though it had already been eaten and the bag left flat.',
  'FAULTS: 1',
].join('\n');

/** The deterministic third source — buildWordBudgetFindings' own line, as stored. */
const COUNTER_RAW =
  'FAULT[LENGTH]: p18 — page has 117 words, budget 25-70 — tighten the wording; keep every action, line of dialogue and feeling. Losing one is a fault.';

/** The 18 pages the chain was given. */
const PAGES = Array.from({ length: 18 }, (_, i) => ({ pageNumber: i + 1, text: `page ${i + 1}` }));

/** Round 1's real changedPages: every page but p2. */
const REPAIR_CHANGED = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

const merged = mergeAuditFindings([
  { source: 'arc-informed', raw: ARC_INFORMED_RAW },
  { source: 'blind', raw: BLIND_RAW },
  { source: 'counter', raw: COUNTER_RAW },
]);

describe('the merge reproduces the stored run', () => {
  it('folds three sources into the same 20 findings, 0 duplicates', () => {
    expect(merged.findings).toHaveLength(20);
    expect(merged.duplicates).toHaveLength(0);
    expect(merged.bySource).toEqual({ 'arc-informed': 18, blind: 1, counter: 1 });
  });

  it('keeps the blind CONTRADICTION as its own finding, not folded into a p13 twin', () => {
    const p13 = merged.findings.filter((f: any) => f.pageNumber === 13);
    expect(p13.map((f: any) => f.category).sort()).toEqual(['CAUSE', 'CONTRADICTION', 'LOADBEARING']);
  });
});

describe('the finding ledger is total', () => {
  const ledger = resolveFindingOutcomes(merged.findings, PAGES, REPAIR_CHANGED);

  it('gives every merged finding exactly one outcome', () => {
    expect(ledger).toHaveLength(merged.findings.length);
    const known = new Set(Object.values(FINDING_OUTCOME));
    for (const f of ledger) expect(known.has(f.outcome)).toBe(true);
  });

  it('gives every non-applied outcome a reason, and no applied one a reason', () => {
    for (const f of ledger) {
      if (f.outcome === FINDING_OUTCOME.PAGE_REWRITTEN) expect(f.reason).toBeNull();
      else expect(String(f.reason || '')).not.toBe('');
    }
  });

  it('resolves the p13 CONTRADICTION instead of losing it silently', () => {
    const c = ledger.find((f: any) => f.pageNumber === 13 && f.category === 'CONTRADICTION');
    expect(c).toBeDefined();
    expect(c.outcome).toBe(FINDING_OUTCOME.PAGE_REWRITTEN);
    expect(c.sources).toEqual(['blind']);
  });

  it('resolves the counter\'s LENGTH finding like any other', () => {
    const l = ledger.find((f: any) => f.category === 'LENGTH');
    expect(l.pageNumber).toBe(18);
    expect(l.outcome).toBe(FINDING_OUTCOME.PAGE_REWRITTEN);
  });

  it('reports nothing unanswered for this run — every finding named a rewritten page', () => {
    expect(unresolvedFindings(ledger)).toHaveLength(0);
  });
});

describe('a finding the pass leaves unanswered is named, never silent', () => {
  it('marks a finding whose page came back unchanged', () => {
    // p2 is the one page round 1 did not rewrite. A fault filed against it
    // would have vanished without a word before this ledger existed.
    const findings = mergeAuditFindings([
      { source: 'blind', raw: 'FAULT[IDLE]: p2 — a promise no later page acts on.' },
    ]).findings;
    const [entry] = resolveFindingOutcomes(findings, PAGES, REPAIR_CHANGED);
    expect(entry.outcome).toBe(FINDING_OUTCOME.PAGE_UNCHANGED);
    expect(entry.reason).toContain('page 2');
    expect(unresolvedFindings([entry])).toHaveLength(1);
  });

  it('marks a finding naming a page the story does not have', () => {
    const findings = mergeAuditFindings([
      { source: 'blind', raw: 'FAULT[PAYOFF]: p99 — a closed container the book never opens.' },
    ]).findings;
    const [entry] = resolveFindingOutcomes(findings, PAGES, REPAIR_CHANGED);
    expect(entry.outcome).toBe(FINDING_OUTCOME.NO_SUCH_PAGE);
    expect(entry.reason).toContain('not in this story');
  });

  it('marks a fault line that names no page at all', () => {
    const findings = mergeAuditFindings([
      { source: 'arc-informed', raw: 'FAULT[LIMIT]: the limit the plot leans on is never stated.' },
    ]).findings;
    expect(findings[0].pageNumber).toBeNull();
    const [entry] = resolveFindingOutcomes(findings, PAGES, REPAIR_CHANGED);
    expect(entry.outcome).toBe(FINDING_OUTCOME.NO_PAGE_NAMED);
    expect(entry.reason).toContain('names no page');
  });

  it('marks every finding when the pass rewrote nothing', () => {
    const ledger = resolveFindingOutcomes(merged.findings, PAGES, []);
    expect(ledger).toHaveLength(20);
    expect(unresolvedFindings(ledger)).toHaveLength(20);
    for (const f of ledger) expect(f.outcome).toBe(FINDING_OUTCOME.PAGE_UNCHANGED);
  });
});

describe('the ledger carries provenance, so a finding can be traced back', () => {
  it('keeps each finding\'s category, page, text and source auditors', () => {
    const ledger = resolveFindingOutcomes(merged.findings, PAGES, REPAIR_CHANGED);
    for (const f of ledger) {
      expect(typeof f.category).toBe('string');
      expect(Array.isArray(f.sources)).toBe(true);
      expect(String(f.text || '')).not.toBe('');
    }
    expect(ledger.filter((f: any) => f.sources.includes('arc-informed'))).toHaveLength(18);
    expect(ledger.filter((f: any) => f.sources.includes('counter'))).toHaveLength(1);
  });
});

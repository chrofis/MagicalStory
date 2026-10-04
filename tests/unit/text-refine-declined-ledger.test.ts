/**
 * A FINDING THE REFINE DECLINES IS OPEN (owner, 2026-10-04).
 *
 * Staging job_1791040103540_atbttop6w: the arc-informed audit filed
 * "MISMATCH p18 — the text has Rubina climb down, the picture has her in the
 * nest". The refine's ledger answered "stands: this is the ending's own act",
 * left the sentence, and rewrote other parts of p18 — so the finding ledger
 * recorded it `page-rewritten`, i.e. answered. Pinned here, behaviour only:
 *   - the refine is shown each merged finding with an id (T1, T2 …);
 *   - a ledger line `<id> … STANDS: <reason>` records that finding `declined`,
 *     which unresolvedFindings counts, whatever happened to its page;
 *   - a fix claimed in prose never closes a finding (only this direction is read);
 *   - an id the pass was never given is ignored;
 *   - both callers of the refine template (the main repair pass and the
 *     post-audit round) do it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const textModels = nodeRequire('../../server/lib/textModels.js');
const TR = nodeRequire('../../server/lib/textRefine.js');

const ANALYSIS = [
  'LEDGER',
  '- T1 STYLE p18 look stated as a comparison → fixed on p18.',
  '- T2 MISMATCH p18 Rubina down with the boys → STANDS: this is the ending\'s own act.',
  '- T9 STYLE p3 → STANDS: an id nobody was given',
  '- STYLE p18 (no id) → stands: prose without an id is not read',
].join('\n');

describe('parseDeclinedFindings', () => {
  it('reads only id-led STANDS lines, and ignores ids the pass was not given', () => {
    const d = TR.parseDeclinedFindings(ANALYSIS, 2);
    expect([...d.entries()]).toEqual([['T2', "this is the ending's own act."]]);
  });
  it('a FIXED line closes nothing by itself and opens nothing', () => {
    expect(TR.parseDeclinedFindings('- T1 MISMATCH p2 → fixed on p2', 1).size).toBe(0);
  });
});

describe('resolveFindingOutcomes with declines', () => {
  const findings = [
    { category: 'STYLE', pageNumber: 18, text: 'look as comparison', line: 'FAULT[STYLE]: p18 — look as comparison' },
    { category: 'MISMATCH', pageNumber: 18, text: 'Rubina down vs nest', line: 'FAULT[MISMATCH]: p18 — Rubina down vs nest' },
  ];
  it('REGRESSION p18: a declined finding on a rewritten page is open, its sibling on the same page is answered', () => {
    const out = TR.resolveFindingOutcomes(findings, [{ pageNumber: 18 }], [18], [18], TR.parseDeclinedFindings(ANALYSIS, 2));
    expect(out.map((f: any) => [f.id, f.outcome])).toEqual([['T1', 'page-rewritten'], ['T2', 'declined']]);
    expect(out[1].reason).toContain("the ending's own act");
    expect(TR.unresolvedFindings(out).map((f: any) => f.id)).toEqual(['T2']);
  });
  it('without declines nothing changes', () => {
    const out = TR.resolveFindingOutcomes(findings, [{ pageNumber: 18 }], [18], [18]);
    expect(out.map((f: any) => f.outcome)).toEqual(['page-rewritten', 'page-rewritten']);
  });
  it('the refine is shown each finding under its id', () => {
    expect(TR.numberedFindingsText(findings)).toBe('T1 FAULT[STYLE]: p18 — look as comparison\nT2 FAULT[MISMATCH]: p18 — Rubina down vs nest');
  });
});

describe('both callers of the refine template record a decline', () => {
  const original = textModels.callTextModelStreaming;
  const sent: Record<string, string> = {};
  const PAGES = [
    { pageNumber: 1, text: 'Die Karte ist alt. Der Rand ist eingerissen.', sceneIntent: 'a map', sceneBrief: 'a map', planLine: '' },
    { pageNumber: 2, text: 'Der Hund bellt am Tor.', sceneIntent: 'a dog', sceneBrief: 'a dog', planLine: '' },
  ];
  const STORY = { language: 'de', languageLevel: '1st-grade', pages: 2, characters: [{ id: 'c1', name: 'Alba', age: 8, isMainCharacter: true }], mainCharacters: ['c1'] };
  const REFINE_REPLY = ['---ANALYSIS---', '- T1 CAUSE p1 → fixed on p1.', '- T2 MISMATCH p1 → STANDS: the picture holds an earlier instant.', '---STORY TEXT---', '## Page 1', 'Die Karte ist alt. Beim Auspacken riss der Rand ein.'].join('\n');

  beforeAll(() => {
    textModels.callTextModelStreaming = async (prompt: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      sent[label] = prompt;
      let text = '';
      if (label === 'text_audit') text = 'FAULT[CAUSE]: p1 - nothing says how the map tore.\nFAULT[MISMATCH]: p1 - the words have the dog inside, the picture outside.\nFAULTS: 2';
      else if (label === 'text_audit_blind') text = 'FAULTS: 0';
      else if (label.startsWith('text_refine')) text = REFINE_REPLY;
      else if (label === 'text_diff') text = 'NONE';
      else if (label === 'text_lector') text = 'NONE';
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 10, output_tokens: 20, direct_cost: 0 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('refineStoryText: the repair pass is shown ids and its declined finding stays open in the ledger', async () => {
    const res = await TR.refineStoryText(STORY, PAGES, { arc: '1. A map tears.' });
    const refinePrompt = Object.entries(sent).find(([k]) => k.startsWith('text_refine'))![1];
    expect(refinePrompt).toMatch(/T1 FAULT\[CAUSE\]/);
    expect(refinePrompt).toMatch(/T2 FAULT\[MISMATCH\]/);
    // The code counters may add their own findings; the two audit findings are T1, T2.
    const byId = Object.fromEntries(res.findingLedger.map((f: any) => [f.id, `${f.category}:${f.outcome}`]));
    expect(byId.T1).toBe('CAUSE:page-rewritten');
    expect(byId.T2).toBe('MISMATCH:declined');
    expect(TR.unresolvedFindings(res.findingLedger).map((f: any) => f.id)).toContain('T2');
  });

  it('runPostAuditTextRound: same contract', async () => {
    const res = await TR.runPostAuditTextRound(STORY, PAGES, [
      { page: 1, severity: 'MAJOR', line: 'FAULT[TEXT][MAJOR]: p1 — nothing says how the map tore' },
      { page: 1, severity: 'MAJOR', line: 'FAULT[TEXT][MAJOR]: p1 — the words have the dog inside, the picture outside' },
    ]);
    expect(res!.entry.prompt).toMatch(/T2 FAULT\[TEXT\]\[MAJOR\]: p1/);
    expect(res!.entry.findingOutcomes.map((f: any) => f.outcome)).toEqual(['page-rewritten', 'declined']);
    expect(res!.entry.unresolvedCount).toBe(1);
  });
});

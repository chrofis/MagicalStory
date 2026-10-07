import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * The diff pass reviews EVERY page a whole-page pass rewrote — the length
 * corrective pass included. refineStoryText's word-budget re-measure runs its
 * corrective pass "before the diff so the diff reviews this rewrite too"
 * (textRefine.js), and the diff's own header says "every page either
 * whole-page pass rewrote". A page the length_fix alone changed must therefore
 * reach the diff as a BEFORE/AFTER pair. Offline: the model is stubbed.
 */
// @ts-ignore CommonJS
const textModels = require('../../server/lib/textModels');
// @ts-ignore CommonJS
const { refineStoryText } = require('../../server/lib/textRefine.js');

// 12 words: under the 'standard' floor (40 words, tolerance 0.2 → 32), so the
// counter files FAULT[LENGTH] and the re-measure after the repair still trips.
const SHORT = 'Mia ging in den Garten. Sie fand eine rote Tulpe und lachte.';
// The length fix adds three words — well inside the 30% edit cap.
const EXPANDED = 'Mia ging in den Garten. Sie fand eine rote Tulpe und lachte laut vor Freude.';

describe('the diff pass reviews a page the length corrective pass rewrote', () => {
  const original = textModels.callTextModelStreaming;
  let calls: { label: string; prompt: string }[] = [];
  let replies: string[] = [];
  const PAGES = [{ pageNumber: 1, text: SHORT, sceneIntent: 'garden', sceneBrief: 'garden', planLine: '' }];
  const STORY = { language: 'de-ch', languageLevel: 'standard', pages: 1, characters: [{ id: 'c1', name: 'Mia', age: 6 }], mainCharacters: ['c1'] };
  // Both AI auditors clean: the only merged finding is the counter's LENGTH line.
  const AUDITS = [
    { source: 'arc-informed', ok: true, raw: 'FAULTS: 0', modelKey: 'gemini-3.1-pro' },
    { source: 'blind', ok: true, raw: 'FAULTS: 0', modelKey: 'grok-4.6' },
  ];
  const NONE = '---ANALYSIS---\nT1 STANDS: the page is as long as its moment needs\n---STORY TEXT---\nNONE';
  const page = (t: string) => `---ANALYSIS---\nexpanded p1\n---STORY TEXT---\n## Page 1\n${t}`;
  beforeAll(() => {
    textModels.callTextModelStreaming = async (prompt: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      calls.push({ label, prompt });
      const text = label.includes('text_refine') ? (replies.shift() ?? NONE) : 'FAULTS: 0';
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 1, output_tokens: 1, direct_cost: 0.01 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('hands the length_fix rewrite to the diff as a before/after pair', async () => {
    calls = []; replies = [NONE, page(EXPANDED)];
    const res = await refineStoryText(STORY, PAGES, { audits: AUDITS, jevOptions: { jevFallback: { step: 'start' } } });
    // The repair declined, the length fix rewrote p1.
    const repair = res.rounds.find((r: any) => r.kind === 'repair');
    expect(repair.changedPages).toEqual([]);
    const lengthFix = res.rounds.find((r: any) => r.kind === 'length_fix');
    expect(lengthFix.ok).toBe(true);
    expect(lengthFix.changedPages).toEqual([1]);
    expect(res.wordBudget.correctivePassRan).toBe(true);
    // The diff pass reviewed that rewrite: one call, p1 as its pair.
    const diffCalls = calls.filter(c => c.label === 'text_diff');
    expect(diffCalls).toHaveLength(1);
    const diff = res.rounds.find((r: any) => r.kind === 'diff');
    expect(diff).toBeTruthy();
    expect(diff.ok).toBe(true);
    expect(diff.reviewedPages).toEqual([1]);
    expect(res.pages[0].text).toBe(EXPANDED);
  });
});

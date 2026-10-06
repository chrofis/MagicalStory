import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * The text repair EDITS, it does not recompose (owner, 2026-10-06: "the first
 * text is rewritten by 70-80%; the changes should be 20-30% max"). The cap is
 * enforced in code: changedWordRatio / capEditedPages, and refineStoryText's
 * repair pass reverts an over-cap page after ONE fed-back re-ask.
 * Offline: the model is stubbed.
 */
// @ts-ignore CommonJS
const textModels = require('../../server/lib/textModels');
// @ts-ignore CommonJS
const { refineStoryText, changedWordRatio, computeEditRatios, capEditedPages, projectTextRefineReport, FINDING_OUTCOME } = require('../../server/lib/textRefine.js');
// @ts-ignore CommonJS
const { MODEL_DEFAULTS } = require('../../server/config/models');
// @ts-ignore CommonJS
const { LOAD_BEARING_RULE } = require('../../server/lib/promptBuilders');

const DRAFT = 'Mia ging in den Garten. Sie fand eine rote Tulpe. Sie roch daran und lachte laut. Dann ging sie nach Hause.';
const ONE_SENTENCE_EDIT = 'Mia ging in den Garten. Sie fand eine rote Tulpe. Sie roch daran und lachte laut. Dann rannte sie nach Hause.';
const RECOMPOSED = 'Im Garten blühte es überall, und Mia blieb staunend stehen. Eine Tulpe leuchtete im Beet. Mia beugte sich hinunter und atmete tief ein. Am Ende lief sie fröhlich heim zu Mama.';

describe('changedWordRatio', () => {
  it('is 0 for identical text, ignoring case and punctuation', () => {
    expect(changedWordRatio(DRAFT, DRAFT)).toBe(0);
    expect(changedWordRatio('Mia, geht!', 'mia geht')).toBe(0);
  });
  it('counts one swapped word in a 19-word page as ~5%', () => {
    const r = changedWordRatio(DRAFT, ONE_SENTENCE_EDIT);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(0.1);
  });
  it('is high for a recomposed page', () => {
    expect(changedWordRatio(DRAFT, RECOMPOSED)).toBeGreaterThan(0.7);
  });
  it('is 1 when nothing is kept and 0 for two empty texts', () => {
    expect(changedWordRatio('a b c', 'x y z')).toBe(1);
    expect(changedWordRatio('', '')).toBe(0);
  });
});

describe('capEditedPages', () => {
  const original = [{ pageNumber: 1, text: DRAFT }, { pageNumber: 2, text: DRAFT }];
  it('keeps an edit under the cap and reverts a recomposed page to the base', () => {
    const next = [{ pageNumber: 1, text: ONE_SENTENCE_EDIT }, { pageNumber: 2, text: RECOMPOSED }];
    const r = capEditedPages({ base: original, next, original, cap: 0.3 });
    expect(r.pages[0].text).toBe(ONE_SENTENCE_EDIT);
    expect(r.pages[1].text).toBe(DRAFT);
    expect(r.over.map((o: any) => o.pageNumber)).toEqual([2]);
  });
  it('measures against the writer draft, not the pass base (cumulative)', () => {
    const base = [{ pageNumber: 1, text: ONE_SENTENCE_EDIT }];
    const r = capEditedPages({ base, next: [{ pageNumber: 1, text: RECOMPOSED }], original: [{ pageNumber: 1, text: DRAFT }], cap: 0.3 });
    expect(r.over).toHaveLength(1);
    expect(r.pages[0].text).toBe(ONE_SENTENCE_EDIT);
  });
  it('never reverts an exempt (MISMATCH-move) page', () => {
    const r = capEditedPages({ base: original, next: [original[0], { pageNumber: 2, text: RECOMPOSED }], original, cap: 0.3, exempt: new Set([2]) });
    expect(r.over).toEqual([]);
    expect(r.pages[1].text).toBe(RECOMPOSED);
  });
});

describe('refineStoryText enforces the cap', () => {
  const original = textModels.callTextModelStreaming;
  let calls: { label: string; prompt: string }[] = [];
  let replies: string[] = [];
  const PAGES = [{ pageNumber: 1, text: DRAFT, sceneIntent: 'garden', sceneBrief: 'garden', planLine: '' }];
  const STORY = { language: 'de-ch', languageLevel: 'standard', pages: 1, characters: [{ id: 'c1', name: 'Mia', age: 6 }], mainCharacters: ['c1'] };
  const AUDITS = [
    { source: 'arc-informed', ok: true, raw: 'FAULT[CAUSE]: p1 - nothing says why Mia goes home.\nFAULTS: 1', modelKey: 'gemini-3.1-pro' },
    { source: 'blind', ok: true, raw: 'FAULTS: 0', modelKey: 'grok-4.6' },
  ];
  const page = (t: string) => `---ANALYSIS---\nT1 fixed on p1\n---STORY TEXT---\n## Page 1\n${t}`;
  beforeAll(() => {
    textModels.callTextModelStreaming = async (prompt: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      calls.push({ label, prompt });
      const text = label.includes('text_refine') ? (replies.shift() ?? '---ANALYSIS---\nnone\n---STORY TEXT---\nNONE') : 'FAULTS: 0';
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 1, output_tokens: 1, direct_cost: 0.01 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('keeps a one-sentence edit with no re-ask and logs the ratio', async () => {
    calls = []; replies = [page(ONE_SENTENCE_EDIT)];
    const res = await refineStoryText(STORY, PAGES, { audits: AUDITS });
    expect(res.pages[0].text).toBe(ONE_SENTENCE_EDIT);
    expect(calls.filter(c => c.label.endsWith('cap_reask'))).toHaveLength(0);
    const repair = res.rounds.find((r: any) => r.kind === 'repair');
    expect(repair.editCap.overFirst).toEqual([]);
    const report = projectTextRefineReport(res, new Map([[1, DRAFT]]));
    expect(report.editRatios[0].pageNumber).toBe(1);
    expect(report.editRatios[0].ratio).toBeLessThanOrEqual(MODEL_DEFAULTS.textRefineMaxChangedRatio);
  });

  it('re-asks once for a recomposed page and keeps the corrected edit', async () => {
    calls = []; replies = [page(RECOMPOSED), page(ONE_SENTENCE_EDIT)];
    const res = await refineStoryText(STORY, PAGES, { audits: AUDITS });
    const reasks = calls.filter(c => c.label.endsWith('cap_reask'));
    expect(reasks).toHaveLength(1);
    expect(reasks[0].prompt).toMatch(/EDIT CAP: your rewrite of page 1/);
    expect(res.pages[0].text).toBe(ONE_SENTENCE_EDIT);
    const repair = res.rounds.find((r: any) => r.kind === 'repair');
    expect(repair.editCap.rejected).toEqual([]);
    expect(repair.cost).toBeCloseTo(0.02, 5);
  });

  it('keeps the draft and opens the finding when the re-ask is still over the cap', async () => {
    calls = []; replies = [page(RECOMPOSED), page(RECOMPOSED)];
    const res = await refineStoryText(STORY, PAGES, { audits: AUDITS });
    expect(calls.filter(c => c.label.endsWith('cap_reask'))).toHaveLength(1);
    expect(res.pages[0].text).toBe(DRAFT);
    expect(res.findingLedger[0].outcome).toBe(FINDING_OUTCOME.EDIT_CAP_REJECTED);
    expect(computeEditRatios(res.original, res.pages)[0].ratio).toBe(0);
  });
});

describe('the load-bearing rule reaches the writer, the refine and the arc-informed audit', () => {
  it('is one string, injected where each template names it', () => {
    // @ts-ignore CommonJS
    const fs = require('fs');
    for (const f of ['story-text-from-beats.txt', 'text-refine.txt', 'story-text-audit.txt']) {
      expect(fs.readFileSync(`prompts/${f}`, 'utf8')).toContain('{LOAD_BEARING}');
    }
    expect(LOAD_BEARING_RULE).toMatch(/optional/);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// @ts-ignore — CommonJS lib
const {
  normalizeForShingles, shinglesOf, findRepeatedPassages, buildRepetitionFindings, refineStoryText,
} = require('../../server/lib/textRefine.js');
const { MODEL_DEFAULTS } = require('../../server/config/models');

/**
 * Cross-page repetition check (2026-09-10). Origin: job_1788983823620_csjcyp1q9
 * p12/p13 shipped one paragraph twice (11 identical 5-word sequences) after the
 * repair pass copied a scene onto the page whose picture shows it instead of
 * moving it. The check is string equality on the pages' own words — no model.
 */

const PARA = 'Sie erzählt eine ganze Stunde lang von den drei Landmarken. Die Hauptfigur zeichnet die Karte mit Kohle auf ein Stück Segeltuch, und die Linien werden krumm. Dann heftet sie das Tuch an den Mast.';

describe('normalizeForShingles', () => {
  it('lowercases, strips punctuation incl. «» and dashes, collapses whitespace', () => {
    expect(normalizeForShingles('«Halt!»  sagte   Fiona — und lief, sofort.\n\nWeiter…'))
      .toEqual(['halt', 'sagte', 'fiona', 'und', 'lief', 'sofort', 'weiter']);
  });
  it('keeps umlauts and ß as themselves', () => {
    expect(normalizeForShingles('Größe, weiß, Mädchen')).toEqual(['größe', 'weiß', 'mädchen']);
  });
  it('shingles are 5 words and positional', () => {
    expect(shinglesOf('a b c d e f')).toEqual(['a b c d e', 'b c d e f']);
    expect(shinglesOf('a b c d')).toEqual([]);
  });
});

describe('findRepeatedPassages', () => {
  const N = MODEL_DEFAULTS.textRepetitionMinShingles;

  it('a duplicated paragraph (the measured case: ≥11 shared shingles) trips', () => {
    const pages = [
      { pageNumber: 12, text: 'Lorena steht am Mast und will nicht umkehren. ' + PARA },
      { pageNumber: 13, text: PARA + ' Am Abend ist die Karte fertig.' },
      { pageNumber: 14, text: 'Ganz etwas anderes passiert hier auf dieser Seite der Geschichte.' },
    ];
    const hits = findRepeatedPassages(pages, N);
    expect(hits).toHaveLength(1);
    expect(hits[0].pages).toEqual([12, 13]);
    expect(hits[0].sharedCount).toBeGreaterThanOrEqual(11);
    // The rebuilt passage is the copied paragraph, normalised.
    expect(hits[0].passages.join(' ')).toContain('drei landmarken die hauptfigur zeichnet');
  });

  it('a recurring proper-noun phrase alone does not trip', () => {
    // The same 5-word ship name on every page = ONE shared shingle per pair.
    const name = 'das Schiff Stern der sieben Meere';
    const pages = [
      { pageNumber: 1, text: `Morgens segelt ${name} aus dem Hafen hinaus und der Wind ist frisch.` },
      { pageNumber: 2, text: `Am Mittag liegt ${name} still, denn kein Wind kommt mehr.` },
      { pageNumber: 3, text: `Nachts leuchten Lampen auf ${name}, und alle schlafen.` },
    ];
    const hits = findRepeatedPassages(pages, N);
    expect(hits).toEqual([]);
    // Sanity: the pairs DO share something — just below the threshold.
    expect(findRepeatedPassages(pages, 1).length).toBe(3);
  });

  it('the corrective findings carry both page numbers, both plan lines and the passage', () => {
    const pages = [
      { pageNumber: 12, text: PARA, planLine: 'wide — a sailor at the mast — she refuses to turn back — the course holds' },
      { pageNumber: 13, text: PARA, planLine: 'close — two figures at the sailcloth — the chart is pinned to the mast — the chart exists' },
    ];
    const text = buildRepetitionFindings(findRepeatedPassages(pages, N), pages);
    expect(text).toMatch(/^FAULT\[REPETITION\]: p12 — pages 12 and 13 carry the same passage/);
    expect(text).toContain('Plan p12: wide — a sailor at the mast');
    expect(text).toContain('Plan p13: close — two figures at the sailcloth');
    expect(text).toContain('drei landmarken');
    expect(text).toContain('rewrite the other page without it, change nothing else');
  });
});

/**
 * Chain behaviour with stubbed models: the repair pass returns two pages that
 * share a paragraph; exactly one corrective pass runs and carries the failure;
 * a stub that leaves the duplication in place produces a WARN and a report,
 * never a throw.
 */
describe('refineStoryText — one corrective repetition pass', () => {
  const textModels = require('../../server/lib/textModels');
  const originalCall = textModels.callTextModelStreaming;
  const calls: { label: string; prompt: string }[] = [];
  let correctiveFixes = true;

  const PAGES = [
    { pageNumber: 12, text: 'Lorena steht am Mast und sagt, dass sie nicht umkehren will, egal was kommt.', sceneIntent: 'a sailor at the mast', sceneBrief: 'a sailor at the mast', planLine: 'wide — a sailor at the mast — she refuses to turn back — the course holds' },
    { pageNumber: 13, text: 'Die Karte ist fertig und hängt am Mast, damit alle sie sehen können.', sceneIntent: 'two figures at the sailcloth', sceneBrief: 'two figures at the sailcloth', planLine: 'close — two figures at the sailcloth — the chart is pinned — the chart exists' },
  ];
  const STORY = { language: 'de', languageLevel: '1st-grade', pages: 2, characters: [{ id: 'c1', name: 'Alba', age: 8, isMainCharacter: true }], mainCharacters: ['c1'] };

  beforeAll(() => {
    textModels.callTextModelStreaming = async (prompt: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      calls.push({ label, prompt: String(prompt || '') });
      let text = '';
      if (label === 'text_audit' || label === 'text_audit_blind') text = 'FAULTS: 0';
      else if (label === 'text_refine') {
        // The repair COPIES the paragraph onto both pages.
        text = ['---ANALYSIS---', 'split 12/13', '---STORY TEXT---', '## Page 12', PAGES[0].text + ' ' + PARA, '## Page 13', PARA + ' Am Abend ist die Karte fertig.'].join('\n');
      } else if (label === 'text_refine_repetition_fix') {
        text = correctiveFixes
          ? ['---ANALYSIS---', 'moved from p12 to p13', '---STORY TEXT---', '## Page 12', PAGES[0].text].join('\n')
          : ['---ANALYSIS---', 'nothing', '---STORY TEXT---', 'NONE'].join('\n');
      } else text = '---STORY TEXT---\nNONE';
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 10, output_tokens: 20, direct_cost: 0.01 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = originalCall; });

  it('runs exactly one corrective pass carrying both pages and plan lines, and reports resolved', async () => {
    calls.length = 0;
    correctiveFixes = true;
    const res = await refineStoryText(STORY, PAGES);
    const fixes = calls.filter(c => c.label === 'text_refine_repetition_fix');
    expect(fixes).toHaveLength(1);
    expect(fixes[0].prompt).toContain('pages 12 and 13 carry the same passage');
    expect(fixes[0].prompt).toContain('Plan p12: wide — a sailor at the mast');
    expect(fixes[0].prompt).toContain('Plan p13: close — two figures at the sailcloth');
    // length_fix sits between the repetition fix and the diff (2026-09-11): the
    // word budget is re-measured on the text the whole-page passes produced.
    expect(res.rounds.map((r: any) => r.kind)).toEqual(['repair', 'repetition_fix', 'length_fix', 'diff', 'lector']);
    expect(res.repetition.pairs).toHaveLength(1);
    expect(res.repetition.pairs[0].pages).toEqual([12, 13]);
    expect(res.repetition.correctivePassRan).toBe(true);
    expect(res.repetition.resolved).toBe(true);
    expect(res.repetition.cost).toBe(0.01);
    expect(res.pages.find((p: any) => p.pageNumber === 12).text).not.toContain('Landmarken');
    // The diff pass reviews every page either whole-page pass touched.
    const diff = res.rounds.find((r: any) => r.kind === 'diff');
    expect(diff.reviewedPages).toEqual([12, 13]);
  });

  it('a still-tripping result warns, records remaining pairs, and does not throw — one pass max', async () => {
    calls.length = 0;
    correctiveFixes = false;
    const { log } = require('../../server/utils/logger');
    const warns: string[] = [];
    const origWarn = log.warn;
    log.warn = (m: string) => { warns.push(String(m)); };
    try {
      const res = await refineStoryText(STORY, PAGES);
      expect(calls.filter(c => c.label === 'text_refine_repetition_fix')).toHaveLength(1);
      expect(res.repetition.correctivePassRan).toBe(true);
      expect(res.repetition.resolved).toBe(false);
      expect(res.repetition.remaining[0].pages).toEqual([12, 13]);
      expect(warns.some(w => /STILL DUPLICATED.*pages 12 and 13/.test(w))).toBe(true);
    } finally {
      log.warn = origWarn;
    }
  });
});

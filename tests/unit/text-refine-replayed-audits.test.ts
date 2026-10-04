import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Lab repair-model A/B (2026-10-04, Opus 5 vs Sonnet 5.5 on text_refine):
 * `opts.audits` replays a stored run's audit results, so no auditor is called
 * and the repair answers the identical fault list. Offline: model stubbed.
 */
// @ts-ignore CommonJS
const textModels = require('../../server/lib/textModels');
// @ts-ignore CommonJS
const { refineStoryText } = require('../../server/lib/textRefine.js');
// @ts-ignore CommonJS
const { storedRefineAudits } = require('../../server/lib/testlab');

const PAGES = [{ pageNumber: 1, text: 'Mia ging in den Garten.', sceneIntent: 'garden', sceneBrief: 'garden', planLine: '' }];
const STORY = { language: 'de-ch', languageLevel: 'standard', pages: 1, characters: [{ id: 'c1', name: 'Mia', age: 6 }], mainCharacters: ['c1'] };
const STORED = [
  { source: 'arc-informed', ok: true, raw: 'FAULT[CAUSE]: p1 - nothing says why Mia goes out.\nFAULTS: 1', modelKey: 'gemini-3.1-pro' },
  { source: 'blind', ok: true, raw: 'FAULTS: 0', modelKey: 'grok-4.6' },
];

describe('refineStoryText with replayed audits', () => {
  const original = textModels.callTextModelStreaming;
  const labels: string[] = [];
  let repairPrompt = '';
  beforeAll(() => {
    textModels.callTextModelStreaming = async (prompt: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      labels.push(String(opts.usageLabel || ''));
      if (opts.usageLabel === 'text_refine') repairPrompt = prompt;
      return {
        text: opts.usageLabel === 'text_refine' ? '---ANALYSIS---\nnone\n---STORY TEXT---\nNONE' : 'FAULTS: 0',
        modelId: `stub-${model}`, usage: { input_tokens: 1, output_tokens: 1, direct_cost: 0 },
      };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('calls no auditor and hands the stored findings to the repair', async () => {
    const res = await refineStoryText(STORY, PAGES, { audits: STORED });
    expect(labels).not.toContain('text_audit');
    expect(labels).not.toContain('text_audit_blind');
    expect(labels).toContain('text_refine');
    expect(repairPrompt).toMatch(/FAULT\[CAUSE\]: p1 - nothing says why Mia goes out/);
    expect(res.audits.every((a: any) => a.replayed)).toBe(true);
  });
});

describe('storedRefineAudits', () => {
  it('keeps source/ok/raw of every stored audit', () => {
    const out = storedRefineAudits({ textRefineReport: { audits: [...STORED, { source: 'jev', ok: false, error: 'down' }] } }, 'job_x');
    expect(out.map((a: any) => [a.source, a.ok])).toEqual([['arc-informed', true], ['blind', true], ['jev', false]]);
    expect(out[0].raw).toBe(STORED[0].raw);
  });

  it('fails loudly when no stored audit succeeded', () => {
    expect(() => storedRefineAudits({ textRefineReport: { audits: [{ source: 'blind', ok: false }] } }, 'job_x')).toThrow(/job_x stores no successful/);
    expect(() => storedRefineAudits({}, 'job_x')).toThrow(/no successful/);
  });
});

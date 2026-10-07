import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * An auditor that returns NOTHING twice is a FAILED audit, said so (NO
 * FALLBACKS: a missing input is logged, never a quiet degrade). Before the fix
 * refineStoryText's runAudit returned `{ok:false}` with no `error` for an
 * empty-twice reply: the stored report showed the audit as ok:false /
 * error:null / 0 faults, the only log line said "0 fault(s)" at info, and the
 * merge silently ran on the other auditors. gemini-3.1-pro's occasional empty
 * body (models.js) is exactly the path. Offline: the model is stubbed.
 */
// @ts-ignore CommonJS
const textModels = require('../../server/lib/textModels');
// @ts-ignore CommonJS
const { refineStoryText } = require('../../server/lib/textRefine.js');

const DRAFT = 'Mia ging in den Garten. Sie fand eine rote Tulpe. Sie roch daran und lachte laut. Dann ging sie nach Hause. Die Sonne schien warm auf den Weg. Mama wartete an der Tür und winkte ihr zu. Mia zeigte die Tulpe. Mama lachte auch.';

describe('an auditor that answers empty twice is recorded as a failed audit', () => {
  const original = textModels.callTextModelStreaming;
  let calls: string[] = [];
  const PAGES = [{ pageNumber: 1, text: DRAFT, sceneIntent: 'garden', sceneBrief: 'garden', planLine: '' }];
  const STORY = { language: 'de-ch', languageLevel: 'standard', pages: 1, characters: [{ id: 'c1', name: 'Mia', age: 6 }], mainCharacters: ['c1'] };
  beforeAll(() => {
    textModels.callTextModelStreaming = async (_p: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      calls.push(label);
      // The arc-informed auditor returns an empty body on BOTH tries; everything else is clean.
      const text = label === 'text_audit' ? '' : (label.includes('text_refine') ? '---ANALYSIS---\nnone\n---STORY TEXT---\nNONE' : 'FAULTS: 0');
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 1, output_tokens: 1, direct_cost: 0.01 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('names the empty reply as the error on the audit record', async () => {
    calls = [];
    const res = await refineStoryText(STORY, PAGES, { jevOptions: { jevFallback: { step: 'start' } } });
    // The auditor was retried once, then given up on.
    expect(calls.filter(l => l === 'text_audit')).toHaveLength(2);
    const arc = res.audits.find((a: any) => a.source === 'arc-informed');
    expect(arc.ok).toBe(false);
    expect(typeof arc.error).toBe('string');
    expect(arc.error).toMatch(/empty/i);
    // The blind auditor answered and the chain went on with it.
    const blind = res.audits.find((a: any) => a.source === 'blind');
    expect(blind.ok).toBe(true);
    expect(res.pages[0].text).toBe(DRAFT);
  });
});

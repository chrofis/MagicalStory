/**
 * THE AUDIT ASKS ABOUT STYLE (owner, 2026-09-23).
 *
 * The repair rewrites only the pages an audit names, and no audit asked about
 * style, so a bare fragment the writer produced survived the whole chain
 * (writer reruns Lab 1426/1428 on staging job_1790100385959_1nitlympp). The
 * blind audit now checks every page against the SAME STYLE_RULEBOOK the writer
 * and the repair are given, and a STYLE finding makes its page rewritable.
 * Behaviour only — never template wording.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');
// @ts-ignore — CommonJS lib
const TR = require('../../server/lib/textRefine.js');

describe('the style rulebook reaches the blind audit', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the blind audit carries the rulebook exactly once and no unfilled placeholder', () => {
    const p = PB.buildTextAuditBlindPrompt({ language: 'de' }, [{ pageNumber: 1, text: 'Hier. Da. Nichts.' }]);
    expect(p.split(PB.STYLE_RULEBOOK).length - 1).toBe(1);
    expect(p).not.toContain('{STYLE_RULEBOOK}');
  });

  it('the arc-informed audit does not also ask it (one auditor owns STYLE)', () => {
    const p = PB.buildTextAuditPrompt({ language: 'de' }, [{ pageNumber: 1, text: 'Hier. Da. Nichts.' }], 'An arc.');
    expect(p).not.toContain(PB.STYLE_RULEBOOK);
  });
});

describe('a STYLE finding routes to the repair for its page', () => {
  const textModels = require('../../server/lib/textModels');
  const original = textModels.callTextModelStreaming;
  const sent: Record<string, string> = {};
  const STYLE_LINE = 'FAULT[STYLE]: p2 — «Wieder nur Rauch.» a bare fragment standing as a sentence';

  const PAGES = [
    { pageNumber: 1, text: 'Der Drache blies gegen die Schale.', sceneIntent: 'a dragon', sceneBrief: 'a dragon', planLine: '' },
    { pageNumber: 2, text: 'Er blies noch einmal. Wieder nur Rauch.', sceneIntent: 'smoke', sceneBrief: 'smoke', planLine: '' },
  ];
  const STORY = { language: 'de', languageLevel: 'standard', pages: 2, characters: [{ id: 'c1', name: 'Levin', age: 5, isMainCharacter: true }], mainCharacters: ['c1'] };

  beforeAll(() => {
    textModels.callTextModelStreaming = async (prompt: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      sent[label] = prompt;
      let text = '';
      if (label === 'text_audit') text = 'FAULTS: 0';
      else if (label === 'text_audit_blind') text = `${STYLE_LINE}\nFAULTS: 1`;
      else if (label.startsWith('text_refine')) text = ['---ANALYSIS---', 'fixed', '---STORY TEXT---', '## Page 2', 'Er blies noch einmal, aber wieder kam nur Rauch.'].join('\n');
      else if (label === 'text_diff') text = 'NONE';
      else if (label === 'text_lector') text = 'NONE';
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 10, output_tokens: 20, direct_cost: 0 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('the blind audit files it, the repair is handed it, and the ledger answers it on that page', async () => {
    const res = await TR.refineStoryText(STORY, PAGES, { arc: '1. A dragon blows smoke.' });
    expect(sent.text_audit_blind).toContain(PB.STYLE_RULEBOOK);
    const merged = res.mergedFindings.find((f: any) => f.category === 'STYLE');
    expect(merged).toMatchObject({ pageNumber: 2, sources: ['blind'] });
    expect(sent.text_refine).toContain(STYLE_LINE);
    const ledger = res.findingLedger.find((f: any) => f.category === 'STYLE');
    expect(ledger.outcome).toBe(TR.FINDING_OUTCOME.PAGE_REWRITTEN);
    expect(res.pages[1].text).toBe('Er blies noch einmal, aber wieder kam nur Rauch.');
    expect(res.pages[0].text).toBe('Der Drache blies gegen die Schale.');
  });
});

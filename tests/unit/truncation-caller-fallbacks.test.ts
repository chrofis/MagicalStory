/**
 * Callers that MUST react to a truncated reply, exercised with the model call
 * mocked: the shared guard stamps `result.truncation`, and each caller falls
 * back to the input it was given instead of adopting a cut reply.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const textModels = require('../../server/lib/textModels.js');
const { assessTextReply } = require('../../server/lib/textReplyGuard.js');

const realStreaming = textModels.callTextModelStreaming;
const realCall = textModels.callTextModel;

/** A reply as callTextModel would return it after guardReply. */
function reply(text: string, over: any = {}) {
  const r = { text, usage: { output_tokens: over.output_tokens ?? 100 }, stop_reason: over.stop_reason ?? 'end_turn', modelId: over.modelId || 'mock-model', provider: 'mock' };
  return { ...r, truncation: assessTextReply(r, { capInForce: over.capInForce ?? 64000 }) };
}
const truncated = (text: string) => reply(text, { stop_reason: 'max_tokens', output_tokens: 64000 });

afterEach(() => {
  textModels.callTextModelStreaming = realStreaming;
  textModels.callTextModel = realCall;
});

describe('textRefine.refineStoryText — every round falls back to its input on a truncated reply', () => {
  const pages = [
    { pageNumber: 1, text: 'Mila fand am Morgen einen kleinen Drachen im Garten. Er zitterte vor Kälte.' },
    { pageNumber: 2, text: 'Sie brachte ihm eine Decke und einen Becher warme Milch. Der Drache lächelte.' },
  ];
  const storyData = { title: 'Mila und der Drache', language: 'de-ch', languageLevel: 'standard', ageRange: '4-6', pages };

  it('audits ok:false, repair/diff/lector rounds fail, page text is byte-identical to the input', async () => {
    const calls: string[] = [];
    textModels.callTextModelStreaming = async (_p: string, maxTokens: any, _c: any, _m: string, opts: any) => {
      calls.push(`${opts?.usageLabel}:${maxTokens}`);
      // Long, plausible-looking, and cut at the ceiling — the shape that used
      // to parse as "fewer findings" / "nothing to rewrite".
      return truncated(('FAULT[CORE]: p1 — something\n' + 'PAGE 1: ' + 'x'.repeat(50) + '\n').repeat(40));
    };
    const { refineStoryText } = require('../../server/lib/textRefine.js');
    const out = await refineStoryText(storyData, pages, { usageLabel: 'test_refine' });
    // Every call went out uncapped (null = model max).
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.endsWith(':null'), c).toBe(true);
    // Nothing was adopted.
    expect(out.pages.map((p: any) => p.text)).toEqual(pages.map(p => p.text));
    expect(out.changed).toEqual([]);
    for (const a of out.audits) {
      expect(a.ok).toBe(false);
      expect(a.error).toMatch(/audit reply TRUNCATED/);
    }
    const repair = out.rounds.find((r: any) => r.kind === 'repair');
    expect(repair).toBeTruthy();
    expect(repair.ok).toBe(false);
    expect(repair.error).toMatch(/TRUNCATED.*rewrites unusable/);
  }, 30000);
});

describe('evalPipeline.evaluateThreeStage — a truncated compliance reply is evalFailed with the reason, never "no findings"', () => {
  it('returns { evalFailed: true, evalError } instead of a compliance result', async () => {
    let sent: any = null;
    textModels.callTextModel = async (_p: string, maxTokens: any, model: string, opts: any) => {
      sent = { maxTokens, model, label: opts?.usageLabel };
      return truncated('{"verdict":"PASS","fixable_issues":[' + '{"description":"x","severity":"MINOR"},'.repeat(300));
    };
    const { evaluateThreeStage } = require('../../server/lib/evalPipeline.js');
    const res = await evaluateThreeStage('data:image/jpeg;base64,AAAA', 'a boy and a dragon in a garden', 'the boy hands the dragon a cup', {
      pageContext: 'p1',
      compliancePromptOverride: 'INVENTORY:\n{{VISION_INVENTORY}}\nPROMPT:\n{{IMAGE_PROMPT}}\nReply JSON.',
      inventoryPromise: Promise.resolve({ figures: [{ id: 1, hair: 'brown', position: 'center' }], inputTokens: 10, outputTokens: 20 }),
    });
    expect(sent).toMatchObject({ maxTokens: null, label: 'semantic_compliance' });
    expect(res).toMatchObject({ evalFailed: true });
    expect(res.evalError).toMatch(/compliance reply TRUNCATED: stop_reason=max_tokens/);
    expect(res.fixableIssues).toBeUndefined();
    expect(res.score).toBeUndefined();
  }, 30000);

  it('a complete compliance reply still parses (the guard does not fire on a clean reply)', async () => {
    textModels.callTextModel = async () => reply('{"verdict":"FAIL","fixable_issues":[{"description":"the dragon is missing","severity":"MAJOR","type":"missing_character"}]}');
    const { evaluateThreeStage } = require('../../server/lib/evalPipeline.js');
    const res = await evaluateThreeStage('data:image/jpeg;base64,AAAA', 'a boy and a dragon', 'hint', {
      compliancePromptOverride: 'X {{VISION_INVENTORY}} {{IMAGE_PROMPT}}',
      inventoryPromise: Promise.resolve({ figures: [], inputTokens: 1, outputTokens: 1 }),
    });
    expect(res && res.evalFailed).toBeFalsy();
    expect(res && Array.isArray(res.fixableIssues) ? res.fixableIssues.length : -1).toBe(1);
  }, 30000);
});

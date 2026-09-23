/**
 * THE TEXT CHAIN AFTER DRAGON RUN 6 (staging job_1790100385959_1nitlympp, 2026-09-23).
 *
 * 1. The finding ledger was settled before the diff pass ran, so when the diff
 *    put the writer's sentences back on a rewritten page the ledger still
 *    claimed the finding answered. It is now re-settled after the diff.
 * 2. The word counter measured before the diff and the lector; the text that
 *    ships is now counted too.
 * 3. The arc hints reached the writer only. The arc-informed audit and the
 *    repair now read them; the blind audit stays blind.
 * 4. The DO-NOT-WRITE list reached the refine with the writer's "no need to
 *    re-check" line while its check 18 is the re-check; and the outline
 *    reviewer's missing-template path assigned to a const.
 * Behaviour only — never template wording.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');
// @ts-ignore — CommonJS lib
const TR = require('../../server/lib/textRefine.js');

const HINTS = 'ISSUE: The helper searches the place he sent the other to. → CHANGE: He searches the other place himself.';

describe('restoredSentences — provenance of a diff correction', () => {
  const writer = 'The fox ran home. The fox hid the key under the stone.';
  const rewritten = 'The fox ran home. The fox hid the key in the hollow tree.';

  it('a correction that puts back the writer\'s sentence is a restoration', () => {
    expect(TR.restoredSentences('The fox hid the key under the stone.', writer, rewritten))
      .toEqual(['The fox hid the key under the stone.']);
  });

  it('a language fix with new words restores nothing', () => {
    expect(TR.restoredSentences('The fox hid the key inside the hollow tree.', writer, rewritten)).toEqual([]);
  });

  it('a sentence both texts carry is not a restoration', () => {
    expect(TR.restoredSentences('The fox ran home.', writer, rewritten)).toEqual([]);
  });

  it('finds a restored sentence inside a longer correction', () => {
    expect(TR.restoredSentences('It was late. The fox hid the key under the stone.', writer, rewritten))
      .toEqual(['The fox hid the key under the stone.']);
  });
});

describe('settleLedgerAfterDiff', () => {
  const ledger = [
    { pageNumber: 3, category: 'MISMATCH', text: 'x', outcome: 'page-rewritten', reason: null },
    { pageNumber: 5, category: 'CAUSE', text: 'y', outcome: 'page-rewritten', reason: null },
    { pageNumber: 3, category: 'CAUSE', text: 'z', outcome: 'page-unchanged', reason: 'the pass did not return page 3' },
  ];

  it('a rewritten finding whose page got a restoration is no longer counted answered', () => {
    const out = TR.settleLedgerAfterDiff(ledger, [{ pageNumber: 3, restored: ['The fox hid the key under the stone.'] }]);
    expect(out[0].outcome).toBe(TR.FINDING_OUTCOME.REWRITE_RESTORED);
    expect(out[0].reason).toContain('The fox hid the key under the stone.');
    expect(out[1].outcome).toBe('page-rewritten');
    expect(out[2]).toEqual(ledger[2]);
    expect(TR.unresolvedFindings(out).length).toBe(2);
  });

  it('a correction that restores nothing leaves the ledger as it was', () => {
    expect(TR.settleLedgerAfterDiff(ledger, [{ pageNumber: 3, restored: [] }])).toEqual(ledger);
  });
});

describe('refineStoryText — ledger and counter after the diff, hints to the sighted critics', () => {
  const textModels = require('../../server/lib/textModels');
  const original = textModels.callTextModelStreaming;
  const sent: Record<string, string> = {};

  const PAGES = [
    { pageNumber: 1, text: 'Die Karte ist alt. Der Rand ist eingerissen.', sceneIntent: 'a map', sceneBrief: 'a map', planLine: '' },
    { pageNumber: 2, text: 'Der Hund bellt am Tor.', sceneIntent: 'a dog', sceneBrief: 'a dog', planLine: '' },
  ];
  const STORY = { language: 'de', languageLevel: '1st-grade', pages: 2, characters: [{ id: 'c1', name: 'Alba', age: 8, isMainCharacter: true }], mainCharacters: ['c1'] };

  beforeAll(() => {
    textModels.callTextModelStreaming = async (prompt: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      sent[label] = prompt;
      let text = '';
      if (label === 'text_audit') text = 'FAULT[CAUSE]: p1 - nothing says how the map tore.\nFAULTS: 1';
      else if (label === 'text_audit_blind') text = 'FAULTS: 0';
      else if (label.startsWith('text_refine')) text = ['---ANALYSIS---', 'fixed', '---STORY TEXT---', '## Page 1', 'Die Karte ist alt. Beim Auspacken riss der Rand ein.'].join('\n');
      // The diff pass puts the writer's sentence back over the fix.
      else if (label === 'text_diff') text = "PAGE 1: 'Beim Auspacken riss der Rand ein.' -> 'Der Rand ist eingerissen.'";
      else if (label === 'text_lector') text = 'NONE';
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 10, output_tokens: 20, direct_cost: 0 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('re-settles the ledger, counts the shipped text, and hands the hints to the audit and the repair only', async () => {
    const res = await TR.refineStoryText(STORY, PAGES, { arc: '1. A map tears.', arcHints: HINTS });
    // The fix was undone on the shipped page, and the ledger says so.
    expect(res.pages[0].text).toBe('Die Karte ist alt. Der Rand ist eingerissen.');
    const cause = res.findingLedger.find((f: any) => f.category === 'CAUSE');
    expect(cause.outcome).toBe(TR.FINDING_OUTCOME.REWRITE_RESTORED);
    expect(res.diffApplied[0].restored).toEqual(['Der Rand ist eingerissen.']);
    expect(TR.projectTextRefineReport(res).diffApplied[0].restored).toEqual(['Der Rand ist eingerissen.']);
    // The shipped text is counted.
    expect(res.wordBudget.shipped.counts).toEqual([
      { pageNumber: 1, words: 8, sentences: 2, paragraphs: 1 },
      { pageNumber: 2, words: 5, sentences: 1, paragraphs: 1 },
    ]);
    // Hints: both sighted critics, with the writer's arc-outranks-hint rule; never the blind audit.
    for (const label of ['text_audit', 'text_refine']) {
      expect(sent[label], label).toContain('He searches the other place himself.');
      expect(sent[label], label).toContain(PB.HINT_VS_ARC_RULE);
    }
    expect(sent.text_audit_blind).not.toContain('He searches the other place himself.');
  });
});

describe('the DO-NOT-WRITE list as a checker reads it', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const REF_LINE = /analysis pass does NOT need to re-check/;

  it('the refine, whose check 18 is the re-check, is not told there is no re-check', () => {
    const p = PB.buildTextRefinePrompt({ language: 'en', languageLevel: 'standard', characters: [] },
      [{ pageNumber: 1, text: 'A page.' }], 'FAULT[CAUSE]: p1 - x', '1. A story.');
    expect(p).toContain('# DO-NOT-WRITE LIST');
    expect(p).not.toMatch(REF_LINE);
  });

  it('the writer still gets the full list', () => {
    expect(PB.buildDoNotWriteSection()).toMatch(REF_LINE);
  });

  it('the refine carries no hint block when the story has no hints', () => {
    const p = PB.buildTextRefinePrompt({ language: 'en', languageLevel: 'standard', characters: [] },
      [{ pageNumber: 1, text: 'A page.' }], '', '1. A story.');
    expect(p).not.toContain(PB.HINT_VS_ARC_RULE);
  });

  it('the outline reviewer survives a missing list instead of throwing on a const', () => {
    const saved = PROMPT_TEMPLATES.doNotWriteList;
    PROMPT_TEMPLATES.doNotWriteList = '';
    try {
      expect(() => PB.buildOutlineReviewPrompt({ pages: '', characters: [], language: 'en' }, 'draft', [], {})).not.toThrow();
    } finally {
      PROMPT_TEMPLATES.doNotWriteList = saved;
    }
  });
});

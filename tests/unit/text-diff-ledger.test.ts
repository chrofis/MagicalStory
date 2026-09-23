/**
 * THE DIFF PASS SEES WHAT THE REPAIR WAS ANSWERING (owner decision 2026-09-23).
 *
 * The diff pass compared BEFORE and AFTER blind to the findings the repair was
 * answering, so a deliberate fix read as a dropped fact and was reverted
 * (staging job_1790100385959_1nitlympp p4, p11, p16). Each reviewed page now
 * carries the findings every whole-page pass held for it and for the pages
 * beside it (the p16 fix answered a p17 finding). Pinned here: the ledger
 * reaches the built prompt, per page, through the production chain.
 * Behaviour only — never the template's wording.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');
// @ts-ignore — CommonJS lib
const { refineStoryText } = require('../../server/lib/textRefine.js');

const pageBlock = (prompt: string, n: number) => {
  const m = prompt.match(new RegExp(`--- Page ${n} ---\\n([\\s\\S]*?)(?=\\n--- Page \\d+ ---|$)`));
  return m ? m[1] : '';
};

describe('buildTextDiffPrompt — the findings ledger', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const pairs = [
    {
      pageNumber: 3,
      before: 'The fox hid the key under the stone.',
      after: 'The fox hid the key in the hollow tree.',
      findings: [
        { pageNumber: 3, category: 'MISMATCH', text: 'the picture shows the key in a hollow tree, not under a stone' },
        { pageNumber: 4, category: 'TRANSITION', text: 'the fox is at the river with no page taking it there' },
      ],
    },
    {
      pageNumber: 6,
      before: 'The owl flew home.',
      after: 'The owl flew back home.',
      findings: [],
    },
  ];

  it('puts each finding under its own page, labelled with the page it names', () => {
    const prompt = PB.buildTextDiffPrompt({ language: 'en' }, pairs);
    expect(pageBlock(prompt, 3)).toContain('p3 [MISMATCH] the picture shows the key in a hollow tree');
    expect(pageBlock(prompt, 3)).toContain('p4 [TRANSITION] the fox is at the river');
    expect(pageBlock(prompt, 6)).not.toContain('hollow tree, not under');
    expect(prompt.match(/\{[A-Z][A-Z0-9_]*\}/g) || []).toEqual([]);
  });

  it('carries no finding text when the page has none', () => {
    const prompt = PB.buildTextDiffPrompt({ language: 'en' }, [{ ...pairs[0], findings: [] }]);
    expect(prompt).not.toContain('hollow tree, not under a stone');
    expect(pageBlock(prompt, 3)).toContain('The fox hid the key in the hollow tree.');
  });
});

describe('refineStoryText — the diff prompt carries the findings the whole-page passes answered', () => {
  const textModels = require('../../server/lib/textModels');
  const original = textModels.callTextModelStreaming;
  const sent: Record<string, string> = {};

  const PAGES = [
    { pageNumber: 1, text: 'Die Karte ist alt und der Rand ist eingerissen.', sceneIntent: 'a map', sceneBrief: 'a map', planLine: '' },
    { pageNumber: 2, text: 'Der Hund bellt am Tor.', sceneIntent: 'a dog', sceneBrief: 'a dog', planLine: '' },
    { pageNumber: 3, text: 'Die Katze schläft im Korb.', sceneIntent: 'a cat', sceneBrief: 'a cat', planLine: '' },
  ];
  const STORY = { language: 'de', languageLevel: '1st-grade', pages: 3, characters: [{ id: 'c1', name: 'Alba', age: 8, isMainCharacter: true }], mainCharacters: ['c1'] };

  beforeAll(() => {
    textModels.callTextModelStreaming = async (prompt: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      sent[label] = prompt;
      let text = '';
      if (label === 'text_audit') {
        text = ['FAULT[CAUSE]: p1 - nothing says how the map tore.', 'FAULT[CAUSE]: p3 - nothing says why the cat is tired.', 'FAULTS: 2'].join('\n');
      } else if (label === 'text_audit_blind') text = 'FAULTS: 0';
      else if (label === 'text_refine') text = ['---ANALYSIS---', 'fixed', '---STORY TEXT---', '## Page 1', 'Die Karte ist alt, und der Rand riss beim Auspacken ein.'].join('\n');
      else if (label === 'text_diff' || label === 'text_lector') text = 'NONE';
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 10, output_tokens: 20, direct_cost: 0 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('lists the findings on the rewritten page and its neighbours, and no further', async () => {
    await refineStoryText(STORY, PAGES, {});
    const diff = sent.text_diff;
    expect(diff, 'the diff pass ran').toBeTruthy();
    const p1 = pageBlock(diff, 1);
    expect(p1).toContain('p1 [CAUSE] nothing says how the map tore.');
    // The word-budget counter's findings (the stub pages are under the floor).
    expect(p1).toContain('p1 [LENGTH]');
    // p2 neighbours p1: its finding is listed. p3 is two pages away: not.
    expect(p1).toContain('p2 [LENGTH]');
    expect(p1).not.toContain('why the cat is tired');
    expect(p1).not.toContain('p3 [');
    // Only the rewritten page is reviewed.
    expect(diff).not.toContain('--- Page 2 ---');
  });
});

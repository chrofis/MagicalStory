import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { trialWriterPrompt } from './helpers/trialWriterPrompt';
// @ts-ignore CommonJS
const B = require('../../server/lib/promptBuilders');
// @ts-ignore CommonJS
const textModels = require('../../server/lib/textModels');
// @ts-ignore CommonJS
const { refineStoryText } = require('../../server/lib/textRefine.js');

/**
 * Text-stage fixes, owner decisions 2026-10-16 (tasks/text-stage-fixes-2026-10-16.md,
 * docs/decisions.md 2026-10-16): no content loss, text may go beyond the picture,
 * the writer does not narrate plan staging, very young characters talk like
 * small children, the logic audit does not exempt premise facts.
 */
const story = { characters: [{ name: 'Mara', age: 2, isMain: true }], language: 'de', pages: 10, languageLevel: 'standard' };
const beatPages = [{ pageNumber: 1, planLine: 'wide, Mara, Mara pulls the rope, the sail is up' }];

describe('decisions 2026-10-16: the built prompts', () => {
  beforeAll(async () => { await require('../../server/services/prompts').loadPromptTemplates(); });

  it('3. the full writer and the trial writer both get the no-plan-staging rule, and the header no longer says "matches them, page for page"', () => {
    const full = B.buildStoryTextFromBeatsPrompt(story, beatPages, [], 'An arc.');
    expect(full).toContain(B.NO_PLAN_STAGING_RULE);
    expect(full).not.toContain('the text matches them, page for page');
    expect(full).not.toContain('the move that gets them there included');
    expect(trialWriterPrompt(story, 6)).toContain(B.NO_PLAN_STAGING_RULE);
  });

  it('4. the writers and the refine get the young-child speech rule', () => {
    const full = B.buildStoryTextFromBeatsPrompt(story, beatPages, [], 'An arc.');
    expect(full).toContain(B.YOUNG_CHILD_SPEECH_RULE);
    expect(trialWriterPrompt(story, 6)).toContain(B.YOUNG_CHILD_SPEECH_RULE);
    const refine = B.buildTextRefinePrompt(story, [{ pageNumber: 1, text: 'x' }], 'T1 f', 'arc', {});
    expect(refine).toContain(B.YOUNG_CHILD_SPEECH_RULE);
  });

  it('1+2. the refine states no content loss and that the text may go beyond the picture; the old "text moves" rule is gone', () => {
    const refine = B.buildTextRefinePrompt(story, [{ pageNumber: 1, text: 'x' }], 'T1 f', 'arc', {});
    expect(refine).toContain(B.NO_CONTENT_LOSS_RULE);
    expect(refine).toContain(B.TEXT_VS_PICTURE_RULE);
    expect(refine).not.toContain('the TEXT moves');
    expect(refine).not.toContain('PRECEDENCE: a figure the picture does not show');
    expect(refine).not.toMatch(/\{[A-Z_]{4,}\}/);
  });

  it('2. the audit files MISMATCH only for a contradiction; 5. its ASSUMED question does not exempt premise facts', () => {
    const audit = B.buildTextAuditPrompt(story, [{ pageNumber: 1, text: 'A page.', planLine: 'x' }], 'An arc.');
    expect(audit).toContain(B.TEXT_VS_PICTURE_RULE);
    expect(audit).toContain('A text that names a figure, object or action its picture does not show is not a MISMATCH');
    expect(audit).not.toContain('is a MISMATCH too, and so is a page that was given a passage naming a figure');
    expect(audit).toMatch(/even when the story states it as a premise/);
    expect(B.ARC_GIVEN_RULE).toContain('a premise fact is never exempt');
  });

  it('1. a repeated rhyme or callback is not a "coined saying" for any prose pass', () => {
    expect(B.buildTextAuditBlindPrompt(story, [{ pageNumber: 1, text: 'x' }])).toContain('refers back to');
    expect(B.buildTextRefinePrompt(story, [{ pageNumber: 1, text: 'x' }], 'T1 f', 'arc', {})).toContain('refers back to on another page belongs to the story');
  });

  it('buildTextDiffPrompt lists a standing finding apart from the answered ones', () => {
    const d = B.buildTextDiffPrompt({ language: 'de' }, [{
      pageNumber: 3, before: 'Eins.', after: 'Zwo.',
      findings: [{ pageNumber: 3, category: 'STYLE', text: 'KEPT-SIMILE', standing: true }, { pageNumber: 3, category: 'LANGUAGE', text: 'FIXED-ONE' }],
    }]);
    const pg = d.slice(d.indexOf('--- Page 3'));
    const answered = pg.slice(pg.indexOf('FINDINGS THE REWRITE ANSWERED'), pg.indexOf('RULED STANDS'));
    expect(answered).toContain('FIXED-ONE');
    expect(answered).not.toContain('KEPT-SIMILE');
    expect(pg.slice(pg.indexOf('RULED STANDS'), pg.indexOf('BEFORE:'))).toContain('KEPT-SIMILE');
  });
});

// Regression: gull story job_1792078014622_uh8tj6ht1 p3. The repair ruled
// "T1 STANDS" (a STYLE finding on a simile that explains a name), then the diff
// pass was handed T1 as a finding "the rewrite answered" and fixed the simile away.
describe('the diff pass is told which findings the repair ruled STANDS', () => {
  const original = textModels.callTextModelStreaming;
  let diffPrompt = '';
  const PAGES = [{ pageNumber: 1, text: 'Mia ging in den Garten. Ihr Flügel hängt wie eine Nudel.', sceneIntent: 'garden', sceneBrief: 'garden', planLine: '' }];
  const STORY = { language: 'de-ch', languageLevel: 'standard', pages: 1, characters: [{ id: 'c1', name: 'Mia', age: 6 }], mainCharacters: ['c1'] };
  const AUDITS = [
    { source: 'blind', ok: true, modelKey: 'grok-4.6', raw: 'FAULT[STYLE]: p1 — «Ihr Flügel hängt wie eine Nudel.» simile\nFAULT[LANGUAGE]: p1 — «Mia ging in den Garten.» wrong\nFAULTS: 2' },
    { source: 'arc-informed', ok: true, modelKey: 'gemini-3.1-pro', raw: 'FAULTS: 0' },
  ];
  const REPAIR = '---ANALYSIS---\nT1 STANDS: the simile explains the name\nT2 fixed on p1\n---STORY TEXT---\n## Page 1\nMia lief in den Garten. Ihr Flügel hängt wie eine Nudel.';
  beforeAll(() => {
    textModels.callTextModelStreaming = async (prompt: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      if (label === 'text_diff') diffPrompt = prompt;
      const text = label.includes('text_refine') ? REPAIR : label === 'text_diff' ? 'NONE' : 'FAULTS: 0';
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 1, output_tokens: 1, direct_cost: 0.01 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('hands T1 to the diff under RULED STANDS, not under ANSWERED', async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    diffPrompt = '';
    await refineStoryText(STORY, PAGES, { audits: AUDITS, jevOptions: { jevFallback: { step: 'start' } } });
    const pg = diffPrompt.slice(diffPrompt.indexOf('--- Page 1'));
    expect(pg).toContain('RULED STANDS');
    const standing = pg.slice(pg.indexOf('RULED STANDS'), pg.indexOf('BEFORE:'));
    const answered = pg.slice(pg.indexOf('FINDINGS THE REWRITE ANSWERED'), pg.indexOf('RULED STANDS'));
    expect(standing).toContain('Nudel');
    expect(answered).not.toContain('Nudel');
    expect(answered).toContain('[LANGUAGE]');
  });
});

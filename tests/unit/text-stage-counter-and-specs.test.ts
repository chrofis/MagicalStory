import { describe, it, expect, beforeAll } from 'vitest';

// Prompt audit 2026-09-23 (docs/audits/prompt-audit-2026-09-23/05-story-text.md):
//  - the reading level's sentence count and the page's paragraph shape were
//    never counted (pages ran 6-12 sentences against 3-6, p18 had 5 paragraphs);
//  - the lector had no reading level, and made two of its four changes harder
//    or wrong-meaning;
//  - the critics read a longer, different picture spec than the writer.
// Behaviour is pinned on the real builders and the real counter.
const PB = require('../../server/lib/promptBuilders');
const TR = require('../../server/lib/textRefine');
const { buildTextStagePictureSpecs } = require('../../server/lib/sceneMetadata');

const sentences = (n: number) => Array.from({ length: n }, (_, i) => `Der Hund lief ${i}.`).join(' ');

describe('measurePageText', () => {
  it('counts words, sentences and blank-line paragraphs', () => {
    expect(PB.measurePageText('Eins zwei. Drei!\n\nVier fünf?')).toEqual({ words: 5, sentences: 3, paragraphs: 2 });
  });

  it('keeps a quote that runs on into its speech tag as one sentence', () => {
    expect(PB.measurePageText('«Komm her!», rief sie. «Nein!» Er ging.').sentences).toBe(3);
  });

  it('counts an unterminated last line as a sentence and an empty page as nothing', () => {
    expect(PB.measurePageText('Ein Satz ohne Punkt').sentences).toBe(1);
    expect(PB.measurePageText('   ')).toEqual({ words: 0, sentences: 0, paragraphs: 0 });
  });
});

describe('buildWordBudgetFindings — sentences and paragraphs', () => {
  it('flags a page past the sentence ceiling by the words\' OVER tolerance, in one line', () => {
    // 1st-grade: 3-6 sentences, 0.5 over-tolerance → faulted above 9.
    const nine = TR.buildWordBudgetFindings([{ pageNumber: 1, text: sentences(9) }], '1st-grade');
    const ten = TR.buildWordBudgetFindings([{ pageNumber: 2, text: sentences(10) }], '1st-grade');
    expect(nine).toBe('');
    expect(ten.split('\n')).toHaveLength(1);
    expect(ten).toContain('FAULT[LENGTH]: p2');
    expect(ten).toContain('10 sentences, budget 3-6');
  });

  it('flags a page with more paragraphs than the shape allows', () => {
    const five = Array.from({ length: 5 }, () => 'Er lief. Sie lachte.').join('\n\n');
    const out = TR.buildWordBudgetFindings([{ pageNumber: 3, text: five }], '1st-grade');
    expect(out).toContain(`5 paragraphs, at most ${PB.PAGE_PARAGRAPHS.maxPerPage}`);
  });

  it('keeps the word-only finding and the under-budget finding as they were', () => {
    const long = Array.from({ length: 110 }, () => 'Wort').join(' ') + '.';
    expect(TR.buildWordBudgetFindings([{ pageNumber: 4, text: long }], '1st-grade')).toContain('page has 110 words, budget 25-70');
    expect(TR.buildWordBudgetFindings([{ pageNumber: 5, text: 'Kurz.' }], '1st-grade')).toContain('expand without padding');
  });
});

describe('built prompts', () => {
  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
  });
  const story = { language: 'de-ch', languageLevel: '1st-grade', characters: [{ name: 'Mara', age: 5 }] };
  const pages = [{ pageNumber: 1, text: 'Mara lief.\n\nSie lachte laut.', planLine: 'wide — Mara — Mara runs — she is home' }];

  it('the lector is told the reading level', () => {
    const p = PB.buildTextProofreadPrompt(story, pages);
    expect(p).toContain(PB.getReadingLevel('1st-grade', { pacing: false }));
    expect(p).not.toContain('{READING_LEVEL}');
  });

  it('the refine gets every page\'s counts and the one paragraph shape the writer gets', () => {
    const refine = PB.buildTextRefinePrompt(story, pages, '', 'An arc.');
    expect(refine).toContain('p1: 5 words, 2 sentences, 2 paragraphs');
    expect(refine).toContain(PB.paragraphShapeRule());
    const writer = PB.buildStoryTextFromBeatsPrompt(story, [{ pageNumber: 1, planLine: 'wide — Mara — Mara runs — she is home' }], [], 'An arc.');
    expect(writer).toContain(PB.paragraphShapeRule());
  });
});

describe('one picture spec for the writer, the audit and the refine', () => {
  const meta = (clothing: string) => `\n---METADATA---\n${JSON.stringify({ characters: [{ name: 'Hero', clothing }] })}`;
  const scenes = [
    { pageNumber: 1, text: 'a', sceneDescription: 'Hero — a small child wearing a red coat — waves (ART001).' + meta('standard'), outlineExtract: 'PLAN: p1' },
    { pageNumber: 2, text: 'b', sceneDescription: 'Hero — a small child wearing a red coat — runs to the gate.' + meta('standard'), outlineExtract: 'PLAN: p2' },
    { pageNumber: 3, text: 'c', sceneDescription: 'Hero — a small child wearing a knight costume — bows.' + meta('costumed:knight'), outlineExtract: 'PLAN: p3' },
  ];

  it('the critics read exactly what the writer read: ids gone, a repeated look dropped, a changed look kept', () => {
    const writer = buildTextStagePictureSpecs(scenes.map(s => ({ pageNumber: s.pageNumber, brief: s.sceneDescription })));
    const critics = TR.extractRefinablePages(scenes);
    for (const p of critics) expect(p.sceneBrief).toBe(writer.get(p.pageNumber));
    expect(writer.get(1)).toBe('Hero — a small child wearing a red coat — waves.');
    expect(writer.get(2)).toBe('Hero runs to the gate.');
    expect(writer.get(3)).toContain('knight costume');
  });
});

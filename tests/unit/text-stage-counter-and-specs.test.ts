import { describe, it, expect, beforeAll } from 'vitest';

// Prompt audit 2026-09-23 (docs/audits/prompt-audit-2026-09-23/05-story-text.md)
// and the owner decisions of the same day:
//  - sentences and paragraphs are counted; the 1st-grade band is 4-9 and only
//    a real outlier draws a LENGTH finding;
//  - the lector gets the reading level;
//  - writer, audit and refine read one compact picture spec (clothing kept,
//    in short form, from the outfit version the page selects);
//  - the audit asks whether each arc hint was applied;
//  - the pass after the repair is a grammar check that edits numbered
//    sentences and never writes a sentence neither version had.
// Behaviour is pinned on the real builders, the real counter and the real applier.
const PB = require('../../server/lib/promptBuilders');
const TR = require('../../server/lib/textRefine');
const { buildTextStagePictureSpecs } = require('../../server/lib/sceneMetadata');

const sentences = (n: number) => Array.from({ length: n }, (_, i) => `Der Hund lief ${i}.`).join(' ');

beforeAll(async () => {
  await require('../../server/services/prompts').loadPromptTemplates();
});

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
  it('flags only a real outlier: past the sentence ceiling by the words\' OVER tolerance, in one line', () => {
    // 1st-grade: 4-9 sentences since 2026-09-23 (owner: "rather lift the limit"),
    // 0.5 over-tolerance → faulted above 13. Run 6's writer pages ran 6-13.
    const thirteen = TR.buildWordBudgetFindings([{ pageNumber: 1, text: sentences(13) }], '1st-grade');
    const fourteen = TR.buildWordBudgetFindings([{ pageNumber: 2, text: sentences(14) }], '1st-grade');
    expect(thirteen).toBe('');
    expect(fourteen.split('\n')).toHaveLength(1);
    expect(fourteen).toContain('FAULT[LENGTH]: p2');
    expect(fourteen).toContain('14 sentences, budget 4-9');
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

  it('the arc-informed audit asks whether each hint was applied, only when there are hints', () => {
    const withHints = PB.buildTextAuditPrompt({ language: 'en' }, pages, 'An arc.', { arcHints: 'ISSUE: x → CHANGE: y' });
    const without = PB.buildTextAuditPrompt({ language: 'en' }, pages, 'An arc.');
    expect(withHints).toMatch(/^15\. HINT:/m);
    expect(without).not.toMatch(/HINT:/);
  });
});

describe('the compact picture spec: the outfit version the page selects, in short form', () => {
  const meta = (clothing: string) => `Prose for the image model.\n---METADATA---\n${JSON.stringify({ sceneIntent: 'The hero waves.', characters: [{ name: 'Hero', clothing }], objects: [] })}`;
  const story = {
    visualBible: {},
    clothingRequirements: { Hero: {
      standard: { used: true, description: 'A red coat with a hood, blue trousers, and a green scarf.' },
      costumed: { used: true, costume: 'knight', description: 'A silver knight costume with a tabard, and grey boots.' },
    } },
  };
  const scenes = [
    { pageNumber: 1, text: 'a', sceneDescription: meta('standard'), outlineExtract: 'PLAN: p1' },
    { pageNumber: 2, text: 'b', sceneDescription: meta('costumed:knight'), outlineExtract: 'PLAN: p2' },
  ];

  it('names garment and colour, cuts the describing tail, and follows the version per page', () => {
    const specs = buildTextStagePictureSpecs(scenes.map(s => ({ pageNumber: s.pageNumber, brief: s.sceneDescription })), story);
    expect(specs.get(1)).toContain('Hero: wears red coat, blue trousers, green scarf');
    expect(specs.get(2)).toContain('Hero: wears silver knight costume, grey boots');
    expect(specs.get(1)).not.toContain('Prose for the image model');
    for (const p of TR.extractRefinablePages(scenes, story)) expect(p.sceneBrief).toBe(specs.get(p.pageNumber));
  });
});

describe('the grammar check edits numbered sentences only', () => {
  const before = new Map([[1, 'Der Hund bellt. Die Katze schläft am Fenster.']]);
  const pages = [{ pageNumber: 1, text: 'Der Hund bellte laut. Die Katze schlaeft.' }];

  it('fixes a sentence within a few words and restores a writer sentence word for word', () => {
    const { edits } = TR.parseDiffEdits('PAGE 1 FIX A2: Die Katze schläft.\nPAGE 1 RESTORE B1 AFTER A0\nNONE');
    const r = TR.applyDiffEdits(pages, before, edits);
    expect(r.pages[0].text).toBe('Der Hund bellt. Der Hund bellte laut. Die Katze schläft.');
    expect(r.applied.map((a: any) => a.kind)).toEqual(['fix', 'restore']);
    expect(r.applied[1].restored).toEqual(['Der Hund bellt.']);
  });

  it('never ships a sentence neither version had', () => {
    const { edits } = TR.parseDiffEdits('PAGE 1 FIX A1: Ein Vogel flog über das ganze grosse Dorf.\nPAGE 1 FIX A2: Die Katze schläft. Dann wacht sie auf.');
    const r = TR.applyDiffEdits(pages, before, edits);
    expect(r.pages[0].text).toBe(pages[0].text);
    expect(r.dropped.map((d: any) => d.reason)).toEqual(['rewrites-the-sentence', 'not-one-sentence']);
  });

  it('refuses a sentence number that does not exist, and reports a free-text line as unreadable', () => {
    const { edits, unparsed } = TR.parseDiffEdits("PAGE 1 RESTORE B9 AFTER A1\nPAGE 1: 'x' -> 'y'");
    const r = TR.applyDiffEdits(pages, before, edits);
    expect(r.dropped[0].reason).toBe('no-such-sentence');
    expect(unparsed).toHaveLength(1);
  });

  it('shows the pass each page as numbered sentences', () => {
    const p = PB.buildTextDiffPrompt({ language: 'de' }, [{ pageNumber: 1, before: before.get(1), after: pages[0].text, findings: [] }]);
    expect(p).toContain('B2: Die Katze schläft am Fenster.');
    expect(p).toContain('A1: Der Hund bellte laut.');
  });
});

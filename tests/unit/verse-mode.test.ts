/**
 * VERSE MODE (docs/decisions.md 2026-11-07): the learning topic `rhyming` means the book is
 * TOLD in rhyming couplets. One constant (VERSE_FORM_RULE) reaches the page writers, the
 * rewrite passes and the critics for this topic and for no other; the passes that quote
 * sentences keep the line breaks; the length counters do not punish stanzas.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import { trialWriterPrompt } from './helpers/trialWriterPrompt';

const PB = require('../../server/lib/promptBuilders');
const TR = require('../../server/lib/textRefine');
const { loadPromptTemplates } = require('../../server/services/prompts');

const verseInput = (band: string) => ({
  pages: 6, language: 'de-CH', languageLevel: band, storyCategory: 'educational', storyTopic: 'rhyming',
  storyDetails: 'Ein Kind sucht seine Muetze.', textForm: 'verse',   // stamped by the page writer (markVerseWriter)
  characters: [{ id: 'a', name: 'Levin', age: 5 }], mainCharacters: ['a'],
});
const plainInput = (band: string) => ({ ...verseInput(band), storyTopic: 'seasons', textForm: undefined });
const PAGES = [{ pageNumber: 1, text: 'Der Mond steht hoch,\nder Wald ist still.\n\nDa kommt ein Fuchs,\ner will, was er will.' }];
const BANDS = ['1st-grade', 'advanced'];
const MARK = 'VERSE FORM.';

beforeAll(async () => { await loadPromptTemplates(); });

describe('VERSE_FORM_RULE reaches every prompt for the rhyming topic only', () => {
  for (const band of BANDS) {
    const builders: Record<string, (i: any) => string> = {
      'full writer': (i) => PB.buildStoryTextFromBeatsPrompt(i, [], [], '1. A story.'),
      'refine': (i) => PB.buildTextRefinePrompt(i, PAGES, '', '1. A story.'),
      'lector': (i) => PB.buildTextProofreadPrompt(i, PAGES),
      'grammar check': (i) => PB.buildTextDiffPrompt(i, [{ pageNumber: 1, before: PAGES[0].text, after: PAGES[0].text, findings: [] }]),
      'blind audit': (i) => PB.buildTextAuditBlindPrompt(i, PAGES),
      'arc audit': (i) => PB.buildTextAuditPrompt(i, PAGES, '1. A story.'),
      'trial writer': (i) => trialWriterPrompt(i, 6),
    };
    for (const [name, build] of Object.entries(builders)) {
      it(`${name} (${band}): carries the rule for rhyming, not for another topic, no stray placeholder`, () => {
        const v = build(verseInput(band));
        expect(v).toContain(MARK);
        expect(v).toContain('rhyming couplets');
        expect(v).not.toMatch(/\{VERSE_FORM\}/);
        const p = build(plainInput(band));
        expect(p).not.toContain(MARK);
        expect(p).not.toMatch(/\{VERSE_FORM\}/);
      });
    }
  }

  it('the role tails differ: writers write, rewrite passes keep, the audit flags', () => {
    const w = PB.verseFormFor(verseInput('1st-grade'), 'write');
    expect(w).toContain(PB.VERSE_FORM_RULE);
    expect(PB.verseFormFor(verseInput('1st-grade'), 'rewrite')).toContain('keep the couplets');
    expect(PB.verseFormFor(verseInput('1st-grade'), 'audit')).toContain('do not rhyme');
    expect(PB.verseFormFor(plainInput('1st-grade'), 'audit')).toBe('');
    expect(() => PB.verseFormFor(verseInput('1st-grade'), 'nope')).toThrow();
  });

  it('the rule keeps rhyme a form, never a plot device', () => {
    expect(PB.VERSE_FORM_RULE).toMatch(/only the FORM/);
    expect(PB.VERSE_FORM_RULE).toMatch(/no character, game, rule or spell is built on rhyming/);
  });

  it('the [rhyming] guide reaches the writer as form, and no longer asks to teach rhyming words', () => {
    const guide = PB.getTeachingGuide('educational', 'rhyming');
    expect(guide).toContain('told in rhyming verse');
    expect(guide).toContain('FORM');
    expect(guide).not.toMatch(/Which word rhymes with/i);
    expect(guide).not.toMatch(/changing the first letter/i);
  });
});

describe('page text with line breaks survives the parsers', () => {
  it('parseRefinedText keeps single and blank-line breaks inside a page', () => {
    const raw = `---STORY TEXT---\n## Page 1\n${PAGES[0].text}\n\n## Page 2\nZeile eins,\nZeile zwei.\n`;
    const parsed = PB.parseRefinedText(raw, [1, 2]);
    expect(parsed.pages[0].text).toBe(PAGES[0].text);
    expect(parsed.pages[1].text).toBe('Zeile eins,\nZeile zwei.');
  });
  it('pageSentences / measurePageText count stanzas as paragraphs and keep a sentence its lines', () => {
    const s = PB.pageSentences(PAGES[0].text);
    expect(s[0].text).toBe('Der Mond steht hoch,\nder Wald ist still.');
    expect(PB.measurePageText(PAGES[0].text).paragraphs).toBe(2);
  });
  it('the overlay renderer splits on newline runs, so every verse line starts its own line', () => {
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../server/lib/textOverlayRenderer.js'), 'utf8');
    expect(src).toContain('.split(/\\n+/)');
  });
});

describe('passes that quote sentences keep the verse lines', () => {
  const page = (text: string) => [{ pageNumber: 1, text }];
  it('lector: a correction carrying " / " gets its breaks back; a flat one is dropped', () => {
    const f = { pageNumber: 1, quote: 'Der Mond steht hoch, / der Wald ist still.', correction: 'Der Mond steht hoch, / der Wald ist stille.' };
    const ok = TR.applyLectorFindings(page(PAGES[0].text), [f], { verse: true });
    expect(ok.applied).toHaveLength(1);
    expect(ok.pages[0].text).toBe('Der Mond steht hoch,\nder Wald ist stille.\n\nDa kommt ein Fuchs,\ner will, was er will.');
    const flat = TR.applyLectorFindings(page(PAGES[0].text), [{ ...f, correction: 'Der Mond steht hoch, der Wald ist stille.' }], { verse: true });
    expect(flat.applied).toHaveLength(0);
    expect(flat.dropped[0].reason).toBe('verse-line-breaks');
  });
  it('lector: a single-line correction is applied in place', () => {
    const r = TR.applyLectorFindings(page(PAGES[0].text), [{ pageNumber: 1, quote: 'der Wald ist still', correction: 'der Wald ist stille' }], { verse: true });
    expect(r.pages[0].text).toContain('Der Mond steht hoch,\nder Wald ist stille.');
  });
  it('grammar check: the prompt shows " / " and a FIX must keep the line count', () => {
    const p = PB.buildTextDiffPrompt(verseInput('1st-grade'), [{ pageNumber: 1, before: PAGES[0].text, after: PAGES[0].text, findings: [] }]);
    expect(p).toContain('A1: Der Mond steht hoch, / der Wald ist still.');
    const edits = (text: string) => [{ kind: 'fix', pageNumber: 1, afterIndex: 1, text }];
    const ok = TR.applyDiffEdits(page(PAGES[0].text), new Map(), edits('Der Mond steht hoch, / der Wald ist stille.'), { verse: true });
    expect(ok.pages[0].text.startsWith('Der Mond steht hoch,\nder Wald ist stille.')).toBe(true);
    const flat = TR.applyDiffEdits(page(PAGES[0].text), new Map(), edits('Der Mond steht hoch, der Wald ist stille.'), { verse: true });
    expect(flat.applied).toHaveLength(0);
    expect(flat.dropped[0].reason).toBe('verse-line-breaks');
  });
  it('the one-sentence-paragraph counter does not fire on stanzas of one sentence', () => {
    const t = 'Der Mond steht hoch,\nder Wald ist still.\n\nDa kommt ein Fuchs,\ner will, was er will.\n\nEr geht nach Haus,\ndie Nacht ist aus.';
    expect(TR.findOneSentenceParagraphs([{ pageNumber: 1, text: t }]).length).toBeGreaterThan(0);
    expect(TR.findOneSentenceParagraphs([{ pageNumber: 1, text: t }], { verse: true })).toEqual([]);
    expect(TR.buildOneSentenceParagraphFindings([{ pageNumber: 1, text: t }], { verse: true })).toBe('');
  });
});

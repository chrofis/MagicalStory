/**
 * Pipeline review 2026-11-13 finding 5; owner 2026-11-14: "Eval must be same as creation of image!!"
 * The painter is told who else to add from the page's `population` (promptBuilders.buildRequiredCastRule:
 * no one, a few passers-by, a crowd, animals ...). The book reviewer was only told the cast, so correct
 * passers-by came back as extra characters and paid redraws. The reviewer's BRIEF line now carries the
 * painter's SAME sentence for the SAME population value.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const bookAudit = require_('../../server/lib/bookAudit.js');
const PB = require_('../../server/lib/promptBuilders.js');
const prompts = require_('../../server/services/prompts.js');
beforeAll(async () => { await prompts.loadPromptTemplates(); });

const POPS = ['cast_only', 'sparse', 'ambient', 'crowd', 'wildlife', 'creature_crowd'];
const scene = (population: string | null) => ({
  pageNumber: 4,
  sceneCharacters: [{ name: 'Mara' }],
  sceneMetadata: { sceneIntent: 'Mara buys bread', ...(population ? { population } : {}) },
});
const story = { characters: [{ id: 'c1', name: 'Mara' }], visualBible: null, mainCharacters: ['c1'] };

describe('the reviewer reads who else the painter was told to add', () => {
  for (const pop of POPS) {
    it(`${pop}: the brief carries the painter's own sentence`, () => {
      const brief = bookAudit.auditPageBrief(scene(pop), story);
      const painter = PB.buildRequiredCastRule(pop);
      expect(brief.background).toBe(PB.requiredCastBackgroundText(pop));
      // the reviewer's sentence is literally inside the painter's REQUIRED CAST line
      expect(painter).toContain(brief.background);
      const line = bookAudit.briefLine('PAGE 4', brief);
      expect(line).toContain(`who else the painter was told to add: ${brief.background.replace(/[.\s]+$/, '')}`);
    });
  }

  it('a brief with no population is cast-only for both (the same normalisation)', () => {
    expect(bookAudit.auditPageBrief(scene(null), story).background).toBe('no one else is added.');
  });

  it('an unknown population fails loudly instead of guessing', () => {
    expect(() => PB.requiredCastBackgroundText('festival')).toThrow(/unknown population/);
  });

  it('the review prompt tells the reader how to use the line', () => {
    expect(prompts.PROMPT_TEMPLATES.bookAudit).toMatch(/Where it says who else the painter was told to add, the unnamed people or creatures that sentence asks for belong in the picture and are never an extra character/);
  });
});

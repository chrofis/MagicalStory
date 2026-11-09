/**
 * THE BOOK AUDIT'S D3 PLACEHOLDERS (2026-11-09, docs/decisions.md): {MAIN_CHARACTERS}, {LOGIC_*} and {BUY_CRITERION}
 * are filled for EVERY chunk call from one per-audit fill; the builder's own placeholders survive; the logic read
 * still renders the same MAIN_CHARACTERS text after it moved into promptBuilders.mainCharactersText.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const bookAudit = require_('../../server/lib/bookAudit.js');
const PB = require_('../../server/lib/promptBuilders.js');
const prompts = require_('../../server/services/prompts.js');

const SIX = ['MAIN_CHARACTERS', 'LOGIC_OBSTACLE', 'LOGIC_KNOWLEDGE', 'LOGIC_PLACE', 'LOGIC_CONTRADICTION', 'BUY_CRITERION'];
beforeAll(async () => { await prompts.loadPromptTemplates(); });

const story = (mains: string[]) => ({
  id: 's1',
  mainCharacters: mains.map((_, i) => `c${i + 1}`),
  characters: [
    { id: 'c1', name: 'Mara', age: 7 }, { id: 'c2', name: 'Tom', age: 8 }, { id: 'c3', name: 'Fox', age: 30 },
  ].map(c => c),
}) as any;
const withMains = (n: number) => { const s = story([]); s.mainCharacters = ['c1', 'c2'].slice(0, n); return s; };
const chunk = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ pageNumber: from + i, text: 't', part: {}, brief: null }));
const render = (s: any, c = chunk(1, 3)) =>
  bookAudit.buildChunkInstructions(prompts.PROMPT_TEMPLATES.bookAudit, c, null, bookAudit.bookAuditStoryFill(s)).instructions as string;

describe('book-audit.txt D3 fill', () => {
  for (const n of [1, 2]) {
    it(`${n} main(s): all six filled, nothing left over, questions present`, () => {
      const s = withMains(n);
      const fill = bookAudit.bookAuditStoryFill(s);
      for (const k of SIX) expect(fill[k], k).toBeTruthy();
      const text = render(s);
      for (const k of SIX) expect(text).toContain(fill[k]);
      expect(text).not.toMatch(/\{[A-Z_]+\}/);
      expect(text).toContain('8. CHILD');
      expect(text).toContain('9. PARENT');
      expect(text).toContain('10. SHOW-STOPPER');
      expect(text).toContain('write one line for each picture that must change');
      expect(text).toContain('This batch covers page(s) 1, 2, 3');
      expect(text).not.toContain('VERDICT');
    });
  }
  it('two mains are named together', () => {
    expect(bookAudit.bookAuditStoryFill(withMains(2)).MAIN_CHARACTERS).toBe('Mara, Tom (together: the deciding act may be any one of them)');
    expect(bookAudit.bookAuditStoryFill(withMains(1)).MAIN_CHARACTERS).toBe('Mara');
  });
  it('a 2-call book has the six filled in both calls', () => {
    const fill = bookAudit.bookAuditStoryFill(withMains(1));
    for (const c of [chunk(1, 24), chunk(25, 30)]) {
      const t = bookAudit.buildChunkInstructions(prompts.PROMPT_TEMPLATES.bookAudit, c, null, fill).instructions as string;
      for (const k of SIX) expect(t).toContain(fill[k]);
      expect(t).not.toMatch(/\{[A-Z_]+\}/);
    }
  });
  it('the builder placeholders survive (ROUTE_TAG, BOOK_REVIEW_RULES) in a review', () => {
    const t = bookAudit.buildChunkInstructions(prompts.PROMPT_TEMPLATES.bookAudit, chunk(1, 2),
      { title: 'T', hasRepairedPages: false }, bookAudit.bookAuditStoryFill(withMains(1))).instructions as string;
    expect(t).toContain('[<ROUTE>]');
    expect(t).not.toMatch(/\{[A-Z_]+\}/);
  });
  it('fails loudly without a story or without the logic-read template', () => {
    expect(() => bookAudit.bookAuditStoryFill(null)).toThrow();
    expect(() => bookAudit.buildChunkInstructions(prompts.PROMPT_TEMPLATES.bookAudit, chunk(1, 1), null, null)).toThrow();
  });
  it('the LOGIC_* texts are the logic-read template lines, verbatim', () => {
    const q = PB.logicReadQuestions();
    for (const id of ['OBSTACLE', 'KNOWLEDGE', 'PLACE', 'CONTRADICTION']) {
      expect(prompts.PROMPT_TEMPLATES.storyTextLogicRead).toContain(`${id}. ${q['LOGIC_' + id]}`);
    }
  });
});

describe('logic read keeps its MAIN_CHARACTERS text', () => {
  it('renders the same sentence as before the refactor', () => {
    const one = PB.buildTextLogicReadPrompt(withMains(1), [{ pageNumber: 1, text: 'x' }]);
    expect(one).toContain('The main character is: Mara.');
    const two = PB.buildTextLogicReadPrompt(withMains(2), [{ pageNumber: 1, text: 'x' }]);
    expect(two).toContain('The main character is: Mara, Tom (together: the deciding act may be any one of them).');
    const none = PB.buildTextLogicReadPrompt({ characters: [] }, [{ pageNumber: 1, text: 'x' }]);
    expect(none).toContain('The main character is: the character the story follows.');
    const unmarked = PB.buildTextLogicReadPrompt({ characters: [{ name: 'Zed' }, { name: 'Y' }] }, []);
    expect(unmarked).toContain('The main character is: Zed.');
  });
});

import { describe, it, expect } from 'vitest';

// The page-text writer emits ---ANALYSIS--- / ---STORY TEXT--- / ---TITLE---,
// with TITLE last. parseRefinedText only stops the final page at that block
// when TITLE is named as a trailing marker. Production names it
// (beatsPipeline.js:3126); the two Test Lab stages that replay the same call
// did not, so the last page carried the candidate list and the pick line as if
// it were prose, and no title was extracted at all.
const { parseRefinedText, parseTitleBlock } = require('../../server/lib/promptBuilders');

const response = [
  '---ANALYSIS---',
  'Page 1 opens the book. Page 2 closes it.',
  '',
  '---STORY TEXT---',
  '## Page 1',
  'The main character knelt in the leaves and dug with both hands.',
  '',
  '## Page 2',
  'The light fell warm across the square, and the friends stood together.',
  '',
  '---TITLE---',
  'TITLE_CANDIDATES:',
  '1. A first title',
  '2. A second title',
  '3. A third title',
  '',
  'TITLE_PICK: 1 — the first names what the book is about and gives away no ending.',
].join('\n');

const pages = [1, 2];

describe('the writer response parses with TITLE as a trailing marker', () => {
  it('stops the last page before the title block', () => {
    const parsed = parseRefinedText(response, pages, 'STORY TEXT', ['TITLE']);
    const last = parsed.pages.find((p: any) => p.pageNumber === 2);
    expect(last.text).toBe('The light fell warm across the square, and the friends stood together.');
    expect(last.text).not.toContain('TITLE_CANDIDATES');
    expect(last.text).not.toContain('TITLE_PICK');
  });

  it('parses every expected page', () => {
    const parsed = parseRefinedText(response, pages, 'STORY TEXT', ['TITLE']);
    expect(parsed.pages.map((p: any) => p.pageNumber)).toEqual([1, 2]);
    expect(parsed.missing).toEqual([]);
  });

  it('keeps the analysis out of the pages', () => {
    const parsed = parseRefinedText(response, pages, 'STORY TEXT', ['TITLE']);
    expect(parsed.pages[0].text).not.toContain('---ANALYSIS---');
  });

  // The bug itself, pinned: drop the marker and the last page absorbs the block.
  it('without the marker the last page swallows the title block', () => {
    const parsed = parseRefinedText(response);
    const last = parsed.pages[parsed.pages.length - 1];
    expect(last.text).toContain('TITLE_CANDIDATES');
  });
});

// Stopping the page is only half of it: parseRefinedText never reads the block,
// so the title comes from parseTitleBlock. One helper, shared by the beats
// pipeline and the Lab stages, so the two cannot drift.
describe('parseTitleBlock reads the writer\'s pick', () => {
  it('ships the picked candidate', () => {
    const t = parseTitleBlock(response);
    expect(t.title).toBe('A first title');
    expect(t.titleCandidates).toEqual(['A first title', 'A second title', 'A third title']);
    expect(t.titleJudge.pick).toBe(0);
    expect(t.outOfRange).toBeNull();
  });

  it('falls back to a stable pick when TITLE_PICK is out of range', () => {
    const t = parseTitleBlock('---TITLE---\nTITLE_CANDIDATES:\n1. One\n2. Two\n\nTITLE_PICK: 9 — nope');
    expect(t.titleJudge).toBeNull();
    expect(['One', 'Two']).toContain(t.title);
    expect(t.outOfRange).toBe('9 of 2');
  });

  it('returns no title when there is no block', () => {
    const t = parseTitleBlock('pages only, no title block here');
    expect(t.title).toBeNull();
    expect(t.titleCandidates).toEqual([]);
  });

  it('survives a writer that ignored the numbered format', () => {
    expect(parseTitleBlock('---TITLE---\nA Plain Title Line').title).toBe('A Plain Title Line');
  });
});

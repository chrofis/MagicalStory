import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only';
const { buildStoryScope, buildIdeaLandmarksSection } = require(path.join(ROOT, 'server/routes/storyIdeas'));

const TEMPLATES = ['generate-story-idea-single.txt', 'generate-story-ideas.txt']
  .map(f => [f, fs.readFileSync(path.join(ROOT, 'prompts', f), 'utf-8')] as [string, string]);

describe('{STORY_SCOPE}', () => {
  it('short band (<=10 pages) is four sentences in one paragraph', () => {
    for (const pages of [1, 8, 10]) {
      const s = buildStoryScope(pages);
      expect(s).toContain('This is a short book');
      expect(s).toContain('four sentences in one paragraph');
      expect(s).toContain('one place, one creature or thing, one want, one obstacle');
    }
  });

  it('journey band (11-20 pages) is six sentences in one paragraph', () => {
    for (const pages of [11, 16, 20]) {
      const s = buildStoryScope(pages);
      expect(s).toContain('This is a journey');
      expect(s).toContain('six sentences in one paragraph');
      expect(s).toContain('two or three places');
      expect(s).toContain('one turn');
    }
  });

  it('world band (21+ pages) is nine sentences in TWO paragraphs', () => {
    for (const pages of [21, 25, 40]) {
      const s = buildStoryScope(pages);
      expect(s).toContain('This is a world');
      expect(s).toContain('nine sentences in two paragraphs');
      expect(s).toContain('a second thread that crosses the main one');
    }
  });

  // Reversal of the 2026-09-14 "a long book gets the same short back-cover text
  // as a short one" line (owner, 2026-09-21): the count now FOLLOWS the scope,
  // and it is a count, never a range.
  it('every band names its own sentence count and no fixed four-to-six range', () => {
    const counts = [[10, 'four'], [16, 'six'], [24, 'nine']] as [number, string][];
    for (const [pages, word] of counts) {
      const s = buildStoryScope(pages);
      expect(s).toContain(`${word} sentences`);
      expect(s).not.toMatch(/four to six|three to five/i);
      expect(s).toContain('Write the sentence count this scope names, no more and no less');
      expect(s).toContain('No sentence runs past about 30 words');
      expect(s).not.toMatch(/beats?|events|sentences max|pages/i);
    }
  });

  it('the three bands are distinct and only the world band is two paragraphs', () => {
    const [short, journey, world] = [10, 16, 25].map(buildStoryScope);
    expect(new Set([short, journey, world]).size).toBe(3);
    expect(short).toContain('one paragraph');
    expect(journey).toContain('one paragraph');
    expect(world).toContain('two paragraphs');
  });

  it('both sibling templates carry {STORY_SCOPE} and no page-count block', () => {
    for (const [name, text] of TEMPLATES) {
      expect(text, name).toContain('{STORY_SCOPE}');
      expect(text, name).not.toContain('STORY LENGTH');
      expect(text, name).not.toContain('{STORY_LENGTH_CATEGORY}');
      // The fixed sentence range is gone: length is the scope's job now.
      expect(text, name).not.toMatch(/four to six sentences/i);
      expect(text, name).toContain('the sentence count the scope names');
      // The ending is the picture, not the cost line.
      expect(text, name).not.toContain('The last sentence states what failing costs.');
      expect(text, name).toContain('The last sentence is the main character in the act');
      expect(text, name).toContain('Every sentence carries one concrete thing a reader can see');
      // CUT labelling: "act" is a label, a cost may stand anywhere, both are kept.
      expect(text, name).toContain('"cost" or "act"');
      expect(text, name).toContain('Setup, hook, promise, cost and act are kept.');
    }
  });
});

describe('idea landmarks section', () => {
  const rows = [
    { name: 'A', type: 'Castle', wikipediaExtract: 'First sentence here. Second sentence that must not ship. Third.' },
    { name: 'B', type: 'Bridge', photoDescription: 'Only one line' },
    { name: 'C', type: 'Tower', wikipediaExtract: 'Never reaches the prompt.' },
  ];

  it('ships at most two landmarks, one line each, first sentence only', () => {
    const out = buildIdeaLandmarksSection(rows);
    const lines = out.split('\n');
    expect(lines[0]).toBe('**LOCAL LANDMARKS (use one or two)**');
    expect(lines.length).toBe(3);
    expect(out).toContain('- A (Castle): First sentence here.');
    expect(out).not.toContain('Second sentence');
    expect(out).not.toContain('C (Tower)');
  });

  it('is empty when there are no landmarks', () => {
    expect(buildIdeaLandmarksSection([])).toBe('');
    expect(buildIdeaLandmarksSection(undefined)).toBe('');
  });
});

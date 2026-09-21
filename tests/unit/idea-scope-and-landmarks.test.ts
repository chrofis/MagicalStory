import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only';
const { buildStoryScope, buildIdeaLandmarksSection } = require(path.join(ROOT, 'server/routes/storyIdeas'));

const TEMPLATES = ['generate-story-idea-single.txt', 'generate-story-ideas.txt']
  .map(f => [f, fs.readFileSync(path.join(ROOT, 'prompts', f), 'utf-8')] as [string, string]);

describe('{STORY_SCOPE}', () => {
  it('short band (<=10 pages) names one place and one want', () => {
    for (const pages of [1, 8, 10]) {
      const s = buildStoryScope(pages);
      expect(s).toContain('This is a short book');
      expect(s).toContain('one place, one want, one thing in the way');
    }
  });

  it('journey band (11-20 pages) names two or three places', () => {
    for (const pages of [11, 16, 20]) {
      const s = buildStoryScope(pages);
      expect(s).toContain('This is a journey');
      expect(s).toContain('two or three places');
    }
  });

  it('world band (21+ pages) names several places and a second thread', () => {
    for (const pages of [21, 40]) {
      const s = buildStoryScope(pages);
      expect(s).toContain('This is a world');
      expect(s).toContain('a second thread crosses the main one');
    }
  });

  it('every band keeps the four-to-six-sentence line and names no beats or events', () => {
    for (const pages of [10, 16, 24]) {
      const s = buildStoryScope(pages);
      expect(s).toContain('four to six sentences whatever the scope');
      expect(s).not.toMatch(/\bbeats?\b|\bevents\b|\bsentences max\b|\bpages\b/i);
    }
  });

  it('both sibling templates carry {STORY_SCOPE} and no page-count block', () => {
    for (const [name, text] of TEMPLATES) {
      expect(text, name).toContain('{STORY_SCOPE}');
      expect(text, name).not.toContain('STORY LENGTH');
      expect(text, name).not.toContain('{STORY_LENGTH_CATEGORY}');
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

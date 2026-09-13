/**
 * The beats brief carries relationship NAMES and TYPE.
 *
 * Production runs the beats chain. Its `{STORY_BRIEF}` used to render
 * `relationshipTexts` alone, keyed by the raw id pair, so the arc author saw
 *
 *     Relationships:
 *       1-2: They share a room.
 *
 * — no names, no relationship type, and a stale pair whose ids no longer
 * resolve leaked through as a raw key. The unified writer prompt had the named
 * form all along. Both now read through one renderer,
 * `buildRelationshipLines` (docs/decisions.md, 2026-09-13).
 *
 * These pin behaviour, not wording: that names and type are present, that no
 * raw id key is ever emitted, and that the unified path still renders its
 * named lines.
 */
import { describe, it, expect } from 'vitest';

const {
  buildRelationshipLines,
  buildStoryContextFields,
} = require('../../server/lib/promptBuilders');

const characters = [
  { id: 1, name: 'Leo', age: 7, gender: 'boy' },
  { id: 2, name: 'Mia', age: 5, gender: 'girl' },
  { id: 3, name: 'Oma Ruth', age: 70, gender: 'woman' },
];

const inputData = {
  title: 'The Attic Door',
  storyType: 'adventure',
  language: 'en',
  characters,
  mainCharacters: [1, 2],
  relationships: {
    '1-2': 'Brother of',
    '2-1': 'Sister of',
    '1-3': 'Grandson of',
    '9-4': 'Friend of',          // stale: neither id resolves
    '2-3': 'Not Known to',       // explicitly unknown
  },
  relationshipTexts: {
    '1-2': 'They share a room.',
    '1-3': 'He visits every summer.',
    '9-4': 'stale entry',
  },
  storyDetails: 'A door in the attic that was never there before.',
};

describe('buildRelationshipLines', () => {
  it('renders names and the relationship type, with the note appended', () => {
    const lines = buildRelationshipLines(inputData);
    expect(lines).toContain('Leo is Brother of Mia. They share a room.');
    expect(lines).toContain('Leo is Grandson of Oma Ruth. He visits every summer.');
  });

  it('renders both directions of a reciprocal pair — they are different facts', () => {
    expect(buildRelationshipLines(inputData)).toContain('Mia is Sister of Leo');
  });

  it('drops a pair whose ids do not resolve to a character', () => {
    const lines = buildRelationshipLines(inputData).join('\n');
    expect(lines).not.toMatch(/\b9-4\b/);
    expect(lines).not.toContain('stale entry');
  });

  it('drops a "Not Known to" pair', () => {
    expect(buildRelationshipLines(inputData).join('\n')).not.toContain('Not Known to');
  });

  it('keeps a note whose pair has no type, rendered with names and no invented type', () => {
    const lines = buildRelationshipLines({
      characters,
      relationships: {},
      relationshipTexts: { '1-2': 'They met at school.', '2-1': 'They met at school.' },
    });
    expect(lines).toEqual(['Leo and Mia: They met at school.']);   // deduped by unordered pair
  });

  it('drops a note whose ids do not resolve rather than emitting a raw key', () => {
    expect(buildRelationshipLines({
      characters,
      relationships: {},
      relationshipTexts: { '9-4': 'stale entry' },
    })).toEqual([]);
  });

  it('returns nothing when there are no relationships at all', () => {
    expect(buildRelationshipLines({ characters })).toEqual([]);
  });
});

describe('the beats STORY_BRIEF', () => {
  const brief = buildStoryContextFields(inputData).STORY_BRIEF;

  it('names the characters and states the relationship type', () => {
    expect(brief).toContain('Leo is Brother of Mia. They share a room.');
    expect(brief).toContain('Leo is Grandson of Oma Ruth. He visits every summer.');
  });

  it('never emits a raw id-pair key', () => {
    const relBlock = brief.slice(brief.indexOf('Relationships:'));
    expect(relBlock).not.toMatch(/^\s*-?\s*\d+-\d+:/m);
  });

  it('omits the Relationships block entirely when nothing resolves', () => {
    const bare = buildStoryContextFields({
      ...inputData,
      relationships: { '9-4': 'Friend of' },
      relationshipTexts: { '9-4': 'stale entry' },
    }).STORY_BRIEF;
    expect(bare).not.toContain('Relationships:');
    expect(bare).not.toContain('stale entry');
  });
});

describe('the unified writer prompt is unchanged by the shared renderer', () => {
  it('still renders its named lines and still drops the stale pair', async () => {
    const { buildUnifiedStoryPrompt } = require('../../server/lib/promptBuilders');
    const built = await buildUnifiedStoryPrompt(inputData);
    const text = typeof built === 'string' ? built : JSON.stringify(built);
    expect(text).toContain('- Leo is Brother of Mia. They share a room.');
    expect(text).toContain('- Mia is Sister of Leo');
    expect(text).toContain('- Leo is Grandson of Oma Ruth. He visits every summer.');
    expect(text).not.toContain('stale entry');
  });
});

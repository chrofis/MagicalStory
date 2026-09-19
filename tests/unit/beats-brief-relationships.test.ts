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
const {
  isNotSetRelationship,
  isStrangersRelationship,
  getNotSetRelationship,
  getStrangersRelationship,
} = require('../../server/lib/relationships');
const SENTINELS = require('../../shared/relationship-sentinels.json');

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

  it('drops a legacy "Not Known to" pair — the English path is unchanged', () => {
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

// The fourth case here pinned buildUnifiedStoryPrompt, the pre-beats unified
// writer. That builder and its two templates were deleted 2026-09-15 as
// unreachable (docs/decisions.md); the renderer contract it exercised is
// already pinned by the buildStoryContextFields cases above, which is where
// every live writer stage reads STORY_BRIEF from.

/**
 * THE TWO SENTINELS (owner 2026-09-19).
 *
 * A matrix cell can hold a relationship or one of two non-relationships, and the
 * pipeline has to tell all three apart:
 *
 *   Not set                 the auto-filled default. The user did not answer.
 *                           Emits NOTHING.
 *   Don't know each other   a deliberate statement that the two are strangers.
 *                           That IS a fact about the cast, so it reaches the
 *                           writer — as one reciprocal sentence per pair.
 *   anything else           a real relationship, rendered as before.
 *
 * THE BUG THIS REPLACES: the guard was `type === 'Not Known to'`, the ENGLISH
 * literal, while the wizard stores the LOCALIZED label. For de/fr/it it never
 * fired, so every cell the user had not filled reached the arc author as a
 * positive assertion — staging job_1789759147125_p08djwhbl (de-ch) sent ten of
 * them ("Levin is Nicht bekannt mit Max"), the matrix having had 12 ordered
 * pairs of which the user filled 2. English was never affected.
 *
 * These pin BEHAVIOUR in every UI language, never prompt wording: what emits
 * nothing, what emits a line, and that the sentinel label itself never reaches a
 * prompt. The labels come from shared/relationship-sentinels.json rather than
 * being typed in here, so a re-worded sentinel does not need these edited.
 */
const LANGS = ['en', 'de', 'fr', 'it'] as const;

/** Every ordered pair of the three-character cast, seeded with one value. */
const fullMatrix = (value: string) => {
  const rels: Record<string, string> = {};
  for (const a of characters) {
    for (const b of characters) {
      if (a.id !== b.id) rels[`${a.id}-${b.id}`] = value;
    }
  }
  return rels;
};

describe('an unanswered cell says nothing to the writer, in every language', () => {
  for (const lang of LANGS) {
    it(`a full ${lang} matrix of the default produces no relationship line`, () => {
      expect(buildRelationshipLines({ characters, relationships: fullMatrix(getNotSetRelationship(lang)) })).toEqual([]);
    });

    it(`a full ${lang} matrix of the LEGACY stored value produces no relationship line`, () => {
      // Pre-split saves, where one value was both the default and the only way
      // to say "strangers". Not distinguishable retroactively, so it reads as
      // the default: it emits nothing, which is what English already did.
      for (const legacy of SENTINELS.legacyNotSet) {
        expect(buildRelationshipLines({ characters, relationships: fullMatrix(legacy[lang]) }), `${lang}: ${legacy[lang]}`).toEqual([]);
      }
    });

    it(`a ${lang} default cell never puts the Relationships block in the brief`, () => {
      const brief = buildStoryContextFields({
        title: 'T', language: lang, characters,
        relationships: fullMatrix(getNotSetRelationship(lang)),
      }).STORY_BRIEF;
      expect(brief).not.toContain('Relationships:');
      expect(brief).not.toContain(getNotSetRelationship(lang));
    });
  }

  it('an empty or absent value is unanswered too', () => {
    expect(buildRelationshipLines({ characters, relationships: { '1-2': '', '2-1': undefined } })).toEqual([]);
  });
});

describe('the deliberate strangers choice IS a fact and reaches the writer', () => {
  for (const lang of LANGS) {
    const strangers = getStrangersRelationship(lang);

    it(`renders one natural sentence in ${lang}, never "is <sentinel>"`, () => {
      const lines = buildRelationshipLines({ characters, relationships: { '1-2': strangers } });
      expect(lines).toEqual(['Leo and Mia do not know each other']);
      expect(lines.join('\n')).not.toContain(strangers);
    });

    it(`says it once for a reciprocal ${lang} pair — the relation is symmetric`, () => {
      expect(buildRelationshipLines({ characters, relationships: { '1-2': strangers, '2-1': strangers } }))
        .toEqual(['Leo and Mia do not know each other']);
    });

    it(`keeps the user's note on a ${lang} strangers pair, from either direction`, () => {
      expect(buildRelationshipLines({
        characters,
        relationships: { '1-2': strangers, '2-1': strangers },
        relationshipTexts: { '2-1': 'They pass on the stairs.' },
      })).toEqual(['Leo and Mia do not know each other. They pass on the stairs.']);
    });

    it(`puts the ${lang} strangers sentence in the brief alongside real relationships`, () => {
      const brief = buildStoryContextFields({
        title: 'T', language: lang, characters,
        relationships: { '1-2': 'Brother of', '1-3': strangers, '2-3': getNotSetRelationship(lang) },
      }).STORY_BRIEF;
      expect(brief).toContain('Leo is Brother of Mia');
      expect(brief).toContain('Leo and Oma Ruth do not know each other');
      expect(brief).not.toContain(getNotSetRelationship(lang));
    });
  }
});

describe('a real relationship is untouched by the split', () => {
  it('renders a localized type verbatim — only the sentinels are special', () => {
    expect(buildRelationshipLines({
      characters,
      relationships: { '1-2': 'Bruder von', '2-1': 'Schwester von' },
    })).toEqual(['Leo is Bruder von Mia', 'Mia is Schwester von Leo']);
  });

  it('a note on a filled pair still appends, as before', () => {
    expect(buildRelationshipLines({
      characters,
      relationships: { '1-2': 'Freunde mit' },
      relationshipTexts: { '1-2': 'Sie teilen ein Zimmer.' },
    })).toEqual(['Leo is Freunde mit Mia. Sie teilen ein Zimmer.']);
  });
});

describe("a user's own note survives whatever the cell says", () => {
  for (const lang of LANGS) {
    it(`renders on a ${lang} default pair, with names and no invented type`, () => {
      expect(buildRelationshipLines({
        characters,
        relationships: { '1-2': getNotSetRelationship(lang), '2-1': getNotSetRelationship(lang) },
        relationshipTexts: { '1-2': 'They met at school.' },
      })).toEqual(['Leo and Mia: They met at school.']);
    });

    it(`renders on a ${lang} LEGACY pair too`, () => {
      const legacy = SENTINELS.legacyNotSet[0][lang];
      expect(buildRelationshipLines({
        characters,
        relationships: { '1-2': legacy, '2-1': legacy },
        relationshipTexts: { '2-1': 'They met at school.' },
      })).toEqual(['Mia and Leo: They met at school.']);
    });
  }
});

describe('the sentinel table reaches both consumers', () => {
  it('server and client agree on every label, in every language', async () => {
    const client = await import('../../client/src/constants/relationships');

    expect(client.NOT_SET_RELATIONSHIP).toEqual(SENTINELS.notSet);
    expect(client.STRANGERS_RELATIONSHIP).toEqual(SENTINELS.strangers);

    for (const lang of LANGS) {
      expect(client.getNotSetRelationship(lang)).toBe(getNotSetRelationship(lang));
      expect(client.getStrangersRelationship(lang)).toBe(getStrangersRelationship(lang));

      const unanswered = [SENTINELS.notSet[lang], ...SENTINELS.legacyNotSet.map((l: Record<string, string>) => l[lang])];
      for (const label of unanswered) {
        expect(isNotSetRelationship(label), `server notSet ${lang}: ${label}`).toBe(true);
        expect(client.isNotSetRelationship(label), `client notSet ${lang}: ${label}`).toBe(true);
        expect(isStrangersRelationship(label), `server strangers ${lang}: ${label}`).toBe(false);
        expect(client.isStrangersRelationship(label), `client strangers ${lang}: ${label}`).toBe(false);
      }

      const strangers = SENTINELS.strangers[lang];
      expect(isStrangersRelationship(strangers), `server strangers ${lang}`).toBe(true);
      expect(client.isStrangersRelationship(strangers), `client strangers ${lang}`).toBe(true);
      expect(isNotSetRelationship(strangers), `server notSet ${lang}`).toBe(false);
      expect(client.isNotSetRelationship(strangers), `client notSet ${lang}`).toBe(false);
    }
  });

  it('both sentinels are offered by the wizard and are their own inverse', async () => {
    const client = await import('../../client/src/constants/relationships');
    for (const lang of LANGS) {
      const offered = client.relationshipTypes.map(t => t.value[lang]);
      expect(offered, `${lang} options`).toContain(SENTINELS.notSet[lang]);
      expect(offered, `${lang} options`).toContain(SENTINELS.strangers[lang]);
      expect(client.findInverseRelationship(SENTINELS.notSet[lang], lang)).toBe(SENTINELS.notSet[lang]);
      expect(client.findInverseRelationship(SENTINELS.strangers[lang], lang)).toBe(SENTINELS.strangers[lang]);
    }
  });

  it('a real relationship is neither sentinel', () => {
    for (const value of ['Brother of', 'Freunde mit', 'Rivals with', 'Onkel von']) {
      expect(isNotSetRelationship(value), value).toBe(false);
      expect(isStrangersRelationship(value), value).toBe(false);
    }
  });

  it('Swiss German uses ss, never the eszett', () => {
    expect(JSON.stringify([SENTINELS.notSet.de, SENTINELS.strangers.de])).not.toMatch(/ß/);
  });
});

/**
 * The idea generator posts the SAME matrix, sentinels included, through its own
 * renderer. Before the split that site had no guard at all, so it emitted the
 * sentinel verbatim in every language, English included.
 */
describe('the story-idea prompt makes the same two distinctions', () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const { buildIdeasPromptContext } = require('../../server/routes/storyIdeas.js');
  const render = (relationship: string) => buildIdeasPromptContext({
    storyCategory: 'adventure', storyTypeName: 'Adventure', language: 'de', pages: 4,
    characters: [{ name: 'Leo', age: 7, gender: 'boy', isMain: true }, { name: 'Mia', age: 5, gender: 'girl' }],
    relationships: [{ character1: 'Leo', character2: 'Mia', relationship }],
  }).then((ctx: { relationshipDescriptions: string }) => ctx.relationshipDescriptions);

  for (const lang of LANGS) {
    it(`drops the ${lang} default and the ${lang} legacy value`, async () => {
      expect(await render(SENTINELS.notSet[lang])).toBe('');
      expect(await render(SENTINELS.legacyNotSet[0][lang])).toBe('');
    });

    it(`states the ${lang} strangers choice as a sentence`, async () => {
      const out = await render(SENTINELS.strangers[lang]);
      expect(out).toBe('- Leo and Mia do not know each other');
      expect(out).not.toContain(SENTINELS.strangers[lang]);
    });
  }

  it('renders a real relationship unchanged', async () => {
    expect(await render('Freunde mit')).toBe('- Leo Freunde mit Mia');
  });
});

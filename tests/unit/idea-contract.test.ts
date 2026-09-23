/**
 * The idea contract switches on the YOUNGEST main character's age: two or under
 * gets a PATTERN (what happens on every page, what varies, the one that
 * resists, the refrain, the landing), three and up keeps the premise (setup,
 * obstacle, promise, cost, picture). Owner, 2026-09-21.
 *
 * Pinned here rather than in the templates, because the point of the change is
 * that the templates hold no age branching at all: one {IDEA_CONTRACT}
 * placeholder, filled in code.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const contract = require('../../server/lib/ideaContract');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildStoryScope } = require('../../server/routes/storyIdeas');

const ROOT = path.resolve(__dirname, '../..');
const TEMPLATES = ['prompts/generate-story-idea-single.txt', 'prompts/generate-story-ideas.txt'];
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const main = (age: number) => ({ name: 'M', age, isMain: true });
const side = (age: number) => ({ name: 'S', age, isMain: false });

const PATTERN_SLOTS = ['THE PATTERN', 'THE VARIATION', 'THE ONE THAT RESISTS', 'THE REFRAIN', 'THE LANDING'];
const PREMISE_SLOTS = ['THE SETUP', 'WHAT STANDS IN THE WAY', 'THE PROMISE', 'WHAT IT COSTS THEM TO FAIL', 'THE PICTURE'];

describe('the contract switches at age two', () => {
  it.each([0, 1, 2])('age %i gets the pattern contract', (age) => {
    expect(contract.isPatternContract([main(age)])).toBe(true);
    expect(contract.buildIdeaContract([main(age)]).IDEA_CONTRACT).toBe(contract.IDEA_CONTRACT_PATTERN);
    expect(contract.buildIdeaContract([main(age)]).BUY_CRITERION).toMatch(/say along/);
  });

  it.each([3, 5, 8, 12, 68])('age %i keeps the premise contract', (age) => {
    expect(contract.isPatternContract([main(age)])).toBe(false);
    expect(contract.buildIdeaContract([main(age)]).IDEA_CONTRACT).toBe(contract.IDEA_CONTRACT_PREMISE);
    expect(contract.buildIdeaContract([main(age)]).BUY_CRITERION).toMatch(/cannot do at home/);
  });

  it('a toddler SIDE character does not turn an older book into a pattern book', () => {
    expect(contract.isPatternContract([main(8), side(1)])).toBe(false);
  });

  it('the youngest MAIN decides, not the oldest', () => {
    expect(contract.youngestMainAge([main(8), main(2)])).toBe(2);
    expect(contract.isPatternContract([main(8), main(2)])).toBe(true);
  });

  it('no readable main age keeps the premise contract', () => {
    expect(contract.youngestMainAge([{ name: 'X', isMain: true }])).toBe(null);
    expect(contract.isPatternContract([{ name: 'X', isMain: true }])).toBe(false);
    expect(contract.isPatternContract([])).toBe(false);
  });
});

describe('the two contracts hold their own slots and not the other one', () => {
  it('the pattern contract names its five slots and no premise slot', () => {
    for (const slot of PATTERN_SLOTS) expect(contract.IDEA_CONTRACT_PATTERN).toContain(slot);
    for (const slot of PREMISE_SLOTS) expect(contract.IDEA_CONTRACT_PATTERN).not.toContain(slot);
  });

  it('the premise contract names its five slots and no pattern slot', () => {
    for (const slot of PREMISE_SLOTS) expect(contract.IDEA_CONTRACT_PREMISE).toContain(slot);
    for (const slot of PATTERN_SLOTS) expect(contract.IDEA_CONTRACT_PREMISE).not.toContain(slot);
  });

  it('the pattern contract asks for no cost and forbids saying what the resisting one does', () => {
    expect(contract.IDEA_CONTRACT_PATTERN).toMatch(/Nothing here names what failing costs/);
    expect(contract.IDEA_CONTRACT_PATTERN).toMatch(/Never what the one that resists finally does/);
    expect(contract.IDEA_CONTRACT_PATTERN).toMatch(/movement of the body/);
  });

  it('each contract carries its own CUT step', () => {
    expect(contract.IDEA_CONTRACT_PREMISE).toMatch(/CONTRACT CHECK[^:]*: number the sentences/);
    expect(contract.IDEA_CONTRACT_PREMISE).toMatch(/List every cut sentence, not one of them/);
    expect(contract.IDEA_CONTRACT_PATTERN).toMatch(/CONTRACT CHECK[^:]*: quote each of the five slots/);
    expect(contract.IDEA_CONTRACT_PATTERN).toMatch(/List every cut sentence, not one of them/);
  });

  it('the check is done in the review, never inside the idea (a labelled "Satz 1 — setup" final reached a customer, 2026-09-23)', () => {
    for (const c of [contract.IDEA_CONTRACT_PREMISE, contract.IDEA_CONTRACT_PATTERN]) {
      expect(c).toMatch(/written in the review and never in the idea itself/);
      expect(c).not.toMatch(/sentences of the final|slots from the final/);
    }
  });

  it('both contracts are generic — no name, no place, no cell', () => {
    for (const c of [contract.IDEA_CONTRACT_PREMISE, contract.IDEA_CONTRACT_PATTERN]) {
      expect(c).not.toMatch(/Baden|Limmat|Lena|Emil|Noah|Mia|Koppel/);
    }
  });
});

describe('the templates hold the placeholder, not the age branching', () => {
  it.each(TEMPLATES)('%s carries {IDEA_CONTRACT} exactly once', (t) => {
    expect(read(t).split('{IDEA_CONTRACT}').length - 1).toBe(1);
  });

  it.each(TEMPLATES)('%s no longer states either slot list in prose', (t) => {
    const src = read(t);
    // The slot names live in the contract constants only. (The worked toddler
    // example is prose ABOUT a pattern book, and names no slot.)
    for (const slot of [...PATTERN_SLOTS, ...PREMISE_SLOTS]) expect(src).not.toContain(slot);
    // …and neither template asks for a cost sentence any more.
    expect(src).not.toContain('The idea names what failing costs');
  });

  it.each(TEMPLATES)('%s points its review at the contract check instead of restating it', (t) => {
    const src = read(t);
    expect(src).toMatch(/run the CONTRACT CHECK the idea contract above names/);
    expect(src).not.toContain('Label each one "setup", "hook", "promise"');
  });

  // Round 22 measured the hazard the worked example carried: cell 7 arm 1 came
  // back as a translation of it (the fence, the answering animals, the brown
  // pony, «Komm her!»). The example is gone and the mechanism is handed over as
  // a picked VALUE instead — prompts/pattern-seeds.txt, {PATTERN_SEED}
  // (owner, 2026-09-21; tests/unit/pattern-seeds.test.ts).
  it.each(TEMPLATES)('%s no longer carries a toddler worked example', (t) => {
    const src = read(t);
    expect(src).not.toContain('A child walks along the fence and every animal answers back');
    expect(src).not.toContain('«Come here!»');
    expect(src).toContain('{PATTERN_SEED');
  });
});

describe('buildStoryScope: a pattern book has one band at every page count', () => {
  it.each([10, 16, 25, 40])('%i pages, pattern: four or five sentences in one paragraph', (pages) => {
    const s = buildStoryScope(pages, { pattern: true });
    expect(s).toContain('four or five sentences in one paragraph');
    expect(s).not.toContain('This is a journey');
    expect(s).not.toContain('This is a world');
    expect(s).not.toContain('This is a short book');
  });

  it('the premise scope bands are unchanged when pattern is off', () => {
    expect(buildStoryScope(10)).toContain('This is a short book');
    expect(buildStoryScope(16)).toContain('This is a journey');
    expect(buildStoryScope(25)).toContain('This is a world');
  });
});

describe('the 0-2 band files carry the pattern, and the 3+ band files do not', () => {
  const band = (f: string) => read(`prompts/${f}`);
  it.each(['age-band-routine.txt', 'age-band-quest.txt'])('%s states the pattern in its premise view', (f) => {
    const src = band(f);
    expect(src).toContain('[[premise]]**The book is a pattern, not a plot.**');
    expect(src).toContain('Nothing costs anything, and everything can be pointed at.');
  });

  it.each(['age-band-tries.txt', 'age-band-fear-choice.txt', 'age-band-journey.txt'])('%s does not', (f) => {
    expect(band(f)).not.toContain('The book is a pattern, not a plot.');
  });
});

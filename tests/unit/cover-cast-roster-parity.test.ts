/**
 * The cover JUDGE holds the roster the cover GENERATOR was given.
 *
 * Owner, 2026-09-15: "Cover the author is correct max 5."
 *
 * The generator caps a cover at MAX_COVER_CHARACTERS and hands the image model
 * an explicit exclusion list ("ONLY show these characters: … Do NOT include:
 * …"). The judge's EXPECTED CAST was rebuilt from the UNTRIMMED brief: the
 * cover PROSE still names the excluded characters — that is the whole reason
 * the restriction block exists — and `matchVbEntitiesInText` read them straight
 * back onto the roster. A cover drawn exactly to order was then held to a cast
 * the generator had been ordered to violate.
 *
 * Both sides now read `server/lib/coverCastRoster.js`. Pinned here: an
 * over-cap cast yields the SAME roster on both sides.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { MAX_COVER_CHARACTERS, resolveCoverCastRoster } = require('../../server/lib/coverCastRoster.js');
const { buildExpectedCastBlock } = require('../../server/lib/evalPipeline.js');

const NAMES = ['Levin', 'Julian', 'Max', 'Kiaan', 'Noor', 'Tomas', 'Elif'];
const CHARACTERS = NAMES.map((name, i) => ({ id: `c${i}`, name, isMainCharacter: i < 2 }));

// The cover prose names EVERY character — including the ones the cap dropped.
const COVER_PROSE = `A group portrait: ${NAMES.join(', ')} stand together under the arch.`;

// The dropped characters live in the bible as secondaries, which is the pool
// the cover name matcher reads.
const VISUAL_BIBLE = {
  mainCharacters: CHARACTERS.slice(0, 2).map((c) => ({ id: c.id, name: c.name })),
  secondaryCharacters: CHARACTERS.slice(2).map((c, i) => ({ id: `CHR00${i}`, name: c.name })),
  animals: [{ id: 'ANI001', name: 'Nia' }],
};

const generatorRoster = () => resolveCoverCastRoster(CHARACTERS, CHARACTERS);

const judgeRoster = (opts: any = {}) =>
  buildExpectedCastBlock({
    sceneCharacters: generatorRoster().selected.map((n: string) => ({ name: n })),
    sceneHint: COVER_PROSE,
    originalPrompt: COVER_PROSE,
    visualBible: VISUAL_BIBLE,
    evaluationType: 'cover',
    storyData: { characters: CHARACTERS },
    ...opts,
  });

describe('cover cast: generator and judge agree by construction', () => {
  it('the generator trims to the cap and names the rest as excluded', () => {
    const r = generatorRoster();
    expect(r.cap).toBe(MAX_COVER_CHARACTERS);
    expect(r.selected).toEqual(NAMES.slice(0, MAX_COVER_CHARACTERS));
    expect(r.excluded).toEqual(NAMES.slice(MAX_COVER_CHARACTERS));
    expect(r.excluded.length, 'the fixture no longer exercises an over-cap cast').toBeGreaterThan(0);
  });

  it('THE REGRESSION: the judge does not rebuild the excluded cast from the cover prose', () => {
    const gen = generatorRoster();
    const judged = judgeRoster({ excludedCastNames: gen.excluded });
    for (const dropped of gen.excluded) {
      expect(judged.names, `${dropped} was excluded from the render and is back on the EXPECTED CAST`)
        .not.toContain(dropped);
    }
  });

  it('NEGATIVE CONTROL: withholding the exclusion list puts a dropped character back', () => {
    // Proves the assertions are testing the fix and not the fixture. A cast
    // UNDER the cap — what the "Regenerate cover" character filter produces —
    // so the cap cannot be what keeps the dropped name off the roster: only the
    // exclusion list can. The cover prose names all seven either way.
    const picked = CHARACTERS.slice(0, 3);
    const r = resolveCoverCastRoster(picked, CHARACTERS);
    const roster = (excludedCastNames: string[] | null) =>
      buildExpectedCastBlock({
        sceneCharacters: picked.map((c) => ({ name: c.name })),
        sceneHint: COVER_PROSE,
        originalPrompt: COVER_PROSE,
        visualBible: VISUAL_BIBLE,
        evaluationType: 'cover',
        storyData: { characters: CHARACTERS },
        excludedCastNames,
      }).names;
    expect(roster(null), 'the fixture no longer reads the dropped cast out of the prose')
      .toContain('Kiaan');
    expect(roster(r.excluded), 'the exclusion list is not being honoured')
      .not.toContain('Kiaan');
  });

  it('the two sides hold the same people', () => {
    const gen = generatorRoster();
    const judged = judgeRoster({ excludedCastNames: gen.excluded });
    const people = judged.names.filter((n: string) => !judged.nonHumanNames.includes(n));
    expect(people).toEqual(gen.selected);
  });

  it('the person roster never exceeds the cap', () => {
    const gen = generatorRoster();
    const judged = judgeRoster({ excludedCastNames: gen.excluded });
    const people = judged.names.filter((n: string) => !judged.nonHumanNames.includes(n));
    expect(people.length).toBeLessThanOrEqual(MAX_COVER_CHARACTERS);
  });

  it('an animal the cover prose names is still expected — the cap governs characters', () => {
    const gen = generatorRoster();
    const judged = judgeRoster({
      sceneHint: `${COVER_PROSE} The dog Nia sits at their feet.`,
      originalPrompt: `${COVER_PROSE} The dog Nia sits at their feet.`,
      excludedCastNames: gen.excluded,
    });
    expect(judged.names).toContain('Nia');
  });

  it('a cast within the cap excludes nobody and both sides keep everyone', () => {
    const few = CHARACTERS.slice(0, 3);
    const r = resolveCoverCastRoster(few, few);
    expect(r.excluded).toEqual([]);
    expect(r.selected).toEqual(few.map((c) => c.name));
  });
});

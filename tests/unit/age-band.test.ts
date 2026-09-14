import { describe, it, expect, beforeAll } from 'vitest';

import { createRequire } from 'node:module';

// Both modules are loaded through node's CJS registry, not vitest's ESM graph:
// promptBuilders reaches the template store with a plain require(), and an
// `import` here would hand the test a SECOND copy of it whose loaded templates
// promptBuilders never sees.
const require_ = createRequire(import.meta.url);
const { loadPromptTemplates } = require_('../../server/services/prompts');
const {
  resolveAgeBand,
  resolvePacingBand,
  pickMainCharacters,
  buildAgeModeSection,
  buildStoryShapeSection,
  challengeCatalogueBands,
  buildLifeSkillGuidelines,
  buildTopicWindowSection,
  TOPIC_AGE_WINDOWS,
} = require_('../../server/lib/promptBuilders');

const char = (id: number, name: string, age: number, isMain: boolean) =>
  ({ id, name, age: String(age), gender: 'male', isMain });

const solo = (age: number) => ({ characters: [char(1, 'A', age, true)], mainCharacters: [1] });

/**
 * Owner rules: five whole-year plot bands below six (2026-09-04), decided by
 * the OLDEST MAIN character and never by a secondary (2026-08-25, retained).
 * From 2026-09-14 there is NO 'standard' shape band and no upper cap: every age
 * from six up, and an unknown age, resolves to `journey`. Before that the band
 * array simply ran out at index 5 and ages 6+ received no plot-shape rules at
 * all. See docs/decisions.md.
 */
describe('resolveAgeBand', () => {
  it('maps every whole year 0..7 to its band', () => {
    expect(resolveAgeBand(solo(0))).toBe('routine');
    expect(resolveAgeBand(solo(1))).toBe('routine');
    expect(resolveAgeBand(solo(2))).toBe('quest');
    expect(resolveAgeBand(solo(3))).toBe('tries');
    expect(resolveAgeBand(solo(4))).toBe('fear-choice');
    expect(resolveAgeBand(solo(5))).toBe('journey');
    expect(resolveAgeBand(solo(6))).toBe('journey');
    expect(resolveAgeBand(solo(7))).toBe('journey');
  });

  it('routes every age from six up to journey, with NO upper cap', () => {
    // The owner's rule: "what would a mother or grandmother get that try it out,
    // should also work for them". An adult main is a reader, not a gap.
    for (const age of [6, 7, 8, 10, 12, 16, 17, 18, 38, 68, 99]) {
      expect(resolveAgeBand(solo(age)), `age ${age}`).toBe('journey');
    }
  });

  it('keeps ages 0-5 on their own bands, unchanged', () => {
    expect([0, 1, 2, 3, 4, 5].map(age => resolveAgeBand(solo(age))))
      .toEqual(['routine', 'routine', 'quest', 'tries', 'fear-choice', 'journey']);
  });

  it('lets the OLDEST main decide when two mains span two bands', () => {
    expect(resolveAgeBand({
      characters: [char(1, 'A', 5, true), char(2, 'B', 1, true)],
      mainCharacters: [1, 2],
    })).toBe('journey');
  });

  it('ignores an older SECONDARY character', () => {
    expect(resolveAgeBand({
      characters: [char(1, 'A', 1, true), char(2, 'B', 8, false)],
      mainCharacters: [1],
    })).toBe('routine');
  });

  it('reads isMain flags when no mainCharacters id array is given (idea-generation payload)', () => {
    expect(resolveAgeBand({ characters: [char(1, 'A', 8, true), char(2, 'B', 1, true)] })).toBe('journey');
    expect(resolveAgeBand({ characters: [char(1, 'A', 2, true), char(2, 'B', 5, false)] })).toBe('quest');
  });

  it('reads isMainCharacter, the flag the story pipeline stamps on its objects', () => {
    const pipelineChar = (id: number, name: string, age: number, main: boolean) =>
      ({ id, name, age: String(age), gender: 'male', role: main ? 'main' : 'secondary', isMainCharacter: main });
    expect(resolveAgeBand({ characters: [pipelineChar(1, 'A', 3, true), pipelineChar(2, 'B', 9, false)] })).toBe('tries');
    expect(resolveAgeBand({ characters: [pipelineChar(1, 'A', 9, true), pipelineChar(2, 'B', 1, false)] })).toBe('journey');
  });

  it('falls back to journey — never to silence — when the age is missing or the cast is empty', () => {
    // Pre-2026-09-14 these returned 'standard', which had no template and so
    // meant NO plot-shape rules. The journey rules are generic story craft and
    // are wrong for nobody but a toddler, and a toddler book always has an age.
    expect(resolveAgeBand({ characters: [{ id: 1, name: 'A', isMain: true }], mainCharacters: [1] })).toBe('journey');
    expect(resolveAgeBand({ characters: [] })).toBe('journey');
    expect(resolveAgeBand({})).toBe('journey');
  });
});

/**
 * The PACING band is the second axis, split out of resolveAgeBand on
 * 2026-09-14: the journey SHAPE suits 6 and 16 alike, the five-year-old's event
 * budget does not. It is what the maturity tables key on, and it still hands
 * over to the reading level at 'standard' from six up.
 */
describe('resolvePacingBand', () => {
  it('keeps the pre-2026-09-14 mapping, including standard from six up', () => {
    expect([0, 1, 2, 3, 4, 5].map(a => resolvePacingBand(solo(a))))
      .toEqual(['routine', 'routine', 'quest', 'tries', 'fear-choice', 'journey']);
    for (const age of [6, 8, 12, 16, 38, 68]) {
      expect(resolvePacingBand(solo(age)), `age ${age}`).toBe('standard');
    }
    expect(resolvePacingBand({})).toBe('standard');
  });

  it('diverges from the shape band exactly from age six', () => {
    for (const age of [0, 1, 2, 3, 4, 5]) {
      expect(resolvePacingBand(solo(age)), `age ${age}`).toBe(resolveAgeBand(solo(age)));
    }
    for (const age of [6, 12, 38]) {
      expect(resolvePacingBand(solo(age)), `age ${age}`).not.toBe(resolveAgeBand(solo(age)));
    }
  });
});

describe('pickMainCharacters', () => {
  it('sorts mains oldest first, so the focus IS the oldest main', () => {
    // A two-character cast caps mains at one (half the cast), so the younger
    // main drops out entirely and the older one is the focus.
    const { mains, focus } = pickMainCharacters({
      characters: [char(1, 'A', 1, true), char(2, 'B', 5, true)],
      mainCharacters: [1, 2],
    });
    expect(mains.map((c: { name: string }) => c.name)).toEqual(['B']);
    expect(focus.name).toBe('B');
  });

  it('caps mains at two and puts the rest in others', () => {
    const { mains, others } = pickMainCharacters({
      characters: [char(1, 'A', 9, true), char(2, 'B', 8, true), char(3, 'C', 7, true), char(4, 'D', 6, false)],
      mainCharacters: [1, 2, 3],
    });
    expect(mains).toHaveLength(2);
    expect(others.map((c: { name: string }) => c.name)).toEqual(['C', 'D']);
  });
});

describe('buildAgeModeSection', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('returns the band-specific content rules below six', () => {
    expect(buildAgeModeSection(solo(1))).toContain('# ROUTINE BOOK');
    expect(buildAgeModeSection(solo(2))).toContain('# REPETITION QUEST');
    expect(buildAgeModeSection(solo(3))).toContain('# THREE TRIES');
    expect(buildAgeModeSection(solo(4))).toContain('# FEAR AND CHOICE');
    expect(buildAgeModeSection(solo(5))).toContain("# MINI HERO'S JOURNEY");
  });

  it('gives ages six and up the journey rules — never nothing (2026-09-14)', () => {
    // The regression this pins: ages 6-18 used to receive NO band at all, which
    // is how job_1789420083330_5si0z6ze1 (age 8) shipped a father handing the
    // child a key that removed the only obstacle, with no low point.
    for (const age of [6, 8, 12, 16, 38, 68]) {
      const section = buildAgeModeSection(solo(age));
      expect(section, `age ${age}`).toContain("HERO'S JOURNEY");
      expect(section, `age ${age}`).toMatch(/A real low point is required/);
      expect(section, `age ${age}`).toMatch(/never a\s+grown-up arriving to fix it/);
      expect(section, `age ${age}`).toMatch(/They are never carried\s+through their own story/);
    }
  });

  it('gives an unknown age the journey rules with no age claimed', () => {
    const section = buildAgeModeSection({ characters: [{ id: 1, name: 'A', isMain: true }] });
    expect(section.split('\n')[0]).toBe("# HERO'S JOURNEY");
    expect(section).not.toMatch(/\(age\s*\)/);
    expect(section).toContain('A real low point is required');
  });

  it('scales the journey framing across the whole range and leaves no token unfilled', () => {
    const head = (age: number) => buildAgeModeSection(solo(age)).split('\n').slice(0, 5).join('\n');
    // MINI and "in small" are the owner's wording for a five- or six-year-old.
    expect(head(5)).toContain("# MINI HERO'S JOURNEY (age 5)");
    expect(head(5)).toContain('The child this book is for is five.');
    expect(head(5)).toContain('The full shape, in small.');
    expect(head(6)).toContain("# MINI HERO'S JOURNEY (age 6)");
    expect(head(6)).toContain('The full shape, in small.');
    // From seven it is a full hero's journey, not a miniature one.
    expect(head(8)).toContain("# HERO'S JOURNEY (age 8)");
    expect(head(8)).not.toContain('MINI');
    expect(head(8)).toContain('The child this book is for is eight.');
    expect(head(8)).toContain('The full shape, at full size.');
    expect(head(12)).toContain('The child this book is for is twelve.');
    // A teenager is a reader, not a child...
    expect(head(16)).toContain('The reader this book is for is sixteen.');
    expect(head(16)).toContain('a young adult, not a small child');
    // ...and an adult trying the product gets an adult's book.
    expect(head(38)).toContain("# HERO'S JOURNEY (adult reader, age 38)");
    expect(head(38)).toContain('The reader this book is for is an adult of 38.');
    expect(head(68)).toContain('an adult of 68');
    for (const age of [5, 6, 8, 12, 16, 38, 68]) {
      expect(buildAgeModeSection(solo(age)).match(/\{[A-Z][A-Z0-9_]*\}/g), `age ${age}`).toBeNull();
    }
  });

  it('never prescribes a text length — that belongs to the reading level', () => {
    for (const age of [0, 1, 2, 3, 4, 5]) {
      expect(buildAgeModeSection(solo(age)))
        .not.toMatch(/words? per page|sentences per page|\d+\s*[-–]\s*\d+\s*words/i);
    }
  });

  it('keeps the safety rules in the two youngest bands', () => {
    for (const age of [1, 2]) {
      const section = buildAgeModeSection(solo(age));
      expect(section).toMatch(/cannot chew or swallow safely/);
      expect(section).toMatch(/Nothing appears from nowhere/);
      expect(section).toMatch(/opens and closes where the child really is/);
    }
  });
});

describe('buildStoryShapeSection', () => {
  const shapeAt = (age: number, pages = 6) => buildStoryShapeSection(
    { characters: [char(1, 'A', age, true)], mainCharacters: [1], storyTheme: 'pirate' }, pages);

  it('gives the routine band one small setback and a range of feelings, not a challenge budget', () => {
    const shape = shapeAt(1);
    expect(shape).toMatch(/Challenges: one, small/);
    expect(shape).toMatch(/Feelings: three different ones/);
    expect(shape).not.toMatch(/major challenge/);
    // The routine band's per-page units are MOMENTS, not events: saying "N distinct
    // events" here collided with this band's own budget of "at most 1 event"
    // (buildArcBudgetSection), and both blocks reach the model in one prompt.
    expect(shape).toMatch(/6 pages, a different moment on each/);
    expect(shape).not.toMatch(/distinct events/);
  });

  it('gives the quest band one tiny goal and a repeated search', () => {
    const shape = shapeAt(2);
    expect(shape).toMatch(/Goal: one tiny thing/);
    expect(shape).toMatch(/one place per page/);
    expect(shape).not.toMatch(/major challenge/);
  });

  it('gives the tries band one challenge met three times', () => {
    const shape = shapeAt(3);
    expect(shape).toMatch(/Challenges: one, met three times/);
    // Each try is a different KIND of attempt and the third turns on a
    // noticing — "more effort" licensed four variations of the same try.
    expect(shape).toMatch(/each try a different kind of attempt/);
    expect(shape).toMatch(/notices something about the problem the earlier tries missed/);
    expect(shape).not.toMatch(/major challenge/);
    // The tries span is named as pages, never a bare number beside "the three
    // tries" (which read as a count of tries).
    expect(shape).not.toMatch(/the three tries \d/);
    expect(shape).toMatch(/pages 2-\d+ carry the three tries/);
  });

  it('puts the causal-coherence rule on every band', () => {
    for (const age of [1, 2, 3, 4, 8]) {
      expect(shapeAt(age)).toMatch(/An object brought into the solution does real mechanical work/);
    }
  });

  it('keeps the computed challenge budget for fear-choice and adds its resolution rule', () => {
    const shape = shapeAt(4);
    expect(shape).toContain('Challenges: exactly 2');
    expect(shape).toContain('major challenge');
    expect(shape).toMatch(/resolve through the main character's own choice/);
  });

  it('requires a real low point in the journey band', () => {
    const shape = shapeAt(5);
    expect(shape).toContain('Challenges: exactly 2');
    expect(shape).toMatch(/A real low point before the end is required/);
  });

  it('carries the band difficulty rule into the lean arc variant too', () => {
    const arc = buildStoryShapeSection(
      { characters: [char(1, 'A', 5, true)], mainCharacters: [1] }, 6, { arc: true });
    expect(arc).toMatch(/A real low point before the end is required/);
    expect(arc).not.toMatch(/Page budget/);
  });

  it('keeps age six and up on the full page-budget shape AND gives it the journey rule', () => {
    // Until 2026-09-14 this asserted NO band rule at six and up — the same gap
    // that left the age-band section empty. The page arithmetic is unchanged;
    // what is added is the one difficulty line, matching the band file these
    // readers now receive.
    const shape = shapeAt(6, 24);
    expect(shape).toContain('major challenge');
    expect(shape).toMatch(/Challenges: exactly \d/);
    expect(shape).toMatch(/A real low point before the end is required/);
    expect(shape).toMatch(/never a grown-up arriving to fix it/);
    // Still not the fear-choice band's rule, which belongs to age four alone.
    expect(shape).not.toMatch(/An opponent is beaten by wit or kindness/);
    // The old blanket "the focus character is very young" soften is gone.
    expect(shape).not.toMatch(/focus character is very young/);
    // The reading-level difficulty line rides alongside it, not replaced by it.
    expect(shape).toMatch(/The reading level allows real difficulty/);
  });

  it('carries the journey rule at every age from six up, with no cap', () => {
    for (const age of [6, 8, 12, 16, 38, 68]) {
      expect(shapeAt(age, 24), `age ${age}`).toMatch(/A real low point before the end is required/);
    }
  });

  // Traits are optional (owner, 2026-08-25): "it can be that we do not have any
  // child traits... if we have traits we use them. If not we take something
  // generic. Both must work."
  const shapeFor = (traits: unknown) => buildStoryShapeSection(
    { characters: [{ ...char(1, 'A', 1, true), traits }], mainCharacters: [1] }, 6);

  it('makes the traits the page plan when the character has any', () => {
    expect(shapeFor({ strengths: ['Mutig'], flaws: [], challenges: [], specialDetails: '' }))
      .toMatch(/traits are the page plan/);
    expect(shapeFor(['Fröhlich'])).toMatch(/traits are the page plan/);
    expect(shapeFor({ strengths: [], specialDetails: 'Liebt Hunde' })).toMatch(/traits are the page plan/);
  });

  it('falls back to generic small-child feelings when there are none', () => {
    // The structured-but-empty shape is truthy — a naive check would pass it.
    expect(shapeFor({ strengths: [], flaws: [], challenges: [], specialDetails: '' }))
      .toMatch(/every small child is: hungry, sleepy, curious, delighted, grumpy/);
    expect(shapeFor(undefined)).toMatch(/every small child is/);
    expect(shapeFor(['', '  '])).toMatch(/every small child is/);
  });
});

describe('challengeCatalogueBands', () => {
  it('gives the three simple bands no catalogue at all', () => {
    expect(challengeCatalogueBands(solo(0))).toEqual([]);
    expect(challengeCatalogueBands(solo(2))).toEqual([]);
    expect(challengeCatalogueBands(solo(3))).toEqual([]);
  });

  it('gives fear-choice the youngest band and journey the two youngest', () => {
    expect(challengeCatalogueBands(solo(4))).toEqual(['3']);
    expect(challengeCatalogueBands(solo(5))).toEqual(['3', '6']);
  });

  it('keeps the youngest-cast-member logic from age six up', () => {
    // The YOUNGEST cast member picks the bands in standard mode, main or not.
    expect(challengeCatalogueBands({
      characters: [char(1, 'A', 8, true), char(2, 'B', 4, false)], mainCharacters: [1],
    })).toEqual(['3']);
    expect(challengeCatalogueBands(solo(8))).toEqual(['3', '6']);
    expect(challengeCatalogueBands(solo(12))).toEqual(['6', '9']);
  });

  it('treats an unknown age as standard with the default youngest of eight', () => {
    expect(challengeCatalogueBands({ characters: [{ id: 1, name: 'A', isMain: true }] })).toEqual(['3', '6']);
  });
});

/**
 * Topic-age suitability (owner, Option A). Two kinds of topic: a developmental
 * skill has a window, a life event has none and reaches a child at any age.
 */
describe('life-skill guidelines below age four', () => {
  const lifeSkill = (age: number) => ({ ...solo(age), storyTopic: 'moving-house', storyTheme: 'realistic' });

  it('drops the coping-strategy and empowering-ending demands in the simple bands', () => {
    for (const age of [0, 1, 2, 3]) {
      const block = buildLifeSkillGuidelines('moving-house', 'realistic', null, lifeSkill(age));
      expect(block).not.toMatch(/coping strateg/i);
      expect(block).not.toMatch(/empowering/i);
    }
  });

  it('keeps them from age four up and when no story input is supplied', () => {
    for (const age of [4, 5, 6, 9]) {
      const block = buildLifeSkillGuidelines('moving-house', 'realistic', null, lifeSkill(age));
      expect(block).toMatch(/coping strateg/i);
      expect(block).toMatch(/empowering/i);
    }
    expect(buildLifeSkillGuidelines('moving-house', 'realistic', null)).toMatch(/empowering/i);
  });

  it('still names the topic and still carries the teaching guide', () => {
    const block = buildLifeSkillGuidelines('moving-house', 'realistic', 'GUIDE BODY', lifeSkill(1));
    expect(block).toContain('moving-house');
    expect(block).toContain('GUIDE BODY');
  });
});

describe('buildTopicWindowSection', () => {
  const withTopic = (age: number, storyTopic: string) => ({ ...solo(age), storyTopic });

  // The window VALUE is catalogue data and moves when a topic is recalibrated;
  // what is pinned here is the behaviour around it, read from the table itself.
  const [lo, hi] = TOPIC_AGE_WINDOWS['potty-training'] as [number, number];

  it('says nothing while the child is inside the window', () => {
    for (let age = lo; age <= hi; age++) expect(buildTopicWindowSection(withTopic(age, 'potty-training'))).toBe('');
  });

  it('nudges without refusing when the child is outside it', () => {
    const under = buildTopicWindowSection(withTopic(lo - 1, 'potty-training'));
    const over = buildTopicWindowSection(withTopic(9, 'potty-training'));
    for (const line of [under, over]) {
      expect(line).toMatch(new RegExp(`${lo}-${hi}`));
      expect(line).not.toMatch(/refus|cannot|not allowed|choose another/i);
    }
    expect(under).toContain(`main character is ${lo - 1}`);
    expect(over).toContain('main character is 9');
  });

  it('treats a topic with no window as any-age', () => {
    expect(TOPIC_AGE_WINDOWS['moving-house']).toBeUndefined();
    for (const age of [0, 1, 5, 11]) {
      expect(buildTopicWindowSection(withTopic(age, 'moving-house'))).toBe('');
    }
  });

  it('says nothing when the topic or the age is unreadable', () => {
    expect(buildTopicWindowSection(solo(1))).toBe('');
    expect(buildTopicWindowSection({ characters: [{ id: 1, name: 'A', isMain: true }], mainCharacters: [1], storyTopic: 'potty-training' })).toBe('');
  });

  it('reaches the writer through the age-mode block, at every band', () => {
    expect(buildAgeModeSection({ ...solo(1), storyTopic: 'potty-training' })).toMatch(/Topic timing/);
    expect(buildAgeModeSection({ ...solo(9), storyTopic: 'potty-training' })).toMatch(/Topic timing/);
    expect(buildAgeModeSection({ ...solo(3), storyTopic: 'potty-training' })).not.toMatch(/Topic timing/);
  });
});

describe('the simple bands ban the coda, not success', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('forbids the closing moral and allows the thing to go well', () => {
    for (const age of [1, 2, 3]) {
      const section = buildAgeModeSection(solo(age));
      expect(section).toMatch(/no prize, no ceremony/i);
      expect(section).toMatch(/life event/i);
    }
    expect(buildAgeModeSection(solo(1))).toMatch(/A small thing may go well/);
    expect(buildAgeModeSection(solo(3))).toMatch(/The problem is solved/);
  });
});

/**
 * `TOPIC_AGE_WINDOWS` is a hand-kept mirror of `suitableAges` in
 * client/src/constants/storyTypes.ts — the client filters the picker with it,
 * the server nudges the writer with it. A drift between the two shows a topic
 * in the trial that the writer is then told is off-age (or the reverse), so it
 * is pinned here rather than left to whoever edits one side next.
 */
describe('TOPIC_AGE_WINDOWS mirrors the client windows exactly', () => {
  it('has the same window for every one of the 64 life challenges', async () => {
    const { lifeChallenges } = await import('../../client/src/constants/storyTypes');
    expect(lifeChallenges.length).toBe(64);
    for (const c of lifeChallenges) {
      if (c.suitableAges) expect(TOPIC_AGE_WINDOWS[c.id]).toEqual(c.suitableAges);
      else expect(TOPIC_AGE_WINDOWS[c.id]).toBeUndefined();
    }
    // …and nothing on the server that the client does not know about.
    for (const key of Object.keys(TOPIC_AGE_WINDOWS)) {
      expect(lifeChallenges.some(c => c.id === key)).toBe(true);
    }
    expect(Object.keys(TOPIC_AGE_WINDOWS).length).toBe(56);
  });
});

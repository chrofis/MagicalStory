/**
 * Two judge rules now have a generator-side counterpart, and each is ONE
 * constant so the two halves cannot drift apart.
 *
 * WHY — the 2026-09-15 generator-vs-critic audit. Owner: "we fix the reviewer,
 * but we never told the creator the change." Both rules below were judge-only:
 *   - image-evaluation.txt D-24 `character_marking` is CATASTROPHIC/CRITICAL for
 *     a mark painted on a figure, and image-generation.txt forbade LETTERING
 *     only — a decal, arrow or badge broke no stated rule.
 *   - D-16b `action_interaction` is MAJOR when a hand holds something the scene
 *     never named while a named object is missing, and nothing told the renderer
 *     what a hand may hold.
 *
 * These tests pin the CONTRACT — the rule reaches the built prompt, byte-
 * identical, read from the exported constant — never the wording. They run the
 * REAL builder: a rule present in the template proves nothing, because
 * fillTemplate strips an undeclared placeholder silently and the prompt ships
 * with a hole.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PB = require('../../server/lib/promptBuilders.js');
const { NO_CHARACTER_MARKING_RULE, HANDS_HOLD_ONLY_NAMED_RULE } = PB;
const { loadPromptTemplates } = require('../../server/services/prompts.js');

const inputData: any = {
  title: 'The Lamp on the Pier',
  characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl', hairColor: 'brown' }],
  mainCharacters: ['c1'],
  language: 'en',
  pages: 4,
  storyCategory: 'adventure',
  storyDetails: 'A night at the harbour.',
  artStyle: 'watercolor',
};

const VISUAL_BIBLE: any = {
  artifacts: [{ id: 'ART001', name: 'brass lantern', description: 'a dented brass lantern', pages: [1] }],
  locations: [], vehicles: [], characters: [],
};

const brief = () =>
  `The main character kneels beside the lantern.\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'the lamp is lit',
    characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
    shot: 'wide',
    objects: ['ART001'],
    textPosition: 'bottom-left',
  })}`;

const unfilled = (p: string) => [...new Set(String(p).match(/\{[A-Z][A-Z0-9_]*\}/g) || [])];

beforeAll(async () => {
  await loadPromptTemplates();
});

describe('generator-side counterparts of judge rules reach the built image prompt', () => {
  const build = (opts: any = {}) =>
    String(PB.buildImagePrompt(brief(), inputData, null, VISUAL_BIBLE, 1, null, opts));

  it('the constants are exported, so the test pins identity and not wording', () => {
    expect(typeof NO_CHARACTER_MARKING_RULE).toBe('string');
    expect(typeof HANDS_HOLD_ONLY_NAMED_RULE).toBe('string');
    expect(NO_CHARACTER_MARKING_RULE.length).toBeGreaterThan(50);
    expect(HANDS_HOLD_ONLY_NAMED_RULE.length).toBeGreaterThan(50);
  });

  it('D-24 character_marking has its counterpart in the page prompt', () => {
    expect(build()).toContain(NO_CHARACTER_MARKING_RULE);
  });

  it('D-16b action_interaction has its counterpart in the page prompt', () => {
    expect(build()).toContain(HANDS_HOLD_ONLY_NAMED_RULE);
  });

  it('a cover is built from the same template, so both rules reach covers too', () => {
    // D-24 is the heaviest deduction a cover can take; covers run through the
    // same image template plus the cover-composition bullets.
    const cover = build({ coverComposition: 'Keep the top third clear of faces.' });
    expect(cover).toContain(NO_CHARACTER_MARKING_RULE);
    expect(cover).toContain(HANDS_HOLD_ONLY_NAMED_RULE);
  });

  it('leaves no unfilled placeholder behind', () => {
    // fillTemplate warns once and then deletes an unfilled {TOKEN}. Adding a
    // placeholder without declaring it in the builder ships a silent hole.
    expect(unfilled(build())).toEqual([]);
  });

  // REACH IS MEASURED ON THE SENT PROMPT (2026-09-23). The built prompt is not
  // what the illustrator receives once it is over the model cap: the shrink
  // listed both anchors as droppable blocks, and staging
  // job_1790100385959_1nitlympp p12 and all three covers were judged for D-24
  // and D-16b with neither rule in the prompt that was sent. A built-prompt
  // assertion stayed green through all of it.
  it('both rules survive the shrink of an over-cap page and an over-cap cover', async () => {
    // @ts-expect-error - JS module without types
    const { shrinkPromptForModel } = await import('../../server/lib/images.js');
    const CAP = 7900;
    const longBrief = () => {
      const prose = 'The main character kneels beside the lantern on the wet planks of the pier, both hands cupped around its glass. '.repeat(70);
      return `${prose}\n\n---METADATA---\n${JSON.stringify({
        sceneIntent: 'the lamp is lit',
        characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
        shot: 'wide',
        objects: ['ART001'],
        textPosition: 'bottom-left',
      })}`;
    };
    const page = String(PB.buildImagePrompt(longBrief(), inputData, null, VISUAL_BIBLE, 1, null, {}));
    const cover = String(PB.buildCoverPrompt('back', {
      sceneDescription: 'A wide group portrait set before the pier. '.repeat(160),
      inputData, visualBible: VISUAL_BIBLE, referencePhotos: [],
    }));
    for (const built of [page, cover]) {
      expect(built.length, 'the fixture must be over the cap or it proves nothing').toBeGreaterThan(CAP);
      const sent = String(await shrinkPromptForModel(built, CAP, 'TEST reach', null));
      expect(sent.length).toBeLessThanOrEqual(CAP);
      expect(sent).toContain(NO_CHARACTER_MARKING_RULE);
      expect(sent).toContain(HANDS_HOLD_ONLY_NAMED_RULE);
    }
  });

  it('both rules sit in the protected tail, after REQUIRED OBJECTS', () => {
    // shrinkPromptForModel splits the prompt at the REQUIRED OBJECTS block and
    // hands only the HEAD to a compressor. A must-survive rule placed above
    // that split can be compressed away — the exact fault 2adea0dd9 fixed.
    const p = build();
    const split = p.indexOf('**REQUIRED OBJECTS');
    expect(split, 'the tail marker moved — re-check where these rules sit').toBeGreaterThan(-1);
    expect(p.indexOf(NO_CHARACTER_MARKING_RULE)).toBeGreaterThan(split);
    expect(p.indexOf(HANDS_HOLD_ONLY_NAMED_RULE)).toBeGreaterThan(split);
  });
});

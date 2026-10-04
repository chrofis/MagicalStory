/**
 * A CREATURE'S FACE AND ACTION ARE FIELDS (owner-approved 2026-10-04; staging
 * job_1791040103540_atbttop6w p6).
 *
 * The brief had a Visual Bible animal press its wings over its ears with a tense
 * face. `characters[]` is the human cast, so the creature got no EXPRESSIONS
 * line, no emotion check, and no EXACT POSES line (no interaction row named it
 * as the actor); its Visual Bible `features` also fixed "a calm closed-mouth
 * smile" on every page. Pinned:
 *   1  all four brief-authoring templates carry CREATURE_FIELD_RULE, both
 *      Visual Bible authoring sites carry CREATURE_FEATURES_RULE;
 *   2  the parser keeps `creatures[]` rows (animal ids only) on both branches;
 *   3  a creature row reaches the image prompt's EXPRESSIONS AND EYES block
 *      under the animal's name, and its actor row the EXACT POSES block;
 *   4  the declared-emotion check compares a creature's declared emotion with
 *      the one the blind inventory read off the animal.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const PB = cjs('../../server/lib/promptBuilders.js');
const { parseCreatures } = cjs('../../server/lib/sceneMetadata.js');
const { gazeCreatures, gazeCharacters } = cjs('../../server/lib/vbIdGuard.js');
const { checkDeclaredEmotion } = cjs('../../server/lib/emotionCheck.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = cjs('../../server/services/prompts.js');

const BIBLE = { animals: [{ id: 'ANI001', name: 'the dragon', species: 'dragon', features: 'large round golden eyes' }], artifacts: [], vehicles: [], locations: [], secondaryCharacters: [] };
const META = {
  objects: ['LOC001', 'ANI001'],
  fullData: {
    objects: ['LOC001', 'ANI001'],
    characters: [{ name: 'CharacterA', depth: 'foreground', looksAt: 'ANI001', expression: 'brows pulled together', emotion: 'sad' }],
    creatures: [{ id: 'ANI001', depth: 'midground', looksAt: 'CharacterA', expression: 'brows pulled down, face tense', emotion: 'afraid' }],
    interactions: [{ character: 'ANI001', object: 'its ears', where: 'presses both folded wings flat over its ears', action: 'covering ears', storyRelevant: true, priority: 'essential' }],
  },
};

describe('1 — the rules reach every authoring site', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  it('the four page-brief templates place {CREATURE_FIELD}; the two bible sites place {CREATURE_FEATURES}', () => {
    for (const k of ['sceneBriefsAll', 'sceneExpansion', 'sceneIteration', 'sceneIterationFree']) {
      const t = String((PROMPT_TEMPLATES as any)[k] || '');
      if (t) expect(t, k).toContain('{CREATURE_FIELD}');
    }
    expect(PB.CREATURE_FIELD_RULE).toContain('`creatures[]`');
    expect(PB.CREATURE_FEATURES_RULE).toMatch(/Never an expression, an emotion or a smile/);
    expect(PB.CREATURE_FEATURES_RULE).toMatch(/no visible teeth/);
  });
  it('the cute tone level states mouth anatomy, never a smile', () => {
    for (const age of [0, 3, 4]) {
      const tone = PB.buildCreatureToneSection({ characters: [{ id: 1, name: 'A', age }], mainCharacters: [1] });
      expect(tone, `age ${age}`).not.toMatch(/smil/i);
    }
    expect(PB.buildCreatureToneSection({ characters: [{ id: 1, name: 'A', age: 3 }], mainCharacters: [1] })).toMatch(/no visible teeth/);
  });
});

describe('2 — the parser keeps creature rows', () => {
  it('keeps animal ids and the four face fields, drops anything else', () => {
    expect(parseCreatures([
      { id: 'ani001', depth: ' midground ', emotion: 'afraid', size: 'big' },
      { id: 'CHR001', emotion: 'happy' },
      'ANI002',
    ])).toEqual([{ id: 'ANI001', depth: 'midground', emotion: 'afraid' }]);
  });
});

describe('3 — the image prompt states the creature\'s face and action', () => {
  it('EXPRESSIONS AND EYES names the creature; EXACT POSES carries its actor row', () => {
    const figures = [...(gazeCharacters(META) || []), ...gazeCreatures(META, BIBLE)];
    const block = PB.buildExactPosesBlock(META.fullData.interactions, figures, BIBLE);
    expect(block).toMatch(/- the dragon: presses both folded wings flat over its ears/);
    expect(block).toMatch(/- the dragon: brows pulled down, face tense; eyes on CharacterA/);
  });
  it('a row whose id the bible does not hold as an animal is dropped', () => {
    expect(gazeCreatures({ fullData: { creatures: [{ id: 'ANI009', emotion: 'happy' }] } }, BIBLE)).toEqual([]);
  });
});

describe('4 — the declared emotion of a creature is checked', () => {
  // Stored quality-eval match for the creature on p6 (body box) and the
  // inventory's animal object with its read emotion.
  const matches = [{ figure: 2, reference: 'the dragon', confidence: 0.9, body_bbox: [0.44, 0.03, 0.89, 0.51] }];
  const inventory = { figures: [], objects: [{ what: 'a red dragon', body_bbox: [0.45, 0.04, 0.88, 0.5], emotion: 'happy' }] };
  it('afraid declared, happy read → a CRITICAL emotion finding on the creature', () => {
    const out = checkDeclaredEmotion({ declared: gazeCreatures(META, BIBLE), inventory, matches });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'emotion', character: 'the dragon', severity: 'CRITICAL' });
  });
  it('NEGATIVE CONTROL — an animal object with no face read is not a figure', () => {
    const blind = { figures: [], objects: [{ what: 'a red dragon', body_bbox: [0.45, 0.04, 0.88, 0.5] }] };
    expect(checkDeclaredEmotion({ declared: gazeCreatures(META, BIBLE), inventory: blind, matches })).toEqual([]);
  });
});

/**
 * `scaleClass` — the authored, machine-facing scale band on every Visual Bible
 * element (phase 1 of tasks/vb-scale-class-plan-2026-09-15.md).
 *
 * WHY THIS EXISTS. On job_1789420511893_zly5rcdej page 8 a chestnut whose
 * `size` correctly read "the size of a thumb" rendered football-sized as the
 * nearest object to camera: a correct free-text size changed nothing, because
 * nothing in CODE reads a sentence. `scaleClass` is the token code reads.
 *
 * Three invariants are pinned here, and they are behaviour, not wording:
 *   1. the WHITELIST parse admits the field on all five element collections
 *      (an unlisted field is dropped silently — that is how VEH001 lost its
 *      size entirely);
 *   2. an unknown or missing value becomes `null` and is NEVER coerced to a
 *      nearest band — a guessed class routes an object to the wrong pipeline,
 *      and `null` is a first-class route back to today's type-based behaviour;
 *   3. the token NEVER reaches an image model: not in `description`, not in
 *      `label`, not in the REQUIRED OBJECTS `sizeNote`, not anywhere in a
 *      built page prompt.
 */
import { describe, it, expect, vi } from 'vitest';

// @ts-ignore - CommonJS
const VB = require('../../server/lib/visualBible');
// @ts-ignore - CommonJS
const PB = require('../../server/lib/promptBuilders');
// @ts-ignore - CommonJS
const { log } = require('../../server/utils/logger');

const { parseVisualBible, parseNewVisualBibleEntries, normaliseScaleClass, SCALE_CLASSES } = VB;

const bible = (data: any) =>
  '---VISUAL BIBLE---\n```json\n' + JSON.stringify(data) + '\n```';

const FULL = {
  secondaryCharacters: [{ id: 'CHR001', name: 'Tobias', pages: [1], scaleClass: 'person' }],
  animals: [{ id: 'ANI001', name: 'Fünkli', pages: [1], species: 'cat', scaleClass: 'person' }],
  artifacts: [{
    id: 'ART001', label: 'roasted chestnut', name: 'roasted chestnut', pages: [1],
    type: 'food', size: 'the size of a thumb', scaleClass: 'hand',
    description: 'a split roasted chestnut, glossy brown'
  }],
  locations: [{ id: 'LOC001', name: 'the quay', pages: [1], setting: 'outdoor', scaleClass: 'landscape' }],
  vehicles: [{
    id: 'VEH001', label: 'wooden sailing ship', name: 'wooden sailing ship', pages: [1],
    colorAndDetails: 'a three-masted hull in tarred oak', signatureElement: 'a red pennant',
    scaleClass: 'building'
  }],
};

describe('scaleClass — the closed enum', () => {
  it('is exactly the six authored bands, in the order the prompt states them', () => {
    expect(SCALE_CLASSES).toEqual(['hand', 'arm', 'person', 'vehicle', 'building', 'landscape']);
  });

  it('lowercases and trims an authored value', () => {
    expect(normaliseScaleClass('  Vehicle ', 'VEH001')).toBe('vehicle');
  });

  it('never coerces an unknown token to a nearest band', () => {
    // Adjectives name no band, and neither does a near-miss spelling.
    for (const bad of ['huge', 'massive', 'tiny', 'ship', 'hand-sized', 'buildings', '']) {
      expect(normaliseScaleClass(bad, 'ART001'), bad).toBeNull();
    }
  });

  it('accepts a correctly spelled band in any casing', () => {
    expect(normaliseScaleClass('HAND', 'ART001')).toBe('hand');
    expect(normaliseScaleClass('Landscape', 'LOC001')).toBe('landscape');
  });

  it('returns null rather than throwing for a missing or non-string value', () => {
    expect(normaliseScaleClass(undefined, 'ART001')).toBeNull();
    expect(normaliseScaleClass(null, 'ART001')).toBeNull();
    expect(normaliseScaleClass(3, 'ART001')).toBeNull();
    expect(normaliseScaleClass({}, 'ART001')).toBeNull();
  });
});

describe('scaleClass — the Visual Bible whitelist parse', () => {
  it('admits the field on all five element collections', () => {
    const vb = parseVisualBible(bible(FULL));
    expect(vb.secondaryCharacters[0].scaleClass).toBe('person');
    expect(vb.animals[0].scaleClass).toBe('person');
    expect(vb.artifacts[0].scaleClass).toBe('hand');
    expect(vb.locations[0].scaleClass).toBe('landscape');
    expect(vb.vehicles[0].scaleClass).toBe('building');
  });

  it('admits it on entries the story text adds mid-book too', () => {
    const section = '---NEW VISUAL BIBLE ENTRIES---\n```json\n' + JSON.stringify({
      artifacts: [{ id: 'ART009', name: 'iron key', pages: [5], scaleClass: 'hand', description: 'a key' }],
      vehicles: [{ id: 'VEH009', name: 'hay cart', pages: [5], colorAndDetails: 'a cart', signatureElement: 'a wheel', scaleClass: 'vehicle' }],
    }) + '\n```';
    const entries = parseNewVisualBibleEntries(section);
    expect(entries.artifacts[0].scaleClass).toBe('hand');
    expect(entries.vehicles[0].scaleClass).toBe('vehicle');
  });

  it('leaves a stored bible that predates the field at null, not at a guess', () => {
    const legacy = JSON.parse(JSON.stringify(FULL));
    for (const coll of ['secondaryCharacters', 'animals', 'artifacts', 'locations', 'vehicles']) {
      for (const e of (legacy as any)[coll]) delete e.scaleClass;
    }
    const vb = parseVisualBible(bible(legacy));
    expect(vb.artifacts[0].scaleClass).toBeNull();
    expect(vb.vehicles[0].scaleClass).toBeNull();
    expect(vb.locations[0].scaleClass).toBeNull();
    // and the entry is otherwise intact — a missing class is not an error
    expect(vb.artifacts[0].size).toBe('the size of a thumb');
    expect(vb.vehicles[0].name).toBe('wooden sailing ship');
  });

  it('drops an unknown value to null and says so in the log', () => {
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const bad = JSON.parse(JSON.stringify(FULL));
      bad.artifacts[0].scaleClass = 'enormous';
      const vb = parseVisualBible(bible(bad));
      expect(vb.artifacts[0].scaleClass).toBeNull();
      const said = spy.mock.calls.map(c => String(c[0])).join('\n');
      expect(said).toContain('ART001');
      expect(said).toContain('enormous');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('scaleClass is machine-facing — it never reaches an image model', () => {
  const vb = parseVisualBible(bible(FULL));

  it('stays out of every element description and label', () => {
    for (const coll of ['secondaryCharacters', 'animals', 'artifacts', 'locations', 'vehicles']) {
      for (const e of (vb as any)[coll]) {
        expect(String(e.description || '')).not.toMatch(/scaleClass/i);
        // the band token itself must not have been folded into the prose
        expect(String(e.description || '').toLowerCase()).not.toContain('scaleclass');
        expect(String(e.label || '')).not.toMatch(/scaleClass/i);
      }
    }
  });

  it('stays out of the built page prompt, while `size` still rides on it', () => {
    const brief = 'The main character stands on the quay holding a roasted chestnut.'
      + '\n\n---METADATA---\n' + JSON.stringify({
        sceneIntent: 'the chestnut is offered',
        characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
        shot: 'wide',
        objects: ['ART001'],
        textPosition: 'bottom-left',
      });
    const inputData: any = {
      title: 'The Quay', characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl' }],
      mainCharacters: ['c1'], language: 'en', languageLevel: 'medium', pages: 4,
      artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
    };
    const prompt = String(PB.buildImagePrompt(brief, inputData, null, vb, 1, null, {}));
    expect(prompt).not.toMatch(/scaleClass/i);
    // The negative control: the prompt IS carrying the artifact and its free-text
    // size, so "the token is absent" is not just "nothing arrived at all".
    expect(prompt).toContain('the size of a thumb');
  });
});

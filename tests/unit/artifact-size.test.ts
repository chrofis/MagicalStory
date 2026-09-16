import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// @ts-ignore - CommonJS modules
const { buildArtifactDescription, parseVisualBible, SCALE_CLASS_SPEC } = require('../../server/lib/visualBible');
// @ts-ignore
const { buildTextFromJson } = require('../../server/lib/sceneMetadata');
// @ts-ignore
const PB = require('../../server/lib/promptBuilders');

const NL = String.fromCharCode(10);
const PROMPTS = path.join(__dirname, '..', '..', 'prompts');
const read = (f: string) => fs.readFileSync(path.join(PROMPTS, f), 'utf-8');

/** The page prompt a one-artifact bible produces, with that artifact cited. */
const buildPagePrompt = (vb: any) => {
  const brief = ['The main character carries a wooden pail across the yard.', '', '---METADATA---', JSON.stringify({
    sceneIntent: 'the pail is carried',
    characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
    shot: 'wide', objects: ['ART001'], textPosition: 'bottom-left',
  })].join(NL);
  return String(PB.buildImagePrompt(brief, {
    title: 'The Yard', characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl' }],
    mainCharacters: ['c1'], language: 'en', languageLevel: 'medium', pages: 4,
    artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
  } as any, null, vb, 1, null, {}));
};

// Templates that AUTHOR artifacts into a Visual Bible. Every one of them must
// make the element state its scale, or the anchor never reaches the image
// prompt (measured 2026-09-14: full path 2/176 on staging, 0/29 on prod,
// because two of these four had no such field). Since 2026-09-15 the field is
// the closed `scaleClass` band, not a free-text sentence.
/** The bands every authoring site must offer, ascending. */
// 2026-09-16: the height ladder's top rung is `adult`, and `melon` is the
// head-SIZED band it used to be confused with. `head` survives only as a
// stored-bible alias — it is no longer OFFERED to an author.
const BANDS = ['fingertip', 'palm', 'hand', 'melon', 'forearm', 'arm', 'knee', 'hip', 'chest', 'adult', 'double', 'house', 'landmark'];

// The two pre-beats unified writers were members until 2026-09-15, when they
// were deleted as unreachable (docs/decisions.md).
const ARTIFACT_AUTHORING_TEMPLATES = [
  'story-trial.txt',
  'scene-expansion-all.txt'
];

describe('artifact size — builder contract', () => {
  it('folds the authored band into the description, the way animals do', () => {
    const desc = buildArtifactDescription({
      description: 'a squat pail with two iron bands',
      type: 'hand tool',
      scaleClass: 'knee'
    });
    expect(desc).toContain('a squat pail with two iron bands');
    expect(desc).toContain('stands knee-high to an adult');
    // the phrase, never the token
    expect(desc).not.toMatch(/Size: knee$/);
  });

  it('falls back to a stored free-text size when the bible predates the enum', () => {
    const desc = buildArtifactDescription({
      description: 'a squat pail with two iron bands',
      type: 'hand tool',
      size: 'reaches the knee of a child standing beside it'
    });
    expect(desc).toContain('reaches the knee of a child standing beside it');
  });

  it('omits the size clause entirely when neither a band nor a size is set', () => {
    const desc = buildArtifactDescription({ description: 'a squat pail', type: 'hand tool' });
    expect(desc).toBe('a squat pail');
    expect(desc.toLowerCase()).not.toContain('size');
  });

  it('never emits the "undefined" fallback the old inline expression produced', () => {
    expect(buildArtifactDescription({ type: 'hand tool' })).not.toContain('undefined');
  });

  // 2026-09-15 (afternoon, reversing that morning): the enum REPLACED the
  // free-text size as the thing that reaches the model. `elementScaleNote` is
  // the one lookup - code reads the token, the prompt gets the phrase.
  it('puts the band phrase on the REQUIRED OBJECTS line, and not the token', () => {
    const outline = ['---VISUAL BIBLE---', '```json', JSON.stringify({
      artifacts: [{
        id: 'ART001', label: 'wooden pail', name: 'wooden pail', pages: [1],
        type: 'hand tool', scaleClass: 'forearm',
        description: 'a squat pail with two iron bands'
      }]
    }), '```'].join(NL);
    const prompt = buildPagePrompt(parseVisualBible(outline));
    expect(prompt).toContain("about as long as an adult's forearm");
    expect(prompt).not.toMatch(/scaleClass/i);
    expect(prompt).not.toMatch(/\u2014 forearm\b/);
  });

  it('still rides a pre-enum bible stored size onto the same line', () => {
    const outline = ['---VISUAL BIBLE---', '```json', JSON.stringify({
      artifacts: [{
        id: 'ART001', label: 'wooden pail', name: 'wooden pail', pages: [1],
        type: 'hand tool', size: 'spans a child forearm',
        description: 'a squat pail with two iron bands'
      }]
    }), '```'].join(NL);
    expect(buildPagePrompt(parseVisualBible(outline))).toContain('spans a child forearm');
  });

  it('survives the real Visual Bible parser', () => {
    const outline = '---VISUAL BIBLE---\n```json\n' + JSON.stringify({
      artifacts: [{
        id: 'ART001', label: 'wooden pail', name: 'wooden pail', pages: [1],
        type: 'hand tool', size: 'spans a child forearm',
        description: 'a squat pail with two iron bands'
      }]
    }) + '\n```';
    const vb = parseVisualBible(outline);
    expect(vb.artifacts[0].size).toBe('spans a child forearm');
    expect(vb.artifacts[0].description).toContain('spans a child forearm');
  });
});

describe('artifact size — trial scene-hint slot', () => {
  const scene = (objects: any[]) => ({
    imageSummary: 'x',
    setting: { location: 'none', indoorOutdoor: 'outdoor', description: 'a yard', lighting: 'morning' },
    characters: [{ name: 'Main', position: 'center', action: 'stands', expression: 'calm' }],
    objects,
    interactions: []
  });

  it('renders a per-page size into the scene prose', () => {
    const text = buildTextFromJson(scene([
      { id: 'ART001', name: 'wooden pail [ART001]', position: 'in both hands', size: 'spans a child forearm' }
    ]));
    expect(text).toContain('spans a child forearm');
  });

  it('adds nothing when the hint omits size', () => {
    const text = buildTextFromJson(scene([
      { id: 'ART001', name: 'wooden pail [ART001]', position: 'in both hands' }
    ]));
    expect(text).toContain('wooden pail: in both hands');
    expect(text).not.toContain('(');
  });
});

describe('artifact scale — authoring instruction contract', () => {
  for (const file of ARTIFACT_AUTHORING_TEMPLATES) {
    it(file + ' offers scaleClass on artifacts and demands it', () => {
      const text = read(file);
      const artifactBlock = text.slice(text.indexOf('"artifacts"'));
      expect(artifactBlock).toContain('"scaleClass"');
      expect(text).toContain('Every Visual Bible element carries `scaleClass`');
    });

    it(file + ' offers no free-text size field on a Visual Bible entry', () => {
      // The reversal, pinned: an authored sentence is unverifiable and drifts,
      // so the schema no longer has a slot for one.
      const text = read(file);
      expect(text).not.toContain('"size": "[relative size]"');
      expect(text).not.toContain('"size": "[how big this object is beside a person');
      expect(text).not.toContain('Every artifact carries `size`');
    });

    // The instruction itself is no longer typed into the template: both
    // authoring sites declare the {SCALE_CLASS_SPEC} placeholder and the
    // constant in visualBible.js is filled into it (2026-09-16). What each
    // template still owes is the slot; the vocabulary is asserted on the
    // constant, so there is one place to read it and one place to change it.
    it(file + ' takes its scaleClass instruction from the code constant', () => {
      const text = read(file);
      expect(text.includes('"scaleClass": "{SCALE_CLASS_SPEC}"'),
        file + ' no longer declares the scaleClass placeholder').toBe(true);
      expect(text.includes('"scaleClass": "[the element'),
        file + ' hand-types the scaleClass instruction again').toBe(false);
    });

    it(file + ' lists the thirteen bands and no others', () => {
      for (const band of BANDS) expect(SCALE_CLASS_SPEC, band).toContain(band);
      // the retired six-value list must not survive as choices anywhere
      expect(read(file)).not.toContain('person, vehicle, building, landscape');
    });

    it(file + ' states the bands against an adult, never in units', () => {
      expect(SCALE_CLASS_SPEC).toMatch(/\badult\b/);
      expect(SCALE_CLASS_SPEC).not.toMatch(/\bcm\b|\bmetre|\bmeter|\binch/i);
    });
  }
});

/**
 * The Art Director's size-ratio rule (8f) lives at BOTH brief templates and was
 * CONDITIONAL on the entry stating a size ("an element whose Visual Bible entry
 * states a size"). With the free-text field retired, that condition would now
 * read as never satisfied — so the obligation is unconditional, which is what
 * decisions.md 2026-09-14 wanted and the enum finally makes true: every element
 * carries a band.
 */
describe('the Art Director size-ratio rule survives the field swap', () => {
  for (const file of ['scene-expansion.txt', 'scene-expansion-all.txt']) {
    it(file + ' states the ratio obligation without a size-field condition', () => {
      const text = read(file);
      expect(text).toContain('Every page that cites an element and holds a figure too names');
      expect(text).toContain('as a ratio against a figure in the prose');
      // the retired condition must not linger — it would gate the rule off
      expect(text).not.toContain('whose Visual Bible entry states a size');
    });

    it(file + ' keeps a creature\u2019s scale on every page, now keyed on the band', () => {
      const text = read(file);
      expect(text).toContain("keeps the size its entry\u2019s `scaleClass` band states on every page it appears on");
    });
  }
});

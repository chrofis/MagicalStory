import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// @ts-ignore - CommonJS modules
const { buildArtifactDescription, parseVisualBible } = require('../../server/lib/visualBible');
// @ts-ignore
const { buildTextFromJson } = require('../../server/lib/sceneMetadata');
// @ts-ignore
const PB = require('../../server/lib/promptBuilders');

const NL = String.fromCharCode(10);
const PROMPTS = path.join(__dirname, '..', '..', 'prompts');
const read = (f: string) => fs.readFileSync(path.join(PROMPTS, f), 'utf-8');

// Templates that AUTHOR artifacts into a Visual Bible. Every one of them must
// offer the `size` field, or the bible cannot emit it and the scale anchor
// never reaches the image prompt (measured 2026-09-14: full path 2/176 on
// staging, 0/29 on prod, because two of these four had no such field).
const ARTIFACT_AUTHORING_TEMPLATES = [
  'story-unified.txt',
  'story-unified-imagefirst.txt',
  'story-trial.txt',
  'scene-expansion-all.txt'
];

describe('artifact size — builder contract', () => {
  it('folds a set size into the description, the way animals do', () => {
    const desc = buildArtifactDescription({
      description: 'a squat pail with two iron bands',
      type: 'hand tool',
      size: 'reaches the knee of a child standing beside it'
    });
    expect(desc).toContain('a squat pail with two iron bands');
    expect(desc).toContain('reaches the knee of a child standing beside it');
  });

  it('omits the size clause entirely when the field is unset', () => {
    const desc = buildArtifactDescription({ description: 'a squat pail', type: 'hand tool' });
    expect(desc).toBe('a squat pail');
    expect(desc.toLowerCase()).not.toContain('size');
  });

  it('never emits the "undefined" fallback the old inline expression produced', () => {
    expect(buildArtifactDescription({ type: 'hand tool' })).not.toContain('undefined');
  });

  // 2026-09-15: `scaleClass` was added beside `size`, not instead of it. The
  // two have different consumers — `size` is the prose a model reads, the class
  // is the token code routes on — and folding `size` away would reverse
  // e476ca314 and the 2026-09-11 animal extension with no evidence it harms.
  it('keeps the free-text size on the REQUIRED OBJECTS line once a class is authored too', () => {
    const outline = ['---VISUAL BIBLE---', '```json', JSON.stringify({
      artifacts: [{
        id: 'ART001', label: 'wooden pail', name: 'wooden pail', pages: [1],
        type: 'hand tool', size: 'spans a child forearm', scaleClass: 'arm',
        description: 'a squat pail with two iron bands'
      }]
    }), '```'].join(NL);
    const vb = parseVisualBible(outline);
    const brief = ['The main character carries a wooden pail across the yard.', '', '---METADATA---', JSON.stringify({
        sceneIntent: 'the pail is carried',
        characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
        shot: 'wide', objects: ['ART001'], textPosition: 'bottom-left',
      })].join(NL);
    const prompt = String(PB.buildImagePrompt(brief, {
      title: 'The Yard', characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl' }],
      mainCharacters: ['c1'], language: 'en', languageLevel: 'medium', pages: 4,
      artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
    } as any, null, vb, 1, null, {}));
    expect(prompt).toContain('spans a child forearm');
    expect(prompt).not.toMatch(/scaleClass/i);
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

describe('artifact size — authoring instruction contract', () => {
  for (const file of ARTIFACT_AUTHORING_TEMPLATES) {
    it(`${file} offers a size field on artifacts and demands it`, () => {
      const text = read(file);
      const artifactBlock = text.slice(text.indexOf('"artifacts"'));
      expect(artifactBlock).toContain('"size"');
      expect(text).toContain('Every artifact carries `size`');
    });

    it(`${file} forbids metric units in the size anchor`, () => {
      const text = read(file);
      const sizeLine = text.split('\n').find(l => l.includes('"size": "[how big this object is beside a person'));
      expect(sizeLine, `${file} is missing the shared size instruction`).toBeTruthy();
      expect(sizeLine!).toMatch(/No metric or imperial units/);
    });

    it(`${file} gives no copyable size exemplar`, () => {
      const text = read(file);
      const start = text.indexOf('"size": "[how big this object is beside a person');
      const instruction = text.slice(start, text.indexOf(']"', start));
      // The exemplar the model collapsed onto (6 of 9 staging values verbatim).
      expect(instruction).not.toContain('fits in one hand');
      expect(instruction).not.toContain('carried in both arms');
      // No quoted phrase at all inside the size instruction — nothing to copy.
      expect(instruction.match(/'[^']{4,}'/g)).toBeNull();
    });
  }
});

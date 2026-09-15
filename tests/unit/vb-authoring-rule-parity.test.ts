import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * The Visual Bible is authored in four places: the Art Director on the beats
 * path, the two unified writers, and the trial writer. A rule about what a VB
 * entry must STATE has to exist at every site that writes one — the trial path
 * has repeatedly lagged the full path by weeks.
 */
const VB_AUTHORING_TEMPLATES = [
  'prompts/scene-expansion-all.txt',
  'prompts/story-unified.txt',
  'prompts/story-unified-imagefirst.txt',
  'prompts/story-trial.txt',
];

describe('shared Visual-Bible authoring rules reach every authoring site', () => {
  // A person-shaped entry reaches the image model as its description and
  // nothing else, so an unstated head is drawn bald.
  it('the hair rule for person-shaped entries', () => {
    for (const rel of VB_AUTHORING_TEMPLATES) {
      expect(read(rel).includes('is drawn bald'), path.basename(rel)).toBe(true);
    }
  });

  // Closed world: the landmark list is the only source of a real landmark, and
  // an ABSENT list means none are available. Without the empty-list clause the
  // author was told to take the name "from the available landmarks list" while
  // {AVAILABLE_LANDMARKS_SECTION} rendered to nothing.
  it('the landmark closed-world rule, including the empty-list case', () => {
    for (const rel of VB_AUTHORING_TEMPLATES) {
      const text = read(rel);
      expect(/isRealLandmark/.test(text), path.basename(rel)).toBe(true);
      expect(
        /[Nn]o (AVAILABLE )?LANDMARKS section/.test(text),
        `${path.basename(rel)} states what happens with no landmark list`
      ).toBe(true);
    }
  });

  // A proper noun in `name` reaches the image model as the thing to draw.
  it('a prop name is a plain description; the story name goes in properName', () => {
    for (const rel of ['prompts/story-unified.txt', 'prompts/story-unified-imagefirst.txt']) {
      const text = read(rel);
      expect(/goes in `properName` and nowhere else/.test(text), path.basename(rel)).toBe(true);
      expect(/"properName": /.test(text), path.basename(rel) + ' schema').toBe(true);
    }
  });

  // 2026-09-15: the free-text `size` rule was REPLACED by the enum rule, not
  // dropped. Every element still has to state its scale at every authoring
  // site — it now states it as a closed band instead of a sentence.
  it('every element carries scaleClass, and no entry states a size of its own', () => {
    for (const rel of VB_AUTHORING_TEMPLATES) {
      const text = read(rel);
      const who = path.basename(rel);
      expect(/Every Visual Bible element carries `scaleClass`/.test(text), who).toBe(true);
      expect(/it is the only place an element’s size is stated/.test(text), who).toBe(true);
      // the retired free-text rule must not linger at any site
      expect(/Every artifact carries `size`/.test(text), who + ' still demands free-text size').toBe(false);
    }
  });
});

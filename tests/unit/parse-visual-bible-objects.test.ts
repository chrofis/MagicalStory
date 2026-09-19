import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseVisualBibleObjects } = require('../../server/lib/bboxDetection');

// The exact REQUIRED OBJECTS block a real page prompt carries (dragon story p17):
// header line, one `* **Name** (type) — rider` entry per element, then the
// trailing PLAIN lines that promptBuilders deliberately emits without a `* **`
// prefix so they are not read as objects.
const REAL_P17 = `The scene shows the nest at dawn.

**REQUIRED OBJECTS IN THIS SCENE (each appears exactly as the scene description places it):**
* **dragon egg** (object) — broken open into two empty shell halves
* **Mother Dragon** (animal) — about the size of a small house
* **Funkli** (animal) — about the size of a school bag
The attached reference images include rough images of: dragon egg; Mother Dragon — match each one's look at the size and placement the scene description gives it.
A state that divides, opens or breaks an object does not multiply its markings: a device, emblem or pattern on the surface is one marking, and the split runs through it — each part shows only its share.
`;

describe('parseVisualBibleObjects', () => {
  it('returns every entry of a real REQUIRED OBJECTS block', () => {
    expect(parseVisualBibleObjects(REAL_P17)).toEqual(['dragon egg', 'Mother Dragon', 'Funkli']);
  });

  it('does not read the trailing plain reference-image line as an object', () => {
    const names = parseVisualBibleObjects(REAL_P17);
    expect(names.some(n => /attached|reference images|marking/i.test(n))).toBe(false);
  });

  it('excludes (location) entries', () => {
    const block = `**REQUIRED OBJECTS IN THIS SCENE:**
* **Old Mill** (location) — at dusk
* **lantern** (object) — lit
`;
    expect(parseVisualBibleObjects(block)).toEqual(['lantern']);
  });

  it('parses the legacy "* **Name** (type): description" shape', () => {
    const block = `**REQUIRED OBJECTS IN THIS SCENE:**
* **wooden chest** (object): A shoebox-sized chest with iron bands
* **Bruno** (animal): A large brown dog
`;
    expect(parseVisualBibleObjects(block)).toEqual(['wooden chest', 'Bruno']);
  });

  it('terminates at the next bold heading without swallowing it', () => {
    const block = `**REQUIRED OBJECTS IN THIS SCENE:**
* **lantern** (object) — lit
* **Funkli** (animal) — small
**WORN ITEMS:**
* **red scarf** (clothing) — worn by the hero
`;
    expect(parseVisualBibleObjects(block)).toEqual(['lantern', 'Funkli']);
  });

  it('terminates at a blank line', () => {
    const block = `**REQUIRED OBJECTS IN THIS SCENE:**
* **lantern** (object) — lit

* **not an object** (object) — after the block
`;
    expect(parseVisualBibleObjects(block)).toEqual(['lantern']);
  });

  it('returns [] for non-string or missing sections', () => {
    expect(parseVisualBibleObjects('')).toEqual([]);
    expect(parseVisualBibleObjects(null)).toEqual([]);
    expect(parseVisualBibleObjects('no such section here')).toEqual([]);
  });
});

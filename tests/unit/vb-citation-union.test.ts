import { describe, it, expect } from 'vitest';

// STORY B job_1789343124794_z2c779f7i p17 — the silent VB-citation loss.
//
// The v0 prompt (Art Director brief) carried:
//   * **dragon egg** (object) — broken open into two empty shell halves
//   * **Mother Dragon** (animal) — about the size of a small house
//   * **Funkli** (animal) — about the size of a school bag
//   The attached reference images include rough images of: dragon egg;
//   Mother Dragon — …
//
// The v1 prompt — the image that SHIPPED — carried only the dragon egg line
// and only the egg's reference image. The `iterate-round-1` repair, whose
// commission named a hammer artefact, a facing error and stray leaves and no
// scale issue at all, re-authored the page metadata and moved Mother Dragon
// and Funkli OUT of objects[] and INTO characters[]. The REQUIRED OBJECTS
// block walked metadata.objects only, so the render was made with no size
// clause and no ANI reference cell — only the prose adjective "a massive
// emerald green creature". Nothing logged it.
//
// Fix: the citation list is the UNION of objects[] and characters[], and a
// rewrite that drops a cited id warns.

// @ts-expect-error - JS module without types
import { buildImagePrompt, warnDroppedVbCitations } from '../../server/lib/promptBuilders.js';

const ART003 = {
  id: 'ART003',
  name: 'dragon egg',
  label: 'dragon egg',
  type: 'egg',
  description: 'A large pale egg with a net-like pattern of hairline cracks across the shell',
  size: 'roughly the size of a beach ball',
};
const ANI001 = {
  id: 'ANI001',
  name: 'Funkli',
  label: 'small dragon',
  type: 'dragon',
  description: 'A small emerald green dragon with copper belly scales and short blunt horns',
  size: 'about the size of a school bag',
};
const ANI002 = {
  id: 'ANI002',
  name: 'Mother Dragon',
  label: 'large dragon',
  type: 'dragon',
  description: 'A massive emerald green dragon with a long ridged neck and broad leathery wings',
  size: 'about the size of a small house',
};

const visualBible = {
  mainCharacters: [{ id: 'CHR001', name: 'Mila' }],
  secondaryCharacters: [],
  animals: [ANI001, ANI002],
  vehicles: [],
  clothing: [],
  locations: [],
  artifacts: [ART003],
};

const scene = (objects: any[], characters: any[]) =>
  `Mila stands before the hollow, the broken egg at her feet and both dragons beside it. Wide shot.\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'test',
    characters,
    shot: 'wide',
    objects,
    textPosition: 'bottom-left',
  })}`;

const build = (objects: any[], characters: any[], vbRefElementIds: string[] = []) =>
  buildImagePrompt(
    scene(objects, characters),
    { language: 'en-gb', artStyle: 'pixar', layout: { textInImage: true } },
    null,
    visualBible,
    17,
    null,
    { vbRefElementIds }
  ) as string;

const requiredObjectsBlock = (prompt: string) => {
  const i = prompt.indexOf('**REQUIRED OBJECTS');
  if (i < 0) return '';
  const rest = prompt.slice(i);
  const end = rest.indexOf('\n\n');
  return end > 0 ? rest.slice(0, end) : rest;
};

describe('a VB entity citation resolves from objects[] ∪ characters[]', () => {
  it('p17 REGRESSION — two ANI ids reclassified into characters[] keep their block lines AND size riders', () => {
    // Exactly the v1 shape: objects[] lost both animals, characters[] gained them.
    const block = requiredObjectsBlock(build(
      ['LOC004', 'LOC003', 'ART003'],
      [{ name: 'Mila', position: 'center', depth: 'midground' }, 'ANI001', 'ANI002'],
    ));
    expect(block).toContain('* **dragon egg** (object)');
    expect(block).toContain('* **Funkli** (animal) — about the size of a school bag');
    expect(block).toContain('* **Mother Dragon** (animal) — about the size of a small house');
  });

  it('p17 REGRESSION — the reference-cell claim still names the reclassified animal that has a cell', () => {
    const prompt = build(
      ['LOC004', 'LOC003', 'ART003'],
      [{ name: 'Mila', position: 'center', depth: 'midground' }, 'ANI001', 'ANI002'],
      ['ART003', 'ANI002'],
    );
    expect(prompt).toContain('The attached reference images include rough images of:');
    expect(prompt).toContain('Mother Dragon');
    expect(prompt).toContain('dragon egg');
  });

  it('an id filed in BOTH lists emits exactly one line', () => {
    const block = requiredObjectsBlock(build(
      ['ART003', 'ANI002'],
      [{ name: 'Mila', position: 'center', depth: 'midground' }, 'ANI002', 'Mother Dragon [ANI002]'],
    ));
    expect(block.match(/\*\*Mother Dragon\*\* \(animal\)/g) || []).toHaveLength(1);
  });

  it('NEGATIVE CONTROL — a human cast member in characters[] gains no REQUIRED OBJECTS line', () => {
    const block = requiredObjectsBlock(build(
      ['ART003'],
      [{ name: 'Mila', position: 'center', depth: 'midground' }, 'CHR001'],
    ));
    expect(block).toContain('* **dragon egg** (object)');
    expect(block).not.toContain('Mila');
    expect(block).not.toContain('CHR001');
  });
});

describe('a repair rewrite that drops a cited VB id says so', () => {
  it('p17 — the warning fires and names the page and the dropped ids', () => {
    const warnings: string[] = [];
    const dropped = warnDroppedVbCitations(
      17,
      { objects: ['LOC004', 'LOC003', 'ART003', 'ANI001', 'ANI002'], characters: ['Mila'] },
      { objects: ['LOC004', 'LOC003', 'ART003'], characters: ['Mila'] },
      { warn: (m: string) => warnings.push(m), what: 'iterate rewrite' },
    );
    expect(dropped).toEqual(['ANI001', 'ANI002']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Page 17');
    expect(warnings[0]).toContain('ANI001');
    expect(warnings[0]).toContain('ANI002');
  });

  it('a RECLASSIFICATION into characters[] is not a drop — no warning', () => {
    const warnings: string[] = [];
    const dropped = warnDroppedVbCitations(
      17,
      { objects: ['ART003', 'ANI001', 'ANI002'], characters: ['Mila'] },
      { objects: ['ART003'], characters: ['Mila', 'ANI001', 'ANI002'] },
      { warn: (m: string) => warnings.push(m) },
    );
    expect(dropped).toEqual([]);
    expect(warnings).toHaveLength(0);
  });
});

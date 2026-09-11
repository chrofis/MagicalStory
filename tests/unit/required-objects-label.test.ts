import { describe, it, expect } from 'vitest';

// The bug this file locks down (staging job_1788641639919_mpjwlzkf1):
//
// (1) p3 — the REQUIRED OBJECTS lead was a flat six-word chop of the VB
//     DESCRIPTION, so ART001 ("Lily's red woollen hat", description
//     "A small hat knitted from chunky red wool, …") was labelled
//     "small hat knitted from chunky red" — the head noun "wool" cut off,
//     leaving a colour qualifying nothing. ART008
//     ("Copper-coloured fallen leaves") became "Fallen horse chestnut and
//     plane tree", which names two TREES and no leaves. The entry's own
//     `name` is the checklist term and was never consulted.
//
// (2) p8 — `sanitizeVbIdsInPrompt` registers a possessive-stripped alias so
//     "Fiona's Schatzkarte" is also caught as bare "Schatzkarte". For ART001
//     that tail was the descriptive phrase "red woollen hat", which matched
//     INSIDE the Art Director's own sentence "Lily's chunky red woollen hat
//     lies on the damp cobbles" and rewrote it to "Lily's chunky children's
//     knitted hat" — the colour deleted, "chunky" orphaned onto a noun it was
//     never written for.
//
// Fixtures are ART001 / ART008 verbatim from that story.

// @ts-expect-error - JS module without types
import { buildImagePrompt, sanitizeVbIdsInPrompt } from '../../server/lib/promptBuilders.js';

const ART001 = {
  id: 'ART001',
  name: "Lily's red woollen hat",
  type: "children's knitted hat",
  description:
    'A small hat knitted from chunky red wool, dome-shaped at the crown with a wide turned-back brim of two finger-widths, roughly ten centimetres tall when the brim is turned up, the knit stitches visible as raised ridges across the surface, slightly misshapen from wear',
};

const ART008 = {
  id: 'ART008',
  name: 'Copper-coloured fallen leaves',
  type: 'autumn leaves',
  description:
    'Fallen horse chestnut and plane tree leaves in deep copper, burnt orange, and dull gold tones, roughly palm-sized, lying flat or curled at the edges on the ground, scattered unevenly across stone paving and earth',
};

const visualBible = {
  mainCharacters: [{ id: 'CHR001', name: 'Lily' }],
  secondaryCharacters: [],
  animals: [],
  vehicles: [],
  clothing: [],
  locations: [],
  artifacts: [ART001, ART008],
};

const scene = (prose: string, objects: string[]) =>
  `${prose}\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'test',
    characters: [{ name: 'Lily', position: 'center', depth: 'midground' }],
    shot: 'medium',
    objects,
    textPosition: 'bottom-left',
  })}`;

const requiredObjectsBlock = (prompt: string) => {
  const i = prompt.indexOf('**REQUIRED OBJECTS');
  if (i < 0) return '';
  const rest = prompt.slice(i);
  const end = rest.indexOf('\n\n');
  return end > 0 ? rest.slice(0, end) : rest;
};

const build = (prose: string, objects: string[], language = 'en-gb', pageNumber = 3) =>
  buildImagePrompt(
    scene(prose, objects),
    { language, artStyle: 'pixar', layout: { textInImage: true } },
    null,
    visualBible,
    pageNumber,
    null,
    {}
  ) as string;

describe('REQUIRED OBJECTS label is built from the entry name, not a description chop', () => {
  const p3Prose =
    'Lily, wearing her red chunky-knit woollen hat, springs forward across the stone-paved square. Copper-coloured fallen chestnut leaves scatter across the grey cobbles. Ultra-wide shot.';

  it('never emits the truncated HEAD label for ART001', () => {
    const block = requiredObjectsBlock(build(p3Prose, ['ART001', 'ART008']));
    expect(block).not.toContain('small hat knitted from chunky red');
  });

  it("keeps ART001's colour and a head noun on the label", () => {
    const block = requiredObjectsBlock(build(p3Prose, ['ART001', 'ART008']));
    const line = block.split('\n').find((l) => /hat/.test(l))!;
    expect(line).toBeDefined();
    expect(line).toMatch(/\bred\b/);
    expect(line).toMatch(/\bhat\b/);
    // The label must not END on a bare colour — that is the exact defect.
    expect(line).not.toMatch(/\bred\*\*/);
  });

  it("labels ART008 from its name, not two tree species", () => {
    const block = requiredObjectsBlock(build(p3Prose, ['ART001', 'ART008']));
    expect(block).not.toContain('Fallen horse chestnut and plane tree');
    const line = block.split('\n').find((l) => /leaves/.test(l))!;
    expect(line).toBeDefined();
    expect(line).toMatch(/copper/i);
  });

  it('a NON-English story keeps the description-derived ref (settled English-only direction)', () => {
    // decisions.md 2026-07-31: a story-language name must not reach the
    // image prompt. The name path is gated on the story language, so a German
    // story still routes through englishEntityRef.
    const deVb = {
      ...visualBible,
      artifacts: [{ ...ART001, name: 'Lilys rote Wollmütze' }],
    };
    const prompt = buildImagePrompt(
      scene('Lily springs forward across the square.', ['ART001']),
      { language: 'de', artStyle: 'pixar', layout: { textInImage: true } },
      null,
      deVb,
      3,
      null,
      {}
    ) as string;
    expect(prompt).not.toContain('Wollmütze');
  });
});

describe("a VB type never replaces prose the Art Director wrote (p8)", () => {
  const p8Sentence =
    "In the foreground, Lily's chunky red woollen hat lies on the damp cobbles inside the dark timber nook, the only vivid colour in the gloom.";

  it('round-trips the p8 sentence unchanged through the sanitiser', () => {
    const out = sanitizeVbIdsInPrompt(p8Sentence, visualBible, 8);
    expect(out).toBe(p8Sentence);
  });

  it("never emits the HEAD mangling", () => {
    const out = sanitizeVbIdsInPrompt(p8Sentence, visualBible, 8);
    expect(out).not.toContain("chunky children's knitted hat");
    expect(out).toMatch(/\bred\b/);
  });
});

describe('the bible `size` rides the REQUIRED OBJECTS line as a scale anchor', () => {
  it('appends the size after the label when the entry states one', () => {
    const vb = { ...visualBible, artifacts: [{ ...ART001, size: 'fits in one hand' }, ART008] };
    const prompt = buildImagePrompt(
      scene('Lily holds her hat.', ['ART001']),
      { language: 'en-gb', artStyle: 'pixar', layout: { textInImage: true } },
      null, vb, 3, null, {}
    ) as string;
    const line = requiredObjectsBlock(prompt).split('\n').find((l) => /hat/.test(l))!;
    expect(line).toContain('— fits in one hand');
  });

  it('emits no dangling dash when the entry has no size', () => {
    const line = requiredObjectsBlock(build('Lily holds her hat.', ['ART001'])).split('\n').find((l) => /hat/.test(l))!;
    expect(line).not.toMatch(/—\s*$/);
  });
});

describe('an ANIMAL carries its size too (D11, owner 2026-09-11)', () => {
  // job_1789147573901_m3uam0nxi: the bible wrote ANI002 `size` = "body length
  // approximately four metres from snout to tail tip … large enough for four
  // small children and a dog to sit across the back", and the REQUIRED OBJECTS
  // line dropped it — `obj.type !== 'animal'` excluded animals from the rider
  // added for held props (793049e40). The same dragon then rendered knee-high
  // on two pages, a bodiless wing on a third and house-sized on a fourth; the
  // two pages whose prose never restated the size had nothing to go on.
  const DRAGON = {
    id: 'ANI001',
    name: 'Fauchi',
    species: 'dragon',
    size: 'body length approximately four metres from snout to tail tip; large enough for four small children to sit across the back',
    description: 'A dragon with deep teal-green scales over its body and neck, amber eyes.',
    appearsInPages: [3],
  };

  const withDragon = (prose: string) => buildImagePrompt(
    scene(prose, ['ANI001']),
    { language: 'en-gb', artStyle: 'pixar', layout: { textInImage: true } },
    null, { ...visualBible, animals: [DRAGON] }, 3, null, {},
  ) as string;

  it('appends the creature size to its REQUIRED OBJECTS line', () => {
    const line = requiredObjectsBlock(withDragon('Fauchi waits by the cave.'))
      .split('\n').find((l) => /Fauchi/i.test(l))!;
    expect(line).toContain('— body length approximately four metres');
    expect(line).toContain('four small children to sit across the back');
  });

  it('an animal with no size still emits no dangling dash', () => {
    const prompt = buildImagePrompt(
      scene('Fauchi waits by the cave.', ['ANI001']),
      { language: 'en-gb', artStyle: 'pixar', layout: { textInImage: true } },
      null, { ...visualBible, animals: [{ ...DRAGON, size: undefined }] }, 3, null, {},
    ) as string;
    const line = requiredObjectsBlock(prompt).split('\n').find((l) => /Fauchi/i.test(l))!;
    expect(line).not.toMatch(/—\s*$/);
  });
});

describe('the Art Director is told a creature holds its size (D11)', () => {
  const fs = require('fs');
  const path = require('path');
  for (const f of ['prompts/scene-expansion.txt', 'prompts/scene-expansion-all.txt']) {
    it(`${f} rule 8f covers creatures, not only vessels and buildings`, () => {
      const t = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
      expect(t).toMatch(/A vessel, building, vehicle or creature holds its real size/);
      expect(t).toMatch(/A creature keeps the size its entry states on every page it appears on/);
    });
  }
});

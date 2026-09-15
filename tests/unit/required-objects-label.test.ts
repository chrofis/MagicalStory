import { describe, it, expect } from 'vitest';

// The bug this file locks down (staging job_1788641639919_mpjwlzkf1):
//
// (1) p3 — the REQUIRED OBJECTS lead was a flat six-word chop of the VB
//     DESCRIPTION, so ART001 ("Lily's red woollen hat", description
//     "A small hat knitted from chunky red wool, …") was labelled
//     "small hat knitted from chunky red" — the head noun "wool" cut off,
//     leaving a colour qualifying nothing. ART008
//     ("Copper-coloured fallen leaves") became "Fallen horse chestnut and
//     plane tree", which names two TREES and no leaves.
//
//     The lead is now the element's ONE authored English `label`, read through
//     vbLabel.labelOf — the same string the detector, the cell gates and the
//     judges use. On de-ch job_1789301291267_ueh8h145m two artifacts both
//     declared type "tool" and the block read "**tool** (object)" twice.
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
  label: 'red woollen hat',
  type: "children's knitted hat",
  description:
    'A small hat knitted from chunky red wool, dome-shaped at the crown with a wide turned-back brim of two finger-widths, roughly ten centimetres tall when the brim is turned up, the knit stitches visible as raised ridges across the surface, slightly misshapen from wear',
};

const ART008 = {
  id: 'ART008',
  name: 'Copper-coloured fallen leaves',
  label: 'copper fallen leaves',
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

describe('REQUIRED OBJECTS leads with the element ONE authored label', () => {
  const p3Prose =
    'Lily, wearing her red chunky-knit woollen hat, springs forward across the stone-paved square. Copper-coloured fallen chestnut leaves scatter across the grey cobbles. Ultra-wide shot.';

  it('never emits the truncated HEAD label for ART001', () => {
    const block = requiredObjectsBlock(build(p3Prose, ['ART001', 'ART008']));
    expect(block).not.toContain('small hat knitted from chunky red');
  });

  it('emits the authored label as the bold lead', () => {
    const block = requiredObjectsBlock(build(p3Prose, ['ART001', 'ART008']));
    expect(block).toContain('* **red woollen hat** (object)');
    expect(block).toContain('* **copper fallen leaves** (object)');
    expect(block).not.toContain('Fallen horse chestnut and plane tree');
  });

  it('emits the authored labels for a NON-English story too — the label is English by construction', () => {
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
    expect(requiredObjectsBlock(prompt)).toContain('* **red woollen hat** (object)');
    expect(prompt).not.toContain('Wollmütze');
  });

  it('BACKFILL PARITY — a bible stored before labels emits exactly the pre-label string', () => {
    // No `label` authored: the lead is byte-for-byte what it was before labels
    // existed — an English story's own `name`. The bold lead is the
    // GroundingDINO grounding key and the entity-consistency key, so a stored
    // story must not be re-keyed by this change.
    const legacy = {
      ...visualBible,
      artifacts: [{ id: 'ART001', name: "Lily's red woollen hat", type: "children's knitted hat", description: ART001.description }],
    };
    const prompt = buildImagePrompt(
      scene('Lily springs forward across the square.', ['ART001']),
      { language: 'en-gb', artStyle: 'pixar', layout: { textInImage: true } },
      null, legacy, 3, null, {}
    ) as string;
    expect(requiredObjectsBlock(prompt)).toContain("* **Lily's red woollen hat** (object)");
    expect(prompt).not.toContain('small hat knitted from chunky red');
  });

  it('THE INCIDENT — two artifacts of the same `type` never share a lead (job_1789301291267_ueh8h145m)', () => {
    // Both declared type "tool", so the pre-label rules printed `**tool**
    // (object)` twice and the model could not tell the props apart.
    const twins = {
      ...visualBible,
      artifacts: [
        { id: 'ART001', name: 'Kelle', label: 'wooden trowel', type: 'tool', description: 'a short wooden trowel' },
        { id: 'ART002', name: 'Hammer', label: 'iron hammer', type: 'tool', description: 'a small iron hammer' },
      ],
    };
    const block = requiredObjectsBlock(buildImagePrompt(
      scene('Lily lifts both.', ['ART001', 'ART002']),
      { language: 'de', artStyle: 'pixar', layout: { textInImage: true } },
      null, twins, 3, null, {}
    ) as string);
    expect(block).toContain('* **wooden trowel** (object)');
    expect(block).toContain('* **iron hammer** (object)');
    expect(block).not.toContain('**tool**');
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
      // 2026-09-15: rekeyed onto the scaleClass band when the free-text
      // `size` field was retired. The obligation is unchanged — a creature
      // holds its stated scale on EVERY page — only the field moved.
      expect(t).toMatch(/A creature or a secondary character keeps the size its entry’s `scaleClass` band states on every page it appears on/);
    });

    it(`${f} tells the AD to write a stated height RELATION into the prose (D12)`, () => {
      // job_1789147573901_m3uam0nxi: the bible said one stone guard was "about
      // as tall as a door" and the other "about two thirds the height of"
      // the first. Secondary characters are never emitted into the page prompt
      // (promptBuilders: "the prose already carries them inline"), so the AD's
      // prose is the only route for that relation - and p12 drew both guards
      // the same size.
      const t = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
      expect(t).toMatch(/When an entry states its height against another named figure, write that relation into the prose on every page the two share/);
    });
  }
});

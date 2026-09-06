import { describe, it, expect } from 'vitest';

// Prod job_1788698812047_q5b1vuds7 p2. Two defects in one page prompt:
//
// (1) "Mama" is a Visual Bible SECONDARY — invented by the story, with a full
//     bible entry (age, hair, face, build, clothing, signature look) and no
//     uploaded photo. None of it reached the image prompt: her cast line read
//     "- Mama:, right, bending down toward Amian, …" and the AGE &
//     PROPORTIONS block named only the commissioned 1-year-old. The model
//     invented the adult from nothing on every page.
//
// (2) The two artifacts in REQUIRED OBJECTS were labelled by two different
//     rules — ART001 by its English `type`, ART002 (emitted state-aware,
//     because the scene places it off-body) by a description chop — because
//     the state-aware rebuild dropped `type` from the entry.
//
// Fixtures are the story's own bible entries, verbatim.

// @ts-expect-error - JS module without types
import { buildImagePrompt } from '../../server/lib/promptBuilders.js';

const MAMA = {
  id: 'CHR001',
  name: 'Mama',
  age: 'a woman in her early thirties',
  hair: 'dark brown, shoulder-length, loose',
  face: 'warm brown eyes, gentle smile, no facial hair',
  build: 'medium height, slender',
  clothing: 'soft sage-green linen blouse, cream trousers, white canvas shoes',
  signatureLook: 'a small gold stud earring',
  pages: [1, 2, 3, 4, 5, 6],
  appearsInPages: [1, 2, 3, 4, 5, 6],
  description:
    'a woman in her early thirties. medium height, slender. hair: dark brown, shoulder-length, loose. warm brown eyes, gentle smile, no facial hair. Signature: a small gold stud earring. Clothing: soft sage-green linen blouse, cream trousers, white canvas shoes',
};

const ART001 = {
  id: 'ART001',
  name: 'Strohhut',
  type: 'hat',
  pages: [2],
  description:
    'A small, round straw hat with a flat brim, natural golden-yellow colour, with a thin red ribbon band around the crown',
};

const ART002 = {
  id: 'ART002',
  name: 'Strohkostüm',
  type: 'costume',
  pages: [2],
  description:
    'A child-sized tunic made of woven straw strands in golden-yellow, slightly oversized and fluffy at the edges, tied at the waist with a simple cord',
};

const visualBible = {
  mainCharacters: [{ id: 'CHR000', name: 'Amian' }],
  secondaryCharacters: [MAMA],
  animals: [],
  vehicles: [],
  clothing: [],
  locations: [],
  artifacts: [ART001, ART002],
};

const AMIAN = { id: 1, name: 'Amian', age: '1', gender: 'male' };

const scene = (extra: Record<string, unknown> = {}) =>
  `{"scene":${JSON.stringify({
    imageSummary:
      'Amian stands just inside the straw arch of the museum. He looks up at Mama with a delighted expression.',
    setting: { location: 'Schweizer Strohmuseum', description: 'the entrance hall', camera: 'medium' },
    characters: [
      { id: null, name: 'Amian', position: 'center', action: 'pressing one palm against a straw bundle', depth: 'foreground' },
      { id: 'CHR001', name: 'Mama', position: 'right', action: 'bending down toward Amian', depth: 'midground' },
    ],
    objects: [
      { id: 'ART001', name: 'Strohhut', position: "on Amian's head" },
      { id: 'ART002', name: 'Strohkostüm', position: 'worn by Amian' },
    ],
    ...extra,
  })}}`;

const build = (sceneJson: string, vb: any = visualBible, chars: any = [AMIAN]) =>
  buildImagePrompt(
    sceneJson,
    { language: 'de-ch', artStyle: 'watercolor', layout: { textInImage: true }, characters: chars },
    chars,
    vb,
    2,
    null,
    { skipVisualBible: true, vbRefElementIds: ['ART001', 'ART002'] }
  ) as string;

describe('an invented cast member carries its appearance into the image prompt', () => {
  it("emits Mama's bible description", () => {
    const prompt = build(scene());
    expect(prompt).toContain('CAST WITHOUT A REFERENCE IMAGE');
    expect(prompt).toContain('- Mama: a woman in her early thirties');
    expect(prompt).toContain('dark brown, shoulder-length, loose');
    expect(prompt).toContain('soft sage-green linen blouse');
  });

  it('states her age, so the model cannot draw a peer of the 1-year-old', () => {
    expect(build(scene())).toMatch(/Mama:[^\n]*early thirties/);
  });

  it('never doubles a commissioned character who already has a reference card', () => {
    const vb = { ...visualBible, secondaryCharacters: [MAMA, { id: 'CHR009', name: 'Amian', description: 'a small boy' }] };
    const prompt = build(scene(), vb);
    const rest = prompt.slice(prompt.indexOf('CAST WITHOUT A REFERENCE IMAGE'));
    const block = rest.slice(0, rest.indexOf('\n\n'));
    expect(block).toContain('- Mama:');
    expect(block).not.toContain('- Amian:');
  });

  it('emits nothing for a page the invented cast is not on', () => {
    const offPage = `{"scene":${JSON.stringify({
      imageSummary: 'Amian alone in the hall.',
      characters: [{ name: 'Amian', position: 'center' }],
      objects: [],
    })}}`;
    expect(build(offPage)).not.toContain('CAST WITHOUT A REFERENCE IMAGE');
  });

  it('never leaks the bible id into the prompt', () => {
    expect(build(scene())).not.toMatch(/CHR001/);
  });

  it('gives an invented CHILD a head-count proportion cue in AGE & PROPORTIONS', () => {
    const boy = {
      id: 'CHR002',
      name: 'Nachbarsjunge',
      age: 'a boy of about ten',
      description: 'a boy of about ten. slight build. hair: sandy, short.',
      pages: [2],
      appearsInPages: [2],
    };
    const vb = { ...visualBible, secondaryCharacters: [boy] };
    const withBoy = `{"scene":${JSON.stringify({
      imageSummary: 'Amian and the neighbour boy in the hall.',
      characters: [
        { name: 'Amian', position: 'center' },
        { id: 'CHR002', name: 'Nachbarsjunge', position: 'left' },
      ],
      objects: [],
    })}}`;
    const prompt = build(withBoy, vb);
    const ageBlock = prompt.slice(prompt.indexOf('AGE & PROPORTIONS'));
    expect(ageBlock.split('\n\n')[0]).toMatch(/Nachbarsjunge/);
  });
});

describe('REQUIRED OBJECTS labels the whole list by one rule', () => {
  it('labels both artifacts from their English type for a German story', () => {
    const prompt = build(scene());
    const block = prompt.slice(prompt.indexOf('**REQUIRED OBJECTS'));
    expect(block).toContain('**hat** (object)');
    expect(block).toContain('**costume** (object)');
  });

  it('never labels an object with a leading fragment of its description', () => {
    const prompt = build(scene());
    expect(prompt).not.toContain('**small**');
    expect(prompt).not.toContain('child-sized tunic made of woven straw** (object)');
  });

  it('never paints a story-language prop name as the checklist label', () => {
    const block = build(scene()).slice(0);
    expect(block).not.toContain('**Strohhut**');
  });
});

/**
 * WHAT THE SHRINK SPENDS, AND WHAT IS NEVER EMITTED TO BE SPENT (2026-09-23).
 *
 * Staging job_1790100385959_1nitlympp: p12 and all three covers ran 9.8-10.6k
 * against Grok's 7,900 cap. The cut removed COUNTS, DEPTH AND SIZE, HANDS,
 * NO MARKS, REQUIRED CAST and the whole Composition block, while text that did
 * not apply to the render survived: a close-up SHOT rule on every cover (read
 * from the word "portrait"), a split-state markings rule on a page where
 * nothing divides, and a second copy of the ground bullet in each cover's own
 * composition (docs/audits/prompt-audit-2026-09-23 08 S3, 09 C3).
 *
 * These tests pin the behaviour: units go in rank order, one Composition bullet
 * at a time; nothing a render cannot use is built into it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PB = require('../../server/lib/promptBuilders.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts.js');
// @ts-expect-error - JS module without types
import { shrinkPromptForModel } from '../../server/lib/images.js';

const inputData: any = {
  title: 'The Lamp on the Pier',
  characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl', hairColor: 'brown' }],
  mainCharacters: ['c1'],
  language: 'en',
  pages: 4,
  storyCategory: 'adventure',
  storyDetails: 'A night at the harbour.',
  artStyle: 'watercolor',
};

const brief = (objects: string[] = ['ART001'], prose = 'The main character kneels beside the lantern.') =>
  `${prose}\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'the lamp is lit',
    characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
    shot: 'wide',
    objects,
    textPosition: 'bottom-left',
  })}`;

const bible = (states: any[] | undefined): any => ({
  artifacts: [{ id: 'ART001', name: 'brass lantern', description: 'a dented brass lantern', pages: [1], ...(states ? { states } : {}) }],
  locations: [], vehicles: [], characters: [],
});

let composition: string[] = [];
beforeAll(async () => {
  await loadPromptTemplates();
  // Code-built since 2026-09-24 (promptBuilders.buildCompositionBlock).
  composition = PB.buildCompositionBlock().split('\n');
});

describe('the split-state markings rule is emitted only where a listed element has states', () => {
  it('absent when no listed element declares a state', () => {
    const p = String(PB.buildImagePrompt(brief(), inputData, null, bible(undefined), 1, null, {}));
    expect(p).toContain('**REQUIRED OBJECTS');
    expect(p).not.toContain(PB.SPLIT_STATE_MARKINGS_RULE);
  });

  it('present when a listed element declares states', () => {
    const states = [
      { id: 'ART001.1', name: 'whole', delta: 'whole and unlit', pages: [1] },
      { id: 'ART001.2', name: 'broken', delta: 'split in two halves', pages: [2] },
    ];
    const p = String(PB.buildImagePrompt(brief(), inputData, null, bible(states), 1, null, {}));
    expect(p).toContain(PB.SPLIT_STATE_MARKINGS_RULE);
  });
});

describe('a cover carries no SHOT block', () => {
  it('the "portrait" in a cover prose is not read as a close-up', () => {
    const cover = String(PB.buildCoverPrompt('back', {
      sceneDescription: 'Crisp afternoon. A wide group portrait set before the pier. Mira stands in the center, eyes on the viewer.',
      inputData, visualBible: bible(undefined), referencePhotos: [],
    }));
    expect(cover).not.toContain('**SHOT:**');
    expect(cover).not.toMatch(/close-up ends at the waist/);
  });

  it('a page still gets its declared shot', () => {
    const p = String(PB.buildImagePrompt(brief(), inputData, null, bible(undefined), 1, null, {}));
    expect(p).toContain('**SHOT:**');
  });
});

describe('the cut spends Composition one bullet at a time, in rank order', () => {
  let header = '', facing = '', ground = '', size = '';
  beforeAll(() => { [header, facing, ground, size] = composition; });
  const tail = () => `**ART STYLE:** painterly.\n\n${PB.NO_CHARACTER_MARKING_RULE}\n\n${PB.HANDS_HOLD_ONLY_NAMED_RULE}`;
  const head = (n: number) => 'The main character stands on the pier. '.repeat(n);
  const prompt = (n: number) => `${head(n)}\n\n${composition.join('\n')}\n\n${tail()}`;

  it('the fixture has the three bullets the rank names', () => {
    expect(header).toBe('**Composition:**');
    expect(facing).toMatch(/^- Each character does a specific action/);
    expect(ground).toMatch(/^- A standing character stands/);
    expect(size).toMatch(/^- A vessel, building or vehicle/);
  });

  it('a small overshoot costs the size bullet only, and the header stays', async () => {
    const p = prompt(40);
    const out = String(await shrinkPromptForModel(p, p.length - 50, 'TEST rank', null));
    expect(out).not.toContain(size);
    expect(out).toContain(facing);
    expect(out).toContain(ground);
    expect(out).toContain(header);
  });

  it('the ground bullet outlives the facing bullet', async () => {
    const p = prompt(40);
    const out = String(await shrinkPromptForModel(p, p.length - size.length - 60, 'TEST rank', null));
    expect(out).not.toContain(facing);
    expect(out).toContain(ground);
  });

  it('the header goes with the last bullet — no empty heading is sent', async () => {
    const p = prompt(40);
    const out = String(await shrinkPromptForModel(p, p.length - (facing.length + ground.length + size.length) + 5, 'TEST rank', null));
    for (const b of [facing, ground, size]) expect(out).not.toContain(b);
    expect(out).not.toContain(header);
    expect(out).toContain(PB.NO_CHARACTER_MARKING_RULE);
    expect(out).toContain(PB.HANDS_HOLD_ONLY_NAMED_RULE);
  });
});

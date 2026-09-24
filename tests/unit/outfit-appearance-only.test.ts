/**
 * An outfit description is appearance only, and a repair instruction never
 * carries it verbatim (staging job_1790277448294_5herh01j7, pages 2 and 13).
 *
 * The bible wrote plot notes into the wardrobe ("… hands it to <creature> on
 * page 16"), and describeFigureForRepair wrapped the whole sentence — the
 * character's own name first — into "the 3-year-old boy in <Name> wears …",
 * which the name strip never rescans. On one page it also named a jacket the
 * page takes off.
 *
 * Pins behaviour, never wording: the one shared rule reaches both built
 * prompts, and the descriptor names no cast member, no creature, no page and
 * no garment the page takes off. Offline, no paid call.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');
const { describeFigureForRepair, buildRepairNameMap, nameRepairText } = require('../../server/lib/repairLogic');

const CAST = [
  { name: 'Pim', age: 3, gender: 'male' },
  { name: 'Ottilie', age: 5, gender: 'female' },
];
const CREATURE = 'Grumble';
const REQS: any = {
  Pim: { standard: { used: true, description: `Pim wears a white long-sleeve top under a red hooded sweatshirt, grey wool dungaree trousers, and blue ankle boots; over the sweatshirt he wears a blue padded hooded anorak with a front zip and kangaroo pocket. The pocket holds the warm paper bag from page 2 until he hands it to ${CREATURE} on page 16.` } },
  Ottilie: { standard: { used: true, description: 'Ottilie wears a green crew-neck wool jumper, blue corduroy trousers and brown ankle boots; over these she wears an orange quilted zip-up jacket with a stand collar — the jacket she removes on page 7 and wears again from page 14.' } },
};
const VB: any = {
  clothing: [{ id: 'CLO001', name: 'orange quilted jacket', label: 'orange jacket', wornBy: 'Ottilie' }],
  animals: [{ id: 'ANI001', name: CREATURE, species: 'young dragon', coloring: 'green scales' }],
  secondaryCharacters: [], artifacts: [], vehicles: [], locations: [],
};
const CLOTHING = { Pim: 'standard', Ottilie: 'standard' };
const OFF_PAGE = { wornItems: [{ id: 'CLO001', owner: 'Ottilie', state: 'off', location: 'on the ground' }] };
const NAMES = /Pim|Ottilie|Grumble/;

describe('the appearance-only rule reaches the writer and the reviewer', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const inputData: any = { characters: CAST, language: 'en', pages: 2, storyCategory: 'adventure', artStyle: 'watercolor' };
  const beats = [{ pageNumber: 1, planLine: 'wide — the main character — she walks — home' }];

  it('the built bible-writer prompt carries it', () => {
    const p = PB.buildStoryBibleFromBeatsPrompt(inputData, beats);
    expect(p).toContain(PB.OUTFIT_APPEARANCE_RULE);
    expect(p).not.toContain('{OUTFIT_APPEARANCE_RULE}');
  });

  it('the built wardrobe-review prompt carries it', () => {
    const p = PB.buildClothingReviewPrompt(inputData, REQS, beats);
    expect(p).toContain(PB.OUTFIT_APPEARANCE_RULE);
    expect(p).not.toContain('{OUTFIT_APPEARANCE_RULE}');
  });
});

describe('describeFigureForRepair never embeds the outfit sentence', () => {
  const describe_ = (name: string, sceneMetadata: any = null) => describeFigureForRepair({
    name, characters: CAST, characterClothing: CLOTHING, clothingRequirements: REQS,
    visualBible: VB, sceneMetadata, pageNumber: 13,
  });

  it('a description carrying plot notes yields no name and no page', () => {
    const out = describe_('Pim');
    expect(out).not.toMatch(NAMES);
    expect(out).not.toMatch(/page/i);
    expect(out).toMatch(/anorak/);
  });

  it('a garment the page takes off is not named', () => {
    const out = describe_('Ottilie', OFF_PAGE);
    expect(out).not.toMatch(/jacket/);
    expect(out).not.toMatch(NAMES);
    expect(out).toMatch(/jumper/);
  });

  it('the same garment is named on a page that keeps it on', () => {
    expect(describe_('Ottilie')).toMatch(/jacket/);
  });

  it('repair text leaves the name strip with no name and no page', () => {
    const map = buildRepairNameMap({
      characters: CAST, characterClothing: CLOTHING, clothingRequirements: REQS,
      visualBible: VB, sceneMetadata: OFF_PAGE, pageNumber: 13,
    });
    const out = nameRepairText(`Move Pim closer to Ottilie and turn ${CREATURE} toward them.`, map);
    expect(out).not.toMatch(NAMES);
    expect(out).not.toMatch(/page/i);
  });
});

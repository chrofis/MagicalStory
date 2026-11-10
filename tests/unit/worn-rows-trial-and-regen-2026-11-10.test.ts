import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Two registered bugs, one class: a page's typed `wornItems[]` row lost on the way to the image prompt.
 *
 * 1. worn-item-lost-in-story-still-worn-in-prompt: the TRIAL writer had no wornItems row, so every
 *    trial page resolved a `wornAs` item to WORN by silence ("IS wearing") while the text said it
 *    was lost (measured 2026-11-10: 5 of 9 prod trials, ~15 of 54 pages). The writer now gets the
 *    same WORN_ITEMS_ROW_RULE constant the Art Director gets.
 * 2. regeneration-drops-worn-item-rows: the regenerate route built the prompt from the stored brief
 *    TEXT (`wornItems: []`) while the page's own sceneMetadata held the off row (prod
 *    job_1794060455874_w2sbl0o0s p10). carryWornRowsIntoBrief puts the stored rows into the text.
 */
const PB = require('../../server/lib/promptBuilders');
const { carryWornRowsIntoBrief, resolveWornItemsForPage, buildWornStateLines } = require('../../server/lib/wornItems');
const { extractSceneMetadata } = require('../../server/lib/sceneMetadata');
const { loadPromptTemplates } = require('../../server/services/prompts');

beforeAll(async () => { await loadPromptTemplates(); });

const input = {
  language: 'de-ch', languageLevel: 'standard', storyCategory: 'adventure', storyTheme: 'pirate',
  storyDetails: 'Kinder suchen einen Schatz.', pages: 6,
  characters: [{ id: 'a', name: 'Anna', age: 6, gender: 'female' }], mainCharacters: ['a'],
};

const VB = { artifacts: [{ id: 'ART001', name: 'red cape', wornAs: 'Anna.outer layer' }] };
const OFF_ROW = {
  id: 'ART001', owner: 'Anna', state: 'off', location: 'on the floor',
  redressNote: 'dress stays; cape off', keptGarments: [{ type: 'dress', colour: 'white', details: 'plain' }],
};
const brief = (rows: unknown[]) => `Anna stands in the room.\n\n---METADATA---\n${JSON.stringify({
  characters: [{ name: 'Anna', position: 'center', clothing: 'standard' }], objects: ['ART001'], wornItems: rows,
})}`;
const wornBlock = (text: string) => {
  const m = extractSceneMetadata(text);
  return buildWornStateLines(resolveWornItemsForPage(VB, m.characters, m, { pageNumber: 3 })).join('\n');
};

describe('trial writer carries the typed worn row', () => {
  it('the trial pages prompt contains the one WORN_ITEMS_ROW_RULE constant and no unfilled placeholder', () => {
    const prompt: string = PB.buildTrialPagesPrompt(input, 6, 'PAGE 1: x');
    expect(prompt).toContain(PB.WORN_ITEMS_ROW_RULE);
    expect(prompt).not.toContain('{WORN_ITEMS_ROW}');
    expect(prompt).not.toContain('{GARMENT_REMOVED}');
  });

  it('a trial-shaped scene hint with an off row resolves to NOT wearing; without the row it is WORN', () => {
    const hint = (rows: unknown[]) => JSON.stringify({ scene: {
      imageSummary: 'x', characters: [{ id: null, name: 'Anna', position: 'center', action: 'a' }],
      objects: [{ id: 'ART001', name: 'cape', position: 'p' }], wornItems: rows,
    } });
    expect(wornBlock(hint([OFF_ROW]))).toMatch(/NOT wearing/);
    expect(wornBlock(hint([]))).toMatch(/IS wearing/);
  });
});

describe('regeneration keeps the page’s stored worn rows in the brief text', () => {
  const storedMeta = { wornItems: [OFF_ROW] };

  it('before: the stored text with an empty row prompts IS wearing', () => {
    expect(wornBlock(brief([]))).toMatch(/IS wearing/);
  });

  it('carryWornRowsIntoBrief restores the off row from the stored metadata', () => {
    const carry = carryWornRowsIntoBrief(brief([]), storedMeta);
    expect(carry.carried).toEqual(['ART001']);
    expect(wornBlock(carry.brief)).toMatch(/NOT wearing/);
  });

  it('a row the brief states itself wins and nothing is carried', () => {
    const own = { ...OFF_ROW, location: 'on the chair' };
    expect(carryWornRowsIntoBrief(brief([own]), storedMeta)).toBeNull();
  });

  it('a page with no stored rows is left untouched', () => {
    expect(carryWornRowsIntoBrief(brief([]), { wornItems: [] })).toBeNull();
  });

  it('the stored rows may live under fullData', () => {
    expect(carryWornRowsIntoBrief(brief([]), { fullData: { wornItems: [OFF_ROW] } }).carried).toEqual(['ART001']);
  });
});

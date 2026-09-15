import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { resolveOutfitForPage, resolveGeneratedOutfit, resolveWornItemsForPage } = require_('../../server/lib/wornItems.js');
const { buildImagePrompt } = require_('../../server/lib/promptBuilders.js');
const { buildEvalClothingContract } = require_('../../server/lib/evalPipeline.js');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');

/**
 * ONE RESOLVED OUTFIT PER PAGE — the real p13 disagreement of staging
 * job_1789420511893_zly5rcdej.
 *
 * Stored facts, verbatim: Emma's contract opens with the tricorn; the page's
 * only worn row declares ART002, the navy captain's cap, WORN on Emma, with no
 * `off` row for the tricorn. The worn-state block told the generator and the
 * semantic judge "cap" while the clothing contract told the compliance judge
 * "tricorn" — two answers about one head.
 */
const EMMA = 'A black felt tricorn hat with a red cockade; a red long-sleeved cotton pirate shirt with a gathered neckline and full sleeves; black cotton breeches ending just below the knee and gathered at the hem; a white linen sash tied at the waist; white knee-length cotton stockings; black leather buckle shoes.';

const TRICORN = {
  id: 'ART001', name: 'black tricorn hat', type: 'headwear',
  description: 'a black felt tricorn hat with three turned-up brim edges, featuring a bright red circular ribbon cockade pinned to the left side.',
};
const CAP = {
  id: 'ART002', name: "navy-blue captain's cap", type: 'headwear',
  description: "a navy-blue wool captain's cap with a stiff black visor, a flat crown, and a bright gold metal anchor emblem pinned securely to the front centre.",
  appearsInPages: [13, 14],
};
const visualBible = { artifacts: [TRICORN, CAP], clothing: [], locations: [], vehicles: [], animals: [], secondaryCharacters: [] };

const metadata = {
  characters: [{ name: 'Emma', position: 'right', clothing: 'costumed', depth: 'foreground', expression: 'determined' }],
  objects: ['ART002'],
  wornItems: [{ id: 'ART002', owner: 'Emma', state: 'worn', location: null }],
  emptyScenePrompt: 'A stone quay at dusk.',
};
const sceneDescription = 'Emma stands at the quay rail.\n---METADATA---\n' + JSON.stringify(metadata);
const ctx = { visualBible, sceneMetadata: metadata, pageNumber: 13 };

describe('the page has ONE resolved outfit', () => {
  it('the declared worn cap replaces the contract tricorn', () => {
    const resolved = resolveWornItemsForPage(visualBible, ['Emma'], metadata, { pageNumber: 13 });
    const { text, swaps } = resolveOutfitForPage(EMMA, resolved, 'Emma');
    expect(swaps).toEqual([{ id: 'ART002', slot: 'headwear', applied: true, reason: 'slot-conflict-resolved' }]);
    expect(text).not.toMatch(/tricorn|cockade/i);
    expect(text).toMatch(/captain's cap/);
    expect(text).toMatch(/gold metal anchor emblem/); // the bible's shape words ride along
    // Nothing else is touched.
    for (const keep of ['pirate shirt', 'breeches', 'sash', 'stockings', 'buckle shoes']) expect(text).toContain(keep);
  });

  it('nothing happens when the contract already names the worn item', () => {
    const already = "A navy-blue captain's cap; a red pirate shirt; black breeches";
    const resolved = resolveWornItemsForPage(visualBible, ['Emma'], metadata, { pageNumber: 13 });
    expect(resolveOutfitForPage(already, resolved, 'Emma').text).toBe(already);
  });

  it('an ambiguous or unmappable slot leaves the contract alone', () => {
    // Two headwear clauses: no single clause owns the slot, so nothing is swapped.
    const two = 'A black tricorn hat; a woollen hood; a red pirate shirt';
    const resolved = resolveWornItemsForPage(visualBible, ['Emma'], metadata, { pageNumber: 13 });
    expect(resolveOutfitForPage(two, resolved, 'Emma').text).toBe(two);
  });

  it('the generator and BOTH judges are handed the same string', async () => {
    await loadPromptTemplates();
    const expected = resolveGeneratedOutfit(EMMA, 'Emma', ctx);
    expect(expected).toMatch(/captain's cap/);
    expect(expected).not.toMatch(/tricorn/i);

    // Judge side: one block, read by quality, semantic AND compliance.
    const referenceImages = [{ name: 'Emma', clothingDescription: EMMA, photoUrl: 'data:image/jpeg;base64,AAAA', clothingCategory: 'costumed' }];
    const contract = buildEvalClothingContract({
      sceneCharacters: metadata.characters, referenceImages, artStyle: 'watercolor',
      visualBible, sceneMetadata: metadata,
    });
    expect(contract.error).toBe(null);
    expect(contract.block).toBe(`- Emma: ${expected}`);

    // Generator side: the built prompt names the cap on Emma and demands no tricorn.
    const prompt = buildImagePrompt(
      sceneDescription,
      { language: 'en', artStyle: 'watercolor', characters: [{ id: 1, name: 'Emma', age: 7 }] },
      metadata.characters, visualBible, 13, referenceImages, {}
    );
    expect(prompt).toMatch(/Emma IS wearing this on this page: navy-blue captain's cap/);
    expect(prompt).not.toMatch(/tricorn/i);
  });

  it('a multi-page group takes the OFF union only — no worn swap across pages', () => {
    const other = { ...metadata, wornItems: [] };
    const union = resolveGeneratedOutfit(EMMA, 'Emma', { visualBible, sceneMetadatas: [metadata, other] });
    expect(union).toBe(EMMA);
  });
});

describe('every page-path consumer routes through the one resolver', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '../../', f), 'utf8');

  it('the image prompt builder', () => {
    expect(src('server/lib/promptBuilders.js')).toMatch(/resolveOutfitForPage\(photo\.clothingDescription, wornResolved, photo\.name\)/);
    // The old strip-only call is gone — one entry point, not two.
    expect(src('server/lib/promptBuilders.js')).not.toMatch(/stripOffItemsFromOutfit\(photo\.clothingDescription/);
  });

  it('the compliance + semantic + quality clothing contract', () => {
    expect(src('server/lib/evalPipeline.js')).toMatch(/resolveGeneratedOutfit\(outfit, name, wornCtx\)/);
  });

  it('all three character-repair entry points', () => {
    expect(src('server/lib/repairPipeline.js')).toMatch(/resolveOutfitForStoryPage\(clothingDesc, charName, storyData, pageNumber, sceneDesc\)/);
    expect(src('server/lib/repairPipeline.js')).toMatch(/clothingDescription: pageClothingDesc/);
    expect(src('server/routes/regeneration.js')).toMatch(/resolveOutfitForStoryPage\(storyClothingDesc, characterName, storyData, pageNumber, sceneDesc\)/);
    expect(src('server/lib/entityConsistency.js')).toMatch(/resolveGeneratedOutfit\(\s*\n\s*buildClothingDescription\(character, clothingCategory, artStyle, storyData\.clothingRequirements\)/);
  });

  it('the entity-consistency grid (multi-page union)', () => {
    expect(src('server/lib/entityConsistency.js')).toMatch(/sceneMetadatas: groupWornMetas/);
  });
});

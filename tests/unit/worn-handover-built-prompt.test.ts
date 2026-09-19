import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const { buildImagePrompt } = require_('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');

const ROOT = path.resolve(__dirname, '../..');
const PB = require_('../../server/lib/promptBuilders.js');

/**
 * A template AS THE AUTHOR RECEIVES IT — with every `{TOKEN}` that names an
 * exported `TOKEN_RULE` constant substituted. A shared rule lives in
 * promptBuilders (one constant, four templates), so grepping the raw file for
 * its words finds nothing while the built prompt carries every word of it. That
 * substitution is exactly what these checks are about, so they read the
 * resolved text. (`ad-iterate-parity` pins that the constants do reach all four
 * BUILT prompts.)
 */
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\{([A-Z][A-Z0-9_]*)\}/g, (m, token) => (typeof PB[`${token}_RULE`] === 'string' ? PB[`${token}_RULE`] : m));

/**
 * A worn plot object that changed hands must reach the IMAGE PROMPT on the
 * character who actually wears the page, and must have left the owner's outfit
 * text. Pinned on the built prompt through the real builder — the resolver
 * passing in isolation proved nothing on the path that renders.
 */
const OWNER_OUTFIT = "A long navy-blue captain's coat, black trousers, black leather boots, a navy-blue captain's cap with a gold anchor";

const sceneDescription =
  'Two figures stand on a stone quay beside a moored ship.\n'
  + '---METADATA---\n'
  + JSON.stringify({
    characters: [
      { name: 'Owner', position: 'left', clothing: 'costumed', depth: 'midground', expression: 'warm smile' },
      { name: 'Finder', position: 'right foreground', clothing: 'costumed', depth: 'foreground', expression: 'proud' },
    ],
    objects: ['ART002'],
    wornItems: [{ id: 'ART002', owner: 'Owner', state: 'worn', wearer: 'Finder' }],
    emptyScenePrompt: 'A stone quay beside a moored ship.',
  });

const visualBible = {
  artifacts: [{
    id: 'ART002', name: "navy-blue captain's cap", type: 'headwear', wornAs: 'Owner.headwear',
    description: "A navy-blue captain's cap with a stiff black visor and a gold anchor emblem",
  }],
  clothing: [], locations: [],
};
const inputData = { language: 'en', artStyle: 'watercolor', characters: [{ id: 1, name: 'Owner', age: 34 }, { id: 2, name: 'Finder', age: 7 }] };
const sceneCharacters = [
  { name: 'Owner', position: 'left', clothing: 'costumed', depth: 'midground' },
  { name: 'Finder', position: 'right foreground', clothing: 'costumed', depth: 'foreground' },
];
const referencePhotos = [
  { name: 'Owner', photoUrl: 'data:image/jpeg;base64,AAAA', clothingCategory: 'costumed', clothingDescription: OWNER_OUTFIT },
  { name: 'Finder', photoUrl: 'data:image/jpeg;base64,AAAA', clothingCategory: 'costumed', clothingDescription: 'A red pirate shirt, black breeches, black buckle shoes' },
];

describe('a handed-over worn item in the BUILT image prompt', () => {
  it('names the item on the wearer, not on the owner, and drops it from the owner outfit', async () => {
    await loadPromptTemplates();
    const prompt = buildImagePrompt(sceneDescription, inputData, sceneCharacters, visualBible, 14, referencePhotos, {});
    // The two-direction instruction, on the character who wears it this page.
    expect(prompt).toMatch(/Finder IS wearing this on this page, and Owner is NOT/);
    expect(prompt).toMatch(/Draw it on Finder only/);
    // The owner's outfit text is stripped of the cap before it is rendered
    // (the strip itself is pinned in worn-item-handover.test.ts); what must
    // hold HERE is that no built line puts the cap back on the owner.
    expect(prompt).not.toMatch(/Owner IS wearing this on this page/);
    // The item stays a listed object: no reference in the call shows it worn.
    expect(prompt).toMatch(/ART002|captain's cap/);
  });

  it('with no wearer the owner keeps it — the shipped shape is unchanged', async () => {
    await loadPromptTemplates();
    const plain = sceneDescription.replace('"wearer":"Finder"', '"wearer":""');
    const prompt = buildImagePrompt(plain, inputData, sceneCharacters, visualBible, 14, referencePhotos, {});
    expect(prompt).toMatch(/Owner IS wearing this on this page/);
    expect(prompt).not.toMatch(/Draw it on Finder only/);
  });
});

/**
 * GAP 1 rule parity: `wornAs` is required wherever the Visual Bible is
 * authored. Four sites write one, and a rule on three of them reads as absent
 * on the fourth.
 */
describe('the wornAs-is-required rule reaches every VB authoring site', () => {
  // Every template that still exists and authors a Visual Bible. The registry
  // is the source of the set; a template deleted by a pipeline change drops out
  // of it here rather than failing as a missing file.
  const SITES = [
    'prompts/scene-expansion-all.txt',
    'prompts/scene-expansion.txt',
    'prompts/story-unified.txt',
    'prompts/story-unified-imagefirst.txt',
    'prompts/story-trial.txt',
  ].filter(rel => fs.existsSync(path.join(ROOT, rel)));

  it('at least the two Art Director templates and one writer are covered', () => {
    expect(SITES.length).toBeGreaterThanOrEqual(3);
  });

  for (const rel of SITES) {
    it(path.basename(rel), () => {
      const text = read(rel);
      expect(/wornAs/.test(text), 'names the field').toBe(true);
      expect(/REQUIRED|required|always|carries `wornAs`/.test(text), 'states that it is not optional').toBe(true);
    });
  }

  it('the per-page wearer field is documented on both Art Director templates', () => {
    for (const rel of ['prompts/scene-expansion-all.txt', 'prompts/scene-expansion.txt']) {
      expect(/`wearer`/.test(read(rel)), path.basename(rel)).toBe(true);
    }
  });
});

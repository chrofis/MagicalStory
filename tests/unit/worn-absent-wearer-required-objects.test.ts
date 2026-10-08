import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { buildImagePrompt } = require_('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');

/**
 * job_1791489793707_2ir6nl5kw p14 (staging 2026-10-08): the brief cited Julian's
 * scarf (CLO001) in `objects` and declared it off "out of sight" on a page
 * Julian is not on. The worn-row resolver drops a row whose owner is off-page,
 * so REQUIRED OBJECTS saw no state and wrote "red scarf (worn by Julian)" --
 * and the image put the scarf on Kiaan. A garment whose wearer is not on the
 * page must not be required or attributed.
 */
const scene = (withJulian: boolean) =>
  'Two boys by a linden tree.\n---METADATA---\n' + JSON.stringify({
    characters: [
      { name: 'Kiaan', position: 'left', clothing: 'standard', depth: 'foreground' },
      { name: 'Levin', position: 'right', clothing: 'standard', depth: 'foreground' },
      ...(withJulian ? [{ name: 'Julian', position: 'middle', clothing: 'standard', depth: 'midground' }] : []),
    ],
    objects: ['CLO001'],
    wornItems: [{ id: 'CLO001', owner: 'Julian', state: 'off', location: 'out of sight' }],
    emptyScenePrompt: 'A linden tree at dusk.',
  });
const vb = {
  clothing: [{ id: 'CLO001', name: 'red wool scarf', label: 'red scarf', wornBy: 'Julian',
    description: 'Red chunky hand-knitted wool scarf with a short fringe.' }],
  artifacts: [], locations: [],
};
const input = { language: 'en', artStyle: 'watercolor', characters: [
  { id: 1, name: 'Kiaan', age: 3 }, { id: 2, name: 'Levin', age: 5 }, { id: 3, name: 'Julian', age: 3 }] };
const cast = (withJulian: boolean) => [
  { name: 'Kiaan', position: 'left', clothing: 'standard', depth: 'foreground' },
  { name: 'Levin', position: 'right', clothing: 'standard', depth: 'foreground' },
  ...(withJulian ? [{ name: 'Julian', position: 'middle', clothing: 'standard', depth: 'midground' }] : []),
];
const photos = (withJulian: boolean) => cast(withJulian).map(c => ({ name: c.name, photoUrl: 'data:image/jpeg;base64,AAAA', clothingCategory: 'standard', clothingDescription: 'a coat' }));

describe('a garment whose wearer is not on the page', () => {
  it('is neither required nor attributed (wearer absent)', async () => {
    await loadPromptTemplates();
    const prompt = buildImagePrompt(scene(false), input, cast(false), vb, 14, photos(false), {});
    expect(prompt).not.toMatch(/scarf/i);
    expect(prompt).not.toMatch(/worn by Julian/);
  });

  it('is still listed when its wearer IS on the page', async () => {
    await loadPromptTemplates();
    const prompt = buildImagePrompt(scene(true).replace('"state":"off","location":"out of sight"', '"state":"worn"'), input, cast(true), vb, 14, photos(true), {});
    expect(prompt).toMatch(/scarf/i);
  });
});

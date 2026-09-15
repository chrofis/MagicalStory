import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const worn = require_('../../server/lib/wornItems.js');
const { buildImagePrompt } = require_('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');

/**
 * The WORN ITEMS clause must carry the bible's construction detail, not only
 * the item's name. Real shape from staging job_1789420511893_zly5rcdej: the
 * clause said "navy-blue captain's cap" while the bible held the visor, the
 * flat crown and the gold anchor — and the attached cell showed the child's own
 * tricorn. The render took the colour from the words and the SHAPE from the
 * picture.
 */
const CAP = {
  id: 'ART002',
  name: "navy-blue captain's cap",
  type: 'headwear',
  description: "a navy-blue wool captain's cap with a stiff black visor, a flat crown, and a bright gold metal anchor emblem pinned securely to the front centre. It is worn low.",
  appearsInPages: [13],
};

describe('the worn clause carries the bible description', () => {
  it('appends the first descriptive sentence after the name', () => {
    const [line] = worn.buildWornStateLines([
      { id: 'ART002', name: CAP.name, owner: 'Emma', wearer: 'Emma', handedOver: false, state: 'worn', entry: CAP, slot: 'headwear' },
    ]);
    expect(line).toContain("navy-blue captain's cap — a navy-blue wool captain's cap with a stiff black visor, a flat crown, and a bright gold metal anchor emblem pinned securely to the front centre");
    // First sentence only — the rider is not a second description block.
    expect(line).not.toContain('It is worn low');
  });

  it('an off item and a handover carry it too', () => {
    const base = { id: 'ART002', name: CAP.name, entry: CAP, slot: 'headwear' };
    const [off] = worn.buildWornStateLines([{ ...base, owner: 'Emma', wearer: 'Emma', handedOver: false, state: 'off', location: 'on the quay' }]);
    expect(off).toContain('stiff black visor');
    const [over] = worn.buildWornStateLines([{ ...base, owner: 'Sarah', wearer: 'Emma', handedOver: true, state: 'worn' }]);
    expect(over).toContain('stiff black visor');
    expect(over).toContain('Draw it on Emma only');
  });

  it('an entry with no description still produces the bare clause', () => {
    const [line] = worn.buildWornStateLines([
      { id: 'ART009', name: 'red sash', owner: 'Emma', wearer: 'Emma', handedOver: false, state: 'worn', entry: { id: 'ART009', name: 'red sash' }, slot: 'belt/waist' },
    ]);
    expect(line).toContain('Emma IS wearing this on this page: red sash.');
  });

  it('reaches the BUILT image prompt', async () => {
    await loadPromptTemplates();
    const metadata = {
      characters: [{ name: 'Emma', position: 'right', clothing: 'costumed', depth: 'foreground', expression: 'determined' }],
      objects: ['ART002'],
      wornItems: [{ id: 'ART002', owner: 'Emma', state: 'worn' }],
      emptyScenePrompt: 'A stone quay at dusk.',
    };
    const scene = 'A child hauls on a mooring rope at the quay.\n---METADATA---\n' + JSON.stringify(metadata);
    const vb = { artifacts: [CAP], clothing: [], locations: [], vehicles: [], animals: [], secondaryCharacters: [] };
    const prompt = buildImagePrompt(
      scene,
      { language: 'en', artStyle: 'watercolor', characters: [{ id: 1, name: 'Emma', age: 7 }] },
      metadata.characters,
      vb,
      13,
      [{ name: 'Emma', photoUrl: 'data:image/jpeg;base64,AAAA', clothingCategory: 'costumed', clothingDescription: 'A black felt tricorn hat with a red cockade, a white linen shirt' }],
      {}
    );
    expect(prompt).toContain('stiff black visor');
  });
});

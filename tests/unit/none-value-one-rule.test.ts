import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// bugs.json none-value-rules-disagree: four readers of a stored glasses/other/facialHair value
// each had their own "is it none?" rule, so a stored glasses "nein" printed "Glasses: nein" on
// the avatar sheet and styled-avatar prompt while the story prompts hid it. ONE rule now
// (server/lib/traitNone.js); every consumer must agree on every value.
const req = createRequire(import.meta.url);
const { isNone } = req('../../server/lib/traitNone');
const { declaredGlasses, resolveDeclaredAvatarOverrides } = req('../../server/lib/avatarOverrides');
const { buildOneCallSheetPrompt } = req('../../server/lib/character2x4Sheet');
const { buildLabeledPhysicalParts } = req('../../server/lib/promptBuilders');
const { buildPhysicalTraitsString } = req('../../server/lib/styledAvatars');
const { buildPhysicalTraitsDescription } = req('../../server/lib/entityConsistency');

const NONE_VALUES = ['none', 'None', ' NONE ', 'nein', 'Nein', 'keine', 'no', 'aucun', 'niente', '-', '', null, undefined];

describe('one none-rule', () => {
  it('every sentinel is none, descriptions are not', () => {
    for (const v of NONE_VALUES) expect(isNone(v)).toBe(true);
    for (const v of ['round glasses', 'clean-shaven', 'a scar over the left eye']) expect(isNone(v)).toBe(false);
  });

  it('a stored glasses "nein" is absent in every sheet / avatar reader', () => {
    const c = { name: 'Amalia', age: 8, physical: { glasses: 'nein', other: 'nein' } };
    expect(declaredGlasses(c)).toBeNull();
    const sheet = buildOneCallSheetPrompt(c, { costumeDescription: 'a coat', styleLine: 'watercolour', kind: 'costume' });
    expect(sheet).not.toMatch(/Glasses:/);
    expect(sheet).not.toMatch(/nein/);
  });

  it('avatar overrides drop none-words for glasses, facial hair and other; keep real values', () => {
    const run = (physical: any) => resolveDeclaredAvatarOverrides({ age: 40, gender: 'male', physicalTraits: physical });
    const none = JSON.stringify(run({ glasses: 'nein', facialHair: 'keine', other: 'nein' }));
    expect(none).not.toMatch(/Glasses|Facial hair: keine|Other: nein|nein/);
    const yes = JSON.stringify(run({ glasses: 'round glasses', other: 'a freckled nose' }));
    expect(yes).toMatch(/round glasses/);
    expect(yes).toMatch(/a freckled nose/);
  });

  it('the story-prompt reader agrees on the same values', () => {
    const p = (physical: any) => JSON.stringify(buildLabeledPhysicalParts({ physical, name: 'X', age: 8 }) ?? '');
    expect(p({ glasses: 'nein' })).not.toMatch(/nein/);
  });

  it('styled-avatar and repair trait text never carry a none-word', () => {
    const c = { name: 'X', age: 40, gender: 'male', physical: { glasses: 'nein', other: 'nein', facialHair: 'keine' } };
    expect(buildPhysicalTraitsString(c)).not.toMatch(/nein|keine|Glasses|Other features/);
    expect(buildPhysicalTraitsDescription(c)).not.toMatch(/nein|keine/);
    const real = { ...c, physical: { glasses: 'round glasses', other: 'a freckled nose' } };
    expect(buildPhysicalTraitsString(real)).toMatch(/Glasses: round glasses/);
  });
});

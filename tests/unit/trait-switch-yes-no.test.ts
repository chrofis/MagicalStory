import { describe, it, expect } from 'vitest';
import { traitSwitchIsYes, traitSwitchText, traitSwitchValue, GLASSES_YES_DEFAULT } from '../../client/src/utils/traitSwitch';
// @ts-ignore — CommonJS lib
const { declaredGlasses } = require('../../server/lib/avatarOverrides.js');
// @ts-ignore
const { buildOneCallSheetPrompt } = require('../../server/lib/character2x4Sheet.js');

// Production job_1794479943880_pvykbjtwx: a German customer typed "nein" in the free-text
// glasses field and the sheet prompt said "Glasses: nein - worn on the face in EVERY cell".
// The form now stores a yes/no switch: no -> 'none', yes -> the description.
describe('character form yes/no switch (glasses, other)', () => {
  it('switch "nein" stores the canonical sentinel regardless of typed text', () => {
    expect(traitSwitchValue(false, '')).toBe('none');
    expect(traitSwitchValue(false, 'round glasses')).toBe('none');
  });
  it('switch "ja" with text stores the text', () => {
    expect(traitSwitchValue(true, 'round black-framed')).toBe('round black-framed');
  });
  it('switch "ja" with empty text still states glasses; other stays absent', () => {
    expect(traitSwitchValue(true, '  ', GLASSES_YES_DEFAULT)).toBe('glasses');
    expect(traitSwitchValue(true, '')).toBe('');
  });
  it('existing values show the right switch state', () => {
    for (const v of ['none', 'None', '', '  ', undefined, null]) expect(traitSwitchIsYes(v as any)).toBe(false);
    expect(traitSwitchIsYes('round black-framed')).toBe(true);
    expect(traitSwitchText('none')).toBe('');
    expect(traitSwitchText('round black-framed')).toBe('round black-framed');
  });
});

describe('server never states glasses for the sentinel', () => {
  it('sheet prompt has no Glasses line for none; one for a description', () => {
    const P = (c: any) => buildOneCallSheetPrompt(c, { costumeDescription: 'a coat', styleLine: 'watercolour', kind: 'costume' });
    const none = { name: 'Amalia', age: 8, physical: { glasses: traitSwitchValue(false, '') } };
    expect(declaredGlasses(none)).toBeNull();
    expect(P(none)).not.toMatch(/Glasses:/);
    const yes = { name: 'Amalia', age: 8, physical: { glasses: traitSwitchValue(true, 'round glasses') } };
    expect(P(yes)).toMatch(/Glasses: round glasses/);
  });
});

import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
const { buildOneCallSheetPrompt, buildSkinToneBlock } = require('../../server/lib/character2x4Sheet.js');

const P = (c: any, kind: string, hasReference = false) =>
  buildOneCallSheetPrompt(c, { costumeDescription: 'a coat', styleLine: 'watercolour', kind, hasReference });
const light = { name: 'A', age: 6, physical: { skinTone: 'light' } };
const none = { name: 'B', age: 6, physical: {} };

// Prod trial job_1792584180547_gr4cnr0u8: a light-skinned child's costume sheet came out brown. The sheet prompt stated
// hair colour but never the stored skin tone, and the costume sheet's body reference was told "build only".
describe('the stored skin tone is stated to the sheet generator', () => {
  for (const kind of ['standard', 'costume']) {
    it(`${kind} sheet carries the skin tone`, () => {
      expect(P(light, kind)).toMatch(/Skin tone: light\./);
    });
    it(`${kind} sheet without a stored skin tone says nothing about a skin value`, () => {
      expect(P(none, kind)).not.toMatch(/Skin tone:/);
    });
  }
  it('costume Image 3 takes build AND skin tone, still ignoring clothing', () => {
    const p = P(light, 'costume', true);
    expect(p).toMatch(/take its build and its skin tone only\. IGNORE its clothing/);
  });
  it('blank or missing values give no block', () => {
    expect(buildSkinToneBlock({ physical: { skinTone: '  ' } })).toBe('');
    expect(buildSkinToneBlock({})).toBe('');
  });
});

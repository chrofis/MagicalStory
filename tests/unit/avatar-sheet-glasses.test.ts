import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
const sheet = require('../../server/lib/character2x4Sheet.js');
// @ts-ignore
const { declaredGlasses } = require('../../server/lib/avatarOverrides.js');

const { buildOneCallSheetPrompt, buildGlassesBlock } = sheet;
const P = (c: any) => buildOneCallSheetPrompt(c, { costumeDescription: 'a coat', styleLine: 'watercolour', kind: 'costume' });
const sarah = { name: 'Sarah', age: 36, physical: { glasses: 'rectangular black-framed glasses' } };
const noGlasses = { name: 'Max', age: 36, physical: { glasses: 'none' } };

// Staging job_1791267520938_essbvehs8: Sarah's pass-1 head row drew the front and three-quarter
// cells WITHOUT her glasses (profile and body cells had them). No prompt or judge stated glasses,
// so every page's face repair, the dedication page and the back cover copied a glassless face.
describe('a declared pair of glasses is stated to the sheet generator', () => {
  it('declaredGlasses reads physical.glasses and ignores none / empty', () => {
    expect(declaredGlasses(sarah)).toBe('rectangular black-framed glasses');
    expect(declaredGlasses(noGlasses)).toBeNull();
    expect(declaredGlasses({ physical: { glasses: '  ' } })).toBeNull();
    expect(declaredGlasses({})).toBeNull();
  });
  it('the sheet prompt carries them in every cell; a character without glasses gets no line', () => {
    expect(P(sarah)).toContain('rectangular black-framed glasses');
    expect(P(sarah)).toMatch(/front and three-quarter included/);
    expect(P(noGlasses)).not.toMatch(/glasses/i);
    expect(buildGlassesBlock({})).toBe('');
  });
});

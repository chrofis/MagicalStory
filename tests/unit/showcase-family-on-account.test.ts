/**
 * The showcase reuses a persistent family account only when the WHOLE family is
 * there once each; a partial or duplicated family stops the run instead of
 * creating everyone again (how staging's Dubois account got two Léas, 2026-10-31).
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { familyOnAccount } = require('../../scripts/admin/showcase.js');

const family = { characters: [{ name: 'Léa' }, { name: 'Jules' }, { name: 'Marc' }] };

describe('showcase familyOnAccount', () => {
  it('whole family once each: reuse', () => {
    expect(familyOnAccount(['Léa', ' jules ', 'MARC'], family)).toBe(true);
  });
  it('no family member: create', () => {
    expect(familyOnAccount([], family)).toBe(false);
    expect(familyOnAccount(['Someone'], family)).toBe(false);
  });
  it('part of the family: stop, naming what is there and what is missing', () => {
    expect(() => familyOnAccount(['Léa'], family)).toThrow(/part of the family \(léa; missing jules, marc\)/);
  });
  it('a duplicated member: stop', () => {
    expect(() => familyOnAccount(['Léa', 'Léa', 'Jules', 'Marc'], family)).toThrow(/duplicate family characters \(léa\)/);
  });
});

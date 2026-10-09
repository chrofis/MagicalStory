import { describe, it, expect } from 'vitest';
const { keepsDrawnBody, usablePreparedAvatars } = require('../../server/lib/trialSheets.js');

/** Owner 2026-10-09: "Gender redraws if age is more than 2." */
describe('keepsDrawnBody', () => {
  it('age 2 with a gender change keeps the drawn row', () => {
    expect(keepsDrawnBody('gender:female', { age: 2, gender: 'male' })).toBe(true);
  });
  it('age 3 with a gender change redraws', () => {
    expect(keepsDrawnBody('gender:female', { age: 3, gender: 'male' })).toBe(false);
  });
  it('age 8, same gender, any band keeps', () => {
    expect(keepsDrawnBody('gender:female', { age: 8, gender: 'female' })).toBe(true);
  });
  it('an unreadable age is not a licence to keep', () => {
    expect(keepsDrawnBody('gender:female', { age: '', gender: 'male' })).toBe(false);
  });
  it('the prepared standard sheet follows the same rule', () => {
    const row = (age: number) => ({ age, gender: 'male', preGeneratedStandardFor: 'gender:female', preGeneratedStyledAvatars: { A: { standard: 'S' } } });
    expect(usablePreparedAvatars(row(2)).A.standard).toBe('S');
    expect(usablePreparedAvatars(row(3), { error() {} }).A.standard).toBeUndefined();
  });
});

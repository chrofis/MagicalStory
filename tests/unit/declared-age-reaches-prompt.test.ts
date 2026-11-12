/**
 * An unclamped stored photo age cannot reach a prompt (bug back-cover-maker-wrong-age-and-object-label).
 * Characters made before the write-time clamp (routes/avatars.js, trialAge.js) keep the raw photo read; a declared 4 with
 * apparentAge "middle-aged" was briefed as "a middle-aged man". extractCharacterVisualProfile is the one reader.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const { extractCharacterVisualProfile, getAgeCategory, clampApparentAge } = cjs('../../server/lib/promptBuilders.js');

const mk = (age: string, apparentAge: string, gender = 'male') => ({ name: 'Tom', age, gender, physical: { apparentAge } });

describe('extractCharacterVisualProfile bounds the stored photo age by the declared age', () => {
  it('declared 4 + "middle-aged" is a child, not a man', () => {
    const p = extractCharacterVisualProfile(mk('4', 'middle-aged'));
    expect(p.ageCategory).toBe(clampApparentAge('middle-aged', '4').category);
    expect(['toddler', 'preschooler', 'kindergartner']).toContain(p.ageCategory);
    expect(p.genderTerm).not.toMatch(/man\b|adult/i);
    expect(p.ageMarkers).not.toMatch(/adult/i);
  });
  it('declared 5 + "young-adult" (female) is a girl, not a young woman', () => {
    const p = extractCharacterVisualProfile(mk('5', 'young-adult', 'female'));
    expect(p.ageCategory).not.toBe('young-adult');
    expect(p.genderTerm).not.toMatch(/woman|adult/i);
  });
  it('a read within one band of the declared age is kept (the photo is the better guide, settled 2026-08-05)', () => {
    const declared = getAgeCategory(8);
    expect(declared).toBe('young-school-age');
    expect(extractCharacterVisualProfile(mk('8', 'kindergartner')).ageCategory).toBe('kindergartner');
  });
  it('an adult with a matching read is unchanged, and no declared age leaves the read alone', () => {
    expect(extractCharacterVisualProfile(mk('45', 'middle-aged')).ageCategory).toBe('middle-aged');
    expect(extractCharacterVisualProfile({ name: 'X', physical: { apparentAge: 'senior' } }).ageCategory).toBe('senior');
  });
});

/**
 * The trial's photo apparentAge is clamped to the declared age.
 *
 * Bug (tasks/bugs.json: trial-apparent-age-unclamped): prod trial
 * job_1790282439176_ppgelxibt — declared age 5, an adult's photo, stored
 * physical.apparentAge "middle-aged". extractCharacterVisualProfile trusts
 * apparentAge over the declared age because clampApparentAge() bounds it on the
 * regular avatar paths (routes/avatars.js); the trial copied it unclamped, and
 * the page prompts described the 5-year-old with adult proportions.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { applyTrialPhotoTraits, reclampTrialApparentAge } = require('../../server/lib/trialAge.js');
const { extractCharacterVisualProfile, getAgeCategory } = require('../../server/lib/promptBuilders.js');

const TRIAL_ROUTE = fs.readFileSync(path.join(__dirname, '../..', 'server/routes/trial.js'), 'utf8');
const CHILD_BANDS = ['preschooler', 'kindergartner', 'young-school-age'];

describe('applyTrialPhotoTraits', () => {
  it('an age-5 trial character with a middle-aged photo read ends up in a child band', () => {
    const physical: Record<string, unknown> = {};
    const { clamp } = applyTrialPhotoTraits(physical, { apparentAge: 'middle-aged', hairColor: 'dark brown' }, '5');
    expect(getAgeCategory(5)).toBe('kindergartner');
    expect(physical.apparentAge).toBe('young-school-age');
    expect(CHILD_BANDS).toContain(physical.apparentAge);
    expect(clamp.clamped).toBe(true);
    expect(physical.hairColor).toBe('dark brown');

    const profile = extractCharacterVisualProfile({ name: 'Hero', age: '5', gender: 'male', physical });
    expect(profile.ageMarkers).not.toMatch(/adult/i);
    expect(profile.genderTerm).not.toMatch(/man\b/i);
  });

  it('a low-confidence read snaps to the declared band, as on the regular avatar path', () => {
    const physical: Record<string, unknown> = {};
    applyTrialPhotoTraits(physical, { apparentAge: 'middle-aged', confidence: { overallConfidence: 'low' } }, 5);
    expect(physical.apparentAge).toBe('kindergartner');
  });

  it('a read within one group of the declared age is kept', () => {
    const physical: Record<string, unknown> = {};
    applyTrialPhotoTraits(physical, { apparentAge: 'preschooler' }, 5);
    expect(physical.apparentAge).toBe('preschooler');
  });
});

/**
 * The photo's glasses and recorded features reach the trial character
 * (2026-10-07). prompts/character-analysis.txt returns `glasses` and
 * `distinctive markings` in the same response the trial already pays for; the
 * regular avatar path stores them as physical.glasses / physical.other
 * (routes/avatars.js), and the sheet generator (avatarOverrides.declaredGlasses),
 * both row judges and the page prompt's DISTINCTIVE FEATURES block
 * (promptBuilders.recordedFeatures) read those two fields. The trial never
 * stamped them, so all of that was dead on every trial.
 */
describe('applyTrialPhotoTraits stamps the photo\'s glasses and recorded features', () => {
  const { recordedFeatures } = require('../../server/lib/promptBuilders.js');
  const { declaredGlasses } = require('../../server/lib/avatarOverrides.js');

  it('glasses and "distinctive markings" (as other) reach the readers that were dead for trials', () => {
    const physical: Record<string, unknown> = {};
    applyTrialPhotoTraits(physical, {
      hairColor: 'blonde', apparentAge: 'kindergartner',
      glasses: 'round red-framed glasses', 'distinctive markings': 'light freckles across the nose',
    }, 6);
    expect(physical.glasses).toBe('round red-framed glasses');
    expect(physical.other).toBe('light freckles across the nose');
    const char = { name: 'Hero', age: '6', gender: 'female', physical };
    expect(declaredGlasses(char)).toBe('round red-framed glasses');
    expect(recordedFeatures(char)).toBe('light freckles across the nose');
  });

  it('a regular-path `other` wins over the raw key; "none" is stored raw and read as nothing, as on the regular path', () => {
    const physical: Record<string, unknown> = {};
    applyTrialPhotoTraits(physical, { other: 'a small mole on the left cheek', 'distinctive markings': 'none', glasses: 'none' }, 6);
    expect(physical.other).toBe('a small mole on the left cheek');
    expect(physical.glasses).toBe('none');
    const char = { name: 'Hero', age: '6', gender: 'male', physical: { glasses: 'none', other: 'none' } };
    expect(declaredGlasses(char)).toBeNull();
    expect(recordedFeatures(char)).toBe('');
  });

  it('a response without them leaves the fields untouched', () => {
    const physical: Record<string, unknown> = { glasses: 'kept' };
    applyTrialPhotoTraits(physical, { hairColor: 'black' }, 6);
    expect(physical.glasses).toBe('kept');
    expect('other' in physical).toBe(false);
  });
});

/**
 * extractTraitsShared hands applyTrialPhotoTraits the analysis result's
 * `detailedHairAnalysis`, which character-analysis.txt returns BESIDE `traits`
 * (the regular path reads it from the result, routes/avatars.js). Returning
 * `result.traits` alone dropped it on every trial.
 */
describe('extractTraitsShared carries detailedHairAnalysis and confidence with the traits', () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-trial-traits';
  const { extractTraitsShared } = require('../../server/routes/trial.js');

  it('a result-level detailedHairAnalysis rides on the traits the trial stamps', async () => {
    const hair = { lengthTop: 'chin-length', styling: 'ponytail', density: 'full' };
    const traits = await extractTraitsShared('photo-A-' + Date.now(), 'data:image/jpeg;base64,AAA', async () => ({
      traits: { hairColor: 'brown', glasses: 'none' },
      detailedHairAnalysis: hair,
      confidence: { overallConfidence: 'high' },
    }));
    expect(traits.detailedHairAnalysis).toEqual(hair);
    expect(traits.confidence).toEqual({ overallConfidence: 'high' });
    expect(traits.hairColor).toBe('brown');
    const physical: Record<string, unknown> = {};
    applyTrialPhotoTraits(physical, traits, 7);
    expect(physical.detailedHairAnalysis).toEqual(hair);
  });

  it('a nested detailedHairAnalysis is kept as returned; no traits yields null', async () => {
    const traits = await extractTraitsShared('photo-B-' + Date.now(), 'data:image/jpeg;base64,AAA', async () => ({
      traits: { detailedHairAnalysis: { styling: 'bun' } }, detailedHairAnalysis: { styling: 'ignored' },
    }));
    expect(traits.detailedHairAnalysis).toEqual({ styling: 'bun' });
    expect(await extractTraitsShared('photo-C-' + Date.now(), 'x', async () => ({ _error: 'no json' }))).toBeNull();
  });
});

describe('reclampTrialApparentAge (age changed after the prewarm)', () => {
  it('re-bounds the stored read to the new age and is idempotent for an unchanged one', () => {
    const physical = { apparentAge: 'young-school-age' };
    expect(reclampTrialApparentAge(physical, 15)?.clamped).toBe(true);
    expect(physical.apparentAge).toBe('young-teen');
    expect(reclampTrialApparentAge(physical, 15)?.clamped).toBe(false);
    expect(physical.apparentAge).toBe('young-teen');
    expect(reclampTrialApparentAge({}, 15)).toBeNull();
  });
});

describe('trial.js writes apparentAge only through the clamp', () => {
  it('has no direct physical.apparentAge assignment', () => {
    expect(TRIAL_ROUTE).not.toMatch(/physical\.apparentAge\s*=/);
    // one writer left: create-anonymous-account's background save (generate-preview-avatar was the other, 2026-10-09)
    expect((TRIAL_ROUTE.match(/applyTrialPhotoTraits\(physical,/g) || []).length).toBe(1);
    expect(TRIAL_ROUTE).toMatch(/reclampTrialApparentAge\(c\.physical, patchedAge\)/);
  });
});

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
    expect((TRIAL_ROUTE.match(/applyTrialPhotoTraits\(physical,/g) || []).length).toBe(2);
    expect(TRIAL_ROUTE).toMatch(/reclampTrialApparentAge\(c\.physical, patchedAge\)/);
  });
});

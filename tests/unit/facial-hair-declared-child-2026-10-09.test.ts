/**
 * Staging trial job_1791497394846_v01s6ndpn (2026-10-08): Mia, declared age 6, uploaded her father's photo.
 * The analyzer put "short gray beard and mustache" into the free-text `other`; the page prompt's
 * DISTINCTIVE FEATURES line carried it and Grok drew a bearded six-year-old on 4 pages. Facial hair now has
 * its own analyzer field (character-analysis.txt `facialHair`) and every reader drops it for a declared child
 * (characterPhysical.plausiblePhysical). docs/decisions.md 2026-10-09 "Facial hair is not stated for a declared child".
 */
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const pb = require('../../server/lib/promptBuilders');
const { applyTrialPhotoTraits } = require('../../server/lib/trialAge');
const { buildPhysicalTraitsString } = require('../../server/lib/styledAvatars');
const { buildPhysicalTraitsDescription } = require('../../server/lib/entityConsistency');
const { resolveDeclaredAvatarOverrides } = require('../../server/lib/avatarOverrides');

const man = (age: string) => ({ name: 'Mia', age, gender: 'male', physical: { facialHair: 'short beard', other: 'a mole on the left cheek', glasses: 'none' } });

const woman = (age: string) => ({ ...man(age), name: 'Anna', gender: 'female' });

const { plausiblePhysical } = require('../../server/lib/characterPhysical');
const fh = (v: string, who: any) => plausiblePhysical({ facialHair: v }, who).facialHair;

describe('plausiblePhysical: facial hair', () => {
  it('drops the value for a declared child, keeps it from the minimum age and for an unknown age (male)', () => {
    const m = (age: any) => ({ age, gender: 'male' });
    expect(fh('short beard', m('6'))).toBeUndefined();
    expect(fh('short beard', m(12))).toBeUndefined();
    expect(fh('stubble', m(pb.FACIAL_HAIR_MIN_AGE))).toBe('stubble');
    expect(fh('full beard', m('40'))).toBe('full beard');
    expect(fh('full beard', m(''))).toBe('full beard');
  });
  it('is never stated for a female or an unknown gender, at any age', () => {
    for (const gender of ['female', undefined, null, '']) {
      for (const age of ['40', '', '6']) expect(fh('short beard', { age, gender })).toBeUndefined();
    }
    expect(fh('short beard', undefined)).toBeUndefined();
  });
});

describe('every appearance line drops a child\'s facial hair', () => {
  it('extractCharacterVisualProfile, labeled parts and the prose description', () => {
    expect(pb.extractCharacterVisualProfile(man('6')).facialHair).toBeNull();
    expect(pb.buildLabeledPhysicalParts(pb.extractCharacterVisualProfile(man('6'))).join(' ')).not.toMatch(/beard|Facial hair/i);
    expect(pb.buildCharacterPhysicalDescription(man('6'))).not.toMatch(/beard|Facial hair/i);
    expect(pb.buildGroundingPrompt(man('6'))).not.toMatch(/beard/i);
  });
  it('keeps it for an adult', () => {
    expect(pb.buildCharacterPhysicalDescription(man('40'))).toMatch(/Facial hair: short beard/);
    expect(pb.buildGroundingPrompt(man('40'))).toMatch(/beard/);
  });
  it('avatar prompt traits, styled avatar traits and the entity-judge description', () => {
    expect(buildPhysicalTraitsString(man('6'))).not.toMatch(/beard/i);
    expect(buildPhysicalTraitsString(man('40'))).toMatch(/Facial hair: short beard/);
    expect(buildPhysicalTraitsDescription(man('6'))).not.toMatch(/beard/i);
    expect(buildPhysicalTraitsDescription(man('40'))).toMatch(/short beard/);
  });
  it('declared avatar overrides (generator and judge) drop a child\'s declared facial hair', () => {
    const child = resolveDeclaredAvatarOverrides({ physicalTraits: { facialHair: 'short beard' }, declaredAge: 6, gender: 'male' });
    expect(child.text || '').not.toMatch(/beard/i);
    expect(child.traitLines.join(' ')).not.toMatch(/beard/i);
    const adult = resolveDeclaredAvatarOverrides({ physicalTraits: { facialHair: 'short beard' }, declaredAge: 40, gender: 'male' });
    expect(adult.traitLines.join(' ')).toMatch(/Facial hair: short beard/);
  });
});

describe('a female character never has facial hair stated, on any reader', () => {
  it('profile, labeled parts, prose description and grounding prompt', () => {
    expect(pb.extractCharacterVisualProfile(woman('40')).facialHair).toBeNull();
    expect(pb.buildLabeledPhysicalParts(pb.extractCharacterVisualProfile(woman('40'))).join(' ')).not.toMatch(/beard|Facial hair/i);
    expect(pb.buildCharacterPhysicalDescription(woman('40'))).not.toMatch(/beard|Facial hair/i);
    expect(pb.buildGroundingPrompt(woman('40'))).not.toMatch(/beard/i);
  });
  it('styled-avatar string, avatar-route string, entity-judge description', () => {
    expect(buildPhysicalTraitsString(woman('40'))).not.toMatch(/beard/i);
    expect(buildPhysicalTraitsDescription(woman('40'))).not.toMatch(/beard/i);
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-facial-hair';
    const { buildPhysicalTraitsForAvatar: routeTraits } = require('../../server/routes/avatars');
    expect(routeTraits(woman('40'))).not.toMatch(/beard/i);
    expect(routeTraits(man('40'))).toMatch(/Facial hair: short beard/);
    expect(routeTraits(man('6'))).not.toMatch(/beard/i);
  });
  it('declared overrides (generator and judge) for a female', () => {
    const f = resolveDeclaredAvatarOverrides({ physicalTraits: { facialHair: 'short beard' }, declaredAge: 40, gender: 'female' });
    expect(f.text || '').not.toMatch(/beard/i);
    expect(f.traitLines.join(' ')).not.toMatch(/beard/i);
    const m = resolveDeclaredAvatarOverrides({ physicalTraits: { facialHair: 'short beard' }, declaredAge: 40, gender: 'male' });
    expect(m.traitLines.join(' ')).toMatch(/Facial hair: short beard/);
    expect(m.text).toMatch(/short beard/);
  });
});

describe('analyzer field', () => {
  it('character-analysis.txt reports facial hair in its own field, not in distinctive markings', () => {
    const t = fs.readFileSync(path.join(__dirname, '../../prompts/character-analysis.txt'), 'utf8');
    expect(t).toMatch(/"facialHair":/);
    const markings = t.split('\n').find((l: string) => l.trimStart().startsWith('"distinctive markings"')) || '';
    expect(markings).not.toMatch(/^[^:]*:\s*"<facial hair/);
    expect(markings).toMatch(/NOT listed here/);
  });
  it('the trial writer stamps facialHair beside glasses and other', () => {
    const physical: any = {};
    applyTrialPhotoTraits(physical, { facialHair: 'short beard', 'distinctive markings': 'none', glasses: 'round glasses' }, '6');
    expect(physical.facialHair).toBe('short beard');
    // the stored character now reads clean on the page prompt for a 6-year-old
    expect(pb.recordedFeatures({ name: 'Mia', age: '6', gender: 'male', physical })).toBe('');
    expect(pb.buildCharacterPhysicalDescription({ name: 'Mia', age: '6', gender: 'male', physical })).not.toMatch(/beard/i);
  });
});

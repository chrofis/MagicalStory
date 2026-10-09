/**
 * The trait-plausibility gate (characterPhysical.plausiblePhysical / getPlausiblePhysical), docs/decisions.md
 * 2026-10-09 "Photo traits are gated by the declared age and gender": no gray hair or baldness for a declared
 * child, no baldness for a female at any age, an adult man keeps all of it. Checked on every reader.
 */
import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-trait-plausibility';
const pb = require('../../server/lib/promptBuilders');
const { plausiblePhysical, getPlausiblePhysical } = require('../../server/lib/characterPhysical');
const { buildPhysicalTraitsString } = require('../../server/lib/styledAvatars');
const { buildPhysicalTraitsDescription } = require('../../server/lib/entityConsistency');
const { buildPhysicalTraitsForAvatar } = require('../../server/routes/avatars');
const { resolveDeclaredAvatarOverrides } = require('../../server/lib/avatarOverrides');

const hair = (density: string, lengthTop: string) => ({ detailedHairAnalysis: { type: 'straight', density, lengthTop, styling: 'natural' } });
const mk = (age: string, gender: string, physical: any) => ({ name: 'Pat', age, gender, physical: { hairColor: 'brown', ...physical } });
const readers = (c: any) => ({
  hair: pb.buildCharacterPhysicalDescription(c),
  parts: pb.buildLabeledPhysicalParts(pb.extractCharacterVisualProfile(c)).join(' '),
  styled: buildPhysicalTraitsString(c),
  route: buildPhysicalTraitsForAvatar(c),
  judge: buildPhysicalTraitsDescription(c),
  overrides: JSON.stringify(resolveDeclaredAvatarOverrides({
    physicalTraits: c.physical, hairDescription: pb.buildHairDescription(plausiblePhysical(c.physical, c)),
    declaredAge: c.age, gender: c.gender,
  })),
});
const all = (c: any) => Object.values(readers(c)).join('\n');

describe('plausiblePhysical rules', () => {
  it('does not mutate its input', () => {
    const p = { hairColor: 'gray', facialHair: 'beard', ...hair('bald', 'bald') };
    const copy = JSON.stringify(p);
    plausiblePhysical(p, { age: 6, gender: 'female' });
    expect(JSON.stringify(p)).toBe(copy);
  });
  it('gray / silver / white hair colour is dropped under 13 only', () => {
    for (const c of ['gray', 'silver', 'white', 'salt and pepper']) {
      expect(plausiblePhysical({ hairColor: c }, { age: 6, gender: 'male' }).hairColor).toBeUndefined();
      expect(plausiblePhysical({ hairColor: c }, { age: 40, gender: 'male' }).hairColor).toBe(c);
      expect(plausiblePhysical({ hairColor: c }, { age: '', gender: 'male' }).hairColor).toBe(c);
    }
    expect(plausiblePhysical({ hairColor: 'blonde' }, { age: 6 }).hairColor).toBe('blonde');
  });
  it('baldness is dropped for a child of 3 to 12, kept for a baby, kept for an adult man', () => {
    for (const age of [3, 6, 12]) {
      const h = plausiblePhysical(hair('bald', 'bald'), { age, gender: 'male' }).detailedHairAnalysis;
      expect(h.density).toBeUndefined(); expect(h.lengthTop).toBeUndefined();
    }
    expect(plausiblePhysical(hair('thinning', 'short'), { age: 6, gender: 'male' }).detailedHairAnalysis.density).toBeUndefined();
    expect(plausiblePhysical(hair('bald', 'bald'), { age: 1, gender: 'male' }).detailedHairAnalysis.density).toBe('bald');
    const man = plausiblePhysical(hair('balding', 'bald'), { age: 45, gender: 'male' }).detailedHairAnalysis;
    expect(man.density).toBe('balding'); expect(man.lengthTop).toBe('bald');
  });
  it('baldness is dropped for a female at any age, including a user override', () => {
    for (const age of [1, 6, 30, 70, '']) {
      const p = plausiblePhysical({ ...hair('balding', 'bald'), userHairOverride: { density: 'bald', lengthTop: 'bald', styling: 'combed' } }, { age, gender: 'female' });
      expect(p.detailedHairAnalysis.density).toBeUndefined();
      expect(p.detailedHairAnalysis.lengthTop).toBeUndefined();
      expect(p.userHairOverride.density).toBeUndefined();
      expect(p.userHairOverride.lengthTop).toBeUndefined();
      expect(p.userHairOverride.styling).toBe('combed');
    }
  });
});

describe('every reader: baldness', () => {
  it('an adult woman whose analysis says bald or receding gets no baldness anywhere', () => {
    for (const [d, l] of [['bald', 'bald'], ['balding', 'short'], ['thinning', 'short']]) {
      const out = all(mk('40', 'female', hair(d, l)));
      expect(out, `${d}/${l}`).not.toMatch(/bald|balding|thinning/i);
    }
  });
  it('a child gets no baldness anywhere', () => {
    expect(all(mk('6', 'male', hair('bald', 'bald')))).not.toMatch(/bald|balding|thinning/i);
  });
  it('an adult man keeps it', () => {
    const r = readers(mk('45', 'male', hair('balding', 'short')));
    expect(r.hair).toMatch(/balding/);
    expect(r.styled).toMatch(/balding/);
    expect(r.route).toMatch(/balding/);
    expect(r.judge).toMatch(/balding/);
    expect(readers(mk('45', 'male', hair('bald', 'bald'))).parts).toMatch(/bald/);
  });
});

describe('every reader: gray hair colour', () => {
  it('a child gets no gray hair anywhere, an adult keeps it', () => {
    expect(all(mk('6', 'female', { hairColor: 'gray' }))).not.toMatch(/gray/i);
    const r = readers({ ...mk('60', 'female', { hairColor: 'gray' }), physical: { hairColor: 'gray', ...hair('full', 'short') } });
    expect(r.hair).toMatch(/gray/);
    expect(r.styled).toMatch(/gray/);
    expect(r.route).toMatch(/gray/);
    expect(r.judge).toMatch(/gray/);
  });
  it('getPlausiblePhysical applies the character age and gender', () => {
    expect(getPlausiblePhysical(mk('6', 'male', { hairColor: 'gray' })).hairColor).toBeUndefined();
  });
});

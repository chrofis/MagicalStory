/**
 * The avatar is DRAWN and JUDGED against the age the user entered.
 *
 * Owner, 2026-09-15: "We should draw and evaluate against the age the user
 * enters."
 *
 * The measured contradiction: `prompts/avatar-main-prompt.txt` ordered the
 * generator to build the body from "the apparent age visible in the reference
 * photo" and then to make it "slim and athletic" regardless, while
 * `prompts/avatar-evaluation.txt` TASK 2 scored "apparent age AND body
 * proportions between IMAGE 1 and IMAGE 2" into one `ageMatch.score` that feeds
 * `finalScore` as lowest-of-three. A generator obeying its instruction was
 * guaranteed a deduction, and the retry regenerated the same body into the same
 * rejection.
 *
 * Pinned here: ONE resolver produces both wordings, both call-site families
 * pass the user's age into it, and the judge template no longer compares body
 * proportions against the photo. Face and identity checks are untouched.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveDeclaredAvatarOverrides, normalizeDeclaredAge } = require('../../server/lib/avatarOverrides.js');
const fs = require('fs');
const path = require('path');
const PROMPTS = path.join(__dirname, '../../prompts');
const AVATARS_SRC = fs.readFileSync(path.join(__dirname, '../../server/routes/avatars.js'), 'utf8');

const read = (f: string) => fs.readFileSync(path.join(PROMPTS, f), 'utf8');

describe('declared age is ONE source for the generator and the judge', () => {
  it('a declared age reaches the generator lines and the judge line from one call', () => {
    const r = resolveDeclaredAvatarOverrides({ declaredAge: 7 });
    expect(r.declaredAge).toBe(7);
    expect(r.ageLine).toMatch(/7 years old/);
    expect(r.traitLines.join('\n'), 'the generator never sees the declared age').toMatch(/7 years old/);
    expect(r.ageFact).toBe('7 years old');
  });

  it('the generator line tells the body to follow the declaration, not the photo', () => {
    const r = resolveDeclaredAvatarOverrides({ declaredAge: 4 });
    expect(r.ageLine).toMatch(/head-to-body ratio/i);
    expect(r.ageLine).toMatch(/reference photo suggests does not set the body/i);
  });

  it('no age declared yields nothing — the photo stays the fallback', () => {
    for (const bad of [null, undefined, '', 'unknown', 200, -1]) {
      const r = resolveDeclaredAvatarOverrides({ declaredAge: bad as any });
      expect(r.declaredAge, `${String(bad)} was accepted as an age`).toBeNull();
      expect(r.ageLine).toBeNull();
      expect(r.ageFact).toBeNull();
    }
  });

  it('a free-text age still yields its number', () => {
    expect(normalizeDeclaredAge('7 Jahre')).toBe(7);
    expect(normalizeDeclaredAge(7.4)).toBe(7);
  });

  it('the age is NOT duplicated into the DECLARED OVERRIDES block', () => {
    const r = resolveDeclaredAvatarOverrides({ declaredAge: 7, physicalTraits: { eyeColor: 'green' } });
    expect(r.text, 'the judge would read one fact in two places').not.toMatch(/years old/);
  });
});

describe('both avatar paths pass the user-entered age, and the judge is filled', () => {
  it('every resolver call in the avatar routes declares the age', () => {
    const calls = AVATARS_SRC.match(/resolveDeclaredAvatarOverrides\(\{[\s\S]{0,400}?\}\)/g) || [];
    expect(calls.length, 'the avatar routes stopped using the shared resolver').toBeGreaterThanOrEqual(4);
    for (const c of calls) {
      expect(c, `a resolver call withholds the declared age:\n${c}`).toMatch(/declaredAge:/);
    }
  });

  it('the judge call sites hand the age text over', () => {
    const judged = AVATARS_SRC.match(/evaluateAvatarFaceMatch\((?:[^()]|\([^()]*\))*\)/g) || [];
    // The definition line plus every call.
    expect(judged.length).toBeGreaterThanOrEqual(5);
    const calls = judged.filter((c) => !c.startsWith('evaluateAvatarFaceMatch(originalPhoto'));
    for (const c of calls) {
      expect(c, `a judge call withholds the declared age:\n${c}`).toMatch(/ageFact|declaredAgeText/);
    }
  });

  it('the judge template declares the placeholder the call site fills', () => {
    expect(read('avatar-evaluation.txt')).toMatch(/\{DECLARED_AGE\}/);
    expect(AVATARS_SRC).toMatch(/DECLARED_AGE:/);
  });
});

describe('the judge no longer scores body proportions against the photo', () => {
  const judge = () => read('avatar-evaluation.txt');

  it('TASK 2 judges age against the declaration', () => {
    const t = judge();
    expect(t).toMatch(/TASK 2: AGE MATCH/);
    expect(t).toMatch(/score it against DECLARED AGE/i);
  });

  it('the proportions term is gone from ageMatch', () => {
    const t = judge();
    expect(t, 'ageMatch still fuses age and body proportions')
      .not.toMatch(/combining age category \+ body proportions/i);
    expect(t).toMatch(/single 1-10 number for age alone/i);
    expect(t).toMatch(/Do NOT compare body proportions against IMAGE 1/);
  });

  it('face and identity stay judged against the photo', () => {
    const t = judge();
    expect(t).toMatch(/TASK 1: FACE MATCH/);
    expect(t).toMatch(/Compare facial features/);
  });

  it('the generator draws the body for the declared age', () => {
    const g = read('avatar-main-prompt.txt');
    expect(g).toMatch(/body proportions for the declared age/i);
    expect(g, 'the generator still takes the body from the photo unconditionally')
      .not.toMatch(/body proportions based on the apparent age visible in the reference photo/i);
    expect(g).toMatch(/skeletal proportions match the declared age/i);
  });
});

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { resolveDeclaredAvatarOverrides } = require('../../server/lib/avatarOverrides.js');

// BEHAVIOUR PINNED: the avatar judge grades the avatar against THE SAME SPEC THE
// GENERATOR RECEIVED. A user trait/clothing correction (glasses added where the
// photo has none, a beard removed, a declared outfit) is DELIBERATELY different
// from the reference photo; prompts/avatar-evaluation.txt caps the glasses axis
// at 3 for exactly that difference, faceMatch.score is the MIN of the feature
// scores and finalScore the MIN of the checks, so one capped axis sank the
// avatar below MIN_BASE_AVATAR_SCORE and the auto-retry regenerated the same
// correction into the same rejection — an infinite reject loop on any
// correction. Anything the user did NOT declare must still be judged against
// the photo.

const TEMPLATE = readFileSync(join(__dirname, '../../prompts/avatar-evaluation.txt'), 'utf8');

describe('declared avatar overrides reach the judge', () => {
  it('declares a user-added pair of glasses so the judge does not cap the axis', () => {
    const out = resolveDeclaredAvatarOverrides({
      physicalTraits: { glasses: 'round tortoiseshell frames' },
    });
    expect(out.text).toBeTruthy();
    expect(out.text).toContain('round tortoiseshell frames');
    // and the generator gets the same fact from the same resolver
    expect(out.traitLines.join('\n')).toContain('round tortoiseshell frames');
  });

  it('declares a removed beard (clean-shaven) on both sides', () => {
    const out = resolveDeclaredAvatarOverrides({ physicalTraits: { facialHair: 'clean-shaven' } });
    expect(out.traitLines.join('\n')).toMatch(/NO beard/);
    expect(out.text).toMatch(/clean-shaven/);
  });

  it('declares NOTHING when the user made no corrections, so every difference stays a defect', () => {
    expect(resolveDeclaredAvatarOverrides({}).text).toBeNull();
    expect(resolveDeclaredAvatarOverrides({ physicalTraits: {}, clothing: {} }).text).toBeNull();
    // "none"/empty are not corrections
    expect(resolveDeclaredAvatarOverrides({
      physicalTraits: { glasses: 'none', facialHair: 'none', hairColor: '' },
    }).text).toBeNull();
  });

  it('only declares traits the user actually set - an undeclared trait is absent from the block', () => {
    const out = resolveDeclaredAvatarOverrides({ physicalTraits: { glasses: 'thin gold frames' } });
    expect(out.text).not.toMatch(/Hair color/);
    expect(out.text).not.toMatch(/Facial hair/);
  });

  it('declares clothing only for the category the generator applied it to', () => {
    const args = { clothing: { upperBody: 'blue jumper', shoes: 'brown boots' } };
    expect(resolveDeclaredAvatarOverrides({ ...args, category: 'standard' }).text).toMatch(/blue jumper/);
    expect(resolveDeclaredAvatarOverrides({ ...args, category: 'winter' }).text).toBeNull();
    expect(resolveDeclaredAvatarOverrides({ ...args, category: 'summer' }).text).toBeNull();
    // clothingParts (the generator half) are produced regardless; the call site
    // appends them for 'standard' only.
    expect(resolveDeclaredAvatarOverrides({ ...args, category: 'winter' }).clothingParts).toHaveLength(2);
  });

  it('prefers a full outfit over the split top/bottom, like the generator does', () => {
    const out = resolveDeclaredAvatarOverrides({
      clothing: { fullBody: 'green raincoat', upperBody: 'red shirt' },
      category: 'standard',
    });
    expect(out.text).toMatch(/green raincoat/);
    expect(out.text).not.toMatch(/red shirt/);
  });
});

describe('the evaluation template can receive the declared overrides', () => {
  it('has a DECLARED_OVERRIDES slot that instructs the judge to grade against the declaration', () => {
    expect(TEMPLATE).toContain('{DECLARED_OVERRIDES}');
    // a declared item must not be scored against the photo...
    expect(TEMPLATE).toMatch(/DECLARED OVERRIDES/);
    // ...while an undeclared one still is
    expect(TEMPLATE).toMatch(/not listed[\s\S]{0,80}IMAGE 1/);
  });

  it('lifts the glasses cap only when glasses are declared', () => {
    const glassesRule = TEMPLATE.split('\n').find(l => l.trim().startsWith('- glasses:'));
    expect(glassesRule).toBeTruthy();
    expect(glassesRule).toMatch(/capped at 3/);
    expect(glassesRule).toMatch(/DECLARED OVERRIDES/);
  });

  it('keeps the template generic - no person- or story-specific examples in the block', () => {
    const block = TEMPLATE.slice(TEMPLATE.indexOf('DECLARED OVERRIDES'), TEMPLATE.indexOf('TASK 1'));
    expect(block).not.toMatch(/\b(Fiona|Sarah|Lukas|Manuel|Gessler|Altdorf|Facundo)\b/);
  });
});

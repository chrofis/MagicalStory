/**
 * The detector's identity line must carry HAIR (owner, 2026-09-18).
 *
 * buildCastIdentityDescription emitted hair from `char.physical.hair`. The
 * stored profile has no `hair` key — it holds `hairColor` plus a
 * `detailedHairAnalysis` object — so the branch never fired and every
 * production Set-of-Mark call named figures from age-band + build + face
 * geometry + wardrobe alone. Measured over 379 staging profiles across 45
 * days: 379 hairColor, 365 detailedHairAnalysis, 16 a legacy `hair` key (all
 * of them a bare colour, from stories dated 2026-08-09, none created since).
 *
 * The damage beyond the missing field: the Test Lab's builder routes through
 * buildCharacterPhysicalDescription, which DOES compose hair, so every Lab
 * identity measurement ran on richer input than production got and the two
 * were never comparable.
 *
 * The motivating page is staging job_1789681157795_wkt20ckod p12 — four
 * preschooler boys whose lines differed only in jawline and nose wording. The
 * detector swapped two of them and the page shipped at finalScore 0 on
 * findings attributed to the wrong child. MAX and KIAAN below are their real
 * stored profiles; before this fix their two lines were byte-identical apart
 * from clothing.
 *
 * These tests pin BEHAVIOUR — that hair reaches the line, that it comes from
 * the shared composer, that the legacy key still works, that an absent profile
 * degrades to nothing. They deliberately do not pin prose wording.
 */
import { describe, it, expect } from 'vitest';

const {
  buildCastIdentityDescription,
  buildIdentityLine,
  buildHairDescription,
} = require('../../server/lib/promptBuilders');

// Real stored profiles — job_1789681157795_wkt20ckod, page 12.
const MAX = {
  name: 'Max', age: '3', gender: 'male', ageCategory: 'preschooler',
  physical: {
    build: 'average',
    face: 'soft jawline, neutral chin, concave nose with rounded tip, medium cheekbones, medium lips',
    hairColor: 'light brown',
    apparentAge: 'preschooler',
    detailedHairAnalysis: {
      type: 'curly', density: 'full', parting: 'none', styling: 'natural',
      texture: 'medium', lengthTop: 'short', bangsEndAt: 'no bangs',
      salonLevel: 6, lengthSides: 'short', baseColorHex: '#A07E5B', highlightsHex: 'none',
    },
  },
};

const KIAAN = {
  name: 'Kiaan', age: '3', gender: 'male', ageCategory: 'preschooler',
  physical: {
    build: 'average',
    face: 'soft jawline, neutral chin, concave nose with rounded tip, medium cheekbones, medium lips',
    hairColor: 'dark brown',
    apparentAge: 'preschooler',
    detailedHairAnalysis: {
      type: 'straight', density: 'full', parting: 'none', styling: 'natural',
      texture: 'medium', lengthTop: 'short', bangsEndAt: 'at eyebrows',
      salonLevel: 4, lengthSides: 'short', baseColorHex: '#5C4131', highlightsHex: 'none',
    },
  },
};

// A profile in the legacy shape: a bare `hair` string, no detailed analysis.
// 16 of 379 stored profiles look like this; none has been created since
// 2026-08-09.
const LEGACY = {
  name: 'Emma', gender: 'female', ageCategory: 'preschooler',
  physical: { hair: 'dark brown', hairColor: 'dark brown', build: 'average' },
};

describe('identity line — hair', () => {
  it('emits hair composed from hairColor + detailedHairAnalysis', () => {
    const d = buildCastIdentityDescription(MAX, '').toLowerCase();
    expect(d).toContain('light brown');   // hairColor
    expect(d).toContain('curly');         // detailedHairAnalysis.type
    expect(d).toContain('short');         // detailedHairAnalysis.lengthTop
  });

  it('a profile with no `hair` key still yields hair — the branch that never fired', () => {
    expect(MAX.physical).not.toHaveProperty('hair');
    expect(buildCastIdentityDescription(MAX, '')).toMatch(/hair:/i);
  });

  it('reuses buildHairDescription rather than composing its own prose', () => {
    // One source of truth: whatever the shared composer returns is what the
    // identity line carries, verbatim. A second, divergent composition would
    // break this without touching buildHairDescription.
    for (const c of [MAX, KIAAN, LEGACY]) {
      const hair = buildHairDescription(c.physical, (c as any).physicalTraitsSource);
      expect(hair).toBeTruthy();
      expect(buildCastIdentityDescription(c, '')).toContain(`hair: ${hair}`);
    }
  });

  it('separates two children whose age, build and face prose are identical', () => {
    // The p12 swap in one assertion.
    expect(MAX.physical.build).toBe(KIAAN.physical.build);
    expect(MAX.physical.face).toBe(KIAAN.physical.face);
    const m = buildCastIdentityDescription(MAX, 'brown and white striped t-shirt').toLowerCase();
    const k = buildCastIdentityDescription(KIAAN, 'grey camouflage hoodie').toLowerCase();
    expect(m).not.toEqual(k);
    // Distinguishing on APPEARANCE, not just on the wardrobe tail — a figure
    // drawn in the other child's clothes must still be separable.
    const mNoClothes = buildCastIdentityDescription(MAX, '').toLowerCase();
    const kNoClothes = buildCastIdentityDescription(KIAAN, '').toLowerCase();
    expect(mNoClothes).not.toEqual(kNoClothes);
    expect(mNoClothes).toContain('light brown');
    expect(kNoClothes).toContain('dark brown');
  });

  it('keeps the legacy bare `hair` key working', () => {
    const d = buildCastIdentityDescription(LEGACY, '').toLowerCase();
    expect(d).toContain('dark brown');
  });

  it('never leaks hex codes or salon levels into the line', () => {
    const d = buildCastIdentityDescription(KIAAN, '');
    expect(d).not.toMatch(/#[0-9a-f]{6}/i);
    expect(d).not.toMatch(/salonlevel|salon level|\b4\b/i);
  });

  it('stays short — the line is read by a vision model naming badged figures', () => {
    for (const c of [MAX, KIAAN]) {
      const hair = buildHairDescription(c.physical, undefined);
      expect(hair.length).toBeLessThan(90);
    }
  });

  it('degrades cleanly when the profile is absent or empty', () => {
    expect(buildCastIdentityDescription(null)).toBe('');
    expect(buildCastIdentityDescription('Max')).toBe('');
    expect(buildCastIdentityDescription({ name: 'X' }, '')).toBe('');
    // A name + age band and nothing else: a line, but no hair fragment.
    const bare = buildCastIdentityDescription({ name: 'X', gender: 'male', ageCategory: 'preschooler' }, '');
    expect(bare).toBeTruthy();
    expect(bare).not.toMatch(/hair:/i);
  });

  it('hair survives the wardrobe tail that buildIdentityLine appends', () => {
    const line = buildIdentityLine(KIAAN, 'grey camouflage hoodie, dark blue jeans');
    expect(line).toMatch(/hair: dark brown/i);
    expect(line).toMatch(/Wearing: grey camouflage hoodie/);
  });

  it('a category label is still never emitted as clothing', () => {
    // sceneCharacterClothing holds tags like "standard" / "costumed:mermaid".
    for (const tag of ['standard', 'winter', 'costumed:mermaid']) {
      expect(buildCastIdentityDescription(MAX, tag)).not.toMatch(/Wearing:/);
    }
  });
});

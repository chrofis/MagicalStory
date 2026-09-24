/**
 * One shorter face, everywhere (owner, 2026-09-24: "Shorten each child's face
 * everywhere. Same logic.").
 *
 * The stored face is a comma list on character-analysis.txt's fixed scale.
 * Midpoint descriptors (neutral chin, medium cheekbones, medium lips) are on
 * almost every stored face and separate nobody, so buildFaceDescription drops
 * them. Every path that describes a character's face — the cover's CHARACTERS
 * IN THIS IMAGE line, the Art Director input for pages, the detector identity
 * line and the single-page repair prompt — carries that same shorter text, so
 * covers stay identical to pages (2026-08-26) and the critic reads what the
 * generator was given.
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PB = require('../../server/lib/promptBuilders');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildPhysicalTraitsDescription } = require('../../server/lib/entityConsistency');

const FACE = 'rounded jawline, neutral chin, straight nose with rounded tip, medium cheekbones, medium lips';
const SHORT = 'rounded jawline, straight nose with rounded tip';
const CHILD = {
  name: 'ChildA', age: '4', gender: 'male', ageCategory: 'preschooler',
  physical: { build: 'average', hairColor: 'light brown', face: FACE, eyeColor: 'blue' },
};

describe('buildFaceDescription', () => {
  it('drops the midpoint descriptors and keeps the rest in order', () => {
    expect(PB.buildFaceDescription(FACE)).toBe(SHORT);
    expect(PB.buildFaceDescription('square jawline, dimpled chin, high cheekbones, full lips'))
      .toBe('square jawline, dimpled chin, high cheekbones, full lips');
  });
  it('an all-midpoint or absent face yields nothing', () => {
    expect(PB.buildFaceDescription('neutral chin, medium lips')).toBe('');
    expect(PB.buildFaceDescription('none')).toBe('');
    expect(PB.buildFaceDescription(null)).toBe('');
  });
  it('still strips age words', () => {
    expect(PB.buildFaceDescription('soft jawline, youthful, full lips')).toBe('soft jawline, full lips');
  });
});

describe('every face path carries the same short face', () => {
  const paths: Record<string, string> = {
    'cover CHARACTERS IN THIS IMAGE': PB.buildCharacterReferenceList(
      [{ name: 'ChildA', clothingDescription: 'a red shirt' }], [CHILD], { includeClothing: true }),
    'page Art Director input': PB.buildCharacterDescriptionForExpansion(CHILD, 'a red shirt', 1),
    'prose description (entity judge, consolidator, detector rich line)': PB.buildCharacterPhysicalDescription(CHILD),
    'detector identity line': PB.buildCastIdentityDescription(CHILD),
    'single-page repair': buildPhysicalTraitsDescription(CHILD),
  };
  for (const [label, text] of Object.entries(paths)) {
    it(label, () => {
      expect(text).toContain(SHORT);
      expect(text).not.toMatch(/neutral chin|medium cheekbones|medium lips/);
    });
  }
});

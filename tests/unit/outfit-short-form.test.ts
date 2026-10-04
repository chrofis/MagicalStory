/**
 * Rule 10 outfit shortening (2026-09-30): briefs name top/bottom/footwear by
 * colour + garment noun only, no construction detail (e.g., "blue coat, brown
 * trousers, black shoes", not "blue quilted linen coat with horn buttons").
 *
 * The clothing_incomplete check must accept the short form: a slot counts as
 * stated by any garment noun of that slot in the prose.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { checkClothingIncomplete } = require('../../server/lib/clothingCheck.js');

describe('outfit short form (colour + noun only)', () => {
  const clothingRequirements = {
    Anna: {
      standard: {
        used: true,
        description: 'a blue quilted linen coat; brown wool trousers; black leather boots',
        signature: 'none',
      },
    },
  };

  it('accepts short prose form with colour + garment noun only', () => {
    const page = {
      pageNumber: 1,
      prose: 'Anna, a school-age girl with brown hair and bright eyes, stood at the gate in her blue coat, brown trousers, and black shoes.',
      cast: ['Anna'],
      perCharClothing: { Anna: { value: 'standard' } },
    };
    const findings = checkClothingIncomplete(page, clothingRequirements);
    expect(findings).toHaveLength(0);
  });

  it('accepts omitted construction detail and materials', () => {
    // The full contract says "quilted linen coat" but prose only says "blue coat"
    const page = {
      pageNumber: 1,
      prose: 'Anna wore a blue coat, brown trousers, and black boots on her way out.',
      cast: ['Anna'],
      perCharClothing: { Anna: { value: 'standard' } },
    };
    const findings = checkClothingIncomplete(page, clothingRequirements);
    expect(findings).toHaveLength(0);
  });


  it('recognizes multiple garment nouns for the same slot', () => {
    // Contract says "boots", prose says "shoes" — both are footwear
    const page = {
      pageNumber: 1,
      prose: 'Anna walked in her blue coat, brown trousers, and red shoes.',
      cast: ['Anna'],
      perCharClothing: { Anna: { value: 'standard' } },
    };
    const findings = checkClothingIncomplete(page, clothingRequirements);
    expect(findings).toHaveLength(0);
  });

  it('requires every required slot, even if unadorned', () => {
    const page = {
      pageNumber: 1,
      prose: 'Anna in coat, trousers, boots headed out.',
      cast: ['Anna'],
      perCharClothing: { Anna: { value: 'standard' } },
    };
    const findings = checkClothingIncomplete(page, clothingRequirements);
    // No colour in "coat" (still 1 token), but the slot noun is enough
    expect(findings).toHaveLength(0);
  });
});

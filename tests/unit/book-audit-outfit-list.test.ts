/**
 * THE BOOK AUDIT KNOWS WHO WEARS WHAT (2026-10-09, job_1791531449494_o0kaatvmq
 * p3): given bare cast names it charged Julian (yellow puffer) with "a blue
 * hoodie on the cover pages", the hoodie being another boy's. The brief line
 * now lists each drawn figure's stored outfit.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const bookAudit = require_('../../server/lib/bookAudit.js');

const storyData = {
  characters: [{ name: 'Julian' }, { name: 'Max' }],
  visualBible: null,
  pageClothing: { pageClothing: { 3: { Julian: 'standard' } }, primaryClothing: 'standard' },
  clothingRequirements: {
    Julian: { standard: { used: true, description: 'Yellow quilted puffer jacket, grey jogging trousers.' } },
    Max: { standard: { used: true, description: 'Blue hooded fleece pullover.' } },
  },
};

describe('book audit brief lists outfits', () => {
  it('auditPageBrief resolves each drawn figure to its stored outfit', () => {
    const b = bookAudit.auditPageBrief({
      pageNumber: 3, sceneCharacters: [{ name: 'Julian' }], outlineCharacters: [],
      sceneMetadata: { sceneIntent: 'x', characters: [{ name: 'Julian' }], objects: [] },
    }, storyData);
    expect(b.outfits).toEqual({ Julian: 'Yellow quilted puffer jacket, grey jogging trousers' });
  });
  it('briefLine names them, and stays as before when there are none', () => {
    expect(bookAudit.briefLine('PAGE 3', { cast: ['Julian'], sceneIntent: '', outfits: { Julian: 'yellow puffer' } }))
      .toBe('PAGE 3 BRIEF — drawn with: Julian. what each wears: Julian: yellow puffer');
    expect(bookAudit.briefLine('PAGE 9', { cast: ['Lukas'], sceneIntent: '', outfits: {} })).toBe('PAGE 9 BRIEF — drawn with: Lukas');
  });
});

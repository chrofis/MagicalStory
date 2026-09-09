import { describe, it, expect } from 'vitest';

const { vbNameInText } = require('../../server/lib/visualBible');

/**
 * A repair can only paint an object it has been shown. Findings name the object
 * in prose and carry no structured id, so the reference was never attached and
 * every repair of a missing-prop page scored the same or worse.
 */
describe('resolving the element a finding names', () => {
  const vb = {
    artifacts: [
      { name: 'Dragon scale — large (kept by marmots)', pages: [13, 15, 16, 17] },
      { name: 'Dragon scale — small (shed)', pages: [2, 12] },
    ],
    animals: [{ name: 'Rösi', pages: [13, 16, 17] }],
  };

  it('matches the head of a qualified bible name', () => {
    expect(vbNameInText(vb, 'the dragon scale is missing from the scene', 17))
      .toBe('dragon scale — large (kept by marmots)');
  });

  it('settles two entries of one kind by the page being repaired', () => {
    const text = 'the required dragon scale is not in his hands';
    expect(vbNameInText(vb, text, 2)).toBe('dragon scale — small (shed)');
    expect(vbNameInText(vb, text, 16)).toBe('dragon scale — large (kept by marmots)');
  });

  it('returns nothing when the finding names no object', () => {
    expect(vbNameInText(vb, 'Mouth closed instead of open while speaking name', 7)).toBe('');
    expect(vbNameInText(vb, '', 7)).toBe('');
  });

  it('ignores heads too short to match on purpose', () => {
    const tiny = { artifacts: [{ name: 'Urn', pages: [4] }] };
    expect(vbNameInText(tiny, 'she turns and the sun catches her', 4)).toBe('');
  });
});

import { describe, it, expect } from 'vitest';
const { illustrationProgress } = require('../../server/lib/illustrationProgress');

describe('illustrationProgress', () => {
  it('counts pages and covers against the same total (never 17/14)', () => {
    const last = illustrationProgress(17, 17);
    expect(last.message).toBe('Illustration 17/17 done...');
    expect(last.pct).toBe(64);
  });
  it('stays within 60..64 and moves with completion', () => {
    expect(illustrationProgress(1, 17).pct).toBe(60);
    expect(illustrationProgress(9, 17).pct).toBe(62);
    for (let d = 1; d <= 17; d++) expect(illustrationProgress(d, 17).pct).toBeLessThanOrEqual(64);
  });
});

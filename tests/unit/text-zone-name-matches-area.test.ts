/**
 * A full-width text zone is named a strip, never a "third": the stated area is
 * 10%, 30% or 40% by reading level, and "The upper third (roughly 10%)" told
 * the image model two different sizes in one sentence (dragon rerun
 * job_1791531449494_o0kaatvmq, 2026-10-09).
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildTextZoneInstruction } = require('../../server/lib/promptBuilders');

describe('buildTextZoneInstruction: zone name agrees with its area', () => {
  it.each(['top-full', 'bottom-full'])('%s never says "third"', (pos) => {
    for (const pct of ['10%', '30%', '40%']) {
      const s = buildTextZoneInstruction(pos, null, pct);
      expect(s).not.toMatch(/third/i);
      expect(s).toContain(`strip (roughly ${pct})`);
    }
  });
});

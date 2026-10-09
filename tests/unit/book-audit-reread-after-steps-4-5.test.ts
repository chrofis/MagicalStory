import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
// @ts-expect-error - JS module without types
import { rereadShippedIfMoved } from '../../server/lib/repairLogic.js';

// Stored evidence: staging job_1791531449494_o0kaatvmq. The final book audit
// read p4's original; Step 4 (calm-zone recovery) / Step 5 (style repair) can
// push a new version AFTER that read, so finalChecksReport would describe a
// picture that does not ship. The same re-read mechanism covers both places.
describe('rereadShippedIfMoved', () => {
  const original = { source: 'original', pageNumber: 4 };
  const repainted = { source: 'style-repair', pageNumber: 4 };
  const p3 = { source: 'inpaint-round-1', pageNumber: 3 };

  it('re-reads the whole shipping set when a post-audit step repainted a page', async () => {
    const readBook = vi.fn(async () => ({ faults: 0 }));
    const shipping = new Map([[3, p3], [4, repainted]]);
    const out = await rereadShippedIfMoved({ readByPage: new Map([[3, p3], [4, original]]), shippingByPage: shipping, readBook });
    expect(out).toEqual({ moved: [4], reread: { faults: 0 } });
    expect(readBook).toHaveBeenCalledWith(shipping);
  });

  it('does not read again when what ships is what was read', async () => {
    const readBook = vi.fn();
    const same = new Map([[3, p3], [4, original]]);
    expect(await rereadShippedIfMoved({ readByPage: same, shippingByPage: new Map(same), readBook })).toBeNull();
    expect(readBook).not.toHaveBeenCalled();
  });

  it('reports a failed read as reread:null so the caller can say so loudly', async () => {
    const out = await rereadShippedIfMoved({ readByPage: new Map([[4, original]]), shippingByPage: new Map([[4, repainted]]), readBook: async () => null });
    expect(out).toEqual({ moved: [4], reread: null });
  });
});

describe('repairPipeline wiring', () => {
  const src = fs.readFileSync('server/lib/repairPipeline.js', 'utf8');
  it('re-reads shipped pages after Step 5 and before the results are built', () => {
    const step5 = src.indexOf('Step 5: Style consistency audit');
    const reread = src.indexOf('Calm-zone recovery / style repair changed the shipped version');
    const build = src.indexOf("Building final results");
    expect(step5).toBeGreaterThan(0);
    expect(reread).toBeGreaterThan(step5);
    expect(reread).toBeLessThan(build);
  });
  it('uses one re-read helper for both call sites (no second mechanism)', () => {
    expect(src.match(/rereadShippedIfMoved\(/g)?.length).toBe(1);
    expect(src.match(/await rereadShippingBook\(/g)?.length).toBe(2);
  });
});

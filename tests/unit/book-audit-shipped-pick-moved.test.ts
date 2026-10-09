import { describe, it, expect } from 'vitest';
// @ts-expect-error - JS module without types
import { pagesWherePickMoved } from '../../server/lib/repairLogic.js';
// @ts-expect-error - JS module without types
import * as repairPipeline from '../../server/lib/repairPipeline.js';

// Stored evidence: staging job_1791531449494_o0kaatvmq, page 4. The round-1
// repair left two versions: original (finalScore 67 at the time the final book
// audit read it) and iterate-round-1 (56). The audit read the original, charged
// it a MAJOR missing_element (its stored finalScore is now 22), and the iterate
// version became the shipped pick (bestSource = iterate-round-1) -- a picture
// the audit never saw, while finalChecksReport.objectScale named p4 off the
// original's pixels. Pages 1-3 are unchanged by the audit.
const selectBestVersion = (repairPipeline as any).selectBestVersion;

function p4Versions() {
  return [
    { source: 'original', finalScore: 67, pageNumber: 4 },
    { source: 'iterate-round-1', finalScore: 56, pageNumber: 4 },
  ];
}

describe('pagesWherePickMoved', () => {
  it('names the page whose shipped version is not the one the reader read (stored p4 shape)', () => {
    const versions = p4Versions();
    const read = new Map([[3, { source: 'inpaint-round-1' }], [4, selectBestVersion(versions)]]);
    expect(read.get(4)!.source).toBe('original');          // what the audit was handed
    versions[0].finalScore = 22;                            // the reader's MAJOR charged to it
    const shipping = new Map([[3, read.get(3)], [4, selectBestVersion(versions)]]);
    expect(shipping.get(4)!.source).toBe('iterate-round-1'); // what ships (bestSource)
    expect(pagesWherePickMoved(read, shipping)).toEqual([4]);
  });

  it('is empty when every audited version still ships', () => {
    const versions = p4Versions();
    const read = new Map([[4, selectBestVersion(versions)]]);
    expect(pagesWherePickMoved(read, new Map([[4, selectBestVersion(versions)]]))).toEqual([]);
  });

  it('ignores a page with no shipping version', () => {
    expect(pagesWherePickMoved(new Map([[4, {}]]), new Map())).toEqual([]);
  });
});

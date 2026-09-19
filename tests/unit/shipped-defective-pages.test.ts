/**
 * D7 — a page that ships known-broken must be reported somewhere a reader finds.
 *
 * Evidence: job_1789147573901_m3uam0nxi. p6 shipped as the ACTIVE version at
 * finalScore 0 (six CRITICAL `action_interaction` findings) and p9 at 5. Repair
 * ran on both and moved them -20 → 0 and -15 → 5; `repairMaxPasses` is 1 on
 * staging so there was no second round, and nothing in the stored run, the job
 * status or the story said those pages were known-bad.
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import repairLogic from '../../server/lib/repairLogic.js';
const { collectShippedDefective } = repairLogic as any;

const page = (pageNumber: number, finalScore: number | null, criticals: any[] | null = null) =>
  ({ pageNumber, finalScore, unrepairedCritical: criticals });

describe('collectShippedDefective', () => {
  const RESULTS = [
    page(6, 0, [{ type: 'action_interaction', severity: 'CRITICAL', description: 'the deed is not shown' }]),
    page(9, 5),
    page(13, 85, [{ type: 'object_presence', severity: 'CRITICAL', description: 'the key prop is absent' }]),
    page(1, 85),
  ];

  it('reports a page below the threshold', () => {
    const out = collectShippedDefective(RESULTS, 70);
    expect(out.map((p: any) => p.pageNumber)).toContain(6);
    expect(out.map((p: any) => p.pageNumber)).toContain(9);
  });

  it('reports a page that CLEARS the threshold but kept a CRITICAL', () => {
    const out = collectShippedDefective(RESULTS, 70);
    const p13 = out.find((p: any) => p.pageNumber === 13);
    expect(p13).toBeTruthy();
    expect(p13.finalScore).toBe(85);
    expect(p13.unrepairedCritical[0].type).toBe('object_presence');
  });

  it('leaves a healthy page alone', () => {
    expect(collectShippedDefective(RESULTS, 70).map((p: any) => p.pageNumber)).not.toContain(1);
  });

  it('orders worst first', () => {
    expect(collectShippedDefective(RESULTS, 70).map((p: any) => p.pageNumber)).toEqual([6, 9, 13]);
  });

  it('an UNSCORED page is not a zero', () => {
    // Number(null) === 0, so a null score would otherwise be reported as the
    // worst page in the book.
    const out = collectShippedDefective([page(4, null), page(5, undefined as any)], 70);
    expect(out).toEqual([]);
  });

  it('an unscored page WITH a critical is reported, with a null score, sorted last', () => {
    const out = collectShippedDefective(
      [page(4, null, [{ type: 'anatomy', severity: 'CRITICAL', description: 'x' }]), page(6, 0)],
      70,
    );
    expect(out.map((p: any) => p.pageNumber)).toEqual([6, 4]);
    expect(out[1].finalScore).toBeNull();
  });

  it('the threshold is the caller\'s, never a second number', () => {
    expect(collectShippedDefective([page(2, 60)], 70).map((p: any) => p.pageNumber)).toEqual([2]);
    expect(collectShippedDefective([page(2, 60)], 50)).toEqual([]);
  });

  it('degrades safely on junk input', () => {
    expect(collectShippedDefective(null as any, 70)).toEqual([]);
    expect(collectShippedDefective([null as any, undefined as any], 70)).toEqual([]);
  });
});

/**
 * planCompaction (scripts/admin/merge-landmark-descriptions.js) must key every
 * discard and every kept description on the photo's SOURCE URL, never on the
 * slot number the agent saw at prep time. Regression for the 2026-09-04
 * incident: a re-run after a compaction discarded by stale slot number and
 * deleted the photo that had shifted into that slot (~118 photos on prod).
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { planCompaction, liveSlotOf } = require('../../scripts/admin/merge-landmark-descriptions.js');

const col = (f: string, s: number) => (s === 1 ? f : `${f}_${s}`);
function row(urls: (string | null)[], descs: (string | null)[] = []) {
  const r: Record<string, unknown> = { id: 1, name: 'X' };
  for (let s = 1; s <= 6; s++) {
    r[col('photo_url', s)] = urls[s - 1] || null;
    r[col('photo_attribution', s)] = urls[s - 1] ? `attr-${urls[s - 1]}` : null;
    r[col('photo_description', s)] = descs[s - 1] || null;
    r[col('photo_type', s)] = urls[s - 1] ? 'exterior' : null;
    r[col('photo_r2_url', s)] = urls[s - 1] ? `r2-${urls[s - 1]}` : null;
  }
  return r;
}
const urlsOf = (plan: any) => plan.layout.map((l: any) => l.values.photo_url);

describe('planCompaction — first run on the prep-time layout', () => {
  it('drops the discarded slot, shifts later photos down, moves every column with its photo', () => {
    const r = row(['A', 'B', 'C', 'D']);
    const plan = planCompaction(r, { 2: 'B' }, { 1: { url: 'A', text: 'desc A' }, 4: { url: 'D', text: 'desc D' } });
    expect([...plan.dropSlots]).toEqual([2]);
    expect(plan.survivors).toEqual([1, 3, 4]);
    expect(urlsOf(plan)).toEqual(['A', 'C', 'D', null, null, null]);
    expect(plan.layout[2].values.photo_attribution).toBe('attr-D');
    expect(plan.layout[2].values.photo_r2_url).toBe('r2-D');
    expect(plan.layout[0].values.photo_description).toBe('desc A');
    expect(plan.layout[2].values.photo_description).toBe('desc D');   // followed D from slot 4 to slot 3
    expect(plan.skipped).toEqual([]);
  });
});

describe('planCompaction — re-run against a row that has already been compacted', () => {
  // Prep-time layout was [A, B, C, D]; the first run discarded B, so the live
  // row is [A, C, D]. The same descs dir is merged again.
  const live = row(['A', 'C', 'D'], ['desc A', null, 'desc D']);
  const discards = { 2: 'B' };
  const kept = { 1: { url: 'A', text: 'desc A' }, 3: { url: 'C', text: 'desc C' }, 4: { url: 'D', text: 'desc D' } };

  it('does NOT discard slot 2 again — C lives there now, not B', () => {
    const plan = planCompaction(live, discards, kept);
    expect(plan.dropSlots.size).toBe(0);
    expect(urlsOf(plan)).toEqual(['A', 'C', 'D', null, null, null]);
    expect(plan.skipped).toContainEqual(expect.objectContaining({ slot: 2, url: 'B', reason: expect.stringContaining('different photo') }));
  });

  it('writes kept descriptions at the photo\'s CURRENT slot, not its prep-time slot', () => {
    const plan = planCompaction(live, discards, kept);
    expect(plan.textAt).toEqual({ 1: 'desc A', 2: 'desc C', 3: 'desc D' });
    expect(plan.layout[1].values.photo_description).toBe('desc C');   // prep slot 3 -> live slot 2
    expect(plan.layout[2].values.photo_description).toBe('desc D');   // prep slot 4 -> live slot 3
  });

  it('is a no-op when the discard targets an empty slot', () => {
    const plan = planCompaction(row(['A']), { 2: 'B' }, {});
    expect(plan.dropSlots.size).toBe(0);
    expect(plan.skipped[0].reason).toBe('live slot is empty');
  });
});

describe('planCompaction — guards', () => {
  it('skips a description whose photo is gone from the row', () => {
    const plan = planCompaction(row(['A', 'C']), {}, { 2: { url: 'B', text: 'desc B' } });
    expect(plan.textAt).toEqual({});
    expect(plan.skipped[0].reason).toBe('photo is no longer on the row');
  });
  it('refuses entries without a source URL instead of falling back to the slot number', () => {
    const plan = planCompaction(row(['A', 'B']), { 2: null }, { 1: { url: null, text: 'desc' } });
    expect(plan.dropSlots.size).toBe(0);
    expect(plan.textAt).toEqual({});
    expect(plan.skipped.map((s: any) => s.reason)).toEqual(['no source URL in manifest', 'no source URL in manifest']);
  });
  it('does not describe a photo that is being discarded in the same run', () => {
    const plan = planCompaction(row(['A', 'B']), { 2: 'B' }, { 2: { url: 'B', text: 'desc B' } });
    expect([...plan.dropSlots]).toEqual([2]);
    expect(plan.textAt).toEqual({});
  });
  it('liveSlotOf prefers the prep-time slot when it still holds the URL', () => {
    expect(liveSlotOf(row(['A', 'B']), 2, 'B')).toBe(2);
    expect(liveSlotOf(row(['B', 'A']), 2, 'B')).toBe(1);
    expect(liveSlotOf(row(['A']), 2, 'B')).toBeNull();
  });
});

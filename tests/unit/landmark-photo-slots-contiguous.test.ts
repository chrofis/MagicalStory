/**
 * Landmark photo slots are contiguous from slot 1. Every serving query filters
 * on slot 1 (HAS_PHOTO_SQL), so an empty slot 1 hides a landmark whatever its
 * later slots hold — 17 prod landmarks were invisible that way on 2026-09-24,
 * 68 had a gap somewhere. Two producers are pinned here:
 *  - saveLandmarkToIndex packs its six slots (the indexer's exteriors-in-1-3 /
 *    interiors-in-4-6 layout and a dropped non-free URL both left holes);
 *  - compact-landmark-slots.js closes existing gaps with
 *    merge-landmark-descriptions.js's own planCompaction + writeCompaction.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { packLandmarkPhotoSlots, isFreelyLicensedImageUrl } = require('../../server/lib/landmarkPhotos');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { planCompaction, writeCompaction } = require('../../scripts/admin/merge-landmark-descriptions.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hasSlotGap } = require('../../scripts/admin/compact-landmark-slots.js');

const C = (f: string) => `https://upload.wikimedia.org/wikipedia/commons/a/ab/${f}.jpg`;
const LOCAL = 'https://upload.wikimedia.org/wikipedia/de/a/ab/Logo.png';
// saveLandmarkToIndex's own normaliser: empty → null, non-free URL → null.
const normalize = (v: unknown) => {
  const x = v === undefined || v === 'undefined' || v === '' ? null : v;
  return typeof x === 'string' && /^https?:\/\//.test(x) && /\.(jpe?g|png)/i.test(x) && !isFreelyLicensedImageUrl(x) ? null : x;
};

describe('packLandmarkPhotoSlots', () => {
  it('moves interiors down when the indexer found fewer than three exteriors', () => {
    const slots = packLandmarkPhotoSlots({
      photoUrl: C('ext1'), attribution: 'a1', photoType: 'exterior',
      photoUrl4: C('int1'), attribution4: 'a4', photoDescription4: 'hall', photoType4: 'interior',
    }, normalize);
    expect(slots.map((s: any) => s.url)).toEqual([C('ext1'), C('int1'), null, null, null, null]);
    expect(slots[1]).toEqual({ url: C('int1'), attribution: 'a4', description: 'hall', type: 'interior' });
  });

  it('fills slot 1 when there is no exterior at all', () => {
    const slots = packLandmarkPhotoSlots({ photoUrl4: C('int1'), attribution4: 'a4', photoType4: 'interior' }, normalize);
    expect(slots[0].url).toBe(C('int1'));
    expect(slots[0].type).toBe('interior');
  });

  it('drops a non-free URL with its credit and closes the hole', () => {
    const slots = packLandmarkPhotoSlots({
      photoUrl: LOCAL, attribution: 'logo credit', photoUrl2: C('b'), attribution2: 'b credit',
    }, normalize);
    expect(slots[0]).toEqual({ url: C('b'), attribution: 'b credit', description: null, type: null });
    expect(slots.slice(1).every((s: any) => s.url === null && s.attribution === null)).toBe(true);
  });

  it('accepts the snake_case field names too', () => {
    const slots = packLandmarkPhotoSlots({ photo_url_3: C('c'), photo_attribution_3: 'c credit' }, normalize);
    expect(slots[0]).toMatchObject({ url: C('c'), attribution: 'c credit' });
  });
});

const col = (f: string, s: number) => (s === 1 ? f : `${f}_${s}`);
function row(urls: (string | null)[]) {
  const r: Record<string, unknown> = { id: 7, name: 'X' };
  for (let s = 1; s <= 6; s++) {
    const u = urls[s - 1] || null;
    for (const f of ['photo_url', 'photo_attribution', 'photo_description', 'photo_type', 'photo_r2_url']) {
      r[col(f, s)] = u ? `${f}:${u}` : null;
    }
    r[col('photo_url', s)] = u;
  }
  return r;
}

describe('hasSlotGap', () => {
  it('flags an empty slot followed by a filled one', () => {
    expect(hasSlotGap(row([null, 'B']))).toBe(true);
    expect(hasSlotGap(row(['A', 'B', null, 'D']))).toBe(true);
  });
  it('passes contiguous and empty rows', () => {
    expect(hasSlotGap(row(['A', 'B', 'C']))).toBe(false);
    expect(hasSlotGap(row([]))).toBe(false);
  });
});

describe('compaction with no discards (compact-landmark-slots)', () => {
  it('shifts photos down with every column and re-keys the scores', async () => {
    const r = row([null, 'B', null, 'D']);
    const plan = planCompaction(r, {}, {});
    expect(plan.layout.map((l: any) => l.values.photo_url)).toEqual(['B', 'D', null, null, null, null]);
    expect(plan.layout[1].values.photo_attribution).toBe('photo_attribution:D');
    expect(plan.layout[1].values.photo_r2_url).toBe('photo_r2_url:D');

    const queries: { sql: string; params: unknown[] }[] = [];
    const client = { query: async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rowCount: 1 }; } };
    const scores = [
      { slot: 2, draw_score: 80, photo_score: 70, reason: 'b', judged_at: null, framing: 'medium' },
      { slot: 4, draw_score: 80, photo_score: 60, reason: 'd', judged_at: null, framing: 'interior' },
    ];
    const n = await writeCompaction(client, 7, plan, scores);
    expect(n).toBe(2);
    const inserts = queries.filter(q => q.sql.includes('INSERT INTO landmark_photo_scores'));
    expect(inserts.map(q => [q.params[1], q.params[4]])).toEqual([[1, 'b'], [2, 'd']]);
    expect(hasSlotGap(Object.fromEntries(plan.layout.map((l: any) => [col('photo_url', l.slot), l.values.photo_url])))).toBe(false);
  });
});

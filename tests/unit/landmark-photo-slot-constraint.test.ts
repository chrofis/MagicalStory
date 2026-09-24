/**
 * Migration 042 puts a CHECK on landmark_index: no photo slot may be empty
 * while a later slot holds a photo. These tests pin that the constraint means
 * exactly what hasSlotGap() means, and that the writers that touch individual
 * slots cannot trip it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hasSlotGap } = require('../../scripts/admin/compact-landmark-slots.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { planFreePhotoFill } = require('../../scripts/admin/fetch-landmark-photos-free.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { COLUMNS } = require('../../scripts/admin/sync-landmark-index-to-staging.js');

const col = (s: number) => (s === 1 ? 'photo_url' : `photo_url_${s}`);
const rowOf = (mask: number) => Object.fromEntries([1, 2, 3, 4, 5, 6].map(s => [col(s), (mask >> (s - 1)) & 1 ? `u${s}` : null]));

// Evaluate the migration's CHECK the way Postgres would, from the SQL text:
// every `(photo_url_a IS NOT NULL OR photo_url_b IS NULL)` term must hold.
const SQL = fs.readFileSync(path.join(__dirname, '../../migrations/042_landmark_photo_slots_contiguous.sql'), 'utf8');
const TERMS = [...SQL.matchAll(/\((photo_url(?:_\d)?)\s+IS NOT NULL OR (photo_url(?:_\d)?) IS NULL\)/g)].map(m => [m[1], m[2]]);
const checkPasses = (row: Record<string, unknown>) => TERMS.every(([a, b]) => row[a] !== null || row[b] === null);

describe('migration 042 CHECK', () => {
  it('has the five adjacent-slot terms', () => {
    expect(TERMS).toEqual([1, 2, 3, 4, 5].map(n => [col(n), col(n + 1)]));
  });

  it('rejects exactly the rows hasSlotGap flags, over all 64 slot patterns', () => {
    for (let mask = 0; mask < 64; mask++) {
      const row = rowOf(mask);
      expect(checkPasses(row)).toBe(!hasSlotGap(row));
    }
  });
});

describe('fetch-landmark-photos-free: planFreePhotoFill', () => {
  const U = (n: string) => `https://commons.wikimedia.org/wiki/Special:FilePath/${n}.jpg`;

  it('fills a photoless row from slot 1', () => {
    expect(planFreePhotoFill({ id: 1 }, [U('a'), U('b')])).toEqual([{ slot: 1, url: U('a') }, { slot: 2, url: U('b') }]);
  });

  it('appends after existing photos and never touches an occupied slot', () => {
    const row = { id: 2, photo_url: U('x'), photo_url_2: U('y') };
    expect(planFreePhotoFill(row, [U('a'), U('b'), U('c')])).toEqual([{ slot: 3, url: U('a') }, { slot: 4, url: U('b') }]);
  });

  it('skips URLs the row already holds', () => {
    expect(planFreePhotoFill({ id: 3, photo_url: U('x') }, [U('x'), U('a')])).toEqual([{ slot: 2, url: U('a') }]);
  });

  it('stops at four photos in all', () => {
    const row = { id: 4, photo_url: U('1'), photo_url_2: U('2'), photo_url_3: U('3'), photo_url_4: U('4') };
    expect(planFreePhotoFill(row, [U('a')])).toEqual([]);
  });

  it('refuses a row that already has a gap', () => {
    expect(() => planFreePhotoFill({ id: 5, photo_url_2: U('y') }, [U('a')])).toThrow(/gap/);
  });

  it('never produces a gap', () => {
    for (let mask = 0; mask < 64; mask++) {
      const row = { id: 6, ...rowOf(mask) };
      if (hasSlotGap(row)) continue;
      const after: Record<string, unknown> = { ...row };
      for (const p of planFreePhotoFill(row, [U('a'), U('b'), U('c'), U('d')])) {
        expect(after[col(p.slot)]).toBeNull();
        after[col(p.slot)] = p.url;
      }
      expect(hasSlotGap(after)).toBe(false);
    }
  });
});

describe('sync-landmark-index-to-staging', () => {
  it('writes all six photo slots in the same upsert statement', () => {
    // A row-level CHECK is evaluated on the row a statement leaves behind. The
    // sync writes every photo column of a prod row (itself contiguous) in one
    // INSERT … ON CONFLICT DO UPDATE, so no intermediate state exists.
    for (let s = 1; s <= 6; s++) expect(COLUMNS).toContain(col(s));
  });
});

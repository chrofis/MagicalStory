/**
 * The prod → staging landmark sync MIRRORS per-image scores for every landmark
 * it syncs: a staging score row prod does not have is deleted. Upsert-only left
 * 2,615 staging scores on slots whose photo prod had removed or reshuffled
 * (2026-09-24), so bestPhotoSlots served empty slots on staging.
 *
 * Rows are shaped like the script's staging query: node-pg returns `slot` as a
 * number (INT column), `wikidata_qid` as a string.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scoreRowsToDelete, scoreKey } = require('../../scripts/admin/sync-landmark-index-to-staging.js');

const row = (wikidata_qid: string | null, slot: number, landmark_id = 1) => ({ wikidata_qid, slot, landmark_id });

describe('scoreRowsToDelete', () => {
  const prodKeys = [scoreKey('Q1', 1), scoreKey('Q1', 2), scoreKey('Q2', 1)];
  const synced = ['Q1', 'Q2'];

  it('keeps a staging row prod also has', () => {
    expect(scoreRowsToDelete(prodKeys, synced, [row('Q1', 1), row('Q2', 1)])).toEqual([]);
  });

  it('deletes a synced landmark\'s slot that prod has no score for', () => {
    const stale = row('Q1', 3);
    expect(scoreRowsToDelete(prodKeys, synced, [row('Q1', 1), stale])).toEqual([stale]);
  });

  it('deletes every staging slot of a synced landmark prod has no scores for at all', () => {
    const a = row('Q3', 1), b = row('Q3', 2);
    expect(scoreRowsToDelete(prodKeys, [...synced, 'Q3'], [a, b])).toEqual([a, b]);
  });

  it('never touches a staging-only landmark', () => {
    expect(scoreRowsToDelete(prodKeys, synced, [row('Q999', 1), row(null, 2)])).toEqual([]);
  });

  it('never touches a landmark outside the synced set (--city)', () => {
    expect(scoreRowsToDelete(prodKeys, ['Q1'], [row('Q2', 5)])).toEqual([]);
  });

  it('matches slots numerically', () => {
    expect(scoreRowsToDelete([scoreKey('Q1', '2' as unknown as number)], ['Q1'], [row('Q1', 2)])).toEqual([]);
  });
});

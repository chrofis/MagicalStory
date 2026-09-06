import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { shouldRun } = require_('../../server/lib/dbHousekeeping');

/**
 * The scheduler ticks every 5 minutes and asks this one pure function whether a
 * job is due. Everything that can go wrong with a cron-by-hand — the Zurich/UTC
 * offset, a redeploy replaying a job that already ran, a weekly job firing on
 * the wrong day — is decided here, so it is tested here.
 *
 * Zurich is UTC+2 in September, so 01:30 UTC is 03:30 CH.
 */
describe('shouldRun', () => {
  // 2026-09-07 is a Monday; 2026-09-06 is a Sunday.
  const utc = (iso: string) => new Date(iso);

  describe('daily', () => {
    it('is not due before 03:30 CH', () => {
      expect(shouldRun(utc('2026-09-07T01:29:00Z'), null)).toBe(false); // 03:29 CH
    });

    it('is due at exactly 03:30 CH', () => {
      expect(shouldRun(utc('2026-09-07T01:30:00Z'), null)).toBe(true);
    });

    it('is due later in the day when it has never run', () => {
      expect(shouldRun(utc('2026-09-07T14:00:00Z'), null)).toBe(true);
    });

    it('is not due again on the same Swiss calendar date', () => {
      const last = '2026-09-07T01:35:00Z';
      expect(shouldRun(utc('2026-09-07T09:00:00Z'), last)).toBe(false);
    });

    it('is due again on the next Swiss calendar date', () => {
      const last = '2026-09-07T01:35:00Z';
      expect(shouldRun(utc('2026-09-08T01:35:00Z'), last)).toBe(true);
    });

    it('treats an unreadable marker as never-run rather than wedging forever', () => {
      expect(shouldRun(utc('2026-09-07T09:00:00Z'), 'not-a-timestamp')).toBe(true);
    });
  });

  describe('Zurich/UTC boundary', () => {
    // 23:30 UTC on the 7th is already 01:30 CH on the 8th — the Swiss date has
    // rolled over while UTC has not. A UTC-based comparison would say "already
    // ran today" and skip the 8th entirely.
    it('uses the Swiss calendar date, not the UTC one', () => {
      const last = '2026-09-07T23:30:00Z';          // = 2026-09-08 01:30 CH
      expect(shouldRun(utc('2026-09-08T01:30:00Z'), last)).toBe(false); // same CH day
      expect(shouldRun(utc('2026-09-09T01:30:00Z'), last)).toBe(true);
    });

    it('a 01:29 UTC tick is 03:29 CH and still too early', () => {
      expect(shouldRun(utc('2026-09-07T01:29:59Z'), null)).toBe(false);
    });
  });

  describe('weekly (Sunday only)', () => {
    const SUNDAY = 0;

    it('is due on a Sunday at/after 03:30 CH', () => {
      expect(shouldRun(utc('2026-09-06T01:30:00Z'), null, { weekday: SUNDAY })).toBe(true);
    });

    it('is not due on a Sunday before 03:30 CH', () => {
      expect(shouldRun(utc('2026-09-06T01:00:00Z'), null, { weekday: SUNDAY })).toBe(false);
    });

    it('is not due on any other weekday', () => {
      for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']) {
        expect(shouldRun(utc(`${d}T10:00:00Z`), null, { weekday: SUNDAY })).toBe(false);
      }
    });

    it('does not run twice on the same Sunday', () => {
      const last = '2026-09-06T01:35:00Z';
      expect(shouldRun(utc('2026-09-06T18:00:00Z'), last, { weekday: SUNDAY })).toBe(false);
    });

    it('is due again the following Sunday', () => {
      const last = '2026-09-06T01:35:00Z';
      expect(shouldRun(utc('2026-09-13T01:35:00Z'), last, { weekday: SUNDAY })).toBe(true);
    });
  });
});

/**
 * Pins the two behaviours changed on 2026-09-13 when the trial funnel gained a
 * terminal `account_created` step and CH-calendar-day windows:
 *
 *  1. `email_submitted` is an OPTIONAL step — the Google signup path skips it —
 *     so it must never become the baseline for the step after it. Before this,
 *     a week of Google-only conversions read as "everyone lost at the email
 *     step" and drove the conversion rate to 0%.
 *  2. 'today'/'yesterday' are Europe/Zurich calendar days, so the bounds shift
 *     with DST. Hand-rolled arithmetic (or the container's UTC local midnight)
 *     gets both switch nights wrong.
 */
import { describe, it, expect } from 'vitest';

// The route module boots auth middleware on require; these pure helpers need no
// DB, only a secret to exist.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-trial-funnel';

const { buildTrialFunnelRows, resolveTrialWindow, TRIAL_FUNNEL_STEPS, OPTIONAL_TRIAL_STEPS } =
  require('../../server/routes/trial.js');
const { chDayRange } = require('../../scripts/lib/chTime.js');

const row = (rows: any[], step: string) => rows.find((r) => r.step === step);

describe('trial funnel step vocabulary', () => {
  it('ends on account_created and keeps email_submitted as an optional lead', () => {
    expect(TRIAL_FUNNEL_STEPS[TRIAL_FUNNEL_STEPS.length - 1]).toBe('account_created');
    expect(TRIAL_FUNNEL_STEPS).toContain('email_submitted');
    expect(OPTIONAL_TRIAL_STEPS.has('email_submitted')).toBe(true);
    expect(OPTIONAL_TRIAL_STEPS.has('face_picked')).toBe(true);
    expect(OPTIONAL_TRIAL_STEPS.has('account_created')).toBe(false);
  });
});

describe('buildTrialFunnelRows — optional steps are not a baseline', () => {
  // 8 finished stories, 1 email lead, 4 Google conversions: the real prod shape.
  const byStep = new Map<string, number>([
    ['landing', 28],
    ['generation_completed', 8],
    ['email_submitted', 1],
    ['account_created', 4],
  ]);
  const rows = buildTrialFunnelRows(byStep);

  it('rates account_created against generation_completed, not against the email lead', () => {
    expect(row(rows, 'account_created').pctOfPrev).toBe(50);
    expect(row(rows, 'account_created').droppedFromPrev).toBe(4);
  });

  it('never charges a loss to the optional email step', () => {
    const email = row(rows, 'email_submitted');
    expect(email.optional).toBe(true);
    expect(email.droppedFromPrev).toBe(0);
  });

  it('reports every canonical step, in order', () => {
    expect(rows.map((r: any) => r.step)).toEqual(TRIAL_FUNNEL_STEPS);
  });

  it('clamps a step that exceeds its predecessor instead of reporting >100%', () => {
    const r = buildTrialFunnelRows(new Map([['landing', 5], ['intro_start', 9]]));
    expect(row(r, 'intro_start').pctOfPrev).toBe(100);
    expect(row(r, 'intro_start').droppedFromPrev).toBe(0);
  });
});

describe('resolveTrialWindow — CH calendar days across DST', () => {
  const iso = (d: Date) => d.toISOString();

  it('today = Swiss midnight to Swiss midnight in summer (CEST, UTC+2)', () => {
    const now = new Date('2026-09-13T09:45:00Z'); // 11:45 CH
    const w = resolveTrialWindow('today', now);
    expect(w.range).toBe('today');
    expect(iso(w.params[0])).toBe('2026-09-12T22:00:00.000Z');
    expect(iso(w.params[1])).toBe('2026-09-13T22:00:00.000Z');
    expect(w.label).toBe('2026-09-13 00:00:00 CH – 2026-09-14 00:00:00 CH');
  });

  it('today = Swiss midnight in winter (CET, UTC+1)', () => {
    const w = resolveTrialWindow('today', new Date('2026-01-15T09:00:00Z'));
    expect(iso(w.params[0])).toBe('2026-01-14T23:00:00.000Z');
    expect(iso(w.params[1])).toBe('2026-01-15T23:00:00.000Z');
  });

  it('spring-forward night: 2026-03-29 is a 23-hour Swiss day', () => {
    // "Yesterday" evaluated on 2026-03-30 must start at CET midnight and end at
    // CEST midnight — a fixed 24h subtraction gets the end an hour wrong.
    const w = resolveTrialWindow('yesterday', new Date('2026-03-30T09:00:00Z'));
    expect(iso(w.params[0])).toBe('2026-03-28T23:00:00.000Z');
    expect(iso(w.params[1])).toBe('2026-03-29T22:00:00.000Z');
    expect(w.params[1].getTime() - w.params[0].getTime()).toBe(23 * 3600 * 1000);
  });

  it('fall-back night: 2026-10-25 is a 25-hour Swiss day', () => {
    const { start, end } = chDayRange(0, new Date('2026-10-25T09:00:00Z'));
    expect(iso(start)).toBe('2026-10-24T22:00:00.000Z');
    expect(iso(end)).toBe('2026-10-25T23:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(25 * 3600 * 1000);
  });

  it('a rolling window stays a rolling interval, and bad input falls back to 30d', () => {
    const w = resolveTrialWindow('7d', new Date('2026-09-13T09:45:00Z'));
    expect(w.range).toBe('7d');
    expect(w.days).toBe(7);
    expect(w.clause).toContain("NOW() -");
    expect(w.params).toEqual(['7']);
    expect(resolveTrialWindow('nonsense').range).toBe('30d');
    expect(resolveTrialWindow('9999d').days).toBe(365);
  });

  it('labels are Swiss local and marked CH', () => {
    for (const r of ['today', 'yesterday', '30d']) {
      expect(resolveTrialWindow(r).label).toMatch(/CH – .*CH$/);
    }
  });
});

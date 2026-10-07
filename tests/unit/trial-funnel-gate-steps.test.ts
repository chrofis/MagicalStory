/**
 * The reading gate on the trial waiting page (pages 1–3 readable, 4–6 locked
 * behind the sign-in — tasks/trial-story-gate-2026-10-04.md) is where 7 of 9
 * lost visits left, and at ~9 trial starts a month it needs its own funnel rows
 * to be readable at all: `gate_seen` (the sign-in block at the gate scrolled
 * into view) and `gate_unlocked` (job-status reported the pages unlocked).
 *
 * Both are OPTIONAL steps: a visitor who quits during the writer phase never
 * sees a gate, and one who links Google before the text exists never has a
 * locked page — so neither may become the baseline for generation_completed.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-trial-gate-steps';
const { buildTrialFunnelRows, TRIAL_FUNNEL_STEPS, OPTIONAL_TRIAL_STEPS, ACCEPTED_EVENT_STEPS } =
  require('../../server/routes/trial.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('gate steps in the funnel vocabulary', () => {
  it('sit between generation_started and generation_completed, accepted by /event', () => {
    const i = TRIAL_FUNNEL_STEPS.indexOf('generation_started');
    expect(TRIAL_FUNNEL_STEPS.slice(i, i + 4)).toEqual([
      'generation_started', 'gate_seen', 'gate_unlocked', 'generation_completed',
    ]);
    expect(ACCEPTED_EVENT_STEPS.has('gate_seen')).toBe(true);
    expect(ACCEPTED_EVENT_STEPS.has('gate_unlocked')).toBe(true);
  });

  it('are optional, so a Google-before-text week does not read as "everyone lost at the gate"', () => {
    expect(OPTIONAL_TRIAL_STEPS.has('gate_seen')).toBe(true);
    expect(OPTIONAL_TRIAL_STEPS.has('gate_unlocked')).toBe(true);
  });

  it('report their counts without becoming the baseline for generation_completed', () => {
    // 18 started, 12 saw the gate, 4 unlocked, 15 finished (the Oct-2026 prod shape).
    const rows = buildTrialFunnelRows(new Map([
      ['landing', 30],
      ['generation_started', 18],
      ['gate_seen', 12],
      ['gate_unlocked', 4],
      ['generation_completed', 15],
    ]));
    const row = (step: string) => rows.find((r: any) => r.step === step);
    expect(row('gate_seen')).toMatchObject({ visits: 12, optional: true, droppedFromPrev: 0 });
    expect(row('gate_unlocked')).toMatchObject({ visits: 4, optional: true, droppedFromPrev: 0 });
    // 15 of 18 started, not 15 of 4 unlocked.
    expect(row('generation_completed')).toMatchObject({ visits: 15, pctOfPrev: 83.3, droppedFromPrev: 3 });
  });
});

describe('the waiting page emits both gate steps', () => {
  const page = read('client/src/pages/TrialGenerationPage.tsx');

  it('gate_seen fires from an IntersectionObserver on the sign-in block at the gate, once per mount', () => {
    const at = page.indexOf("trackTrialStep('gate_seen')");
    expect(at).toBeGreaterThan(-1);
    const around = page.slice(at - 700, at + 100);
    expect(around).toContain('new IntersectionObserver(');
    expect(around).toContain('gateSeenFiredRef.current = true');
    // The observed element wraps the sign-in block only while a page is locked.
    expect(page).toMatch(/ref=\{firstLockedIdx >= 0 \? gateRef : undefined\}>\{signInBlock\}/);
  });

  it('gate_unlocked fires on the server-reported unlock in the job-status poll', () => {
    const at = page.indexOf("trackTrialStep('gate_unlocked')");
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(at - 200, at)).toContain('data.unlocked === true');
  });

  it('the admin card has a label for each gate row in every admin language', () => {
    const texts = read('client/src/pages/admin/translations.ts');
    for (const step of ['gate_seen', 'gate_unlocked']) {
      expect(texts.match(new RegExp(`^\\s+${step}: '`, 'gm'))?.length).toBe(3);
    }
  });
});

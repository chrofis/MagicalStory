/**
 * Traffic-source bucketing for the admin trial step funnel
 * (server/lib/trialSource.js).
 *
 * The regression this pins: a Google Ads click whose UTM tags were stripped
 * still carries a gclid (account-level auto-tagging), and until 2026-09-09
 * such a row was bucketed as "direct". The SQL fragment and the JS classifier
 * are asserted side by side so they cannot drift.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  TRIAL_SOURCES,
  trialSourceWhereClause,
  classifyTrialSource,
} = require_('../../server/lib/trialSource');

describe('trial source bucketing', () => {
  it('a gclid-only row (UTMs stripped) is paid, not direct', () => {
    expect(classifyTrialSource({ gclid: 'Cj0KCQjw', utm_source: null, utm_medium: null })).toBe('paid');
  });

  it('tagged paid clicks stay paid', () => {
    expect(classifyTrialSource({ utm_source: 'google', utm_medium: 'search', gclid: null })).toBe('paid');
    expect(classifyTrialSource({ utm_source: 'newsletter', utm_medium: 'cpc', gclid: null })).toBe('paid');
  });

  it('organic = tagged but not paid; direct = nothing at all', () => {
    expect(classifyTrialSource({ utm_source: 'chatgpt.com', utm_medium: 'referral', gclid: null })).toBe('organic');
    expect(classifyTrialSource({ utm_source: null, utm_medium: null, gclid: null })).toBe('direct');
  });

  it('the SQL fragments honour gclid the same way', () => {
    expect(trialSourceWhereClause('all')).toBeNull();
    expect(trialSourceWhereClause('paid')).toContain('gclid IS NOT NULL');
    expect(trialSourceWhereClause('direct')).toContain('gclid IS NULL');
    // organic is "tagged AND NOT paid", so it excludes gclid rows via the paid clause
    expect(trialSourceWhereClause('organic')).toContain('NOT (gclid IS NOT NULL');
  });

  it('rejects unknown sources instead of widening the filter', () => {
    expect(() => trialSourceWhereClause('facebook')).toThrow(/Unknown trial source/);
    expect(TRIAL_SOURCES).toEqual(['all', 'paid', 'organic', 'direct']);
  });
});

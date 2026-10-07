/**
 * Traffic-source bucketing for the admin trial step funnel
 * (server/lib/trialSource.js).
 *
 * Two regressions this pins:
 *  - a Google Ads click whose UTM tags were stripped still carries a gclid
 *    (account-level auto-tagging), and until 2026-09-09 such a row was
 *    bucketed as "direct";
 *  - chatgpt.com sent 5 of 8 trials and was invisible inside "organic" (tagged
 *    links) or "direct" (bare referral) until 2026-10-07, when the assistants
 *    got buckets of their own.
 * The SQL fragment and the JS classifier are asserted side by side so they
 * cannot drift.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  TRIAL_SOURCES,
  ASSISTANT_SOURCES,
  trialSourceWhereClause,
  classifyTrialSource,
} = require_('../../server/lib/trialSource');

const row = (r: Partial<{ utm_source: string | null; utm_medium: string | null; gclid: string | null; referrer: string | null }>) =>
  ({ utm_source: null, utm_medium: null, gclid: null, referrer: null, ...r });

describe('trial source bucketing', () => {
  it('a gclid-only row (UTMs stripped) is paid, not direct', () => {
    expect(classifyTrialSource(row({ gclid: 'Cj0KCQjw' }))).toBe('paid');
  });

  it('tagged paid clicks stay paid', () => {
    expect(classifyTrialSource(row({ utm_source: 'google', utm_medium: 'search' }))).toBe('paid');
    expect(classifyTrialSource(row({ utm_source: 'newsletter', utm_medium: 'cpc' }))).toBe('paid');
  });

  it('organic = tagged but not paid and not an assistant; direct = nothing at all', () => {
    expect(classifyTrialSource(row({ utm_source: 'newsletter', utm_medium: 'email' }))).toBe('organic');
    expect(classifyTrialSource(row({ referrer: 'https://www.reddit.com/r/parenting/' }))).toBe('direct');
    expect(classifyTrialSource(row({}))).toBe('direct');
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
    expect(TRIAL_SOURCES).toEqual(['all', 'paid', 'chatgpt', 'perplexity', 'gemini', 'copilot', 'organic', 'direct']);
  });
});

describe('AI assistants are their own buckets', () => {
  it('ChatGPT by the utm_source it appends to its links', () => {
    expect(classifyTrialSource(row({ utm_source: 'chatgpt.com', utm_medium: 'referral' }))).toBe('chatgpt');
    expect(classifyTrialSource(row({ utm_source: 'chatgpt' }))).toBe('chatgpt');
  });

  it('ChatGPT by referrer alone (an untagged link used to be "direct")', () => {
    expect(classifyTrialSource(row({ referrer: 'https://chatgpt.com/' }))).toBe('chatgpt');
    expect(classifyTrialSource(row({ referrer: 'https://chat.openai.com/c/abc' }))).toBe('chatgpt');
    expect(classifyTrialSource(row({ referrer: 'HTTPS://ChatGPT.com/' }))).toBe('chatgpt');
  });

  it('the host match is anchored: look-alike hosts and paths do not count', () => {
    expect(classifyTrialSource(row({ referrer: 'https://notchatgpt.com/' }))).toBe('direct');
    expect(classifyTrialSource(row({ referrer: 'https://chatgpt.com.evil.example/' }))).toBe('direct');
    expect(classifyTrialSource(row({ referrer: 'https://example.com/?from=chatgpt.com' }))).toBe('direct');
  });

  it('perplexity, gemini (incl. the old bard host) and copilot are analogous', () => {
    expect(classifyTrialSource(row({ referrer: 'https://www.perplexity.ai/search/x' }))).toBe('perplexity');
    expect(classifyTrialSource(row({ utm_source: 'perplexity' }))).toBe('perplexity');
    expect(classifyTrialSource(row({ referrer: 'https://gemini.google.com/app' }))).toBe('gemini');
    expect(classifyTrialSource(row({ referrer: 'https://bard.google.com/' }))).toBe('gemini');
    expect(classifyTrialSource(row({ referrer: 'https://copilot.microsoft.com/' }))).toBe('copilot');
  });

  it('a gemini referral is not "paid" just because the host is under google.com', () => {
    expect(classifyTrialSource(row({ referrer: 'https://gemini.google.com/' }))).toBe('gemini');
    // …but a real paid click pasted into an assistant stays paid.
    expect(classifyTrialSource(row({ gclid: 'Cj0K', referrer: 'https://chatgpt.com/' }))).toBe('paid');
    expect(classifyTrialSource(row({ utm_source: 'chatgpt.com', utm_medium: 'cpc' }))).toBe('paid');
  });

  it('the SQL says the same: assistant buckets test utm_source and an anchored referrer host, organic/direct exclude them', () => {
    const chatgpt = trialSourceWhereClause('chatgpt');
    expect(chatgpt).toContain("utm_source IN ('chatgpt','chatgpt.com','chat.openai.com')");
    expect(chatgpt).toContain("referrer ~* '^https?://([a-z0-9-]+\\.)*(chatgpt\\.com|chat\\.openai\\.com)(/|$)'");
    expect(chatgpt).toContain('AND NOT (gclid IS NOT NULL');
    for (const bucket of Object.keys(ASSISTANT_SOURCES)) {
      expect(trialSourceWhereClause('organic')).toContain(`'${bucket}'`);
      expect(trialSourceWhereClause('direct')).toContain(`'${bucket}'`);
    }
    expect(trialSourceWhereClause('organic')).toMatch(/AND NOT \(\(utm_source IN \('chatgpt'/);
    expect(trialSourceWhereClause('direct')).toMatch(/AND NOT \(\(utm_source IN \('chatgpt'/);
  });

  it('the admin card offers exactly the server buckets', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'AdminDashboard.tsx'), 'utf8');
    const block = src.match(/const ASSISTANT_SOURCE_FILTERS = \[([\s\S]*?)\] as const;/);
    expect(block).not.toBeNull();
    const clientBuckets = [...block![1].matchAll(/\['([a-z]+)',/g)].map((m) => m[1]);
    expect(clientBuckets).toEqual(Object.keys(ASSISTANT_SOURCES));
  });
});

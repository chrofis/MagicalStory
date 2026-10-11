/**
 * Regression (staging job_1791700480532_ul7f67gii): "[ACCOUNTING] anthropic: provider total 17119/6424 != bucket sum 26087/8038".
 * The gap was the trial Flash planner (OpenRouter, 8968/1614) booked under unified_story beside the Anthropic writer; the
 * bucket remembered one provider (the last), so the check summed it into anthropic. Per-provider token sums fix it.
 */
import { describe, it, expect } from 'vitest';
const { newTokenUsage, recordCall, providerBucketDrift } = require('../../server/lib/costLedger');

describe('providerBucketDrift', () => {
  it('a bucket mixing an OpenRouter planner and an Anthropic writer reconciles per provider', () => {
    const t = newTokenUsage();
    recordCall(t, 'openrouter', { input_tokens: 8968, output_tokens: 1614, direct_cost: 0.0128 }, 'unified_story', 'google/gemini-3.7-flash');
    recordCall(t, 'anthropic', { input_tokens: 17119, output_tokens: 6424 }, 'unified_story', 'claude-sonnet-5-5');
    expect(t.byFunction.unified_story.provider).toBe('anthropic');
    expect(providerBucketDrift(t)).toEqual([]);
  });
  it('still reports a real escape: a provider total no bucket holds', () => {
    const t = newTokenUsage();
    recordCall(t, 'anthropic', { input_tokens: 100, output_tokens: 10 }, 'unified_story', 'claude-sonnet-5-5');
    t.anthropic.input_tokens += 500;
    const d = providerBucketDrift(t);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ provider: 'anthropic', providerIn: 600, bucketIn: 100 });
  });
});

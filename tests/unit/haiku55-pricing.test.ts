import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TEXT_MODELS, priceUsage, pricingKnown } = require('../../server/config/models');

describe('Claude Haiku 5.5 registry and pricing', () => {
  it('is a TEXT_MODELS key on the right API id', () => {
    expect(TEXT_MODELS['claude-haiku-5-5'].modelId).toBe('claude-haiku-5-5');
    expect(TEXT_MODELS['claude-haiku-5-5'].provider).toBe('anthropic');
    expect(pricingKnown('claude-haiku-5-5')).toBe(true);
  });
  it('prices a short prompt at 0.10 / 0.50 with cache read 0.01 and write 0.125', () => {
    const usd = priceUsage('claude-haiku-5-5', { input_tokens: 10000, cached_input_tokens: 4000, cache_write_tokens: 2000, output_tokens: 1000 });
    expect(usd).toBeCloseTo((4000 * 0.10 + 4000 * 0.01 + 2000 * 0.125 + 1000 * 0.50) / 1e6, 10);
  });
  it('bills the whole call at the 5x tier once the prompt passes 100k tokens', () => {
    const usd = priceUsage('claude-haiku-5-5', { input_tokens: 150000, output_tokens: 2000 });
    expect(usd).toBeCloseTo((150000 * 0.50 + 2000 * 2.50) / 1e6, 10);
  });
  it('exactly 100k is still the base tier', () => {
    expect(priceUsage('claude-haiku-5-5', { input_tokens: 100000, output_tokens: 0 })).toBeCloseTo(0.01, 10);
  });
});

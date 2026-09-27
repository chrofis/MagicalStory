/**
 * Thinking tokens are billed (2026-09-27). Gemini's `candidatesTokenCount` and
 * xAI's `completion_tokens` both EXCLUDE the model's reasoning, which is billed
 * at the output rate on top — reading only the answer count under-reported the
 * entity check ~5-7x. Every provider usage object is read through
 * server/lib/providerUsage.js; these tests pin the three wire formats (numbers
 * are the measured replies of 2026-09-27), the price that follows from them,
 * the downstream consumers, and that no server file parses a raw usage field
 * itself any more.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const require_ = createRequire(import.meta.url);
const { geminiUsage, xaiUsage, openRouterUsage, sumUsage } = require_('../../server/lib/providerUsage');
const { calculateTextCost } = require_('../../server/config/models');
const JF = require_('../../server/lib/judgeFixtures');

describe('providerUsage normalisers', () => {
  it('Gemini: thoughtsTokenCount is carried as thinking_tokens, separate from output', () => {
    // gemini-2.5-flash, measured: 13 + 1 + 790 = 804 total.
    const u = geminiUsage({ promptTokenCount: 13, candidatesTokenCount: 1, totalTokenCount: 804, thoughtsTokenCount: 790 });
    expect(u).toEqual({ input_tokens: 13, output_tokens: 1, thinking_tokens: 790 });
    expect(u.input_tokens + u.output_tokens + u.thinking_tokens).toBe(804);
  });

  it('xAI: reasoning_tokens sit OUTSIDE completion_tokens and are carried as thinking', () => {
    // grok-4.3, measured: 203 + 1 + 213 = 417 total.
    const u = xaiUsage({ prompt_tokens: 203, completion_tokens: 1, total_tokens: 417, completion_tokens_details: { reasoning_tokens: 213 } });
    expect(u).toEqual({ input_tokens: 203, output_tokens: 1, thinking_tokens: 213 });
    expect(u.input_tokens + u.output_tokens + u.thinking_tokens).toBe(417);
  });

  it('OpenRouter: reasoning is already inside completion_tokens, so it is never billed again', () => {
    const u = openRouterUsage({ prompt_tokens: 100, completion_tokens: 161, completion_tokens_details: { reasoning_tokens: 67 }, prompt_tokens_details: { cached_tokens: 20 } });
    expect(u.output_tokens).toBe(161);
    expect(u.thinking_tokens).toBe(0);
    expect(u.reasoning_tokens).toBe(67);
    expect(u.cached_input_tokens).toBe(20);
  });

  it('a missing usage object reads as zeros, and sumUsage adds thinking like output', () => {
    expect(geminiUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
    expect(sumUsage([geminiUsage({ promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 5 }), null, { input_tokens: 1, output_tokens: 1, thinking_tokens: 1 }]))
      .toEqual({ input_tokens: 11, output_tokens: 3, thinking_tokens: 6 });
  });

  it('the thinking tokens are priced at the output rate on top of the answer', () => {
    const answerOnly = calculateTextCost('gemini-2.5-flash', { input_tokens: 12000, output_tokens: 600 });
    const billed = calculateTextCost('gemini-2.5-flash', geminiUsage({ promptTokenCount: 12000, candidatesTokenCount: 600, thoughtsTokenCount: 3000 }));
    expect(billed - answerOnly).toBeCloseTo(3000 * 2.5 / 1e6, 10);
  });
});

describe('judge-fixture cost estimates read the measured usage, thinking included', () => {
  it('entity: prices report.tokenUsage with its thinking tokens', () => {
    const r = JF.estimateCostUsd('entity', { report: { tokenUsage: { inputTokens: 12000, outputTokens: 600, thinkingTokens: 3000 } } });
    expect(r.basis).toMatch(/measured/);
    expect(r.usd).toBeCloseTo((12000 * 0.30 + 3600 * 2.50) / 1e6, 10);
  });

  it('entity: with no usage returned the flat estimate is labelled as one', () => {
    expect(JF.estimateCostUsd('entity', {}).basis).toMatch(/estimate/);
  });

  it('semantic: input + output + thinking', () => {
    const r = JF.estimateCostUsd('semantic', { usage: { input_tokens: 14000, output_tokens: 800, thinking_tokens: 2000 } });
    expect(r.basis).toMatch(/measured/);
    expect(r.usd).toBeCloseTo((14000 * 0.30 + 2800 * 2.50) / 1e6, 10);
  });

  it('quality: the semantic call already inside the aggregate is not added again as a flat estimate', () => {
    const withSemantic = JF.estimateCostUsd('quality', { totalUsage: { input_tokens: 30000, output_tokens: 3000, thinking_tokens: 1000, semantic_input_tokens: 14000 } });
    expect(withSemantic.usd).toBeCloseTo((30000 * 0.30 + 4000 * 2.50) / 1e6, 10);
    const without = JF.estimateCostUsd('quality', { totalUsage: { input_tokens: 30000, output_tokens: 3000, thinking_tokens: 1000 } });
    expect(without.usd).toBeGreaterThan(withSemantic.usd);
  });
});

describe('no server file parses a provider usage field itself', () => {
  // Raw provider fields may be READ only inside providerUsage.js. A second
  // hand-rolled parser is how the thinking tokens went missing at 20+ sites.
  const RAW = /(\.|\?\.)(candidatesTokenCount|thoughtsTokenCount|promptTokenCount|completion_tokens|prompt_tokens)\b/;
  const root = resolve(__dirname, '../..');
  const files: string[] = [join(root, 'storyJobPipeline.js'), join(root, 'server.js')];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'scripts' && name !== 'node_modules') walk(p); }
      else if (name.endsWith('.js') && !name.endsWith('.test.js')) files.push(p);
    }
  };
  walk(join(root, 'server'));

  it('every raw read lives in providerUsage.js', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(join('lib', 'providerUsage.js'))) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*')) return;
        if (RAW.test(line)) offenders.push(`${relative(root, f)}:${i + 1}: ${t.slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

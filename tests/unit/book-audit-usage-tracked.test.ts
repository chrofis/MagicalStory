import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * The Lab's book_audit stage ran a paid multimodal judge and passed no
 * usageTracker, so bookAudit's `if (usageTracker …)` branch never fired: real
 * spend, zero record. These pin the two halves of the fix.
 */

// 1. bookAudit only reports usage when it is handed a tracker — the behaviour
//    that makes the missing argument a bug rather than a style nit.
describe('auditStoryBook reports spend only through its usageTracker', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/bookAudit.js'), 'utf8');

  it('the tracker call is gated on the tracker existing', () => {
    expect(src).toMatch(/if \(usageTracker && \(usage\.input_tokens \|\| usage\.output_tokens\)\)/);
    expect(src).toMatch(/usageTracker\('gemini_quality', usage, 'book_audit', modelId\)/);
  });
});

// 2. The Lab stage passes one, and surfaces what it collected.
describe('the Lab book_audit stage tracks its spend', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/testlab.js'), 'utf8');
  const stage = src.slice(
    src.indexOf('async function runBookAuditStage'),
    src.indexOf('async function runAuditReplayStage'),
  );

  it('the stage exists and was located', () => {
    expect(stage.length).toBeGreaterThan(200);
  });

  it('hands auditStoryBook a usageTracker', () => {
    expect(stage).toMatch(/usageTracker:/);
  });

  it('reports the collected calls and cost on the stage result, like every other paid stage', () => {
    expect(stage).toMatch(/const usage = \[\]/);
    expect(stage).toMatch(/modelCalls = usage\.length/);
    expect(stage).toMatch(/usage\.reduce\(\(a, u\) => a \+ \(u\.cost \|\| 0\), 0\)/);
    // Both exits — the audit-failed early return too, since a failed audit can
    // still have paid for chunks.
    expect(stage.match(/modelCalls/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('prices a token-only (Gemini native) response instead of recording $0', () => {
    // The collector expression, executed against the real pricing table.
    const { calculateTextCost } = require('../../server/config/models.js');
    const collect = (u: any, mid: string) => u?.cost_usd ?? calculateTextCost(mid || '', u || {});
    // OpenRouter hands back billed dollars verbatim.
    expect(collect({ cost_usd: 0.0123, input_tokens: 10, output_tokens: 2 }, 'whatever')).toBe(0.0123);
    // Gemini native reports tokens only — those must still cost something.
    const priced = collect({ input_tokens: 500000, output_tokens: 50000 }, 'gemini-2.5-flash');
    expect(priced).toBeGreaterThan(0);
  });
});

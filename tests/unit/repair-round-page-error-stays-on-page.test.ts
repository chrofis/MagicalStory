import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// BUG repair-iterate-rejection-kills-story (prod showcase job_1792748239565_nnf6vsk0u, 2026-10-23):
// Gemini refused one page's iterate analysis (PROHIBITED_CONTENT). The round dispatch did
// `return iterateOutcome();` inside its per-page try — a returned, un-awaited promise skips that
// catch, so the rejection reached Promise.all and failed the whole 10-page story while the other
// pages kept repairing. A page's repair error must stay on that page.

describe('repair round: one page failing does not fail the round', () => {
  it('JS: a returned un-awaited promise skips the enclosing catch, `return await` does not', async () => {
    const boom = async () => { throw new Error('blocked'); };
    const withoutAwait = async () => { try { return boom(); } catch (e) { return { error: (e as Error).message }; } };
    const withAwait = async () => { try { return await boom(); } catch (e) { return { error: (e as Error).message }; } };
    await expect(withoutAwait()).rejects.toThrow('blocked');
    await expect(withAwait()).resolves.toEqual({ error: 'blocked' });
  });

  it('the round dispatch awaits every iterateOutcome() it returns', () => {
    const src = readFileSync(resolve(__dirname, '../../server/lib/repairPipeline.js'), 'utf8');
    const calls = src.match(/return\s+(await\s+)?iterateOutcome\(\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c).toMatch(/return\s+await\s+iterateOutcome\(\)/);
  });
});

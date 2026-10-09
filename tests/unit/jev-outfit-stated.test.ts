/**
 * Does the scene prose dress each character in their contract outfit? Jev decides
 * (decideOutfitsStated); clothingCheck.missingGarments, a token match, is gone.
 *
 * The old check was blind for every comma-list costume: its accessory filter dropped a whole
 * clause that held a belt/hat/cap word ("... brown leather boots, plain brown sword belt, no
 * helmet, bare head"), so knight, wizard and pirate pages with NO outfit in the prose passed,
 * while it flagged pages that did state the outfit (a missing "white cotton socks").
 * Measured on 138 hand-read stored pages (90 outfit missing, 48 stated): the old check caught
 * 14/90 and flagged 21/48 stated; Jev (this question, P(contract outfit) < 0.3) caught 90/90
 * and flagged 9/48 (docs/decisions.md 2026-10-09 "The clothing check goes to Jev").
 * The answers below are real stored Jev answers (probabilities of the first option).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const JD = require_('../../server/lib/jevDecisions');

const ans = (s0: number) => ({ type: 'choice', choice: s0 >= 0.5 ? 's0' : 's2', probabilities: { s0, s1: 0, s2: 1 - s0 }, confidence: 1 });
const KNIGHT = 'Silver chain mail tunic over a grey padded gambeson, brown leather bracers, dark brown leather boots, plain brown sword belt, no helmet, bare head';
const SWEATER = 'A green crew-neck pullover sweater, orange corduroy trousers, and grey velcro-strap sneakers.';

function fakeCall(probs: number[]) {
  const seen: any[] = [];
  const callImpl = async (req: any) => {
    seen.push(req);
    return { answers: Object.fromEntries(probs.map((p, i) => [`Q${i}`, ans(p)])), cost: 0.00002, usage: {}, model: 'jev-test' };
  };
  return { callImpl, seen };
}

describe('decideOutfitsStated', () => {
  it('flags the figure whose outfit the prose never states, in ONE call for the page', async () => {
    // real answers: a knight page with no outfit words (P 0.0) and a pullover page that names it (P 1.0)
    const { callImpl, seen } = fakeCall([0.0, 1.0]);
    const r = await JD.decideOutfitsStated({
      prose: 'Emma holds the wooden sword out to the gatekeeper. Max, in his green pullover, orange corduroy trousers and grey velcro-strap sneakers, waits.',
      figures: [{ name: 'Emma', outfit: KNIGHT }, { name: 'Max', outfit: SWEATER }],
    }, { callImpl });
    expect(r.missing).toEqual(['Emma']);
    expect(r.stated.Max).toBe(1);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].questions)).toEqual(['Q0', 'Q1']);
  });

  it('asks the outfit as a choice: the contract outfit / other clothing / nothing said', async () => {
    const { callImpl, seen } = fakeCall([0.5]);
    await JD.decideOutfitsStated({ prose: 'A page.', figures: [{ name: 'Emma', outfit: KNIGHT }] }, { callImpl });
    const q = seen[0].questions.Q0;
    expect(q.type).toBe('choice');
    expect(q.instructions).toContain('Emma');
    expect(q.criteria.s0).toContain(KNIGHT);
    expect(Object.keys(q.criteria)).toEqual(['s0', 's1', 's2']);
    expect(seen[0].state).toBe('A page.');
  });

  it('an over-the-shoulder crop owes the upper garment only', async () => {
    const { callImpl, seen } = fakeCall([0.9]);
    await JD.decideOutfitsStated({ prose: 'A page.', figures: [{ name: 'Levin', outfit: SWEATER, upperOnly: true }] }, { callImpl });
    expect(seen[0].questions.Q0.criteria.s0).toMatch(/^the upper garment of this outfit/);
  });

  it('the threshold: 0.29 is not stated, 0.30 is', async () => {
    const { callImpl } = fakeCall([0.29, 0.3]);
    const r = await JD.decideOutfitsStated({ prose: 'p', figures: [{ name: 'A', outfit: 'x' }, { name: 'B', outfit: 'y' }] }, { callImpl });
    expect(r.missing).toEqual(['A']);
  });

  it('asks nothing without prose or figures', async () => {
    const { callImpl, seen } = fakeCall([]);
    expect((await JD.decideOutfitsStated({ prose: '  ', figures: [{ name: 'A', outfit: 'x' }] }, { callImpl })).missing).toEqual([]);
    expect((await JD.decideOutfitsStated({ prose: 'p', figures: [] }, { callImpl })).missing).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('an answer without the first option\'s probability fails loudly', async () => {
    const callImpl = async () => ({ answers: { Q0: { type: 'choice', choice: 's0' } }, cost: 0, usage: {}, model: 'jev-test' });
    await expect(JD.decideOutfitsStated({ prose: 'p', figures: [{ name: 'A', outfit: 'x' }] }, { callImpl })).rejects.toThrow(/no probability/);
  });
});

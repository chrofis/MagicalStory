import { describe, it, expect } from 'vitest';

// Kept from the reverted deed-source commit c3590467b (owner 2026-11-09: revert the deed rule, keep this piece):
// Jev's group cut never removes the main character from a page where it scored them needed (stored essbvehs8 p3).
const JD = require('../../server/lib/jevDecisions');
const SV = require('../../server/lib/shotVocabulary');

describe('decideGroupCuts: the main character, needed in the instant, is never cut', () => {
  const KIDS = ['Emma', 'Daniel', 'Sarah', 'Hans'];
  const P = SV.PLAN_SHOT_PLACEHOLDER;
  const pages = [1, 2, 3].map(n => ({ pageNumber: n, planLine: `${P} — ${n === 3 ? KIDS.join(', ') : 'Emma'} — they do thing ${n} — change ${n}` }));
  const present = new Map<number, string[]>([[1, ['Emma']], [2, ['Emma']], [3, [...KIDS]]]);
  const stub = (needed: Record<string, number>) => async ({ state, questions }: any) => {
    const page = Number((state.match(/PAGE TO JUDGE: Page (\d+)/) || [])[1]);
    const answers: any = {};
    for (const [id, q] of Object.entries<any>(questions)) {
      const who = (q.instructions.match(/^(\S+) is needed/) || [])[1];
      answers[id] = { noul: /brings the whole group together/.test(q.instructions) ? 0.1 : (needed[who] ?? 0.5) };
    }
    void page;
    return { answers, cost: 0, model: 'stub', usage: {} };
  };
  // The CAST block promises the three friends on page 3 (as on the stored essbvehs8 p3), so only the main is cuttable.
  const castTable = { characters: [{ name: 'Daniel', deedPage: 3, alsoOn: [] }, { name: 'Sarah', deedPage: 3, alsoOn: [] }, { name: 'Hans', deedPage: 3, alsoOn: [] }], ending: null };
  const decide = (mainNames: string[]) => JD.decideGroupCuts({ arc: 'A', pages, present, groupPages: [3], budget: 0, mainNames, castTable },
    { callImpl: stub({ Emma: 0.61, Hans: 0.59, Sarah: 0.27, Daniel: 0.21 }) });
  it('without the rule the trim to the staging maximum dropped her (stored essbvehs8 p3); now she is required and the page keeps its group', async () => {
    const d = await decide(['Emma']);
    const p3 = d.decisions.find((x: any) => x.pageNumber === 3);
    expect(p3.required.Emma).toBe('the main character, needed in this instant');
    expect(p3.remove || []).not.toContain('Emma');
    expect(p3.unsatisfiable || p3.keep).toBeTruthy();
  });
  it('a main character the instant does not need can still be cut', async () => {
    const d = await JD.decideGroupCuts({ arc: 'A', pages, present, groupPages: [3], budget: 0, mainNames: ['Emma'], castTable },
      { callImpl: stub({ Emma: 0.1, Hans: 0.59, Sarah: 0.27, Daniel: 0.21 }) });
    const p3 = d.decisions.find((x: any) => x.pageNumber === 3);
    expect(p3.required.Emma).toBeUndefined();
    expect(p3.remove).toContain('Emma');
  });
  it('a friend scored needed is not made "required" by that rule', async () => {
    const d = await decide([]);
    const p3 = d.decisions.find((x: any) => x.pageNumber === 3);
    expect(p3.required.Emma).toBeUndefined();
  });
});

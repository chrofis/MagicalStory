/**
 * THE JEV DECISION LAYER, Part 2 — group-page cast cuts (owner, 2026-09-27).
 * Jev ranks the group pages (TOGETHER) and scores who each page needs
 * (NEEDED); code keeps the budget, cuts, restores for the constraints and
 * writes the who column; the re-planner only re-words the instant, and a
 * rewrite that still names a removed character is rejected, never patched.
 * Pins behaviour, never question wording.
 * see docs/decisions.md 2026-09-27 "Jev decision layer wired, Part 2"
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const JD = req('../../server/lib/jevDecisions');
const SV = req('../../server/lib/shotVocabulary');
const PB = req('../../server/lib/promptBuilders');
const BP = req('../../server/lib/beatsPipeline');
const textModelsMod = req('../../server/lib/textModels');
const jevAuditMod = req('../../server/lib/jevAudit');
const { loadPromptTemplates } = req('../../server/services/prompts');

const P = SV.PLAN_SHOT_PLACEHOLDER;
const KIDS = ['Ana', 'Ben', 'Cy', 'Dee'];

/** A stub Jev: TOGETHER by the page the state marks, NEEDED by the name the question carries. */
function cutJev(together: Record<number, number>, needed: Record<string, number>) {
  const calls: any[] = [];
  const impl = async ({ state, questions }: any) => {
    calls.push({ state, questions });
    const page = Number((state.match(/PAGE TO JUDGE: Page (\d+)/) || [])[1]);
    const answers: any = {};
    for (const [id, q] of Object.entries<any>(questions)) {
      const who = (q.instructions.match(/^(\S+) is needed/) || [])[1];
      answers[id] = { noul: /brings the whole group together/.test(q.instructions) ? (together[page] ?? 0.5) : (needed[who] ?? 0.5) };
    }
    return { answers, cost: 0, model: 'stub', usage: {} };
  };
  return { impl, calls };
}

const groupBook = () => {
  const pages = [1, 2, 3, 4, 5, 6].map(n => ({ pageNumber: n, planLine: `${P} — ${[1, 3, 6].includes(n) ? 'Ana, Ben, Cy and Dee' : 'Ana and Ben'} — they do thing ${n} — change ${n}` }));
  const present = new Map(pages.map(p => [p.pageNumber, [1, 3, 6].includes(p.pageNumber) ? [...KIDS] : ['Ana', 'Ben']]));
  return { pages, present };
};
const SCORES = { together: { 1: 0.5, 3: 0.2, 6: 0.9 }, needed: { Ana: 0.9, Ben: 0.8, Cy: 0.2, Dee: 0.1 } };

describe('decideGroupCuts: Jev ranks and scores, code cuts and restores', () => {
  it('keeps the top-TOGETHER pages inside the budget and cuts every name below 0.5 elsewhere', async () => {
    const { pages, present } = groupBook();
    const d = await JD.decideGroupCuts({ arc: 'A', pages, present, groupPages: [1, 3, 6], budget: 1 }, { callImpl: cutJev(SCORES.together, SCORES.needed).impl });
    expect(d.keepGroup).toEqual([6]);
    const cut = d.decisions.filter((x: any) => x.remove);
    expect(cut.map((x: any) => x.pageNumber)).toEqual([1, 3]);
    for (const x of cut) { expect(x.keep).toEqual(['Ana', 'Ben']); expect(x.remove).toEqual(['Cy', 'Dee']); }
  });

  it('puts back a character the cut would take under the coverage floor, and the obstacle holder', async () => {
    const { pages, present } = groupBook();
    const d = await JD.decideGroupCuts({ arc: 'A', pages, present, groupPages: [1, 3, 6], budget: 1,
      listed: KIDS, floor: 3, obstacles: new Map([[3, ['Dee']]]) }, { callImpl: cutJev(SCORES.together, SCORES.needed).impl });
    const p1 = d.decisions.find((x: any) => x.pageNumber === 1);
    const p3 = d.decisions.find((x: any) => x.pageNumber === 3);
    expect(p1.required.Cy).toMatch(/below 3/);
    expect(p1.keep.length).toBeLessThanOrEqual(SV.GROUP_STAGING_MAX);
    expect(p3.required.Dee).toMatch(/works against/);
    expect(p3.keep).toContain('Dee');
  });

  it('never cuts a character the CAST block promises on that page (deed, also on, ending)', async () => {
    const { pages, present } = groupBook();
    const castTable = { characters: [{ name: 'Cy', deedPage: 9, alsoOn: [3] }, { name: 'Dee', deedPage: 1, alsoOn: [] }], ending: { page: 6, names: KIDS } };
    const d = await JD.decideGroupCuts({ arc: 'A', pages, present, groupPages: [1, 3, 6], budget: 1, castTable },
      { callImpl: cutJev(SCORES.together, SCORES.needed).impl });
    const p1 = d.decisions.find((x: any) => x.pageNumber === 1);
    const p3 = d.decisions.find((x: any) => x.pageNumber === 3);
    expect(p1.keep).toContain('Dee');
    expect(p3.keep).toContain('Cy');
    expect(p3.required.Cy).toMatch(/promises/);
  });

  it('the CAST CUT line says the cast-out stay in the story, only outside the picture', () => {
    const f = JD.castCutFindings({ decisions: [{ pageNumber: 3, keep: ['Ana'], remove: ['Cy'] }] });
    expect(f[0].line).toContain(JD.CUT_STILL_IN_STORY);
  });

  it('never empties a page — the highest-scored name stays', async () => {
    const { pages, present } = groupBook();
    const d = await JD.decideGroupCuts({ arc: 'A', pages, present, groupPages: [1, 3, 6], budget: 1 },
      { callImpl: cutJev(SCORES.together, { Ana: 0.4, Ben: 0.3, Cy: 0.2, Dee: 0.1 }).impl });
    for (const x of d.decisions.filter((y: any) => y.remove)) expect(x.keep).toEqual(['Ana']);
  });

  it('reports a page whose required names alone exceed three, and cuts nothing there', async () => {
    const { pages, present } = groupBook();
    const d = await JD.decideGroupCuts({ arc: 'A', pages, present, groupPages: [1, 3, 6], budget: 1, obstacles: new Map([[3, KIDS]]) },
      { callImpl: cutJev(SCORES.together, { Ana: 0.1, Ben: 0.1, Cy: 0.1, Dee: 0.1 }).impl });
    const p3 = d.decisions.find((x: any) => x.pageNumber === 3);
    expect(p3.unsatisfiable).toMatch(/keeps its group/);
    expect(p3.remove).toBeUndefined();
  });

  it('averages three calls per decision (the cut decisions flip 3-5% per single call)', async () => {
    const { pages, present } = groupBook();
    const { impl, calls } = cutJev(SCORES.together, SCORES.needed);
    await JD.decideGroupCuts({ arc: 'A', pages, present, groupPages: [1, 3, 6], budget: 1 }, { callImpl: impl });
    expect(calls.length).toBe(3 * 3 + 2 * 4 * 3); // TOGETHER on 3 pages, NEEDED for 4 names on 2 pages, ×3
  });

  it('turns each cut into a must-fix CAST CUT instruction naming who stays and who leaves', () => {
    const f = JD.castCutFindings({ decisions: [{ pageNumber: 3, keep: ['Ana', 'Ben'], remove: ['Cy', 'Dee'] }, { pageNumber: 6, keepsGroup: true }] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ code: 'GROUP_PAGES_OVER_BUDGET', pages: [3], castCut: { keep: ['Ana', 'Ben'], remove: ['Cy', 'Dee'] } });
    expect(PB.replanRank(f[0])).toBe('must');
  });
});

describe('runReplanRounds: code writes the who column; a rewrite naming a removed character is rejected', () => {
  it('applies the clean cut and rejects the dirty one', async () => {
    await loadPromptTemplates();
    const { pages } = groupBook();
    const castPerPage = pages.map(p => ({ pageNumber: p.pageNumber, names: [1, 3, 6].includes(p.pageNumber) ? [...KIDS] : ['Ana', 'Ben'] }));
    const check = (findings: any[]) => ({
      findings, lines: findings.map(f => f.line), modelFindings: [], obstacles: new Map(), wanted: [], actions: [], reply: '', rosterLines: [], prompt: '',
      counters: { lines: findings.map(f => f.line), findings: findings.map(f => ({ code: f.code, pages: [] })), cast: { all: KIDS, aliases: {} },
        stats: { castPerPage, groupPages: { pages: [1, 3, 6], budget: 1 }, focalPages: {}, mainCharacter: 'Ana' } },
    });
    const check1 = check([{ kind: 'counter', code: 'GROUP_PAGES_OVER_BUDGET', line: 'PLAN[GROUP_PAGES_OVER_BUDGET] page 1, 3, 6: 3 pages hold more than three' }]);
    const REPLY = [
      '---PAGE PLAN---',
      `Page 1: ${P} — Ana, Ben — Ana and Ben lift the gate while Cy watches — the gate is open`,
      `Page 3: ${P} — Ana, Ben — Ana hands Ben the key — Ben has the key`,
    ].join('\n');
    const saved = textModelsMod.callTextModelStreaming;
    const savedJev = jevAuditMod.callJev;
    let replanPrompt = '';
    textModelsMod.callTextModelStreaming = async (prompt: string) => { replanPrompt = prompt; return { text: REPLY, modelId: 'stub', usage: {} }; };
    jevAuditMod.callJev = cutJev(SCORES.together, SCORES.needed).impl;
    const errors: string[] = [];
    const gl = { info() {}, warn() {}, debug() {}, error: (e: string) => errors.push(e) };
    const jevReport: any = { castCuts: [] };
    try {
      const out = await BP.runReplanRounds({
        inputData: { characters: KIDS.map(n => ({ name: n })), language: 'en', pages: 6 }, pageCount: 6, plan: { pages }, check1, replanRounds: [],
        approvedArc: 'A', arcHints: '', arcStoryLogic: '', arcCentralFigure: null, castTable: null,
        commission: { listed: ['Ana', 'Ben'], all: KIDS }, commissionedNames: KIDS, maxCast: 6, planModel: 'stub',
        readPlan: BP.makePlanReader([1, 2, 3, 4, 5, 6], 'A'), runCheck: async () => check([]), onChunk: null, gl,
        stage: async () => {}, checkCancellation: async () => {}, beats: pages,
        pagePlan: pages.map(p => `Page ${p.pageNumber}: ${p.planLine}`).join('\n'), jevReport,
      });
      const line = (n: number) => out.beats.find((b: any) => b.pageNumber === n).planLine;
      expect(line(3)).toBe(`${P} — Ana and Ben — Ana hands Ben the key — Ben has the key`); // code wrote the who column
      expect(line(1)).toBe(pages[0].planLine);                                             // rejected: stands as it was
      expect(errors).toContain('beats_jev_cast_cut_rejected');
      expect(jevReport.castCuts[0].applied.rejected.map((r: any) => r.pageNumber)).toEqual([1]);
      expect(replanPrompt).toContain('CAST CUT');
      expect(replanPrompt).toContain('A CAST CUT line is already decided');
    } finally {
      textModelsMod.callTextModelStreaming = saved;
      jevAuditMod.callJev = savedJev;
    }
  });

  it('a Jev failure in the cut fails the step — the first division never ships in its place', async () => {
    await loadPromptTemplates();
    const { pages } = groupBook();
    const castPerPage = pages.map(p => ({ pageNumber: p.pageNumber, names: [1, 3, 6].includes(p.pageNumber) ? [...KIDS] : ['Ana', 'Ben'] }));
    const check1 = {
      findings: [{ kind: 'counter', code: 'GROUP_PAGES_OVER_BUDGET', line: 'PLAN[GROUP_PAGES_OVER_BUDGET] page 1, 3, 6: x' }], lines: ['x'], modelFindings: [],
      obstacles: new Map(), wanted: [], actions: [],
      counters: { lines: ['x'], findings: [], cast: { all: KIDS, aliases: {} }, stats: { castPerPage, groupPages: { pages: [1, 3, 6], budget: 1 }, focalPages: {} } },
    };
    const savedJev = jevAuditMod.callJev;
    jevAuditMod.callJev = async () => { throw new Error('jevAudit: reply lacks answers for TOGETHER'); };
    try {
      await expect(BP.runReplanRounds({
        inputData: { characters: KIDS.map(n => ({ name: n })), language: 'en', pages: 6 }, pageCount: 6, plan: { pages }, check1, replanRounds: [],
        approvedArc: 'A', arcHints: '', arcStoryLogic: '', arcCentralFigure: null, castTable: null,
        commission: { listed: ['Ana', 'Ben'], all: KIDS }, commissionedNames: KIDS, maxCast: 6, planModel: 'stub',
        readPlan: BP.makePlanReader([1, 2, 3, 4, 5, 6], 'A'), runCheck: async () => check1, onChunk: null,
        gl: { info() {}, warn() {}, debug() {}, error() {} }, stage: async () => {}, checkCancellation: async () => {}, beats: pages, pagePlan: '', jevReport: { castCuts: [] },
      })).rejects.toThrow(JD.JevDecisionError);
    } finally {
      jevAuditMod.callJev = savedJev;
    }
  });
});

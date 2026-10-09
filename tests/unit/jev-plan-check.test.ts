/**
 * PLAN-CHECK Q10 (heights) AND Q17 (whole cast) ARE JEV'S, NOT THE CHECKER'S (2026-10-09).
 *
 * docs/decisions.md 2026-10-09 "Jev stays an added reviewer; only plan-check Q10 (heights) and Q17
 * (whole cast) move to Jev". Pins, on division shapes read off the stored staging plans (generic
 * names, same four-field lines, same ROSTER shape):
 *   - jevPlanCheck asks the measured wordings, per page, and applies the measured thresholds;
 *   - its findings have exactly the shape a parsed checker finding has for those checks, so the
 *     counters, the re-plan ranking and the convergence guard treat them identically;
 *   - the checker prompt no longer asks 10 and 17 (numbering of the others is stable);
 *   - createPlanCheckRunner runs Jev IN PARALLEL with the checker call, on the check, the recheck and
 *     the salvage check alike, and a Jev outage follows the existing policy (no silent LLM fallback).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PB = require('../../server/lib/promptBuilders');
const JPC = require('../../server/lib/jevPlanCheck');
const JD = require('../../server/lib/jevDecisions');
const jevAudit = require('../../server/lib/jevAudit');
const textModels = require('../../server/lib/textModels');
const BP = require('../../server/lib/beatsPipeline');
const { loadPromptTemplates } = require('../../server/services/prompts');

const realStreaming = textModels.callTextModelStreaming;
const realJev = jevAudit.callJev;
const realWait = JD.JEV_OUTAGE.waitMs;
afterEach(() => { textModels.callTextModelStreaming = realStreaming; jevAudit.callJev = realJev; JD.JEV_OUTAGE.waitMs = realWait; });
beforeAll(async () => { await loadPromptTemplates(); });

const NAMES = ['Mara', 'Tomas', 'Ines', 'Paul'];
// Six pages shaped like the stored divisions: placeholder shot, who, instant, what is true after.
const LINES: Record<number, string> = {
  1: 'SHOT — Mara, Tomas — Mara hands Tomas the rope at the foot of the cliff — the rope is tied',
  2: 'SHOT — Ines, Paul — Ines climbs the ladder while Paul holds the foot and a bird sits on the roof above — the ladder is steady',
  3: 'SHOT — Mara, Tomas, Ines and Paul — the four stand together on the shore and look at the sea — they are at the shore',
  4: 'SHOT — Mara, Tomas, Ines and Paul — the four haul the boat up the beach with one rope — the boat is on the sand',
  5: 'SHOT — Tomas — Tomas lifts the lantern and shouts — the lantern is lit',
  6: 'SHOT — Mara — Mara looks at the harbour — nothing',
};
const pages = Object.entries(LINES).map(([n, planLine]) => ({ pageNumber: Number(n), planLine }));
const rosterOf = (map: Record<number, string[]>) => new Map(Object.entries(map).map(([n, people]) => [Number(n), { people, covers: [], things: [], unlisted: [] }]));

/** Jev stub: heights high on the ladder page, "no shared action" on the standing page. */
function jevStub(log: any[] = []) {
  return async (req: any) => {
    log.push(req);
    const answers: any = {};
    for (const [id, q] of Object.entries<any>(req.questions)) {
      const ins = String(q.instructions);
      let v = 0.05;
      if (/three or more different heights/.test(ins)) v = /ladder/.test(req.state) ? 0.92 : 0.1;
      else if (/one and the same action, by this rule/.test(ins)) v = /stand together/.test(req.state) ? 0.1 : 0.9; // virtue
      else if (/only stand, gather or are shown together/.test(ins)) v = /stand together/.test(req.state) ? 0.9 : 0.1; // fault
      answers[id] = { noul: v };
    }
    return { answers, cost: 0.00003, model: 'stub', usage: {} };
  };
}

describe('jevPlanCheck: the measured questions, per page', () => {
  it('asks Q10 on every page with the labelled three-field state, and Q17 as the virtue/fault pair on every page of a multi-character cast', async () => {
    const log: any[] = [];
    const r = await JPC.askPlanCheckJev({ pages, commissionedNames: NAMES, callImpl: jevStub(log) });
    const q10 = log.filter(c => /three or more different heights/.test(c.questions.Q.instructions));
    expect(q10).toHaveLength(6);
    expect(q10[0].questions.Q.instructions).toBe(`In the instant, people, animals or objects stand at three or more different heights. ${PB.TWO_HEIGHTS_DEF}`);
    const p2 = q10.find(c => /ladder/.test(c.state));
    expect(p2.state).toBe('WHO IS IN FRAME: Ines, Paul\nTHE INSTANT THE PICTURE SHOWS: Ines climbs the ladder while Paul holds the foot and a bird sits on the roof above\nWHAT IS TRUE AFTER THIS PAGE: the ladder is steady');
    const virtue = log.filter(c => c.questions.Q.instructions.startsWith('The instant gives every character in frame one and the same action'));
    const fault = log.filter(c => c.questions.Q.instructions.startsWith('In the instant, the characters in frame only stand'));
    expect(virtue).toHaveLength(6);
    expect(fault).toHaveLength(6);
    expect(virtue[0].questions.Q.instructions).toContain(PB.WHOLE_CAST_DEF);
    // The state never shows the shot field it has not chosen yet.
    expect(virtue[0].state).not.toMatch(/SHOT/);
    expect(r.heights.get(2)).toBeCloseTo(0.92);
    expect(r.whole.get(3)).toBeCloseTo(0.9);   // ((1 - 0.1) + 0.9) / 2
    expect(r.whole.get(4)).toBeCloseTo(0.1);
  });

  it('asks no whole-cast question of a one-character cast', async () => {
    const log: any[] = [];
    const r = await JPC.askPlanCheckJev({ pages, commissionedNames: ['Mara'], callImpl: jevStub(log) });
    expect(log).toHaveLength(6);
    expect(r.whole.size).toBe(0);
  });

  it('reports a page without four fields as skipped instead of judging it', async () => {
    const r = await JPC.askPlanCheckJev({ pages: [...pages, { pageNumber: 7, planLine: 'Mara runs' }], commissionedNames: NAMES, callImpl: jevStub() });
    expect(r.skipped).toEqual([7]);
    expect(r.heights.has(7)).toBe(false);
  });
});

describe('jevPlanCheck: findings in the checker finding shape', () => {
  const scores = { heights: new Map([[1, 0.2], [2, 0.92], [5, 0.69]]), whole: new Map([[3, 0.9], [4, 0.1], [1, 0.9]]) };
  const roster = rosterOf({ 1: ['Mara', 'Tomas'], 2: ['Ines', 'Paul'], 3: NAMES, 4: NAMES, 5: ['Tomas'] });

  it('flags heights at 0.7 and the whole-cast fault at 0.5, only on a page whose ROSTER holds every commissioned name', () => {
    const { findings } = JPC.planCheckJevFindings({ scores, roster, commissionedNames: NAMES });
    expect(findings.map((f: any) => [f.check, PB.findingPages(f.text)])).toEqual([[10, [2]], [17, [3]]]);
    // p1 scored 0.9 as a fault but its roster holds two of four: not a whole-cast page, so no Q17 finding.
    expect(findings.some((f: any) => f.check === 17 && PB.findingPages(f.text).includes(1))).toBe(false);
  });

  it('has exactly the keys of a parsed checker finding, and the same ranks', () => {
    const { findings } = JPC.planCheckJevFindings({ scores, roster, commissionedNames: NAMES });
    const parsed = PB.parsePlanCheck('10. Page 2: three heights.\n17 Page 3: no shared action.');
    for (const f of findings) {
      expect(Object.keys(f).filter(k => k !== 'jev').sort()).toEqual(Object.keys(parsed[0]).sort());
      expect(typeof f.text).toBe('string');
      expect(f.text).toMatch(/^Page \d+:/);
    }
    expect(PB.replanRank({ kind: 'check', check: findings[0].check })).toBe('also');
    expect(PB.replanRank({ kind: 'check', check: findings[1].check })).toBe('must');
    // The score rides on the finding for the report, never in its line.
    expect(findings[0].jev.score).toBeCloseTo(0.92);
    expect(findings[0].text).not.toMatch(/0\.92/);
  });

  it('holds no Q17 finding when the checker gave no roster', () => {
    const { findings } = JPC.planCheckJevFindings({ scores, roster: null, commissionedNames: NAMES });
    expect(findings.map((f: any) => f.check)).toEqual([10]);
  });
});

describe('jevPlanCheck: an outage throws JevDecisionError (the existing Jev policy)', () => {
  it('after the wait', async () => {
    JD.JEV_OUTAGE.waitMs = 20;
    await expect(JPC.askPlanCheckJev({ pages, commissionedNames: NAMES, callImpl: async () => { throw new Error('HTTP 503'); } })).rejects.toBeInstanceOf(JD.JevDecisionError);
  });
});

describe('the checker prompt no longer asks 10 and 17, and keeps the other numbers', () => {
  const inputData: any = { title: 't', characters: NAMES.map((name, i) => ({ id: `c${i}`, name, age: 7, gender: 'female' })), mainCharacters: ['c0'], language: 'en', languageLevel: 'medium', pages: 6, storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor' };
  const planText = pages.map(p => `Page ${p.pageNumber}: ${p.planLine}`).join('\n');
  const nums = (p: string) => [...p.split('# YOUR TASK')[1].split('# OUTPUT FORMAT')[0].matchAll(/^(\d+)\.\s+\S/gm)].map(m => Number(m[1]));

  it('numbers 1-9, 11-13, 15, 16, 18 (14 retired with the shot word, 10 and 17 with this change)', () => {
    const prompt = PB.buildPlanCheckPrompt(inputData, pages, 'An arc.', planText);
    expect(nums(prompt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 15, 16, 18]);
    expect(prompt).toMatch(/only on the fifteen points below/);
    expect(prompt).toMatch(/Answer only these fifteen:/);
    expect(prompt).not.toContain(PB.TWO_HEIGHTS_DEF);
    expect(prompt).not.toContain(PB.WHOLE_CAST_DEF);
    expect(prompt).not.toMatch(/^10\. Heights/m);
    expect(prompt).not.toMatch(/^17\. The whole cast/m);
  });

  it('the backup (legacy shots) prompt asks sixteen', () => {
    const prompt = PB.buildPlanCheckPrompt(inputData, pages, 'An arc.', planText, { legacyShots: true });
    expect(nums(prompt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 18]);
    expect(prompt).toMatch(/Answer only these sixteen:/);
  });
});

// ───────────────────────── the runner ─────────────────────────

const gl = () => { const ev: any[] = []; return { ev, info: (k: string, m: string, _x: any, d: any) => ev.push({ level: 'info', k, m, d }), warn: (k: string, m: string, _x: any, d: any) => ev.push({ level: 'warn', k, m, d }), error: (k: string, m: string, _x: any, d: any) => ev.push({ level: 'error', k, m, d }), debug() {} }; };
const ROSTER_REPLY = ['ROSTER 1: people = Mara, Tomas', 'ROSTER 2: people = Ines, Paul', 'ROSTER 3: people = Mara, Tomas, Ines, Paul', 'ROSTER 4: people = Mara, Tomas, Ines, Paul', 'ROSTER 5: people = Tomas', 'ROSTER 6: people = Mara'].join('\n');
const inputData: any = { language: 'en', languageLevel: 'standard', ageRange: '6-8', pages: 6, storyType: 'adventure', coverTypes: [], characters: NAMES.map((name, i) => ({ id: i + 1, name, age: 7, gender: i % 2 ? 'male' : 'female', ...(i === 0 ? { isMainCharacter: true } : {}) })) };
const planText = pages.map(p => `Page ${p.pageNumber}: ${p.planLine}`).join('\n');

function runner(extra: any = {}, onChecker?: () => Promise<string>) {
  const g = gl();
  textModels.callTextModelStreaming = async (_p: string, _m: any, _c: any, model: string) => {
    const body = onChecker ? await onChecker() : `${ROSTER_REPLY}\n5. Page 5: the lantern line is odd.`;
    return { text: body, modelId: `stub-${model}`, usage: { output_tokens: 5 }, truncation: null };
  };
  const inputs = BP.planCheckInputs(inputData, { arcPremiseNames: [], modelOverrides: {} });
  const run = BP.createPlanCheckRunner({ inputData, approvedArc: 'An arc.', arcHints: '', arcStoryLogic: '', arcCentralFigure: null, castTable: null, ...inputs, arcInventedNames: [], arcInventedLimit: 0, mainName: 'Mara', onChunk: null, gl: g, ...extra });
  return { run, g };
}

describe('createPlanCheckRunner: Jev answers 10 and 17, in parallel with the checker', () => {
  it('merges the Jev findings into the checker findings in check order, as CHECK[n] lines the guard reads', async () => {
    jevAudit.callJev = jevStub();
    const { run } = runner({ jevReport: { castCuts: [], shots: null } });
    const c = await run('plan_check', pages, planText);
    expect(c.modelFindings.map((f: any) => f.check)).toEqual([5, 10, 17]);
    expect(c.findings.filter((f: any) => f.kind === 'check').map((f: any) => f.line.slice(0, 11))).toEqual(['CHECK[5]: P', 'CHECK[10]: ', 'CHECK[17]: ']);
    const mustFix = c.findings.filter((f: any) => f.kind === 'check' && PB.replanRank(f) === 'must');
    expect(mustFix.map((f: any) => f.check)).toEqual([17]);
    expect(c.jev.stats.calls).toBe(18);        // 6 pages x (1 heights + 2 whole-cast)
  });

  it('asks Jev while the checker call is still in flight (no added wall clock)', async () => {
    let jevSeen: () => void; const seen = new Promise<void>(res => { jevSeen = res; });
    const stub = jevStub();
    jevAudit.callJev = async (req: any) => { jevSeen(); return stub(req); };
    // The checker waits for Jev's first call; if Jev ran after the checker this times out and the test fails.
    const { run } = runner({ jevReport: { castCuts: [], shots: null } }, async () => {
      await Promise.race([seen, new Promise((_, rej) => setTimeout(() => rej(new Error('Jev was not asked while the checker ran')), 1500))]);
      return ROSTER_REPLY;
    });
    const c = await run('plan_recheck', pages, planText);
    expect(c.modelFindings.map((f: any) => f.check)).toEqual([10, 17]);
  });

  it('drops a 10 or 17 line the checker volunteers: one judge per rule', async () => {
    // every page clean: heights low, "one shared action" high, "only stand" low
    jevAudit.callJev = async (req: any) => ({ answers: Object.fromEntries(Object.entries<any>(req.questions).map(([k, q]) => [k, { noul: /one and the same action/.test(q.instructions) ? 0.95 : 0.02 }])), cost: 0, model: 's', usage: {} });
    const { run, g } = runner({ jevReport: { castCuts: [], shots: null } }, async () => `${ROSTER_REPLY}\n10. Page 2: three heights.\n17. Page 3: only stand.\n9. Page 4: x.`);
    const c = await run('plan_check', pages, planText);
    expect(c.modelFindings.map((f: any) => f.check)).toEqual([9]);
    expect(g.ev.some((e: any) => e.level === 'warn' && /checker volunteered/.test(e.m))).toBe(true);
  });

  it('a Jev outage with a jevReport switches the story to the backup once, logged at error level; later checks do not ask Jev', async () => {
    JD.JEV_OUTAGE.waitMs = 20;
    let calls = 0;
    jevAudit.callJev = async () => { calls++; throw new Error('HTTP 503'); };
    const jevReport: any = { castCuts: [], shots: null };
    const { run, g } = runner({ jevReport });
    const c1 = await run('plan_check', pages, planText);
    expect(jevReport.fallback.step).toBe('plan_check');
    expect(g.ev.filter((e: any) => e.k === 'jev_fallback' && e.level === 'error')).toHaveLength(1);
    expect(c1.modelFindings.map((f: any) => f.check)).toEqual([5]);        // the checker's own, no LLM Q10/Q17
    const before = calls;
    const c2 = await run('plan_recheck', pages, planText);
    expect(calls).toBe(before);
    expect(c2.modelFindings.map((f: any) => f.check)).toEqual([5]);
    expect(g.ev.some((e: any) => e.level === 'error' && /plan_recheck_jev_skipped/.test(e.k))).toBe(true);
  });

  it('a Jev outage with no jevReport (the Test Lab) fails loudly', async () => {
    JD.JEV_OUTAGE.waitMs = 20;
    jevAudit.callJev = async () => { throw new Error('HTTP 503'); };
    const { run } = runner({});
    await expect(run('plan_check', pages, planText)).rejects.toBeInstanceOf(JD.JevDecisionError);
  });
});

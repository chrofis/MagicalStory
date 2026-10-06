/**
 * THE TYPED PAGE PLAN (Lab experiment, 2026-10-05; docs/decisions.md "Typed page
 * plan: measured, not adopted"). Pins behaviour, offline and free:
 *   - the who column is read in code; a collective is rejected loudly;
 *   - type <-> cast consistency, and every book target is counted;
 *   - the planner is told the targets from the SAME object the counters measure,
 *     and the production prompt is byte-for-byte unchanged without the param;
 *   - Jev is asked ONE question per call, the shot is picked inside the type;
 *   - the targeted re-plan keeps a page only when it fixes something and breaks nothing;
 *   - the re-plan guards extracted into planGuards behave as the inline ones did.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const SV = req('../../server/lib/shotVocabulary');
const CC = req('../../server/lib/castCoverage');
const PC = req('../../server/lib/planCounters');
const JD = req('../../server/lib/jevDecisions');
const TP = req('../../server/lib/typedPlan');
const PG = req('../../server/lib/planGuards');
const PB = req('../../server/lib/promptBuilders');
const { loadPromptTemplates } = req('../../server/services/prompts');

const LISTED = ['Ana', 'Ben', 'Cy', 'Dora'];
const line = (type: string, who: string, moment = 'they do one thing here', after = 'something changed') => `${type} — ${who} — ${moment} — ${after}`;
const pagesOf = (lines: string[]) => lines.map((l, i) => ({ pageNumber: i + 1, planLine: l }));
const count = (lines: string[], extra: any = {}) => PC.typedPlanCounters({ pages: pagesOf(lines), listedNames: LISTED, mainName: 'Ana', maxCharactersPerScene: 6, ...extra });
const codes = (r: any) => r.findings.map((f: any) => f.code);

function stubJev(noul: (q: string, state: string) => number = () => 0.9) {
  const calls: any[] = [];
  const impl = async ({ state, questions }: any) => {
    calls.push({ state, questions });
    const answers: any = {};
    for (const [id, q] of Object.entries<any>(questions)) answers[id] = { noul: noul(q.instructions, state) };
    return { answers, cost: 0.0001, model: 'stub', usage: {} };
  };
  return { impl, calls };
}

describe('the who column of a typed line', () => {
  it('reads names, canonicalises a first name, and reads nobody', () => {
    expect(PC.parseTypedWho('Ana, Ben and Cy', ['Ana Meier', 'Ben', 'Cy'])).toMatchObject({ nobody: false, names: ['Ana Meier', 'Ben', 'Cy'], rejected: [] });
    expect(PC.parseTypedWho('nobody', LISTED)).toMatchObject({ nobody: true, names: [], rejected: [] });
  });
  it('classes each name: commissioned, arc figure, or planner-invented', () => {
    const r = PC.parseTypedWho('Ana, Rufus, Stranger', LISTED, ['Rufus']);
    expect(r.classes).toEqual({ Ana: 'commissioned', Rufus: 'arc', Stranger: 'invented' });
    expect(PC.whoClassOf('rufus', LISTED, ['Rufus'])).toBe('arc');
  });
  it('rejects a collective, a count and a description loudly, and counts the names that did parse', () => {
    const r = PC.parseTypedWho('the four boys, Ana', LISTED);
    expect(r.names).toEqual(['Ana']);
    expect(r.rejected.map((x: any) => x.entry)).toEqual(['the four boys']);
    expect(PC.parseTypedWho('everyone', LISTED).rejected).toHaveLength(1);
    expect(PC.parseTypedWho('both children', LISTED).rejected).toHaveLength(1);
    expect(PC.parseTypedWho('Ana (and a crowd)', LISTED).rejected.length).toBeGreaterThan(0);
  });
});

describe('typedPlanCounters: type <-> cast consistency', () => {
  const lines = (over: Record<number, string>) => Array.from({ length: 6 }, (_, i) => over[i + 1] || line('medium', i % 2 ? 'Ana, Ben' : 'Ana, Cy'));
  it('flags every mismatch', () => {
    const r = count(lines({
      1: line('landscape', 'Ana'),            // landscape holds nobody
      2: line('face', 'Ana, Ben'),            // face holds one
      3: line('object', 'Ana, Ben'),          // object: nobody or one
      4: line('group', 'Ana, Ben, Cy'),       // group is four or more
      5: line('medium', 'Ana, Ben, Cy, Dora'), // medium is one to three
    }));
    const bad = r.findings.filter((f: any) => f.code === 'TYPE_CAST_MISMATCH').map((f: any) => f.pages[0]);
    expect(bad).toEqual([1, 2, 3, 4, 5]);
  });
  it('accepts the consistent types', () => {
    const r = count([line('landscape', 'nobody'), line('object', 'Ana'), line('face', 'Ben'), line('medium', 'Ana, Ben, Cy'), line('group', 'Ana, Ben, Cy, Dora')]);
    expect(codes(r)).not.toContain('TYPE_CAST_MISMATCH');
  });
  it('reports an unknown type and a short line, and a collective who column', () => {
    const r = count([line('wide', 'Ana'), 'medium — Ana — only three fields', line('medium', 'the four boys')]);
    expect(codes(r)).toContain('TYPED_TYPE_UNKNOWN');
    expect(codes(r)).toContain('PLAN_LINE_INCOMPLETE');
    expect(codes(r)).toContain('TYPED_WHO_COLLECTIVE');
  });
});

describe('every book target is counted, from the object the planner is told', () => {
  const book = (n: number) => Array.from({ length: n }, (_, i) => line('medium', i % 2 ? 'Ana, Ben' : 'Ana, Cy'));
  it('the planner and the counters read ONE target object', () => {
    const t = CC.typedPlanTargets({ pageCount: 16, listed: LISTED, maxCharactersPerScene: 6 });
    const rule = CC.typedTargetsRule(t, 'Ana');
    const cov = CC.castCoverage({ pageCount: 16, castCount: 4 });
    expect(t.appearancesMin).toBe(cov.appearances.min);
    expect(t.groupMax).toBe(CC.groupPageBudget({ pageCount: 16, castCount: 4, maxCharactersPerScene: 6 }).max);
    expect(t.mainMin).toBe(8);
    expect(rule).toContain(`At most ${t.groupMax} page`);
    // Said once (2026-10-06, the planner review): the budget of pages without a commissioned character rides in
    // the requirements of BOTH modes, the commissioned characters' floor in the CAST block, so the targets block
    // does not repeat them. The MAIN character's floor is the typed mode's exception: it stands in THE BOOK'S
    // TARGETS (the planner stopped at 6-8 of 9 when it was one sentence among thirty rules), the number being the
    // one MAIN_UNDER_HALF counts; the production requirements line still carries it.
    expect(CC.mainFloorRule(t.mainMin, 'Ana')).toContain('Ana is in frame on at least 8 pages');
    expect(CC.noCommissionedRule(t.noCommissionedMax)).toContain(`At most ${t.noCommissionedMax} page`);
    expect(rule).toContain('Ana is in frame on at least 8 pages of 16');
    expect(CC.typedTargetsRule(t)).toContain('The main character is in frame on at least 8 pages');
    expect(rule).not.toContain('neighbouring pages share');
    expect(CC.castTableAlsoCount(cov) + 1).toBe(cov.appearances.min);
    // and the counters measure against exactly these
    const r = count(book(16));
    expect(r.stats.targets.mainMin).toBe(t.mainMin);
    expect(r.stats.targets.groupMax).toBe(t.groupMax);
    expect(r.stats.targets.appearancesMin).toBe(t.appearancesMin);
  });
  it('flags no face page, no landscape/object page, neighbours, coverage, main share, group budget, no-commissioned pages', () => {
    const r = count(book(8));
    for (const c of ['TYPED_NO_FACE_PAGE', 'TYPED_NO_SCENERY_PAGE', 'UNDER_COVERED_CHARACTER', 'NO_FOCAL_PAGE']) expect(codes(r)).toContain(c);
    const lines = [line('landscape', 'nobody'), line('landscape', 'nobody'), line('landscape', 'nobody'), line('face', 'Ana'), line('face', 'Ana'),
      line('group', 'Ana, Ben, Cy, Dora'), line('group', 'Ana, Ben, Cy, Dora'), line('group', 'Ana, Ben, Cy, Dora')];
    const r2 = count(lines);
    // neighbours are a SHOT + CAST rule, counted after Jev picks the shots (owner 2026-10-06), never a plan-level finding
    expect(codes(r2)).not.toContain('CONSECUTIVE_SAME_TYPE_CAST');
    expect(codes(r2)).not.toContain('CONSECUTIVE_SAME_SHOT_CAST');
    expect(codes(r2)).toContain('GROUP_PAGES_OVER_BUDGET');
    // people-free pages are not "no commissioned" pages (the counter bug of Lab #1662: 6 pages, 5 of them arc figures or scenery)
    expect(codes(r2)).not.toContain('TYPED_NO_COMMISSIONED_OVER');
    const none = [line('landscape', 'nobody'), line('medium', 'Ben, Cy'), line('face', 'Dora'), line('medium', 'Ben, Cy'), line('medium', 'Dora, Cy'), line('medium', 'Ben, Dora'), line('medium', 'Cy, Ben'), line('medium', 'Dora')];
    expect(codes(count(none))).toContain('MAIN_UNDER_HALF');
  });
  it('a clean book draws none of them', () => {
    const clean = [
      line('medium', 'Ana, Ben'), line('landscape', 'nobody'), line('face', 'Cy'), line('medium', 'Ana, Dora'), line('object', 'Ben'), line('medium', 'Ana, Cy'),
      line('face', 'Dora'), line('medium', 'Ana, Ben'), line('medium', 'Cy, Dora'), line('medium', 'Ana, Cy'), line('medium', 'Ben, Dora'), line('medium', 'Ana, Dora'),
      line('group', 'Ana, Ben, Cy, Dora'), line('medium', 'Ana, Ben'), line('medium', 'Cy, Ana'), line('medium', 'Ben, Dora'),
    ];
    expect(count(clean).lines).toEqual([]);
  });
  it('a face page must show a listed child: a face of an arc figure does not count', () => {
    const lines = [line('face', 'Rufus'), line('landscape', 'nobody'), line('medium', 'Ana, Ben')];
    expect(codes(count(lines, { arcNames: ['Rufus'] }))).toContain('TYPED_NO_FACE_PAGE');
    const ok = [line('face', 'Rufus'), line('face', 'Ana'), line('landscape', 'nobody')];
    expect(codes(count(ok, { arcNames: ['Rufus'] }))).not.toContain('TYPED_NO_FACE_PAGE');
  });
  it('the planner is told who is commissioned (one term) and that the who column names nobody else', () => {
    const rule = CC.typedTargetsRule(CC.typedPlanTargets({ pageCount: 12, listed: LISTED, maxCharactersPerScene: 6 }));
    expect(rule).toContain('a face page shows a commissioned character');
    expect(rule).not.toContain("listed");
    expect(rule).toContain('a figure you invent is a fault');
  });
  it('one who reader for every arm: an untyped plan is read through parseTypedWho, luna only cross-checks', () => {
    const pages = pagesOf(['wide — Ana, Ben — they run — x', 'medium — the egg — it rolls — x', 'close-up — Ana — she smiles — x']);
    const present = new Map([[1, ['Ana', 'Ben']], [2, []], [3, ['Ana', 'little dragon']]]);
    const rows = TP.rowsOfUntypedPlan(pages, present, { commissionedNames: LISTED, arcNames: [] });
    expect(rows.map((r: any) => r.names)).toEqual([['Ana', 'Ben'], [], ['Ana']]);
    expect(rows[1].unreadable).toEqual(['the egg']);
    expect(rows.map((r: any) => r.type)).toEqual(['medium', 'scenery', 'face']);
    expect(TP.crossCheckRows(rows).map((x: any) => x.page)).toEqual([2, 3]);
  });
  it('the same counter measures a plan that carries no type (stored / today): type derived, shot read', () => {
    const rows = [
      { pageNumber: 1, type: PC.deriveRowType(0, 'wide'), names: [], shot: 'wide' },
      { pageNumber: 2, type: PC.deriveRowType(1, 'close-up'), names: ['Ana'], shot: 'close-up' },
      { pageNumber: 3, type: PC.deriveRowType(2, 'close-up'), names: ['Ana', 'Ben'], shot: 'close-up' },
      { pageNumber: 4, type: PC.deriveRowType(4, 'wide'), names: ['Ana', 'Ben', 'Cy', 'Dora'], shot: 'wide' },
    ];
    expect(rows.map(r => r.type)).toEqual(['scenery', 'face', 'medium', 'group']);
    const c = PC.countPlanTargets({ rows, listedNames: LISTED, mainName: 'Ana', maxCharactersPerScene: 6 });
    expect(c.stats.closeUpOnMultiFigurePages).toEqual([3]);
    expect(c.stats.facePages).toEqual([2]);
    expect(c.stats.sceneryPages).toEqual([1]);
  });
});

describe('the planner prompt', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const input = { characters: LISTED.map((name, i) => ({ name, age: 6 + i })), language: 'en', pages: 12, storyCategory: 'adventure' };
  it('production is unchanged without the param: no targets block, the shot placeholder in field 0', () => {
    const p = PB.buildBeatsPrompt(input, 12, { finalArc: 'An arc.' });
    expect(p).not.toContain("THE BOOK'S TARGETS");
    expect(p).toContain(`Page <N>: ${SV.PLAN_SHOT_PLACEHOLDER} —`);
    expect(p).toContain('# PAGE PLAN\n\nBefore dividing');
  });
  it('the typed variant states the targets up front and a typed line format', () => {
    const p = PB.buildBeatsPrompt(input, 12, { finalArc: 'An arc.', typedPlan: true });
    const t = CC.typedPlanTargets({ pageCount: 12, listed: LISTED, maxCharactersPerScene: 6 });
    expect(p.indexOf("THE BOOK'S TARGETS")).toBeLessThan(p.indexOf('Before dividing'));
    expect(p).toContain(CC.typedTargetsRule(t, 'Ana'));
    // the main character's floor stands IN the targets block (before the planning question), once; the requirements line points back
    expect(p.indexOf('Ana is in frame on at least 6 pages of 12')).toBeGreaterThan(-1);
    expect(p.indexOf('Ana is in frame on at least 6 pages of 12')).toBeLessThan(p.indexOf('Before dividing'));
    expect(p.split('is in frame on at least').length - 1).toBe(1);
    expect(p).toContain("Ana's floor stands in THE BOOK'S TARGETS above;");
    // one term and one list: the commissioned characters are named at the head of the prompt
    expect(p).toContain('Commissioned characters: Ana, Ben, Cy, Dora');
    expect(p).toContain(CC.noCommissionedRule(t.noCommissionedMax));
    // the group budget is said once in typed mode: as the "type group" target, not also as the planning question's budget
    expect(p.split(`At most ${t.groupMax} page`).length - 1).toBe(1);
    expect(p).toContain('Page <N>: <type> —');
    for (const id of SV.PLAN_TYPE_IDS) expect(p).toContain(`- ${id}:`);
    expect(p).not.toContain(`Page <N>: ${SV.PLAN_SHOT_PLACEHOLDER} —`);
  });
  it('the typed re-plan returns lines only: no changes block', () => {
    const p = PB.buildBeatsPrompt(input, 12, { finalArc: 'An arc.', typedPlan: true, replan: '# RE-DIVIDE\nx' });
    expect(p).toContain('No changes block.');
    expect(p).not.toContain('---CHANGES---');
  });
});

describe('Jev: one paired question per call', () => {
  const lines = [
    line('landscape', 'nobody'), line('face', 'Ana'), line('medium', 'Ana, Ben'), line('medium', 'Ana, Ben, Cy'), line('group', 'Ana, Ben, Cy, Dora'),
  ];
  const pages = pagesOf(lines);
  const rows = count(lines).rows;
  const CAL = Object.fromEntries(Object.keys(TP.PLAN_QUESTIONS).map(id => [id, { at: 0.5, noise: 0.1, calibrated: true }]));
  const isVirtue = (q: string) => Object.values<any>(TP.PLAN_QUESTIONS).some(x => x.virtue === q);
  it('asks exactly one question in every call (virtue and fault apart) and applies each question where it belongs', async () => {
    const { impl, calls } = stubJev();
    const r = await TP.judgePlanPages({ arc: 'The arc.', pages, rows, listed: LISTED }, { callImpl: impl, retryDelayMs: 1, calibration: CAL });
    for (const c of calls) expect(Object.keys(c.questions)).toHaveLength(1);
    const asked = (id: string) => Object.keys(r.pages).filter(n => id in r.pages[n].scores).map(Number);
    expect(asked('SIMPLE')).toEqual([1, 2, 3, 4, 5]);
    expect(asked('FELT')).toEqual([2]);          // face pages only
    expect(asked('THIRD')).toEqual([4]);         // exactly three figures
    expect(asked('WEIGHT')).toEqual([1]);        // people-free pages
    expect(asked('HEIGHTS')).toEqual([3, 4, 5]); // two or more figures
    expect(asked('WHOLE')).toEqual([5]);         // every listed character in frame
    expect(asked('ACTION')).toEqual([3, 4, 5]);  // not on a face page: a pure face is a presence by design (calibration v2)
    // two calls per (page, question): the virtue and its inverse
    expect(calls).toHaveLength(2 * Object.values(r.pages).reduce((n: number, p: any) => n + Object.keys(p.scores).length, 0));
  });
  it('the question never sees field 0 (type or shot)', async () => {
    const { impl, calls } = stubJev();
    const ls = [line('face', 'Ana', 'she laughs', 'it is funny'), line('medium', 'Ben', 'he waves', 'x')];
    await TP.judgePlanPages({ arc: 'The arc.', pages: pagesOf(ls), rows: count(ls).rows, listed: LISTED }, { callImpl: impl, retryDelayMs: 1, calibration: CAL });
    const simple = calls.find(c => c.questions.Q.instructions === TP.PLAN_QUESTIONS.SIMPLE.virtue);
    expect(simple.state).toContain('Ana — she laughs — it is funny');
    expect(simple.state).not.toMatch(/\bface —/);
  });
  it('the score is the fault probability: ((1 - P(virtue)) + P(fault)) / 2, and agreeing with both pulls to 0.5', async () => {
    expect(TP.faultScore(0.9, 0.1)).toBeCloseTo(0.1, 3);
    expect(TP.faultScore(0.1, 0.9)).toBeCloseTo(0.9, 3);
    expect(TP.faultScore(0.9, 0.9)).toBeCloseTo(0.5, 3);
    const { impl } = stubJev(q => (isVirtue(q) ? 0.2 : 0.8));
    const r = await TP.judgePlanPages({ arc: 'a', pages, rows, listed: LISTED, only: [5] }, { callImpl: impl, retryDelayMs: 1, calibration: CAL });
    expect(r.pages[5].scores.WHOLE).toBeCloseTo(0.8, 2);
    expect(r.pages[5].flags).toContain('WHOLE');
  });
  it('only a CALIBRATED question flags a page, at its own threshold', async () => {
    const { impl } = stubJev(q => (isVirtue(q) ? 0.2 : 0.8)); // every question's fault score is 0.8
    const none = await TP.judgePlanPages({ arc: 'a', pages, rows, listed: LISTED }, { callImpl: impl, retryDelayMs: 1 }); // the shipped CALIBRATION
    const some = await TP.judgePlanPages({ arc: 'a', pages, rows, listed: LISTED }, { callImpl: impl, retryDelayMs: 1, calibration: { SIMPLE: { at: 0.85, noise: 0.1, calibrated: true }, DEED: { at: 0.7, noise: 0.1, calibrated: true }, ACTION: { at: 0.7, noise: 0.1, calibrated: false } } });
    for (const p of Object.values<any>(none.pages)) expect(p.flags.every((id: string) => TP.CALIBRATION[id] && TP.CALIBRATION[id].calibrated)).toBe(true);
    expect(some.flagged.SIMPLE).toBeUndefined();          // 0.8 < 0.85
    expect(some.flagged.DEED).toEqual([1, 2, 3, 4, 5]);   // 0.8 >= 0.7 + 0.1 (the flag level is the threshold plus its noise)
    expect(some.flagged.ACTION).toBeUndefined();          // scored, not calibrated
    expect(some.pages[3].scores.ACTION).toBeCloseTo(0.8, 2);
  });
  it('DEED is a paired question like WHOLE; HEIGHTS allows two levels, not three', () => {
    expect(TP.PLAN_QUESTIONS.DEED.virtue).toBeTruthy();
    expect(TP.PLAN_QUESTIONS.DEED.fault).toContain(PB.DEED_AND_EFFECT_DEF);
    expect(TP.PLAN_QUESTIONS.HEIGHTS.fault).toContain('three or more different heights');
    expect(TP.PLAN_QUESTIONS.HEIGHTS.virtue).toContain('at most two height levels');
    // one remedy everywhere: the planner, the plan check and the typed question say the same sentence
    expect(TP.fixOf('HEIGHTS')).toBe(PB.TWO_HEIGHTS_REMEDY);
    // the third character shares the page's one action, in the typed question as in the planner's
    expect(TP.PLAN_QUESTIONS.THIRD.virtue).toContain("shares the page's one action");
    expect(TP.PLAN_QUESTIONS.THIRD.fault).not.toContain('names the place');
  });
});

describe('the camera inside the type', () => {
  it('assign without quotas takes each page best allowed shot and holds the type', () => {
    const rows = [{ page: 1, roster: [], allow: SV.PLAN_TYPES.landscape.shots }, { page: 2, roster: ['A'], allow: SV.PLAN_TYPES.face.shots }, { page: 3, roster: ['A', 'B'], allow: SV.PLAN_TYPES.medium.shots }];
    const S = [
      { 'close-up': 0.9, medium: 0.9, wide: 0.1, 'ultra-wide': 0.3, 'over-the-shoulder': 0, 'high-angle': 0.2, 'low-angle': 0, aerial: 0.8 },
      { 'close-up': 0.2, medium: 0.9, wide: 0.9, 'ultra-wide': 0, 'over-the-shoulder': 0, 'high-angle': 0, 'low-angle': 0, aerial: 0 },
      { 'close-up': 0.9, medium: 0.1, wide: 0.9, 'ultra-wide': 0, 'over-the-shoulder': 0.5, 'high-angle': 0.1, 'low-angle': 0.2, aerial: 0 },
    ];
    expect(JD.assign(rows, S, { quotas: false })).toEqual(['aerial', 'close-up', 'over-the-shoulder']);
  });
  it('the production assignment is unchanged by the new options', () => {
    expect(JD.budgetOf(16).floors).toEqual(JD.budgetOf(16, true).floors);
    expect(Object.keys(JD.budgetOf(16, false).floors)).toEqual([]);
  });
  it('decideTypedShots: a face page is not asked, every other type is asked only its own shots, one question per call', async () => {
    const lines = [line('landscape', 'nobody'), line('face', 'Ana'), line('medium', 'Ana, Ben'), line('group', 'Ana, Ben, Cy, Dora'), line('object', 'Cy')];
    const rows = count(lines).rows;
    const { impl, calls } = stubJev(() => 0.6);
    const d = await TP.decideTypedShots({ arc: 'a', pages: pagesOf(lines), rows }, { callImpl: impl, retryDelayMs: 1 });
    for (const c of calls) expect(Object.keys(c.questions)).toHaveLength(1);
    expect(d.shots[1]).toBe('close-up');
    d.shots.forEach((s: string, i: number) => expect(SV.PLAN_TYPES[rows[i].type].shots).toContain(s));
    expect(d.beats[0].planLine.startsWith(`${d.shots[0]} — nobody`)).toBe(true);
    expect(calls.some(c => /page to judge: Page 2/i.test(c.state))).toBe(false);
  });
});

describe('the targeted re-plan', () => {
  const targets = CC.typedPlanTargets({ pageCount: 8, listed: LISTED, maxCharactersPerScene: 6 });
  const CAL = Object.fromEntries(Object.keys(TP.PLAN_QUESTIONS).map(id => [id, { at: 0.5, noise: 0.1, calibrated: true }]));
  const jevOf = (flagged: Record<number, Record<string, number>>) => Object.fromEntries(Object.entries(flagged).map(([n, s]) => [n, { scores: s, flags: TP.flagsOf(s, CAL) }]));
  const scopeOf = (c: any, jevPages: any, extra: any = {}) => TP.replanScope({ rows: c.rows, findings: c.findings, jevPages, castTable: null, targets, calibration: CAL, commissionedNames: LISTED, arcNames: [], ...extra });
  it('sends back a flagged page with its reason and a keep list, and nominates candidates for a book-level shortfall', () => {
    const lines = Array.from({ length: 8 }, (_, i) => line('medium', i % 2 ? 'Ana, Ben' : 'Ana, Cy'));
    const c = count(lines);
    const scope = scopeOf(c, jevOf({ 4: { DEED: 0.9 } }));
    expect(scope.get(4).reasons).toContain(TP.fixOf('DEED'));
    expect(scope.get(4).keep).toEqual(expect.arrayContaining(['type medium', expect.stringContaining('in frame: Ana, Ben')]));
    // no face page: candidates are interior pages with one or two figures, never page 1 or the last
    expect([...scope.keys()].every(n => n !== 1 && n !== 8)).toBe(true);
    expect([...scope.values()].flatMap(o => o.reasons).filter(w => /face page/.test(w)).length).toBeGreaterThan(0);
  });
  it('sends at most four Jev flags, the largest margin first; an uncalibrated question sends none', () => {
    const lines = Array.from({ length: 12 }, (_, i) => line('medium', i % 2 ? 'Ana, Ben' : 'Ana, Cy'));
    const c = PC.typedPlanCounters({ pages: pagesOf(lines), listedNames: LISTED, mainName: 'Ana', maxCharactersPerScene: 6 });
    const t12 = CC.typedPlanTargets({ pageCount: 12, listed: LISTED, maxCharactersPerScene: 6 });
    const scores: any = {};
    for (let n = 2; n <= 11; n++) scores[n] = { DEED: 0.55 + n / 100 };
    const cal = { ...CAL };
    const jp = Object.fromEntries(Object.entries(scores).map(([n, s]) => [n, { scores: s, flags: TP.flagsOf(s as any, cal) }]));
    const scope = TP.replanScope({ rows: c.rows, findings: [], jevPages: jp, castTable: null, targets: t12, calibration: cal, commissionedNames: LISTED, arcNames: [] });
    expect([...scope.keys()].sort((a, b) => a - b)).toEqual([8, 9, 10, 11]); // margins 0.13 .. 0.16 are the four largest
    const off = { ...CAL, DEED: { at: 0.5, noise: 0.1, calibrated: false } };
    const jp2 = Object.fromEntries(Object.entries(scores).map(([n, s]) => [n, { scores: s, flags: TP.flagsOf(s as any, off) }]));
    expect(TP.replanScope({ rows: c.rows, findings: [], jevPages: jp2, castTable: null, targets: t12, calibration: off, commissionedNames: LISTED, arcNames: [] }).size).toBe(0);
  });
  it('protects the first and last page, CAST-promised pages, the sole face page and the sole scenery page', () => {
    const lines = [line('medium', 'Ana, Ben'), line('face', 'Ana'), line('medium', 'Ana, Ben'), line('landscape', 'nobody'), line('medium', 'Ana, Ben'), line('medium', 'Ana, Cy'), line('medium', 'Ana, Dora'), line('medium', 'Ana, Ben')];
    const c = count(lines);
    const castTable = { characters: [{ name: 'Ana', deedPage: 3, alsoOn: [5] }], ending: { page: 8, names: ['Ana'] } };
    const prot = TP.protectedPages({ rows: c.rows, castTable, targets, classOf: (n: string) => (LISTED.includes(n) ? 'commissioned' : 'invented') });
    // the deed page (3), the sole face (2), the sole scenery page (4), the ending (8) and the first stay locked; a page
    // the CAST block only promises Ana "also on" (5) may be rewritten, her promise kept by its keep list
    for (const n of [1, 2, 3, 4, 8]) expect(prot.has(n)).toBe(true);
    for (const n of [5, 6, 7]) expect(prot.has(n)).toBe(false);
    // a Jev flag on a protected page is not sent back
    const scope = scopeOf(c, jevOf({ 2: { FELT: 0.95 }, 6: { DEED: 0.9 } }), { castTable });
    expect(scope.has(2)).toBe(false);
    expect(scope.has(6)).toBe(true);
  });
  it('an arc figure carries a page without a listed child; only a planner-invented figure is a finding', () => {
    const lines = [line('medium', 'Ana, Ben'), line('medium', 'Rufus'), line('medium', 'Cy, Dora'), line('medium', 'Stranger'), line('face', 'Ana'), line('landscape', 'nobody')];
    const c = count(lines, { arcNames: ['Rufus'] });
    const cls = c.stats.whoClasses;
    expect(cls[2]).toEqual({ Rufus: 'arc' });
    expect(cls[4]).toEqual({ Stranger: 'invented' });
    expect(codes(c)).toContain('TYPED_INVENTED_FIGURE');
    expect(c.stats.inventedPages).toEqual([4]);
    // the people-free page 6 and the arc-only page 2 are not "no commissioned" pages; the invented-only page 4 is
    expect(c.stats.noCommissionedPages).toEqual([4]);
  });
  it('the replan scope for an invented-figure page names the figure; the section carries each reason once with a Keep line', () => {
    const lines = Array.from({ length: 8 }, () => line('medium', 'Ana, Ben'));
    lines[3] = line('medium', 'Stranger');
    const c = count(lines);
    const scope = scopeOf(c, {});
    expect(scope.get(4).reasons.join(' ')).toContain('Stranger');
    const text = TP.typedReplanSection({ pagePlanText: 'Page 1: x', scope, castTable: null });
    expect(text).toContain('Page 4\nChange: ');
    expect(text).toContain('\nKeep: type medium');
  });
  const base = () => count([line('medium', 'Ana, Ben'), line('medium', 'Ana, Cy'), line('medium', 'Ana, Dora'), line('landscape', 'nobody')]);
  const sc = (v: number) => ({ SIMPLE: v });
  it('keeps a page only when it fixes something and breaks nothing', () => {
    const c = base();
    const countOf = (rows: any[]) => PC.typedPlanCounters({ pages: rows.map(r => ({ pageNumber: r.pageNumber, planLine: r.planLine })), listedNames: LISTED, mainName: 'Ana', maxCharactersPerScene: 6 }).findings;
    const retRows = (l: string, n: number) => count([...Array(n - 1).fill(line('medium', 'Ana, Ben')), l]).rows[n - 1];
    const J = (v: number) => ({ 2: { scores: sc(v), flags: v >= 0.5 ? ['SIMPLE'] : [] } });
    // page 2 becomes a face page of a listed child: fixes TYPED_NO_FACE_PAGE, breaks nothing
    const good = { ...retRows(line('face', 'Cy'), 2), pageNumber: 2 };
    const acc = TP.acceptReplanPages({ rows: c.rows, returned: [good], countOf, jevBefore: J(0.9), jevAfter: J(0.1), targets, calibration: CAL });
    expect(acc.decisions[0].keep).toBe(true);
    expect(acc.rows.find((r: any) => r.pageNumber === 2).type).toBe('face');
    // a page that fixes nothing is dropped
    const same = { ...c.rows[1] };
    const acc2 = TP.acceptReplanPages({ rows: c.rows, returned: [same], countOf, jevBefore: J(0.1), jevAfter: J(0.1), targets, calibration: CAL });
    expect(acc2.decisions[0]).toMatchObject({ keep: false, reason: 'fixes nothing' });
    // a flag that falls only INSIDE the noise margin is not a fix
    const acc2b = TP.acceptReplanPages({ rows: c.rows, returned: [same], countOf, jevBefore: J(0.55), jevAfter: J(0.45), targets, calibration: CAL });
    expect(acc2b.decisions[0].keep).toBe(false);
    // a page that fixes a flag but gains another beyond the margin is dropped
    const before = { 2: { scores: { SIMPLE: 0.9, DEED: 0.1 }, flags: ['SIMPLE'] } };
    const after = { 2: { scores: { SIMPLE: 0.1, DEED: 0.9 }, flags: ['DEED'] } };
    const acc3 = TP.acceptReplanPages({ rows: c.rows, returned: [same], countOf, jevBefore: before, jevAfter: after, targets, calibration: CAL });
    expect(acc3.decisions[0].keep).toBe(false);
    expect(acc3.decisions[0].breaks).toContain('DEED');
    // ... but a new flag inside the noise margin, or on an uncalibrated question, is not a break
    const soft = { 2: { scores: { SIMPLE: 0.1, DEED: 0.55 }, flags: ['DEED'] } };
    const acc3b = TP.acceptReplanPages({ rows: c.rows, returned: [same], countOf, jevBefore: before, jevAfter: soft, targets, calibration: CAL });
    expect(acc3b.decisions[0].keep).toBe(true);
    const acc3c = TP.acceptReplanPages({ rows: c.rows, returned: [same], countOf, jevBefore: before, jevAfter: after, targets, calibration: { ...CAL, DEED: { at: 0.5, noise: 0.1, calibrated: false } } });
    expect(acc3c.decisions[0].keep).toBe(true);
    // a page that fixes one finding and breaks a code target is dropped (the face page empties a character's coverage)
    const breaksCover = { ...c.rows[1], type: 'face', names: ['Ben'], planLine: line('face', 'Ben') };
    const acc4 = TP.acceptReplanPages({ rows: c.rows, returned: [breaksCover], countOf, jevBefore: J(0.9), jevAfter: J(0.1), targets, calibration: CAL });
    expect(acc4.decisions[0].keep).toBe(false);
    expect(acc4.decisions[0].breaks.length).toBeGreaterThan(0);
  });
});

describe('planGuards: the production re-plan guards, one implementation', () => {
  const standing = [1, 2, 3, 4].map(n => ({ pageNumber: n, planLine: `line ${n}` }));
  it('merge restores a returned page nobody asked for and fills an omitted one', () => {
    const returned = [{ pageNumber: 2, planLine: 'new 2' }, { pageNumber: 3, planLine: 'new 3' }];
    const { pages, overridden } = PG.mergeReplanPages(returned, standing, { inScope: n => n === 2 });
    expect(pages.map((p: any) => p.planLine)).toEqual(['line 1', 'new 2', 'line 3', 'line 4']);
    expect(overridden).toBe(1);
  });
  it('scopeAll accepts every returned page', () => {
    const { pages, overridden } = PG.mergeReplanPages([{ pageNumber: 3, planLine: 'new 3' }], standing, { inScope: () => false, scopeAll: true });
    expect(pages[2].planLine).toBe('new 3');
    expect(overridden).toBe(0);
  });
  it('a duplicate line and a wrong page count are caught', () => {
    expect(PG.duplicatePlanLine([{ planLine: 'a  b' }, { planLine: 'A B' }])).toBe('a b');
    expect(PG.duplicatePlanLine([{ planLine: 'a' }, { planLine: 'b' }])).toBeUndefined();
    expect(PG.pageCountHolds([1, 2, 3], 3)).toBe(true);
    expect(PG.pageCountHolds([1, 2, 3, 4], 3)).toBe(false);
  });
});

// ───────────── fix plan items 1-6 (review 2026-10-06): scope, keep lists, floor, calibration v2, acceptance ─────────────
describe('the re-plan scope reaches the main-character floor (fix 1)', () => {
  // 18 pages, Ana the main character on 7, the CAST block promises pages the plan keeps and pages it does not.
  const L4 = ['Ana', 'Ben', 'Cy', 'Dora'];
  const book = [
    line('medium', 'Ana, Ben'), line('medium', 'Ben'), line('landscape', 'nobody'), line('medium', 'Ana, Cy'), line('face', 'Dora'),
    line('medium', 'Ben, Cy'), line('medium', 'Ana, Ben'), line('medium', 'Cy'), line('object', 'nobody'), line('medium', 'Ana, Dora'),
    line('medium', 'Ben, Dora'), line('medium', 'Cy, Dora'), line('medium', 'Ana, Cy'), line('medium', 'Ben'), line('medium', 'Dora'),
    line('medium', 'Cy, Ben'), line('medium', 'Ana, Ben'), line('medium', 'Ana, Dora, Cy'),
  ];
  const c = PC.typedPlanCounters({ pages: pagesOf(book), listedNames: L4, commissionedNames: L4, mainName: 'Ana', maxCharactersPerScene: 6 });
  const t = CC.typedPlanTargets({ pageCount: 18, listed: L4, maxCharactersPerScene: 6 });
  const castTable = { characters: [
    { name: 'Ana', deedPage: 4, alsoOn: [7, 13] }, { name: 'Ben', deedPage: 2, alsoOn: [6, 14] },
    { name: 'Cy', deedPage: 8, alsoOn: [12, 16] }, { name: 'Dora', deedPage: 5, alsoOn: [11, 15] },
  ], ending: { page: 18, names: ['Ana', 'Dora', 'Cy'] } };
  const CAL = Object.fromEntries(Object.keys(TP.PLAN_QUESTIONS).map(id => [id, { at: 0.5, noise: 0.1, calibrated: true }]));
  // every page flagged: the OLD pool (not protected and not flagged) was empty
  const flaggedAll = Object.fromEntries(c.rows.map((r: any) => [r.pageNumber, { scores: { SIMPLE: 0.95 }, flags: ['SIMPLE'] }]));
  it('the floor is reachable: the candidate pool holds at least the shortfall plus one page, flagged pages included', () => {
    expect(c.findings.map((f: any) => f.code)).toContain('MAIN_UNDER_HALF');
    const scope = TP.replanScope({ rows: c.rows, findings: c.findings, jevPages: flaggedAll, castTable, targets: t, calibration: CAL, commissionedNames: L4, arcNames: [] });
    const asked = [...scope.entries()].filter(([, o]: any) => o.reasons.some((w: string) => /in frame here, taking part/.test(w) && /Ana/.test(w)));
    const need = t.mainMin - c.stats.mainCharacter.pages.length;
    expect(need).toBeGreaterThan(0);
    expect(asked.length).toBeGreaterThanOrEqual(need + 1);
    for (const [n, o] of asked as any[]) {
      expect([1, 18, 2, 4, 5, 8]).not.toContain(n);                  // never the first/last page or a kept deed page
      expect(c.rows[n - 1].type).toBe('medium');
      expect(c.rows[n - 1].names.length).toBeLessThanOrEqual(2);
      expect(c.rows[n - 1].names).not.toContain('Ana');
      expect(o.adds).toEqual(['Ana']);
    }
  });
  it('a CAST promise the plan does not keep protects nothing; a kept "also on" promise stays in frame (keep list)', () => {
    const broken = { ...castTable, characters: [{ name: 'Cy', deedPage: 8, alsoOn: [3, 12] }, ...castTable.characters.filter(x => x.name !== 'Cy')] };
    const held = TP.heldPromises(broken, c.rows);
    expect(held.deed.has(8)).toBe(true);
    expect(held.stay.has(3)).toBe(false);                            // page 3 is nobody: Cy is not on it
    expect(held.stay.get(12)).toEqual(['Cy']);
    const flagged12 = { 12: { scores: { WHOLE: 0.95 }, flags: ['WHOLE'] } };
    const scope = TP.replanScope({ rows: c.rows, findings: [], jevPages: flagged12, castTable: broken, targets: t, calibration: CAL, commissionedNames: L4, arcNames: [] });
    expect(scope.get(12).keep.join(' | ')).toContain('stay in frame: Cy');
    // a deed page whose promise the plan does not keep is no longer locked
    const noDeed = { ...castTable, characters: [{ name: 'Cy', deedPage: 7, alsoOn: [] }, ...castTable.characters.filter(x => x.name !== 'Cy')] };
    const prot = TP.protectedPages({ rows: c.rows, castTable: noDeed, targets: t, classOf: (n: string) => (L4.includes(n) ? 'commissioned' : 'invented') });
    expect(prot.has(7)).toBe(false);                                 // page 7 is Ana, Ben: Cy is not there
  });
});

describe('keep lists never contradict the Change (fix 2)', () => {
  const rows = count([
    line('medium', 'Ana, Ben', 'x', 'a dragon is spotted'), line('face', 'Cy', 'she gasps', 'a dragon is spotted'), line('landscape', 'nobody', 'the tree stands', 'the egg is out of the nest'),
    line('medium', 'Ana, Ben', 'x', 'after'), line('medium', 'Ana, Ben', 'x', 'after'), line('medium', 'Dora', 'x', 'after'), line('medium', 'Ana', 'x', 'after'), line('medium', 'Cy', 'x', 'after'),
  ]).rows;
  const CALX = Object.fromEntries(Object.keys(TP.PLAN_QUESTIONS).map(id => [id, { at: 0.5, noise: 0.1, calibrated: true }]));
  const t8 = CC.typedPlanTargets({ pageCount: 8, listed: LISTED, maxCharactersPerScene: 6 });
  const scopeFor = (page: number, id: string) => TP.replanScope({ rows, findings: [], jevPages: { [page]: { scores: { [id]: 0.99 }, flags: [id] } }, castTable: null, targets: t8, calibration: CALX, commissionedNames: LISTED, arcNames: [] }).get(page);
  it('FELT may name what the face reacts to: the after-field anchor is not kept', () => {
    const o = scopeFor(2, 'FELT');
    expect(o).toBeUndefined();                                        // the sole face page is protected: use a book with two
    const rows2 = count([line('medium', 'Ana, Ben'), line('face', 'Cy', 'she gasps', 'a dragon is spotted'), line('face', 'Dora', 'he gasps', 'x'), line('landscape', 'nobody'), line('medium', 'Ana'), line('medium', 'Ana'), line('medium', 'Ben'), line('medium', 'Ana, Ben')]).rows;
    const o2 = TP.replanScope({ rows: rows2, findings: [], jevPages: { 2: { scores: { FELT: 0.99 }, flags: ['FELT'] } }, castTable: null, targets: t8, calibration: CALX, commissionedNames: LISTED, arcNames: [] }).get(2);
    expect(o2.keep.some((k: string) => k.startsWith('what is true after'))).toBe(false);
    expect(o2.keep).toContain('type face');
  });
  it('WEIGHT may give the page a character: "nobody in frame" is not kept', () => {
    const rows3 = count([line('medium', 'Ana, Ben'), line('medium', 'Ana'), line('landscape', 'nobody'), line('object', 'nobody'), line('face', 'Dora'), line('medium', 'Ana'), line('medium', 'Ben'), line('medium', 'Ana, Ben')]).rows;
    const o = TP.replanScope({ rows: rows3, findings: [], jevPages: { 3: { scores: { WEIGHT: 0.99 }, flags: ['WEIGHT'] } }, castTable: null, targets: t8, calibration: CALX, commissionedNames: LISTED, arcNames: [] }).get(3);
    expect(o.reasons.join(' ')).toContain('or give the page a character');
    expect(o.keep.join(' | ')).not.toContain('nobody in frame');
  });
  it('a question whose repair changes who is in frame does not keep the cast, and the type follows the figure count', () => {
    const o = scopeFor(5, 'WHOLE');
    expect(o.keep.join(' | ')).not.toContain('in frame: Ana, Ben');
    expect(o.keep.join(' | ')).toContain('or the type the figures left in frame call for');
    const keepSame = scopeFor(5, 'SIMPLE');
    expect(keepSame.keep).toEqual(expect.arrayContaining(['type medium', 'in frame: Ana, Ben']));
  });
  it('the main character under his floor stays in frame on every page that goes back, even when the cast may change', () => {
    const c2 = count(Array.from({ length: 8 }, (_, i) => line('medium', i === 2 ? 'Ana, Dora' : 'Ben, Cy')));
    expect(c2.findings.map((f: any) => f.code)).toContain('MAIN_UNDER_HALF');
    const sc = TP.replanScope({ rows: c2.rows, findings: c2.findings, jevPages: { 3: { scores: { WHOLE: 0.99 }, flags: ['WHOLE'] } }, castTable: null, targets: t8, calibration: CALX, commissionedNames: LISTED, arcNames: [] });
    expect(sc.get(3).keep.join(' | ')).toContain('stay in frame: Ana');
  });
});

describe('calibration v2 on typed lines (fix 4)', () => {
  it('DEED is scored, never a counted flag; THIRD scored with an added-figure guard only', () => {
    expect(TP.CALIBRATION.DEED.calibrated).toBe(false);
    expect(TP.CALIBRATION.THIRD.calibrated).toBe(false);
    expect(TP.CALIBRATION.THIRD.guardsAdded).toBe(0.5);
    expect(TP.flagsOf({ DEED: 0.99 }, TP.CALIBRATION)).toEqual([]);
  });
  it('ACTION is not asked of a face page', () => {
    expect(TP.PLAN_QUESTIONS.ACTION.applies({ type: 'face', names: ['Ana'] })).toBe(false);
    expect(TP.PLAN_QUESTIONS.ACTION.applies({ type: 'medium', names: ['Ana'] })).toBe(true);
  });
  it('FELT may name what the face reacts to outside the picture (owner 2026-10-06)', () => {
    expect(TP.PLAN_QUESTIONS.FELT.virtue).toContain('may be named');
    expect(TP.PLAN_QUESTIONS.FELT.virtue).toContain('outside the picture');
  });
  it('WEIGHT, the planner and the plan check read ONE definition: a danger or obstacle with nobody in it counts (owner 2026-10-06)', async () => {
    await loadPromptTemplates();
    expect(PB.PEOPLELESS_WEIGHT_DEF).toContain('danger or obstacle');
    expect(TP.PLAN_QUESTIONS.WEIGHT.virtue).toContain(PB.PEOPLELESS_WEIGHT_DEF);
    const input = { characters: LISTED.map((name, i) => ({ name, age: 6 + i })), language: 'en', pages: 12, storyCategory: 'adventure' };
    expect(PB.buildBeatsPrompt(input, 12, { finalArc: 'An arc.' })).toContain(PB.PEOPLELESS_WEIGHT_DEF);
    expect(PB.buildBeatsPrompt(input, 12, { finalArc: 'An arc.', typedPlan: true })).toContain(PB.PEOPLELESS_WEIGHT_DEF);
    expect(PB.buildPlanCheckPrompt(input, 'beats', 'An arc.', 'Page 1: x')).toContain(PB.PEOPLELESS_WEIGHT_DEF);
  });
  it('the flag level is the threshold plus its noise: one level for the flag, the scope margin and the acceptance', () => {
    expect(TP.flagLevel({ at: 0.6, noise: 0.05 })).toBe(0.65);
    expect(TP.flagsOf({ SIMPLE: 0.64 }, { SIMPLE: { at: 0.6, noise: 0.05, calibrated: true } })).toEqual([]);
    expect(TP.flagsOf({ SIMPLE: 0.65 }, { SIMPLE: { at: 0.6, noise: 0.05, calibrated: true } })).toEqual(['SIMPLE']);
  });
});

describe('the neighbour rule is a SHOT + CAST rule counted after the shots (owner decision)', () => {
  const row = (n: number, names: string[], shot: string | null, type = 'medium') => ({ pageNumber: n, type, names, shot });
  const run = (rows: any[]) => PC.countPlanTargets({ rows, listedNames: LISTED, mainName: 'Ana', maxCharactersPerScene: 6 });
  const has = (rows: any[]) => run(rows).findings.map((f: any) => f.code).includes('CONSECUTIVE_SAME_SHOT_CAST');
  it('same shot and same cast on neighbours is a finding; same type and same cast with another shot is not', () => {
    expect(has([row(1, ['Ana', 'Ben'], 'medium'), row(2, ['Ben', 'Ana'], 'medium')])).toBe(true);
    expect(has([row(1, ['Ana', 'Ben'], 'medium'), row(2, ['Ana', 'Ben'], 'wide')])).toBe(false);
    // the same shot with another cast of the same size is no longer a finding (it was, on the head count alone)
    expect(has([row(1, ['Ana', 'Ben'], 'medium'), row(2, ['Ana', 'Cy'], 'medium')])).toBe(false);
    // before the shots exist there is nothing to count
    expect(has([row(1, ['Ana'], null), row(2, ['Ana'], null)])).toBe(false);
  });
});

describe('acceptance: one level for fix, break and the bar (fix 5)', () => {
  const targets = CC.typedPlanTargets({ pageCount: 4, listed: LISTED, maxCharactersPerScene: 6 });
  const CAL2: any = { SIMPLE: { at: 0.5, noise: 0.1, calibrated: true }, THIRD: { at: 1, noise: 0.1, calibrated: false, guardsAdded: 0.5 } };
  const rows = count([line('medium', 'Ana, Ben'), line('medium', 'Ana, Cy'), line('medium', 'Ana, Dora'), line('landscape', 'nobody')]).rows;
  const countOf = (_: any[]) => [] as any[];
  const J = (scores: any) => ({ 2: { scores, flags: [] } });
  it('a flagged question that gets WORSE beyond its noise is a break, not "fixes nothing"', () => {
    const acc = TP.acceptReplanPages({ rows, returned: [{ ...rows[1] }], countOf, jevBefore: J({ SIMPLE: 0.7 }), jevAfter: J({ SIMPLE: 0.9 }), targets, calibration: CAL2 });
    expect(acc.decisions[0].breaks).toContain('SIMPLE');
    expect(acc.decisions[0].keep).toBe(false);
  });
  it('a flag falling from the flag level to just below it is a fix (the bar counts the same level)', () => {
    const acc = TP.acceptReplanPages({ rows, returned: [{ ...rows[1] }], countOf, jevBefore: J({ SIMPLE: 0.61 }), jevAfter: J({ SIMPLE: 0.59 }), targets, calibration: CAL2 });
    expect(acc.decisions[0]).toMatchObject({ keep: true, fixes: ['SIMPLE'], breaks: [] });
  });
  it('a rewrite that ADDS a figure may not leave the third-character question high; one that adds none is not guarded', () => {
    const added = { ...rows[1], names: ['Ana', 'Cy', 'Ben'], planLine: line('medium', 'Ana, Cy, Ben') };
    const acc = TP.acceptReplanPages({ rows, returned: [added], countOf, jevBefore: J({ SIMPLE: 0.7 }), jevAfter: J({ SIMPLE: 0.1, THIRD: 0.8 }), targets, calibration: CAL2 });
    expect(acc.decisions[0].breaks).toContain('THIRD');
    expect(acc.decisions[0].keep).toBe(false);
    const same = { ...rows[1] };
    const acc2 = TP.acceptReplanPages({ rows, returned: [same], countOf, jevBefore: J({ SIMPLE: 0.7 }), jevAfter: J({ SIMPLE: 0.1, THIRD: 0.8 }), targets, calibration: CAL2 });
    expect(acc2.decisions[0].keep).toBe(true);
  });
});

describe('a page is asked to take ONE added figure (Lab 1680-1685: Sarah and Hans both added to a two-figure page broke the type)', () => {
  it('two characters without a focal page are sent to different pages, each holding at most one figure before the add', () => {
    const L = ['Ana', 'Ben', 'Cy', 'Dora'];
    const lines = [line('medium', 'Ana, Ben'), line('medium', 'Ana'), line('medium', 'Ana, Ben'), line('landscape', 'nobody'), line('face', 'Ben'), line('medium', 'Ana'), line('medium', 'Ana, Ben'), line('medium', 'Ana'), line('medium', 'Ben, Ana'), line('medium', 'Ana, Ben'), line('medium', 'Ana')];
    const c = PC.typedPlanCounters({ pages: pagesOf(lines), listedNames: L, commissionedNames: L, mainName: 'Ana', maxCharactersPerScene: 6 });
    expect(c.findings.filter((f: any) => f.code === 'NO_FOCAL_PAGE').length).toBeGreaterThanOrEqual(2);
    const t = CC.typedPlanTargets({ pageCount: 11, listed: L, maxCharactersPerScene: 6 });
    const scope = TP.replanScope({ rows: c.rows, findings: c.findings, jevPages: {}, castTable: null, targets: t, commissionedNames: L, arcNames: [] });
    for (const [n, o] of scope as any) {
      expect(o.adds.length).toBeLessThanOrEqual(1);
      if (o.adds.length) expect(c.rows[n - 1].names.length).toBeLessThanOrEqual(2);
    }
  });
});

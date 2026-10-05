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
    expect(PC.parseTypedWho('Ana, Ben and Cy', ['Ana Meier', 'Ben', 'Cy'])).toEqual({ nobody: false, names: ['Ana Meier', 'Ben', 'Cy'], rejected: [] });
    expect(PC.parseTypedWho('nobody', LISTED)).toEqual({ nobody: true, names: [], rejected: [] });
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
    const rule = CC.typedTargetsRule(t, { mainName: 'Ana' });
    const cov = CC.castCoverage({ pageCount: 16, castCount: 4 });
    expect(t.appearancesMin).toBe(cov.appearances.min);
    expect(t.groupMax).toBe(CC.groupPageBudget({ pageCount: 16, castCount: 4, maxCharactersPerScene: 6 }).max);
    expect(t.mainMin).toBe(8);
    expect(rule).toContain(`at least ${cov.appearances.min} page`);
    expect(rule).toContain(`At most ${t.groupMax} page`);
    expect(rule).toContain('Ana is in frame on at least 8 pages');
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
    expect(codes(r2)).toContain('CONSECUTIVE_SAME_TYPE_CAST');
    expect(codes(r2)).toContain('GROUP_PAGES_OVER_BUDGET');
    expect(codes(r2)).toContain('TYPED_NO_COMMISSIONED_OVER');
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
    expect(p).toContain(CC.typedTargetsRule(t, { mainName: 'Ana' }));
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

describe('Jev: one question per call', () => {
  const lines = [
    line('landscape', 'nobody'), line('face', 'Ana'), line('medium', 'Ana, Ben'), line('medium', 'Ana, Ben, Cy'), line('group', 'Ana, Ben, Cy, Dora'),
  ];
  const pages = pagesOf(lines);
  const rows = count(lines).rows;
  it('asks exactly one question in every call and applies each question where it belongs', async () => {
    const { impl, calls } = stubJev();
    const r = await TP.judgePlanPages({ arc: 'The arc.', pages, rows, listed: LISTED }, { callImpl: impl, retryDelayMs: 1 });
    for (const c of calls) expect(Object.keys(c.questions)).toHaveLength(1);
    const asked = (id: string) => Object.keys(r.pages).filter(n => id in r.pages[n].scores).map(Number);
    expect(asked('SIMPLE')).toEqual([1, 2, 3, 4, 5]);
    expect(asked('FELT')).toEqual([2]);          // face pages only
    expect(asked('THIRD')).toEqual([4]);         // exactly three figures
    expect(asked('WEIGHT')).toEqual([1]);        // people-free pages
    expect(asked('HEIGHTS')).toEqual([3, 4, 5]); // two or more figures
    expect(asked('WHOLE_SHARED')).toEqual([5]);  // every listed character in frame
    expect(asked('ACTION')).toEqual([2, 3, 4, 5]);
  });
  it('the question never sees field 0 (type or shot)', async () => {
    const { impl, calls } = stubJev();
    await TP.judgePlanPages({ arc: 'The arc.', pages: pagesOf([line('face', 'Ana', 'she laughs', 'it is funny'), line('medium', 'Ben', 'he waves', 'x')]), rows: count([line('face', 'Ana', 'she laughs', 'it is funny'), line('medium', 'Ben', 'he waves', 'x')]).rows, listed: LISTED }, { callImpl: impl, retryDelayMs: 1 });
    const simple = calls.find(c => c.questions.Q.instructions.startsWith('The moment of this plan line is simple'));
    expect(simple.state).toContain('Ana — she laughs — it is funny');
    expect(simple.state).not.toMatch(/\bface —/);
  });
  it('flags by side of the threshold: a virtue below it, a fault at or above it', async () => {
    const { impl } = stubJev(q => (q.startsWith('The moment of this plan line is simple') ? 0.3 : q.startsWith('The moment shows an action and the result') ? 0.8 : 0.9));
    const r = await TP.judgePlanPages({ arc: 'The arc.', pages, rows, listed: LISTED }, { callImpl: impl, retryDelayMs: 1 });
    expect(r.flagged.SIMPLE).toEqual([1, 2, 3, 4, 5]);
    expect(r.flagged.DEED).toEqual([1, 2, 3, 4, 5]);
    expect(r.flagged.ACTION).toBeUndefined();
  });
  it('WHOLE averages the shared question inverted with its inverse phrasing, as measured', async () => {
    const { impl } = stubJev(q => (q.startsWith('The moment gives every character in frame one and the same action') ? 0.2 : 0.8));
    const r = await TP.judgePlanPages({ arc: 'a', pages, rows, listed: LISTED, only: [5] }, { callImpl: impl, retryDelayMs: 1 });
    expect(r.pages[5].scores.WHOLE).toBeCloseTo(0.8, 2);
    expect(r.pages[5].flags).toContain('WHOLE');
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
  it('sends back a flagged page with its exact reason, and nominates candidates for a book-level shortfall', () => {
    const lines = Array.from({ length: 8 }, (_, i) => line('medium', i % 2 ? 'Ana, Ben' : 'Ana, Cy'));
    const c = count(lines);
    const flags: any = { 4: ['DEED'] };
    const reasons = TP.replanScope({ rows: c.rows, findings: c.findings, flags, castTable: null, targets });
    expect(reasons.get(4)).toContain(TP.fixOf('DEED'));
    // no face page: candidates are interior pages with one or two figures, never page 1 or the last
    expect([...reasons.keys()].every(n => n !== 1 && n !== 8)).toBe(true);
    const faceWhy = [...reasons.values()].flat().filter(w => /face page/.test(w));
    expect(faceWhy.length).toBeGreaterThan(0);
  });
  it('promised pages (the CAST block) are never nominated', () => {
    const lines = Array.from({ length: 8 }, () => line('medium', 'Ana, Ben'));
    const c = count(lines);
    const castTable = { characters: [{ name: 'Ana', deedPage: 3, alsoOn: [5] }], ending: { page: 8, names: ['Ana'] } };
    const reasons = TP.replanScope({ rows: c.rows, findings: c.findings.filter((f: any) => f.code === 'TYPED_NO_FACE_PAGE'), flags: {}, castTable, targets });
    for (const n of [1, 3, 5, 8]) expect(reasons.has(n)).toBe(false);
  });
  const base = () => count([line('medium', 'Ana, Ben'), line('medium', 'Ana, Cy'), line('medium', 'Ana, Dora'), line('landscape', 'nobody')]);
  it('keeps a page only when it fixes something and breaks nothing', () => {
    const c = base();
    const countOf = (rows: any[]) => PC.typedPlanCounters({ pages: rows.map(r => ({ pageNumber: r.pageNumber, planLine: r.planLine })), listedNames: LISTED, mainName: 'Ana', maxCharactersPerScene: 6 }).findings;
    const retRows = (l: string, n: number) => count([...Array(n - 1).fill(line('medium', 'Ana, Ben')), l]).rows[n - 1];
    // page 2 becomes a face page: fixes TYPED_NO_FACE_PAGE, breaks nothing
    const good = { ...retRows(line('face', 'Cy'), 2), pageNumber: 2 };
    const acc = TP.acceptReplanPages({ rows: c.rows, returned: [good], countOf, jevBefore: { 2: { scores: {}, flags: ['DEED'] } }, jevAfter: { 2: { scores: {}, flags: [] } }, targets });
    expect(acc.decisions[0].keep).toBe(true);
    expect(acc.rows.find((r: any) => r.pageNumber === 2).type).toBe('face');
    // a page that fixes nothing is dropped
    const same = { ...c.rows[1] };
    const acc2 = TP.acceptReplanPages({ rows: c.rows, returned: [same], countOf, jevBefore: { 2: { scores: {}, flags: [] } }, jevAfter: { 2: { scores: {}, flags: [] } }, targets });
    expect(acc2.decisions[0]).toMatchObject({ keep: false, reason: 'fixes nothing' });
    // a page that fixes a flag but gains another is dropped
    const acc3 = TP.acceptReplanPages({ rows: c.rows, returned: [same], countOf, jevBefore: { 2: { scores: {}, flags: ['DEED'] } }, jevAfter: { 2: { scores: {}, flags: ['SIMPLE'] } }, targets });
    expect(acc3.decisions[0].keep).toBe(false);
    // a page that fixes one finding and breaks a code target is dropped (the face page empties a character's coverage)
    const breaksCover = { ...c.rows[1], type: 'face', names: ['Ben'], planLine: line('face', 'Ben') };
    const acc4 = TP.acceptReplanPages({ rows: c.rows, returned: [breaksCover], countOf, jevBefore: { 2: { scores: {}, flags: ['DEED'] } }, jevAfter: { 2: { scores: {}, flags: [] } }, targets });
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

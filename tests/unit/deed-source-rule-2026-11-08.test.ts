import { describe, it, expect, beforeAll } from 'vitest';

// The deed-source rule (owner, 2026-11-08; docs/decisions.md "Deed-source rule replaces the lead-page rule"):
// a friend's or adult's own picture no longer takes the main character's moment, and a deed is the one the story
// gives, staged on the page that tells it. Lab tests G and H (evals/runs/2026-11-08_quality-tests-G, -H).
const fs = require('fs');
const path = require('path');
const CC = require('../../server/lib/castCoverage');
const PC = require('../../server/lib/planCounters');
const PB = require('../../server/lib/promptBuilders');
const JD = require('../../server/lib/jevDecisions');
const SV = require('../../server/lib/shotVocabulary');
const { loadPromptTemplates } = require('../../server/services/prompts');
beforeAll(async () => { await loadPromptTemplates(); });

const NAMES = ['Ana', 'Ben', 'Cara'];
const input = (pages: number, n = 3) => ({
  pages, language: 'en', languageLevel: 'standard', storyDetails: 'x',
  characters: NAMES.slice(0, n).map((name, i) => ({ id: `c${i}`, name, age: 6 })), mainCharacters: ['c0'],
});
const planner = (pages: number, n = 3) => PB.buildBeatsPrompt(input(pages, n), pages, { finalArc: '1. A story.' });
const checker = (pages: number, n = 3) => PB.buildPlanCheckPrompt(
  input(pages, n), Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1, planLine: 'medium — Ana — she waits — nothing' })), '1. A story.', 'Page 1: medium — Ana — she waits — nothing');

describe('the rule texts, rendered', () => {
  it('LEAD_RULE is gone everywhere', () => {
    expect(CC.LEAD_RULE).toBeUndefined();
    const src = ['server/lib/castCoverage.js', 'server/lib/planCounters.js', 'server/lib/promptBuilders.js', 'prompts/story-beats.txt', 'prompts/plan-check.txt']
      .map(f => fs.readFileSync(path.join(__dirname, '../../', f), 'utf8')).join('\n');
    expect(src).not.toMatch(/LEAD_RULE/);
    expect(src).not.toContain('two characters never share a focal page');
    expect(src).not.toContain('sharedLead');
    for (const p of [planner(20), checker(20), CC.castTableSpec(CC.castCoverage({ pageCount: 10, castCount: 5 }), 10)]) {
      expect(p).not.toContain('never share a focal page');
      expect(p).not.toContain('A page leads with one character');
    }
  });
  it('MAIN_IN_FRAME_CLAUSE: one constant, read by the planner (cast rule and requirement), the CAST block and plan-check Q12', () => {
    // narrowed 2026-11-08 (test J): the friend's own deed is never traded away
    expect(CC.MAIN_IN_FRAME_CLAUSE).toContain('when the sentence that tells this action has the main character act, decide or feel in the same place');
    expect(CC.MAIN_IN_FRAME_CLAUSE).toContain("added, never in this character's place");
    expect(CC.MAIN_IN_FRAME_CLAUSE).not.toContain('take another action the story gives this character');
    const p = planner(20);
    // three times: castActionRule ({CAST_COVERAGE}), castTableSpec ({CAST_TABLE}) and the focal-page requirement ({MAIN_IN_FRAME})
    expect(p.split(CC.MAIN_IN_FRAME_CLAUSE).length - 1).toBe(3);
    expect(CC.castActionRule(CC.castCoverage({ pageCount: 20, castCount: 3 }))).toContain(CC.MAIN_IN_FRAME_CLAUSE);
    expect(CC.castTableSpec(CC.castCoverage({ pageCount: 20, castCount: 3 }), 20)).toContain(CC.MAIN_IN_FRAME_CLAUSE);
    expect(checker(20)).toContain(CC.MAIN_IN_FRAME_CLAUSE);
    expect(p).not.toMatch(/\{[A-Z_]+\}/);
    expect(checker(20)).not.toMatch(/\{[A-Z_]+\}/);
    // the hand-copied sentence of story-beats.txt is gone
    expect(fs.readFileSync(path.join(__dirname, '../../prompts/story-beats.txt'), 'utf8')).not.toContain('the main character may be in frame too');
  });
  it('DEED_SOURCE_RULE reaches planner, CAST block and checker, in a small cast too', () => {
    expect(CC.DEED_SOURCE_RULE).toContain("their line under Motives in THE STORY LOGIC names");
    expect(CC.DEED_SOURCE_RULE).toContain("no change takes a deed off a page that stages it — not the main character's moment, not another character's action");
    expect(CC.DEED_SOURCE_RULE).toContain('one whose Motives line names another action takes that one instead; where neither has another, or the story gives them one action together, the two share that page');
    expect(CC.DEED_SOURCE_RULE).toContain('except on the last page, which holds everyone the story keeps together at the end');
    expect(planner(20)).toContain(CC.DEED_SOURCE_RULE);
    expect(checker(20)).toContain(CC.DEED_SOURCE_RULE);
    expect(CC.castTableSpec(CC.castCoverage({ pageCount: 10, castCount: 5 }), 10)).toContain(CC.DEED_SOURCE_RULE);
    expect(CC.castActionRule(CC.castCoverage({ pageCount: 10, castCount: 7 }))).toContain(CC.DEED_SOURCE_RULE);
  });
  it('the main-moment rule stands next to the main floor line, and Q12 files its finding', () => {
    expect(CC.MAIN_MOMENT_RULE).toBe("A page whose sentence has the main character act, decide or feel keeps them in frame, whoever else's action it also stages: the main character is added to that page, never put in place of another character's deed.");
    const p = planner(20);
    expect(p.indexOf(CC.MAIN_MOMENT_RULE)).toBeGreaterThan(p.indexOf('is in frame on at least'));
    expect(p.indexOf(CC.MAIN_MOMENT_RULE) - p.indexOf('is in frame on at least')).toBeLessThan(400);
    expect(CC.CAST_ACTION_FINDINGS).toContain('An action staged on a page that does not tell its sentence, or one the story never gives that character, is a finding.');
    expect(CC.CAST_ACTION_FINDINGS).toContain('A page whose sentence has the main character act, decide or feel, without the main character in its who column, is a finding.');
    expect(checker(20)).toContain(CC.CAST_ACTION_FINDINGS);
    // typed mode states it too
    const typed = PB.buildBeatsPrompt(input(20), 20, { finalArc: '1. A story.', typedPlan: true });
    expect(typed).toContain(CC.MAIN_MOMENT_RULE);
  });
  it('castTableSpec: the garbled splice is gone, the shape names the main character, "Every line names a different page" is gone', () => {
    const cov = CC.castCoverage({ pageCount: 18, castCount: 4 });
    const spec = CC.castTableSpec(cov, 18);
    expect(spec).toMatch(/alone or with one companion, and 2 more pages they are in frame on; when the sentence that tells this action/);
    expect(spec).toContain('never another character\'s "also on" page, except the main character\'s');
    expect(spec).not.toContain('Every line names a different page');
    expect(CC.castTableFormat(cov, 18)).toContain('<with whom — the main character when it is their moment — or alone>');
  });
  it('noFocalFix: the deed comes from the sentence that tells it, never made up or moved', () => {
    const t = CC.noFocalFix('Ben');
    expect(t).toContain("Ben's deed — an action Ben's line under Motives names, on the page that tells its sentence — Ben alone or with one companion (the main character added when it is their moment in the same place)");
    expect(t).toContain("never an action made up, never one moved onto a page whose sentence does not tell it, and never by taking another character's deed off a page");
    expect(t).not.toContain('move that action onto a page of its own');
  });
  it('noFocalFix reaches both NO_FOCAL_PAGE sites, the typed counters included', () => {
    const line = (shot: string, who: string) => `${shot} — ${who} — something happens — something is true`;
    const pages = [1, 2, 3, 4].map(n => ({ pageNumber: n, planLine: line('medium', 'Ana, Ben, Cara') }));
    const r = PC.typedPlanCounters({ pages, listedNames: NAMES, commissionedNames: NAMES, mainNames: ['Ana'], maxCharactersPerScene: 6 });
    const nf = r.findings.filter((f: any) => f.code === 'NO_FOCAL_PAGE');
    expect(nf.length).toBeGreaterThan(0);
    for (const f of nf) expect(f.detail).toContain('on the page that tells its sentence');
  });
});

describe('alsoOnConflicts / the parse: the main characters are exempt, a shared deed page belongs to both', () => {
  const chars = [
    { name: 'Ana', deedPage: 1, deed: 'x', alsoOn: [4] },   // the main, on Ben's deed page 4
    { name: 'Ben', deedPage: 4, deed: 'x', alsoOn: [] },
    { name: 'Cara', deedPage: 6, deed: 'x', alsoOn: [4, 6, 8] },  // not the main: 4 is Ben's
    { name: 'Dee', deedPage: 6, deed: 'x', alsoOn: [] },    // shares page 6 with Cara (one action together)
  ];
  it('without a main list every offence counts (the old behaviour); with it the main is exempt', () => {
    expect(CC.alsoOnConflicts(chars).map((c: any) => `${c.name}:${c.page}`)).toEqual(['Ana:4', 'Cara:4']);
    expect(CC.alsoOnConflicts(chars, ['ana']).map((c: any) => `${c.name}:${c.page}->${c.lead}`)).toEqual(['Cara:4->Ben']);
  });
  it('a character is not in conflict on a deed page they share', () => {
    expect(CC.alsoOnConflicts([{ name: 'Cara', deedPage: 6, alsoOn: [6] }, { name: 'Dee', deedPage: 6, alsoOn: [6] }])).toEqual([]);
  });
  it('parsePlanCastBlock keeps the main character\'s "also on" a friend\'s deed page and rewrites the others', () => {
    const reply = [
      '---CAST---',
      'Ana — deed page 1: opens the door, alone — also on pages 4, 9',
      'Ben — deed page 4: waves, with Ana',
      'Cara — deed page 6: lights the lamp — also on pages 4, 8',
      'Ending page 10: Ana, Ben, Cara',
      '---PAGE PLAN---',
    ].join('\n');
    const t = CC.parsePlanCastBlock(reply, { listed: ['Ana', 'Ben', 'Cara'], leadEach: true, mains: ['Ana'] });
    expect(t.characters.find((c: any) => c.name === 'Ana').alsoOn).toEqual([4, 9]);
    expect(t.characters.find((c: any) => c.name === 'Cara').alsoOn).toEqual([8]);
    expect(t.rejected.map((c: any) => `${c.name}:${c.page}`)).toEqual(['Cara:4']);
  });
  it('both parse call sites pass the main names (production and the Lab)', () => {
    for (const f of ['server/lib/beatsPipeline.js', 'server/lib/testlab.js']) {
      expect(fs.readFileSync(path.join(__dirname, '../../', f), 'utf8')).toMatch(/parsePlanCastBlock\([^\n]*leadEach: !!\(castCov && castCov\.leadEach\), mains: pickMainNames\(/);
    }
  });
});

describe('castTablePromises: the main character\'s "also on" a friend\'s deed page is a promise again', () => {
  const rows = [1, 2, 3, 4].map(n => ({ pageNumber: n, present: n === 2 ? ['Ben'] : ['Ana'] }));
  const table = { characters: [
    { name: 'Ana', deedPage: 1, deed: '', alsoOn: [2] },
    { name: 'Ben', deedPage: 2, deed: '', alsoOn: [] },
    { name: 'Cara', deedPage: 3, deed: '', alsoOn: [2] },
  ], ending: null };
  const args = { rows, castTable: table, actions: null, cast: { all: NAMES, aliases: {} }, focalEach: false, leadEach: true };
  it('a friend\'s "also on" a deed page not theirs is set aside; the main character\'s is held to the plan', () => {
    const r = PC.castTablePromises({ ...args, mains: ['ana'] });
    expect(r.leadWins).toEqual([{ page: 2, name: 'Cara', lead: 'Ben' }]);
    expect(r.broken.map((b: any) => `${b.name}:${b.page}:${b.promise}`)).toEqual(['Ana:2:also']);
    expect(r.sharedLead).toBeUndefined();
  });
  it('mains also arrive as a Set (runPlanCounters passes its lower-cased set)', () => {
    const r = PC.castTablePromises({ ...args, mains: new Set(['ana']) });
    expect(r.leadWins.map((w: any) => w.name)).toEqual(['Cara']);
  });
  it('the focal detail names the moment, not "may be in frame too"', () => {
    const r = PC.castTablePromises({ rows: [{ pageNumber: 2, present: ['Ben', 'Cara', 'Dee'] }, { pageNumber: 3, present: ['Ana'] }], castTable: { characters: [{ name: 'Ben', deedPage: 2, deed: '', alsoOn: [] }], ending: null }, actions: [{ key: 'Ben', page: 2 }], cast: { all: ['Ben', 'Cara', 'Dee', 'Ana'], aliases: {} }, focalEach: true, mains: ['ana'] });
    expect(r.broken[0].detail).toContain('(the main character in frame when it is their moment)');
    expect(r.broken[0].detail).not.toContain('may be in frame too');
  });
});

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

describe('the last page is the focal page of a character whose own action the ACTION line puts on it (test J, 2026-11-08)', () => {
  it('isLastPageDeed: only the last page, only with the ACTION line on it', () => {
    expect(PC.isLastPageDeed(10, 10, 10)).toBe(true);
    expect(PC.isLastPageDeed(10, 10, 9)).toBe(false);
    expect(PC.isLastPageDeed(10, 10, null)).toBe(false);
    expect(PC.isLastPageDeed(9, 10, 9)).toBe(false);
    expect(PC.isLastPageDeed(1, 0, 1)).toBe(false);
  });
  it('isFocalPage: a crowded page stays unfocal unless the fourth argument says it is the last-page deed', () => {
    const crowd = ['Ana', 'Ben', 'Cara', 'Dee'];
    expect(PC.isFocalPage(crowd, 'Ben', ['ana'])).toBe(false);
    expect(PC.isFocalPage(crowd, 'Ben', ['ana'], true)).toBe(true);
  });
  it('castTablePromises: a last-page deed with the whole group in frame keeps its focal promise; on a middle page it breaks', () => {
    const cast = { all: ['Ana', 'Ben', 'Cara', 'Dee'], aliases: {} };
    const crowd = ['Ana', 'Ben', 'Cara', 'Dee'];
    const run = (rows: any[], deed: number) => PC.castTablePromises({ rows, castTable: { characters: [{ name: 'Ben', deedPage: deed, deed: '', alsoOn: [] }], ending: null }, actions: [{ key: 'Ben', page: deed }], cast, focalEach: true, mains: ['ana'] });
    expect(run([{ pageNumber: 1, present: ['Ana'] }, { pageNumber: 2, present: crowd }], 2).broken).toEqual([]);
    const mid = run([{ pageNumber: 1, present: crowd }, { pageNumber: 2, present: ['Ana'] }], 1);
    expect(mid.broken.map((b: any) => b.promise)).toEqual(['focal']);
  });
  it('the three sites share the one helper; the typed counters stay strict (docs/decisions.md 2026-11-08 "Narrowed deed rule")', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/planCounters.js'), 'utf8');
    expect(src.match(/isLastPageDeed\(/g)!.length).toBe(4); // definition + runPlanCounters, castTablePromises, reviewPlanChanges
    expect(src).toMatch(/focal\[name\] = rows\.filter\(r => has\(r, name\) && isFocalPage\(r\.names, name, mainNames\) &&/);
  });
  it('runPlanCounters: no NO_FOCAL_PAGE for a character whose action the ACTION line puts on the crowded last page', () => {
    const P = SV.PLAN_SHOT_PLACEHOLDER;
    const NAMES4 = ['Ana', 'Ben', 'Cara', 'Dee'];
    // 10 pages: a focal page for each is owed (castCoverage.focalEach); Dee is only ever on the crowded last page
    const pages = Array.from({ length: 10 }, (_, i) => ({ pageNumber: i + 1, planLine: `${P} — ${i === 9 ? 'Ana, Ben, Cara, Dee' : `Ana, ${['Ben', 'Cara'][i % 2]}`} — they do thing ${i} — x` }));
    const roster = new Map(pages.map((p: any) => [p.pageNumber, { people: PC.namesIn(PC.whoColumn(p.planLine), NAMES4), things: [], covers: [], unlisted: [] }]));
    const base = { pages, roster, commissionedNames: NAMES4, mainNames: ['Ana'], maxCharactersPerScene: 6 };
    const nf = (r: any) => r.findings.filter((f: any) => f.code === 'NO_FOCAL_PAGE').map((f: any) => f.detail.split(' ')[0]);
    const without = nf(PC.runPlanCounters(base));
    const withAct = nf(PC.runPlanCounters({ ...base, actions: [{ key: 'Dee', page: 10 }] }));
    expect(without).toContain('Dee');
    expect(withAct).not.toContain('Dee');
    expect(withAct).toEqual(without.filter((n: string) => n !== 'Dee'));
  });
});

describe('no change takes a deed off a page (code-checkable parts)', () => {
  it('every rule text that edits a plan forbids taking a deed off a page', () => {
    for (const t of [CC.DEED_SOURCE_RULE, CC.noFocalFix('Ben')]) expect(t).toMatch(/deed off a page/);
    expect(CC.MAIN_MOMENT_RULE).toContain("never put in place of another character's deed");
  });
});

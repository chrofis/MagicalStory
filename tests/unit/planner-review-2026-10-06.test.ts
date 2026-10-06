/**
 * THE PLANNER REVIEW, 2026-10-06 (Opus review of the built planner / plan-check / replan prompts
 * on essbvehs8 and atbttop6w; docs/decisions.md 2026-10-06 "Planner review"). Pins behaviour on the
 * BUILT prompts and the counters, never on template wording:
 *   - the plan line's instant is at most 20 words (a counter finding, told to the planner);
 *   - one page without a commissioned character is allowed, in the prompt and in the counter;
 *   - "nobody" is the who column of a people-free page, in code and in the format;
 *   - the third character shares the page's one action, generator and critic from one constant;
 *   - one remedy for a third height, one whole-cast definition per prompt, one term "commissioned";
 *   - the wardrobe rules the bible writer and the reviewer both hold come from one set of constants;
 *   - the roster's UNLISTED line reads the planner's own context rule (a name that only owns a
 *     prop or a place is not in the picture).
 * Offline and free.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const CC = require('../../server/lib/castCoverage');
const PC = require('../../server/lib/planCounters');
const PB = require('../../server/lib/promptBuilders');
const TP = require('../../server/lib/typedPlan');
const { loadPromptTemplates } = require('../../server/services/prompts');

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const plan = (n: number, who: string, instant: string, after = 'something changed') => ({ pageNumber: n, planLine: `SHOT — ${who} — ${instant} — ${after}` });
const rosterOf = (pages: any[], people: Record<number, string[]>) => new Map(pages.map(p => [p.pageNumber, { people: people[p.pageNumber] || [], things: [], covers: [] }]));

describe('the instant is at most 20 words — a counter finding, not a must-fix', () => {
  it('counts exactly the words of the instant, between the who column and the last field', () => {
    expect(PC.instantWordCount(`SHOT — Ana — ${words(20)} — after words here`).words).toBe(20);
    expect(PC.instantWordCount(`SHOT — Ana — ${words(21)} — after`).words).toBe(21);
    // an em-dash inside the instant does not split it
    expect(PC.instantWordCount('SHOT — Ana — she runs — and jumps — after').words).toBe(4);
    // a plan line without its four fields has no instant to count
    expect(PC.instantWordCount('SHOT — Ana — she runs').complete).toBe(false);
  });

  it('PLAN_INSTANT_TOO_LONG names the pages past the budget and only those, in production and in typed mode', () => {
    const pages = [plan(1, 'Ana', words(20)), plan(2, 'Ana', words(21)), plan(3, 'Ana', words(45))];
    const r = PC.runPlanCounters({ pages, roster: rosterOf(pages, { 1: ['Ana'], 2: ['Ana'], 3: ['Ana'] }), commissionedNames: ['Ana'], listedNames: ['Ana'] });
    const f = r.findings.find((x: any) => x.code === 'PLAN_INSTANT_TOO_LONG');
    expect(f.pages).toEqual([2, 3]);
    expect(f.detail).toContain(`${CC.PLAN_INSTANT_MAX_WORDS} words`);
    const typed = PC.typedPlanCounters({
      pages: [{ pageNumber: 1, planLine: `medium — Ana — ${words(21)} — x` }, { pageNumber: 2, planLine: `medium — Ana — ${words(5)} — x` }],
      listedNames: ['Ana'], maxCharactersPerScene: 6,
    });
    expect(typed.findings.filter((x: any) => x.code === 'PLAN_INSTANT_TOO_LONG').map((x: any) => x.pages)).toEqual([[1]]);
    // the typed re-plan sends the long instant back with its own reason, page by page
    const long2 = PC.typedPlanCounters({
      pages: [{ pageNumber: 1, planLine: `medium — Ana — ${words(21)} — x` }, { pageNumber: 2, planLine: `medium — Ana — ${words(30)} — x` }],
      listedNames: ['Ana'], maxCharactersPerScene: 6,
    });
    const scope = TP.replanScope({ rows: long2.rows, findings: long2.findings.filter((f: any) => f.code === 'PLAN_INSTANT_TOO_LONG'), jevPages: {}, targets: CC.typedPlanTargets({ pageCount: 2, listed: ['Ana'], maxCharactersPerScene: 6 }) });
    expect([...scope.keys()]).toEqual([1, 2]);
    expect(scope.get(2).reasons[0]).toContain('30 words');
    expect(scope.get(2).reasons[0]).not.toContain('21 words');
  });

  it('is a NOTED finding: a long instant costs a rewrite, never a picture', () => {
    expect(PB.replanRank({ code: 'PLAN_INSTANT_TOO_LONG' })).not.toBe('must');
  });

  it('the planner is told the same number the counter counts', () => {
    expect(PB.ONE_ACTION_DEF).toContain(`at most ${CC.PLAN_INSTANT_MAX_WORDS} words`);
  });
});

describe('one page without a commissioned character is allowed — told and counted from one constant', () => {
  const book = (n: number) => Array.from({ length: n }, (_, i) => plan(i + 1, 'Ana, Ben', 'they run'));
  const run = (pages: any[], people: Record<number, string[]>) => PC.runPlanCounters({
    pages, roster: rosterOf(pages, people), commissionedNames: ['Ana', 'Ben'], listedNames: ['Ana', 'Ben'], declaredInvented: ['Rex'], placeNames: [],
  });

  it('one such page is no finding, two are', () => {
    const pages = book(6);
    pages[2] = plan(3, 'Rex', 'Rex digs');
    pages[4] = plan(5, 'Rex', 'Rex barks');
    const people: Record<number, string[]> = { 1: ['Ana', 'Ben'], 2: ['Ana', 'Ben'], 3: ['Rex'], 4: ['Ana', 'Ben'], 5: ['Rex'], 6: ['Ana', 'Ben'] };
    expect(run(pages, people).findings.find((f: any) => f.code === 'NO_COMMISSIONED_ON_PAGE').pages).toEqual([3, 5]);
    const one = pages.map((p, i) => (i === 4 ? plan(5, 'Ana, Ben', 'they run') : p));
    expect(run(one, { ...people, 5: ['Ana', 'Ben'] }).findings.find((f: any) => f.code === 'NO_COMMISSIONED_ON_PAGE')).toBeUndefined();
  });

  it('the planner prompt of BOTH modes states the same budget', () => {
    expect(CC.NO_COMMISSIONED_PAGES_MAX).toBe(1);
    expect(CC.typedPlanTargets({ pageCount: 12, listed: ['Ana', 'Ben'], maxCharactersPerScene: 6 }).noCommissionedMax).toBe(CC.NO_COMMISSIONED_PAGES_MAX);
    expect(CC.noCommissionedRule()).toContain(`At most ${CC.NO_COMMISSIONED_PAGES_MAX} page`);
  });
});

describe('"nobody" is the who column of a people-free page', () => {
  it('the typed reader takes nobody (and none) as an empty page, never as a name', () => {
    for (const w of ['nobody', 'Nobody', 'none']) expect(PC.parseTypedWho(w, ['Ana'])).toMatchObject({ nobody: true, names: [], rejected: [] });
  });

  it('a production page whose who column says nobody is people-free: no NO_COMMISSIONED_ON_PAGE and no NO_PEOPLELESS_PAGE', () => {
    const pages = [plan(1, 'Ana, Ben', 'they run'), plan(2, 'nobody', 'the old wreck lies in the kelp'), plan(3, 'Ana', 'she dives')];
    const r = PC.runPlanCounters({
      pages, roster: rosterOf(pages, { 1: ['Ana', 'Ben'], 2: [], 3: ['Ana'] }), commissionedNames: ['Ana', 'Ben'], listedNames: ['Ana', 'Ben'],
    });
    const codes = r.findings.map((f: any) => f.code);
    expect(codes).not.toContain('NO_COMMISSIONED_ON_PAGE');
    expect(codes).not.toContain('NO_PEOPLELESS_PAGE');
  });

  it('the plan format and the CAST block ask for names only', () => {
    expect(CC.castTableFormat(CC.castCoverage({ pageCount: 14, castCount: 3 }), 14)).toContain('Ending page 14: <names, comma separated>');
    const parsed = CC.parsePlanCastBlock('---CAST---\nAna — deed page 3: runs, alone — also on pages 1, 2\nEnding page 14: Ana, Ben', { listed: ['Ana'] });
    expect(parsed.ending).toEqual({ page: 14, names: ['Ana', 'Ben'] });
  });
});

describe('the built planner, plan check and re-plan', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const input: any = {
    characters: [{ id: 'a', name: 'Ana', age: 5, gender: 'female' }, { id: 'b', name: 'Ben', age: 7, gender: 'male' }],
    mainCharacters: ['a'], language: 'en', pages: 12, storyCategory: 'adventure',
  };
  const planner = (o: any = {}) => PB.buildBeatsPrompt(input, 12, { finalArc: '1. A story.', ...o });
  const checker = () => PB.buildPlanCheckPrompt(input, new Array(12).fill({}), '1. A story.', 'Page 1: SHOT — Ana — she runs — she is out');

  it('names the commissioned characters once at the head, in both modes, with one term', () => {
    for (const p of [planner(), planner({ typedPlan: true })]) expect(p).toContain('Commissioned characters: Ana, Ben');
    expect(planner({ typedPlan: true })).not.toMatch(/\blisted character/);
  });

  it('the seven one-action bullets are one, and the interlock rule allows several hands on one thing as the one action', () => {
    const p = planner();
    for (const gone of ['- Two consecutive actions by one character', '- One centre of action', '- The action at the moment it happens', '- A beat holding two forbidden actions']) expect(p).not.toContain(gone);
    expect(p).toContain(PB.ONE_ACTION_DEF);
    expect(p).toContain(PB.INTERLOCK_DEF);
    expect(p).not.toContain('Never two characters interlocked');
  });

  it('the third character shares the one action, in the planner and in the check', () => {
    expect(planner()).toContain(PB.THIRD_CHARACTER_DEF);
    expect(checker()).toContain(PB.THIRD_CHARACTER_DEF);
    expect(planner()).not.toContain('cannot show without them');
    expect(checker()).not.toContain('cannot show without them');
  });

  it('one remedy for a third height, and the owner\'s "people, animals or objects" wording', () => {
    expect(PB.TWO_HEIGHTS_DEF).toContain('people, animals or objects');
    expect(PB.TWO_HEIGHTS_DEF).not.toContain('A frame holds at most two height levels');
    for (const p of [planner(), checker()]) expect(p.split(PB.TWO_HEIGHTS_REMEDY).length - 1).toBe(1);
    expect(TP.fixOf('HEIGHTS')).toBe(PB.TWO_HEIGHTS_REMEDY);
  });

  it('the opening rule is one sentence: every character\'s first page shows them doing something, said once', () => {
    expect(PB.EXCITING_START_DEF).toContain("each character's first page shows them doing something");
    const c = checker();
    expect(c).not.toContain('a character whose first page shows them doing nothing');
    expect(c.split("first page shows them doing something").length - 1).toBe(1);
  });

  it('a naming and the spoken stake are shown as a visible act, never the words', () => {
    expect(PB.NAMING_DEF).toContain('shown as a visible act');
    expect(planner()).toContain('shown as a visible act, never as the words said');
  });

  it('production gives the planner no frame-composing words; the typed prompt keeps them and says "beyond the page\'s type"', () => {
    const prod = planner();
    expect(prod).not.toContain('close up?');
    expect(prod).not.toContain('seen from afar');
    expect(prod).toContain('- Never compose the frame');
    const typed = planner({ typedPlan: true });
    expect(typed).toContain("Beyond the page's type, never compose the frame");
    expect(typed).toContain('close up?');
    // the lines the review deleted
    for (const p of [prod, typed]) {
      expect(p).not.toContain('the rest of the cast small in the background');
      expect(p).not.toContain('A page may put the subject alone in frame');
      expect(p).not.toContain('Stage a page with two people rather than three');
    }
  });

  it('the main character\'s floor rides in both modes; the budget of one group is said once in typed mode', () => {
    const t = CC.typedPlanTargets({ pageCount: 12, listed: ['Ana', 'Ben'], maxCharactersPerScene: 6 });
    for (const p of [planner(), planner({ typedPlan: true })]) expect(p).toContain(CC.mainFloorRule(t.mainMin, 'Ana'));
    expect(planner()).toContain(CC.groupPageRule(t.group));
    expect(planner({ typedPlan: true })).not.toContain(CC.groupPageRule(t.group));
  });

  it('a re-plan states the whole-cast definition once, and answers a peopled page with no commissioned character', () => {
    const section = PB.buildReplanSection('Page 1: wide — Ana — she runs — x', [{ kind: 'counter', code: 'NO_COMMISSIONED_ON_PAGE', line: 'PLAN[NO_COMMISSIONED_ON_PAGE]: x' }], { pageCount: 12 });
    expect(section).toContain('A peopled page holding none of the commissioned characters gains one');
    const full = planner({ replan: section });
    expect(full.split(PB.WHOLE_CAST_DEF).length - 1).toBe(1);
  });

  it('the planner no longer lists an owner of a prop in the who column, and the roster reads the same context rule', () => {
    expect(PB.PLAN_LINE_FIELD_CONTRACT).not.toContain('named only as the owner of a prop');
    expect(PB.FIGURE_PART_IN_FRAME_RULE).toContain('the owner of a prop or a place');
    expect(checker()).toContain(PB.FIGURE_PART_IN_FRAME_RULE);
  });
});

describe('the wardrobe rules come from one set of constants, in the bible writer and the reviewer', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const input: any = {
    characters: [{ id: 'a', name: 'Ana', age: 5, gender: 'female' }], mainCharacters: ['a'], language: 'en', pages: 2,
    storyCategory: 'adventure', storyTheme: 'mermaid', storyDetails: 'A girl swims.', artStyle: 'watercolor',
  };
  const beats = [{ pageNumber: 1, planLine: 'wide — Ana — Ana swims — x' }, { pageNumber: 2, planLine: 'medium — Ana — Ana waves — x' }];
  const clothing = { Ana: { standard: { used: true, description: 'blue swim shirt and a green tail' }, winter: { used: false }, summer: { used: false }, costumed: { used: false } } };

  it('every rule reaches both prompts verbatim', () => {
    const bible = PB.buildStoryBibleFromBeatsPrompt(input, beats, '1. A girl swims.');
    const review = PB.buildClothingReviewPrompt(input, clothing, beats);
    expect(Object.keys(PB.WARDROBE_RULES)).toHaveLength(8);
    for (const [name, def] of Object.entries<string>(PB.WARDROBE_RULES)) {
      expect(bible, `${name} missing from the bible writer`).toContain(def);
      expect(review, `${name} missing from the reviewer`).toContain(def);
    }
  });

  it('the swim-shirt and tail exception, and the brim and glasses rule, reach the writer', () => {
    const bible = PB.buildStoryBibleFromBeatsPrompt(input, beats, '1. A girl swims.');
    expect(bible).toContain("A child's covering top and a leg-replacing tail are never the garment given up");
    expect(bible).toContain('shadows them with a brim');
    expect(bible).toContain('Glasses are identity');
  });
});

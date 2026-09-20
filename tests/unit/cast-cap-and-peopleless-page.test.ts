import { describe, it, beforeAll, expect } from 'vitest';

const { buildBeatsPrompt, buildPlanCheckPrompt, replanRank } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input = () => ({
  pages: 18, language: 'de-CH', languageLevel: '1st-grade', storyDetails: 'Vier Buben finden ein Ei.',
  characters: [{ id: 'a', name: 'Levin', age: 5 }], mainCharacters: ['a'],
});

/**
 * 2026-09-13 retired the hardcoded CAST_OVER_3 counter — "one counter, one
 * number, read from config" — and reframed the scene reviewer's twin check from
 * a hardcoded three to the configured cap as a composition recommendation. The
 * beats planner was not reframed with them, so for six days the prompt said "At
 * most three named characters in frame… at most one whole-cast page" while the
 * code enforced 6 and nothing enforced the one-page budget at all.
 */
describe('the planner reads the configured cap, like the rest of the pipeline', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('states the ceiling as the configured cap, not a literal three', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
    expect(p).toContain('Two or three named characters carry a page best');
    expect(p).toMatch(/\d+ is the ceiling the image model can hold/);
    expect(p).not.toContain('At most three named characters in frame');
    expect(p).not.toContain('at most one whole-cast page');
    expect(p).not.toContain('{MAX_CHARACTERS_PER_SCENE}');
  });

  it('keeps every STAGING rule the old sentence carried — only the count moved', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
    expect(p).toContain('a named animal that acts in the story counts as one of them');
    expect(p).toContain('wide or distant');
    expect(p).toContain('never a row of figures facing the viewer');
    expect(p).toContain('Add no unnamed figures');
  });
});

/**
 * The checker read p8 of job_1789759147125_p08djwhbl as two named characters —
 * its own roster line said `people = Max, Nia; covers = Levin, Julian, Kiaan`,
 * and check 3 counted the who column alone. Five named, flagged as two.
 */
describe('check 3 counts the cast a covers field expands', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('tells the checker to count covers, not the who column alone', () => {
    const p = buildPlanCheckPrompt(input(), [{ pageNumber: 1, planLine: 'medium — Levin — he waits — nothing' }], '1. A story.', 'Page 1: medium — Levin — he waits — nothing');
    expect(p).toContain("counting the names that page's ROSTER line expands under `covers`");
    expect(p).toContain('never the who column alone');
  });
});

/**
 * The planner is told "At least one page in the book earns this"; the counter
 * reports when none does. As an "also noted" line the re-plan was never obliged
 * to act.
 *
 * CORRECTED 2026-09-20. This block used to cite job_1789759147125_p08djwhbl as
 * "raised in BOTH rounds and shipped unfixed"; that run's stored report says
 * the first check raised it in NEITHER round — it counted page 11 as
 * people-free and only the recheck, reading the same untouched line, resolved
 * "the children" and made the page peopled. That was a measurement fault
 * (CHANGE 1). The promotion is kept on its surviving evidence,
 * job_1789853503332_riqncqg1i: must-fix, raised in both rounds, answered with a
 * correctly-tagged change each time, and shipped 0 for 1.
 */
describe('a requirement nothing is obliged to answer is not a requirement', () => {
  it('NO_PEOPLELESS_PAGE is must-fix, so a re-plan has to spend a round on it', () => {
    expect(replanRank({ kind: 'counter', code: 'NO_PEOPLELESS_PAGE' })).toBe('must');
  });

  it('the codes that were already must-fix stay must-fix', () => {
    for (const code of ['NO_FOCAL_PAGE', 'UNDER_COVERED_CHARACTER', 'MAIN_UNDER_HALF',
      'NO_COMMISSIONED_ON_PAGE', 'PEOPLELESS_ON_INTERACTION_PAGE']) {
      expect(replanRank({ kind: 'counter', code })).toBe('must');
    }
  });

  it('an unranked counter is still only also-noted', () => {
    expect(replanRank({ kind: 'counter', code: 'CONSECUTIVE_SAME_SHOT_CAST' })).toBe('also');
  });
});

/**
 * A MUST-FIX FINDING HAS TO BE ANSWERABLE BY READING IT.
 *
 * job_1789853503332_riqncqg1i, the run the promotion rests on. The planner
 * answered with the right page and the right tag and still failed:
 *   Page 13: action in Levin sitting alone with silent egg on ground before him
 *     — PLAN[NO_PEOPLELESS_PAGE] — … held here with Levin just present to
 *     satisfy the requirement while the egg dominates
 * `action in` is the one declarable verb that cannot empty a page.
 * `REPLAN_FINDING_DIRECTION` already ranked the code 'fewer', so `cast out` was
 * permitted; nothing in the finding said so. The advisory finding that WAS
 * answered twice in the same round, SHOT_NO_CAMERA_POSITION, enumerates its own
 * legal values in its detail — that shape, not the promotion, is what this
 * copies.
 */
describe('NO_PEOPLELESS_PAGE names the move that answers it', () => {
  const { runPlanCounters } = require('../../server/lib/planCounters.js');
  const { PLAN_CHANGE_VOCABULARY } = require('../../server/lib/promptBuilders');

  /** A three-page book, every page peopled. */
  const PAGES = [
    { pageNumber: 1, planLine: 'wide — Levin, Julian — Levin digs in the leaves — the egg is found' },
    { pageNumber: 2, planLine: 'medium — Levin — Levin lifts the egg — the egg knocks' },
    { pageNumber: 3, planLine: 'close-up — Julian — Julian holds the egg — the egg hatches' },
  ];
  const ROSTER = new Map<number, any>([
    [1, { people: ['Levin', 'Julian'], things: [], covers: [] }],
    [2, { people: ['Levin'], things: ['egg'], covers: [] }],
    [3, { people: ['Julian'], things: ['egg'], covers: [] }],
  ]);
  const finding = () => runPlanCounters({
    pages: PAGES, commissionedNames: ['Levin', 'Julian'], placeNames: [],
    maxCharactersPerScene: 6, roster: ROSTER,
  }).findings.find((f: any) => f.code === 'NO_PEOPLELESS_PAGE');

  it('still fires on a book with no people-free page', () => {
    expect(finding()).toBeTruthy();
  });

  it('names the declarable verb, so the finding can be answered by reading it', () => {
    const detail = finding().detail;
    expect(detail).toContain('cast out <name>');
    // …and not the verb the planner reached for instead.
    expect(detail).not.toContain('action in');
  });

  it('says WHICH page may give up its cast, so the answer is not put on the wrong one', () => {
    const detail = finding().detail;
    expect(detail).toContain('a page whose subject is already a thing or a place seen alone');
    expect(detail).toContain('never a moment between people');
  });

  it('the verb is the one the change parser actually reads — no hand-drifted copy', () => {
    const castOut = PLAN_CHANGE_VOCABULARY.find((v: any) => v.kind === 'cast_out');
    expect(finding().detail).toContain(castOut.syntax);
  });

  it('names no page: the heuristic was measured and rejected, and scope does not need one', () => {
    // A finding naming no page is not the obstacle it looked like — the
    // re-plan's merge admits any page the round DECLARES a change for
    // (`declaredPages`, beatsPipeline.js), which a `cast out` line is.
    expect(finding().pages).toEqual([]);
  });
});

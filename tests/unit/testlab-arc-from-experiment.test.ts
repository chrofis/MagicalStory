/**
 * THE PAGE PLAN ON A LAB ARC (2026-09-25) — Test Lab `beats_replan` with
 * `arcFromExperiment`, and the two Lab-only prompt variants the owner A/Bs for
 * "every commissioned character gets their scene":
 *   (A) `plannerMayAddDeeds` — the planner may add one small deed; the plan
 *       check reads the same sentence (castCoverage.ADDED_DEED_RULE);
 *   (B) EVERY_CHILD_ACTS_RULE among the arc's create and re-tell principles —
 *       production since 2026-09-25 (Lab #1490), no longer a switch.
 * (A) off must equal production exactly; on carries the line once.
 *
 * Offline and free: no model, no database.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const PB = require_('../../server/lib/promptBuilders');
const { resolveArcFromExperiment } = require_('../../server/lib/beatsReplayInputs');
const { castActionRule, castCoverageRule, castCoverage, ADDED_DEED_RULE } = require_('../../server/lib/castCoverage');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const { castPageSummary } = require_('../../server/lib/testlab');

const STORY = 'job_test_story';
const LOGIC_BODY = [
  'Want and stakes: the boys want the egg to hatch before dark; if it cools, it never hatches.',
  'Opposition: a young dragon wants the egg for herself, because she lost it this morning.',
  'Facts:',
  '- Levin (commissioned) — can climb the wall',
  '- Nia (commissioned) — a dog; can track by smell',
  '- Nebla (new) — can fly short hops',
  'Motives:',
  '- Nebla: she lost the egg → she takes it back',
  'Central figure: the egg / Kachel',
  'Events: 2',
  'Chain:',
  '- because the egg knocks, Levin keeps it warm',
  '- but Nebla takes the egg, so the boys follow her',
].join('\n');

const arm = (phase: string, effort: string, extra: any = {}) => ({
  phase, effort, ok: true, model: 'claude-opus', arc: `1. ${phase} ${effort} arc.`, logic: LOGIC_BODY, ...extra,
});
const row = (arms: any[], storyId = STORY) => ({ stage: 'arc_effort', results: [{ storyId, pageCount: 12, arms }] });
const want = (extra: any = {}) => ({ expId: 1483, storyId: STORY, ...extra });
const H = { parseStoryLogic: PB.parseStoryLogic };

describe('resolveArcFromExperiment', () => {
  it('takes the retell arm by default, reads the central figure from its logic, and carries no hints', () => {
    const r = resolveArcFromExperiment(row([arm('create', 'xhigh'), arm('retell', 'high')]), want(), H);
    expect(r.arc).toBe('1. retell high arc.');
    expect(r.centralFigure).toEqual(['the egg', 'Kachel']);
    expect(r.logic.commissioned).toEqual(['Levin', 'Nia']);
    expect(r.logic.invented).toEqual(['Nebla']);
    expect(r.arcHints).toBeNull();
    expect(r.pageCount).toBe(12);
    expect(r.source).toMatchObject({ experimentId: 1483, phase: 'retell', effort: 'high' });
  });

  it('falls back to the create arm when no re-telling ran, and honours arcPhase', () => {
    expect(resolveArcFromExperiment(row([arm('create', 'xhigh')]), want(), H).source.phase).toBe('create');
    expect(resolveArcFromExperiment(row([arm('create', 'xhigh'), arm('retell', 'high')]), want({ arcPhase: 'create' }), H).arc)
      .toBe('1. create xhigh arc.');
  });

  it('fails loudly on another story, another stage, an ambiguous or missing arm', () => {
    expect(() => resolveArcFromExperiment(row([arm('create', 'xhigh')], 'job_other'), want(), H)).toThrow(/no result for story job_test_story.*job_other/);
    expect(() => resolveArcFromExperiment({ stage: 'beats_scenes', results: [] }, want(), H)).toThrow(/not arc_effort/);
    expect(() => resolveArcFromExperiment(undefined as any, want(), H)).toThrow(/not found/);
    const two = row([arm('retell', 'high'), arm('retell', 'low')]);
    expect(() => resolveArcFromExperiment(two, want(), H)).toThrow(/pass arcEffort/);
    expect(resolveArcFromExperiment(two, want({ arcEffort: 'low' }), H).arc).toBe('1. retell low arc.');
    expect(() => resolveArcFromExperiment(row([arm('create', 'xhigh', { ok: false })]), want(), H)).toThrow(/no successful create arm/);
    expect(() => resolveArcFromExperiment(row([arm('create', 'xhigh', { logic: null })]), want(), H)).toThrow(/no STORY LOGIC/);
  });
});

describe('castPageSummary', () => {
  it('reads in-frame and focal pages off the counters and the action page off the ACTION line', () => {
    const s = castPageSummary({
      listed: ['Levin Muster', 'Julian'],
      stats: { coveragePages: { 'Levin Muster': [1, 3, 5], Julian: [] }, focalPages: { 'Levin Muster': [3], Julian: [] } },
      actions: [{ key: 'Levin', sentence: 4, page: 5 }, { key: 'Julian', sentence: 7, page: null }],
      aliases: { 'Levin Muster': ['Levin'] },
    });
    expect(s[0]).toMatchObject({ name: 'Levin Muster', inFrameCount: 3, focalPages: [3], actionPage: 5, actionSentence: 4, actionLine: true });
    expect(s[1]).toMatchObject({ name: 'Julian', inFrameCount: 0, actionPage: null, actionLine: true });
  });

  it('says null, not zero, when the counters were skipped', () => {
    const [c] = castPageSummary({ listed: ['Ana'], stats: {}, actions: [] });
    expect(c).toMatchObject({ inFrame: null, inFrameCount: null, focalPages: null, actionPage: null, actionLine: false });
  });
});

const input = () => ({
  pages: 12, language: 'en', languageLevel: 'standard', storyCategory: 'adventure', storyTheme: 'dragon',
  storyDetails: 'Four boys find an egg.',
  characters: [
    { id: 'a', name: 'Levin', age: 7 }, { id: 'b', name: 'Julian', age: 6 },
    { id: 'c', name: 'Max', age: 6 }, { id: 'd', name: 'Kiaan', age: 6 },
  ],
  mainCharacters: ['a'],
});
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('(A) plannerMayAddDeeds — planner and plan check, one sentence', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const cov = castCoverage({ pageCount: 12, castCount: 4 });
  const pages = Array.from({ length: 12 }, (_, i) => ({ pageNumber: i + 1, planLine: `wide — Levin — Levin walks — step ${i + 1}` }));

  it('off is production exactly', () => {
    expect(castActionRule(cov, { mayAddDeeds: false })).toBe(castActionRule(cov));
    expect(castCoverageRule(cov, { mayAddDeeds: false })).toBe(castCoverageRule(cov));
    expect(PB.buildBeatsPrompt(input(), 12, { finalArc: '1. x', mayAddDeeds: false })).toBe(PB.buildBeatsPrompt(input(), 12, { finalArc: '1. x' }));
    expect(PB.buildPlanCheckPrompt(input(), pages, '1. x', '', { mayAddDeeds: false })).toBe(PB.buildPlanCheckPrompt(input(), pages, '1. x', ''));
    expect(PB.buildBeatsPrompt(input(), 12, { finalArc: '1. x' })).not.toContain(ADDED_DEED_RULE);
  });

  it('on puts the same sentence once into the planner, the re-planner and the check', () => {
    expect(count(PB.buildBeatsPrompt(input(), 12, { finalArc: '1. x', mayAddDeeds: true }), ADDED_DEED_RULE)).toBe(1);
    expect(count(PB.buildBeatsPrompt(input(), 12, { finalArc: '1. x', replan: 'RE-PLAN', mayAddDeeds: true }), ADDED_DEED_RULE)).toBe(1);
    expect(count(PB.buildPlanCheckPrompt(input(), pages, '1. x', '', { mayAddDeeds: true }), ADDED_DEED_RULE)).toBe(1);
  });
});

describe('(B) every child acts — the arc create and re-tell principles, production since 2026-09-25', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const committed = '1. An arc.';
  const opts = { challengeIdeas: '# CHALLENGE IDEAS\n- one' };

  it('carries the rule once, in create and in re-tell, with no switch to turn it off', () => {
    expect(count(PB.buildArcCreatePrompt(input(), 12, opts), PB.EVERY_CHILD_ACTS_RULE)).toBe(1);
    expect(count(PB.buildArcRetellPrompt(input(), 12, committed, '1. fix', opts), PB.EVERY_CHILD_ACTS_RULE)).toBe(1);
    // The Lab-only switch is gone: passing it changes nothing.
    expect(PB.buildArcCreatePrompt(input(), 12, { ...opts, everyChildActs: false })).toBe(PB.buildArcCreatePrompt(input(), 12, opts));
  });
});

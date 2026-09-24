/**
 * THE LOGIC-FIRST ARC (owner, 2026-09-24; tasks/arc-logic-first-2026-09-24.md).
 *
 * One arc, a STORY LOGIC block before its numbered sentences, a critique that
 * checks the logic first and counts nothing, and code that counts instead:
 * d1 sentences, d2 chain links, d3 (new) figures, d4 the central figure in
 * each third of the page plan. Evidence for the change: staging
 * job_1790277448294_5herh01j7, whose Opus-max arc carried logic holes the
 * counting critique never looked for.
 *
 * Pins behaviour — what parses, what throws, which shared string reaches which
 * built prompt, what the counters report — never the wording of a rule.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { runPlanCounters } = require('../../server/lib/planCounters');
const { castActionRule, castCoverageRule, castCoverage } = require('../../server/lib/castCoverage');
const { loadPromptTemplates } = require('../../server/services/prompts');
const sc = require('../../server/lib/storyScorecard');

const LOGIC = [
  '**STORY LOGIC:**',
  'Want and stakes: the boys want the egg to hatch before dark; if it cools, it never hatches.',
  'Opposition: a young dragon wants the egg for herself, because she lost it this morning.',
  'Facts:',
  '- Levin (commissioned) — can climb the wall; cannot lift the egg alone',
  '- Nia (commissioned) — Max\'s dog; can track by smell; cannot climb',
  '- Nebla (new) — can fly short hops; cannot hold warmth in the wind',
  '- An egg kept warm hatches; one left in the wind goes quiet.',
  'Central figure: the egg / Kachel',
  'Chain:',
  '- because the egg knocks, Levin decides to keep it warm',
  '- but Nebla takes the egg, so the boys follow her breath through the mist',
  '- because the bridge is cold, the egg goes quiet',
  '- but Levin remembers the leaf heap is warm, so they carry it there',
  '- because the heap holds the warmth, the egg hatches now and not before',
].join('\n');

const CREATE = [
  LOGIC,
  '',
  '# ARC',
  '1. Levin finds the egg.',
  '2. Nebla takes it.',
  '3. The egg hatches in the leaves.',
  '',
  'CRITIQUE:',
  'Logic:',
  '- s2: Nebla could simply fly away with it',
  'Commission honored: yes.',
  'Questions:',
  '1. Nowhere.',
  'Faults:',
  '1. [MAJOR] Nebla has no reason to stay on the bridge.',
].join('\n');

const input = (age = 5, extra: any = {}) => ({
  pages: 18, language: 'de-CH', languageLevel: '1st-grade', storyCategory: 'adventure', storyTheme: 'dragon',
  storyDetails: 'Vier Buben finden ein Ei.',
  characters: [
    { id: 'a', name: 'Levin', age },
    { id: 'b', name: 'Julian', age: 3 },
    { id: 'c', name: 'Max', age: 3 },
    { id: 'd', name: 'Kiaan', age: 3 },
  ],
  mainCharacters: ['a', 'b'],
  ...extra,
});

describe('parseStoryLogic', () => {
  it('reads the sections, the tagged figures, the central figure and the chain', () => {
    const l = PB.parseStoryLogic(CREATE);
    expect(l.want).toMatch(/hatch before dark/);
    expect(l.opposition).toMatch(/lost it this morning/);
    expect(l.commissioned).toEqual(['Levin', 'Nia']);
    expect(l.invented).toEqual(['Nebla']);
    expect(l.centralFigure).toEqual(['the egg', 'Kachel']);
    expect(l.chain).toHaveLength(5);
    expect(l.facts).toEqual(['An egg kept warm hatches; one left in the wind goes quiet.']);
    // The block ends at the arc; the arc never enters it.
    expect(l.text).not.toMatch(/Levin finds the egg/);
  });

  it('fails loudly on a missing or incomplete block — no degraded reading', () => {
    expect(() => PB.parseStoryLogic('ARC:\n1. A story.')).toThrow(/STORY LOGIC/);
    expect(() => PB.parseStoryLogic(LOGIC.replace(/^Central figure:.*$/m, ''))).toThrow(/Central figure/);
    expect(() => PB.parseStoryLogic(LOGIC.split('Chain:')[0])).toThrow(/chain/);
    expect(() => PB.parseStoryLogic(LOGIC.replace(/\((?:commissioned|new)\)/g, ''))).toThrow(/tagged/);
  });
});

describe('parseArcCreate — one arc', () => {
  it('reads the logic, the arc and the critique, and builds the panel block from all three', () => {
    const c = PB.parseArcCreate(CREATE);
    expect(c.arc).toBe('1. Levin finds the egg.\n2. Nebla takes it.\n3. The egg hatches in the leaves.');
    expect(c.sentences).toBe(3);
    expect(c.critique).toMatch(/^Logic:/);
    expect(c.committed).toMatch(/^STORY LOGIC:\n/);
    expect(c.committed).toContain('ARC:\n1. Levin finds the egg.');
    expect(c.committed).toContain('CRITIQUE:\nLogic:');
    expect(c).not.toHaveProperty('discarded');
    expect(c).not.toHaveProperty('strongerLine');
  });

  it('the dash-line chain never reaches the act spans or the fault severity', () => {
    const c = PB.parseArcCreate(CREATE);
    // Only the arc's own numbered sentences set the acts.
    expect(PB.arcActSpans(c.arc)).toBe('The acts are the story\'s sentences in thirds: setup 1, middle 2, ending 3.');
    // The Logic lines are dash lines: the one numbered fault sets the severity.
    expect(PB.critiqueMaxSeverity(c.critique.split('Questions:')[0] + 'Faults:\n1. [MINOR] x')).toBe('MINOR');
  });

  it('throws on a reply with no ARC block or an old two-arc reply', () => {
    expect(() => PB.parseArcCreate(LOGIC)).toThrow(/ARC/);
    expect(() => PB.parseArcCreate('ARC 1:\n1. A.\nCRITIQUE:\n1. x\nARC 2:\n1. B.\nStronger: Arc 1 — why')).toThrow(/STORY LOGIC/);
  });
});

describe('arcChainRange — the chain is the event budget (D3)', () => {
  it('is the band event range plus the last link, from the one table', () => {
    // Journey band at 18 pages: events 4-5, chain 5-6 (the owner's anchor).
    const journey = input(5);
    expect(PB.arcEventRange(journey, 18)).toEqual({ lo: 4, hi: 5 });
    expect(PB.arcChainRange(journey, 18)).toEqual({ lo: 5, hi: 6 });
    // A flat-budget toddler band carries one event, so a two-link chain.
    const toddler = input(1, { characters: [{ id: 'a', name: 'Levin', age: 1 }], mainCharacters: ['a'] });
    expect(PB.arcChainRange(toddler, 18)).toEqual({ lo: 2, hi: 2 });
  });

  it('the number the prompt states is the number code checks', () => {
    const r = PB.arcChainRange(input(5), 18);
    expect(PB.arcLogicSpec(input(5), 18)).toContain(`Chain: ${r.lo}-${r.hi} dash lines`);
    const counts = PB.arcShapeCounts({ sentences: 16, logic: PB.parseStoryLogic(CREATE), inputData: input(5), pageCount: 18 });
    expect(counts.chainRange).toEqual(r);
    expect(counts.chainLinks).toBe(5);
    expect(counts.chainInRange).toBe(true);
    expect(counts.sentenceRange).toEqual({ lo: 14, hi: 18 });
    expect(counts.sentencesInRange).toBe(true);
  });

  it('reports out-of-range lengths without judging them', () => {
    const counts = PB.arcShapeCounts({ sentences: 9, logic: { chain: ['a'], invented: [] }, inputData: input(5), pageCount: 18 });
    expect(counts.sentencesInRange).toBe(false);
    expect(counts.chainInRange).toBe(false);
    expect(counts.inventedOver).toBe(false);
  });
});

describe('the arc prompts', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const committed = PB.parseArcCreate(CREATE).committed;
  const build = (data: any) => ({
    create: PB.buildArcCreatePrompt(data, 18),
    retell: PB.buildArcRetellPrompt(data, 18, committed, '## PANELIST A\nSOLUTION: one'),
    panel: PB.buildArcPanelPrompt(data, committed),
    hints: PB.buildArcHintsPrompt(data, '1. A story.', PB.parseStoryLogic(CREATE).text),
  });

  it('every placeholder is filled, and no budget section or figure list is left', () => {
    for (const [stage, p] of Object.entries(build(input()))) {
      expect(p, stage).toBeTruthy();
      expect(p, stage).not.toMatch(/\{[A-Z][A-Z_]+\}/);
      expect(p, stage).not.toMatch(/# BUDGETS|Premise figures:|Invented figures:|Stronger:/);
    }
  });

  it('create and retell carry the one logic spec; the retell writes it first', () => {
    const b = build(input());
    const spec = PB.arcLogicSpec(input(), 18);
    expect(b.create).toContain(spec);
    expect(b.retell).toContain(spec);
    const out = b.retell.slice(b.retell.indexOf('Output, in this order:'));
    expect(out.indexOf(spec)).toBeLessThan(out.indexOf('"Fixing:"'));
    expect(out.indexOf('"Fixing:"')).toBeLessThan(out.indexOf('"FINAL ARC:"'));
  });

  it('the logic check is ONE string: the critique\'s and the panel\'s first lens', () => {
    const b = build(input());
    expect(b.create).toContain(PB.ARC_LOGIC_CHECK);
    expect(b.retell).toContain(PB.ARC_LOGIC_CHECK);
    expect(b.panel).toContain(`- LOGIC — ${PB.ARC_LOGIC_CHECK}`);
    const lenses = [...b.panel.matchAll(/^- ([A-Z]+)\b/gm)].map(m => m[1]);
    expect(lenses[0]).toBe('LOGIC');
    expect(lenses).not.toContain('CAST');
    expect(lenses).not.toContain('ACTION');
  });

  it('the panel and the hint pass read the story logic', () => {
    const b = build(input());
    const logic = PB.parseStoryLogic(CREATE).text;
    expect(b.panel).toContain(logic);
    expect(b.hints).toContain(logic);
  });

  it('the hint pass without a story logic is not built — it fails loudly', () => {
    expect(PB.buildArcHintsPrompt(input(), '1. A story.', '')).toBeNull();
  });

  it('the arc reads the premise view of the band; the low point rides in the chain', () => {
    const create = PB.buildArcCreatePrompt(input(5), 18);
    expect(create).toContain(PB.buildAgeModeSection(input(5), { bandView: 'premise' }));
    expect(PB.arcLogicSpec(input(5), 18)).toMatch(/low point/);
    // A simple band gets the repetition shape, never a low point.
    const toddler = input(2, { characters: [{ id: 'a', name: 'Levin', age: 2 }], mainCharacters: ['a'] });
    expect(PB.arcLogicSpec(toddler, 18)).not.toMatch(/low point/);
  });

  it('the judge context carries what the arc was given, and no budgets', () => {
    const ctx = sc.buildBriefContext({ ...input(5), pages: 18 }, { arc: true });
    expect(ctx).not.toMatch(/# BUDGETS/);
    expect(ctx).toContain(PB.buildAgeModeSection(input(5), { bandView: 'premise' }).trim());
  });
});

describe('the distinctive voice moves to the prose (D6)', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  it('the style rulebook carries a voice line; the arc does not', () => {
    expect(PB.STYLE_RULEBOOK).toMatch(/voice of their own/);
    expect(PB.buildArcCreatePrompt(input(), 18)).not.toMatch(/distinctive voice|voice of their own/);
  });
});

describe('d4 — the central figure in each third of the page plan', () => {
  const pages = Array.from({ length: 9 }, (_, i) => ({ pageNumber: i + 1, planLine: `wide — Levin — Levin walks — step ${i + 1}` }));
  const rosterWith = (present: number[], name = 'Kachel') => new Map(pages.map(p => [p.pageNumber, {
    people: present.includes(p.pageNumber) ? ['Levin', name] : ['Levin'], things: [], covers: [],
  }]));
  const run = (roster: any, centralFigure: any) => runPlanCounters({ pages, roster, commissionedNames: ['Levin'], placeNames: [], centralFigure });

  it('names each third where no page holds the figure, with that third\'s pages', () => {
    const r = run(rosterWith([1, 2]), ['the egg', 'Kachel']);
    const f = r.findings.filter((x: any) => x.code === 'CENTRAL_FIGURE_ABSENT_THIRD');
    expect(f.map((x: any) => x.pages)).toEqual([[4, 5, 6], [7, 8, 9]]);
  });

  it('either of the figure\'s names counts, and a thing on the roster counts too', () => {
    const roster = rosterWith([5]);
    roster.set(2, { people: ['Levin'], things: ['golden egg'], covers: [] });
    roster.set(8, { people: ['Levin', 'kachel'], things: [], covers: [] });
    const r = run(roster, ['the egg', 'Kachel']);
    expect(r.findings.some((x: any) => x.code === 'CENTRAL_FIGURE_ABSENT_THIRD')).toBe(false);
  });

  it('a different figure sharing a word does not count ("dragon" is not "dragon egg")', () => {
    const r = run(rosterWith([1, 2, 3, 4, 5, 6, 7, 8, 9], 'dragon'), ['dragon egg']);
    expect(r.findings.filter((x: any) => x.code === 'CENTRAL_FIGURE_ABSENT_THIRD')).toHaveLength(3);
  });

  it('is silent when the arc named no central figure', () => {
    expect(run(rosterWith([]), null).findings.some((x: any) => x.code === 'CENTRAL_FIGURE_ABSENT_THIRD')).toBe(false);
  });

  it('is a must-fix finding the re-plan answers by putting the figure in frame', () => {
    expect(PB.replanRank({ kind: 'counter', code: 'CENTRAL_FIGURE_ABSENT_THIRD' })).toBe('must');
    const { replanChangeDirection } = require('../../server/lib/planCounters');
    expect(replanChangeDirection({ code: 'CENTRAL_FIGURE_ABSENT_THIRD' })).toBe('more');
  });

  it('the planner and plan-check Q12 are told the same central-figure sentence', async () => {
    await loadPromptTemplates();
    const cov = castCoverage({ pageCount: 9, castCount: 4 });
    const rule = castActionRule(cov, { centralFigure: ['the egg', 'Kachel'] });
    expect(rule).toMatch(/the egg \/ Kachel/);
    expect(castCoverageRule(cov, { centralFigure: ['the egg', 'Kachel'] })).toContain(rule);
    const plan = PB.buildBeatsPrompt(input(), 9, { finalArc: '1. A story.', centralFigure: ['the egg', 'Kachel'] });
    const check = PB.buildPlanCheckPrompt(input(), pages, '1. A story.', 'Page 1: wide — Levin — x — y', { centralFigure: ['the egg', 'Kachel'] });
    expect(plan).toContain(rule);
    expect(check).toContain(rule);
    // Without a central figure both are byte-identical to the cast rule alone.
    expect(castActionRule(cov)).toBe(castActionRule(cov, { centralFigure: null }));
    expect(castActionRule(cov)).not.toMatch(/central figure/);
  });
});

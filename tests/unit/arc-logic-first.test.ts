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
  'Motives:',
  '- Nebla: she lost the egg this morning → she takes it back',
  '- Levin: he wants the egg to hatch → he carries it to the leaf heap',
  'Central figure: the egg / Kachel',
  'Events: 5',
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
  'Faults:',
  '1. [MAJOR] s2 "Nebla takes it" against "she lost the egg this morning" — she has no reason to stay on the bridge.',
  'Commission honored: yes',
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
    expect(c.critique).toMatch(/^Faults:/);
    expect(c.committed).toMatch(/^STORY LOGIC:\n/);
    expect(c.committed).toContain('ARC:\n1. Levin finds the egg.');
    expect(c.committed).toContain('CRITIQUE:\nFaults:');
    expect(c).not.toHaveProperty('discarded');
    expect(c).not.toHaveProperty('strongerLine');
  });

  it('the dash-line chain never reaches the act spans or the fault severity', () => {
    const c = PB.parseArcCreate(CREATE);
    // Only the arc's own numbered sentences set the acts.
    expect(PB.arcActSpans(c.arc)).toBe('The acts are the story\'s sentences in thirds: setup 1, middle 2, ending 3.');
    // The chain's dash lines never set a severity: the one numbered fault does.
    expect(PB.critiqueMaxSeverity(c.critique)).toBe('MAJOR');
  });

  it('throws on a reply with no ARC block or an old two-arc reply', () => {
    expect(() => PB.parseArcCreate(LOGIC)).toThrow(/ARC/);
    expect(() => PB.parseArcCreate('ARC 1:\n1. A.\nCRITIQUE:\n1. x\nARC 2:\n1. B.\nStronger: Arc 1 — why')).toThrow(/STORY LOGIC/);
  });
});

describe('arcChainRange — the chain is the event budget (D3, tightened 2026-09-25)', () => {
  it('is the band event range itself — one link per happening, no extra link', () => {
    // Journey band at 18 pages: 4-5 happenings, 4-5 links (owner, ages 3-5).
    const journey = input(5);
    expect(PB.arcEventRange(journey, 18)).toEqual({ lo: 4, hi: 5 });
    expect(PB.arcChainRange(journey, 18)).toEqual({ lo: 4, hi: 5 });
    // A flat-budget toddler band carries one happening, so one link.
    const toddler = input(1, { characters: [{ id: 'a', name: 'Levin', age: 1 }], mainCharacters: ['a'] });
    expect(PB.arcChainRange(toddler, 18)).toEqual({ lo: 1, hi: 1 });
    expect(PB.happeningsLabel(toddler, 18)).toBe('1 happening');
  });

  it('the number the principles and the chain state is the number code checks', () => {
    const r = PB.arcChainRange(input(5), 18);
    expect(PB.arcLogicSpec(input(5), 18)).toContain(`Events: the number of happenings, ${r.lo}-${r.hi}.`);
    expect(PB.arcPrinciples(input(5), 18)).toContain(`${r.lo}-${r.hi} happenings a child would retell`);
    const counts = PB.arcShapeCounts({ sentences: 16, logic: PB.parseStoryLogic(CREATE), inputData: input(5), pageCount: 18 });
    expect(counts.chainRange).toEqual(r);
    expect(counts.chainLinks).toBe(5);
    expect(counts.chainInRange).toBe(true);
    expect(counts.eventsDeclared).toBe(5);
    expect(counts.sentenceRange).toEqual({ lo: 14, hi: 18 });
    expect(counts.sentencesInRange).toBe(true);
    expect(counts.worldRules).toBe(1);
    expect(counts.worldRulesOver).toBe(false);
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

describe('the arc prompts v2 (owner, 2026-09-25)', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const committed = PB.parseArcCreate(CREATE).committed;

  it('the principles come first in create and retell, and lead the arc judge\'s context', () => {
    const principles = PB.arcPrinciples(input(5), 18);
    const create = PB.buildArcCreatePrompt(input(5), 18);
    const retell = PB.buildArcRetellPrompt(input(5), 18, committed, '## PANELIST A\nx');
    for (const p of [create, retell]) {
      const at = p.indexOf(principles);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(p.indexOf('# THE COMMISSION'));
    }
    // Landmarks, guide and the challenge catalogue come after the rules.
    expect(create.indexOf('# RULES OF THE LOGIC')).toBeLessThan(create.indexOf('# TOPIC GUIDE'));
    const ctx = sc.buildBriefContext({ ...input(5), pages: 18 }, { arc: true });
    expect(ctx).toContain(principles);
  });

  it('one event budget: no second challenge count in the arc, the trial keeps its line', () => {
    const create = PB.buildArcCreatePrompt(input(5), 18);
    expect(create).not.toMatch(/Build the story on .* challenges/);
    expect(create).not.toMatch(/from (?:one or two|about three|three or four) of these/);
    expect(PB.buildStoryShapeSection(input(5), 18, { arc: true })).toMatch(/Build the story on .* challenges/);
  });

  it('the logic block is capped: one want, one opposition, one ability or limit, two world rules, motive lines', () => {
    const spec = PB.arcLogicSpec(input(5), 18);
    expect(spec).toMatch(/Opposition: one line — the one force/);
    expect(spec).toMatch(/at most one ability and one limit each/);
    expect(spec).toMatch(/at most two dash lines for the rules of the world/);
    expect(spec).toContain('Motives: one dash line per figure that acts, "- <figure>: <motive> → <the act it causes>"');
  });

  it('the parser reads the motive lines and the declared event count', () => {
    const l = PB.parseStoryLogic(CREATE);
    expect(l.motives).toEqual([
      { figure: 'Nebla', motive: 'she lost the egg this morning', act: 'she takes it back' },
      { figure: 'Levin', motive: 'he wants the egg to hatch', act: 'he carries it to the leaf heap' },
    ]);
    expect(l.eventsDeclared).toBe(5);
    // Motive lines are not rules of the world, and not figures.
    expect(l.facts).toEqual(['An egg kept warm hatches; one left in the wind goes quiet.']);
    expect(l.invented).toEqual(['Nebla']);
  });

  it('the creator\'s critique and the panel share the finding rule; the generic self-check is gone', () => {
    const create = PB.buildArcCreatePrompt(input(5), 18);
    const panel = PB.buildArcPanelPrompt(input(5), committed);
    expect(create).toContain(PB.ARC_FINDING_RULE);
    expect(panel).toContain(PB.ARC_FINDING_RULE);
    expect(create).not.toMatch(/Read each sentence against the story logic|blunt self-critique|"Questions:"/);
  });

  it('the re-telling edits only the flagged sentences, adds a fact to the ledger first, and cuts before it adds', () => {
    const retell = PB.buildArcRetellPrompt(input(5), 18, committed, '## PANELIST A\nx');
    expect(retell).toMatch(/Change only the sentences a fault or a panel finding names; copy every other sentence word for word/);
    expect(retell).toMatch(/adds it to the story logic first; then read every sentence against the updated logic/);
    expect(retell).toContain(`The story keeps ${PB.happeningsLabel(input(5), 18)}: a repair that would add a happening cuts one first`);
    expect(retell).not.toMatch(/may rebuild the story|Never edit or patch the old arc/);
  });

  it('a panel solution may not invent plot', () => {
    const panel = PB.buildArcPanelPrompt(input(5), committed);
    expect(panel).toMatch(/A solution adds no figure, object, happening or rule of the world the arc does not have/);
    expect(panel).not.toMatch(/at most 8 numbered points/);
  });
});

describe('filterPanelFindings — a finding must quote the arc (2026-09-25)', () => {
  const block = PB.parseArcCreate(CREATE).committed;
  const reply = [
    'Missed issues:',
    '1. ISSUE s2 "Nebla takes it" against "she lost the egg this morning" — LOGIC: why the bridge?',
    '2. ISSUE s3 "The egg hatches in the leaves" — CAUSE: nothing warmed the leaves.',
    '3. ISSUE s2 — SENSE: she could fly off.',
    '4. ISSUE s1 "Levin finds the golden egg" against "the dragon says so" — invented quote.',
    '',
    'SOLUTION (answers faults 1 and issues 1-4):',
    '1. Cut s2.',
  ].join('\n');

  it('keeps a finding whose quote is in the reviewed block, drops one that quotes nothing or misquotes', () => {
    const f = PB.filterPanelFindings(reply, block);
    expect(f.kept).toHaveLength(2);
    expect(f.kept[0]).toMatch(/^1\. ISSUE s2/);
    expect(f.kept[1]).toMatch(/^2\. ISSUE s3/);
    expect(f.dropped.map((d: string) => d.slice(0, 11))).toEqual(['3. ISSUE s2', '4. ISSUE s1']);
    // The solution passes whole; the heading is layout and is neither.
    expect(f.text).toContain('SOLUTION (answers faults 1 and issues 1-4):\n1. Cut s2.');
    expect(f.text).not.toContain('Missed issues:');
  });

  it('folds case, punctuation, curly quotes and an ellipsis, and needs three words', () => {
    const kept = PB.filterPanelFindings('ISSUE s2 “nebla TAKES it!” — x', block).kept;
    expect(kept).toHaveLength(1);
    expect(PB.filterPanelFindings('ISSUE s1 "Levin finds the egg … Nebla takes" — x', block).kept).toHaveLength(1);
    expect(PB.filterPanelFindings('ISSUE s1 "Levin finds … the egg" — x', block).kept).toHaveLength(0);
    expect(PB.filterPanelFindings('ISSUE s2 "takes it" — x', block).kept).toHaveLength(0);
  });
});

/**
 * Arc-stage fixes from the 2026-09-23 prompt audit of staging
 * job_1790100385959_1nitlympp (docs/audits/prompt-audit-2026-09-23/01-arc.md).
 *
 * Pins BEHAVIOUR: which shared string reaches which built prompt, what the
 * hint parser keeps, what the arc trail stores. Never the wording itself —
 * every assertion reads the exported constant, not a copy of its text.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const landmarks = [
  {
    name: 'Probeplatz', type: 'Square', wikipediaExtract: 'A hilltop square with lime trees.',
    photoVariants: [{ kind: 'exterior', description: 'Gravel square seen from the street' }],
  },
];
const input = (extra: any = {}) => ({
  language: 'de-ch', languageLevel: '1st-grade', storyCategory: 'adventure', storyTheme: 'dragon',
  storyDetails: 'Zwei Kinder finden ein Ei.',
  characters: [
    { id: 'a', name: 'Anna', age: 5, gender: 'female', traits: { specialDetails: 'Her dog is called Bello.' } },
    { id: 'b', name: 'Ben', age: 3, gender: 'male' },
  ],
  mainCharacters: ['a', 'b'],
  availableLandmarks: landmarks,
  ...extra,
});
const build = (data: any) => ({
  create: PB.buildArcCreatePrompt(data, 18),
  panel: PB.buildArcPanelPrompt(data, 'ARC: a committed arc'),
  retell: PB.buildArcRetellPrompt(data, 18, 'ARC: a committed arc', 'SOLUTION: one'),
  hints: PB.buildArcHintsPrompt(data, '1. A story.'),
});

describe('arc prompts after the 2026-09-23 audit', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('no arc prompt is left with an unfilled placeholder', () => {
    for (const [stage, p] of Object.entries(build(input()))) {
      expect(p, stage).toBeTruthy();
      expect(p, stage).not.toMatch(/\{[A-Z][A-Z_]+\}/);
    }
  });

  it('one definition of the commissioned cast reaches the budgets, both figure lists and the panel', () => {
    const b = build(input());
    // Budgets (create + retell), the create critique's Premise-figures list,
    // the re-tell's own list, and the panel's CAST lens.
    expect(b.create.split(PB.COMMISSIONED_CAST_DEF).length - 1).toBeGreaterThanOrEqual(2);
    expect(b.retell.split(PB.COMMISSIONED_CAST_DEF).length - 1).toBeGreaterThanOrEqual(2);
    expect(b.panel).toContain(PB.COMMISSIONED_CAST_DEF);
    expect(PB.COMMISSIONED_CAST_DEF).toMatch(/saved details/);
    expect(b.retell).toContain(PB.PREMISE_FIGURES_SPEC);
    expect(b.retell).toContain(PB.INVENTED_FIGURES_SPEC);
    expect(PB.arcCritiqueSpec()).toContain(PB.PREMISE_FIGURES_SPEC);
  });

  it('the panel and the hint pass are told their working language', () => {
    const b = build(input());
    expect(b.panel).toMatch(/Answer in ENGLISH\./);
    expect(b.hints).toMatch(/Answer in ENGLISH\./);
  });

  it('the rules three panel lenses deduct for are rules the creator and re-teller were given', () => {
    const b = build(input());
    for (const rule of [PB.ARC_ENTRANCE_RULE, PB.ARC_GIVEN_RULE, PB.ARC_SENSE_RULE]) {
      expect(b.create).toContain(rule);
      expect(b.retell).toContain(rule);
      expect(b.panel).toContain(rule);
    }
  });

  it('every commissioned child acts: the shape tells the creator, the critique and the panel check it', () => {
    // Four children, two mains: the two others used to be told "No moment of
    // their own" (owner reversed it 2026-09-23).
    const four = input({
      characters: ['Anna', 'Ben', 'Cleo', 'Dan'].map((name, i) => ({ id: String(i), name, age: 5 - (i % 2) })),
      mainCharacters: ['0', '1', '2', '3'],
    });
    const b = build(four);
    for (const stage of ['create', 'retell', 'panel'] as const) {
      expect(b[stage], stage).toContain(PB.EVERY_CHILD_ACTS_RULE);
      expect(b[stage], stage).not.toMatch(/No moment of their own/);
      expect(b[stage], stage).not.toMatch(/at most two carry a book/);
    }
    expect(PB.arcCritiqueSpec({ inputData: four })).toContain(PB.EVERY_CHILD_ACTS_RULE);
    expect(PB.arcCritiqueSpec({ retell: true, inputData: four })).toContain(PB.EVERY_CHILD_ACTS_RULE);
  });

  it('the central figure is defined once, in the rule and in its check', () => {
    const rules = PB.buildTellingRulesSection(input());
    expect(rules).toContain(PB.CENTRAL_FIGURE_DEF);
    expect(PB.arcCritiqueSpec()).toContain(PB.CENTRAL_FIGURE_DEF);
    expect(PB.CENTRAL_FIGURE_DEF).toMatch(/never the main character/);
  });

  it('the critique persona is the book\'s own reader, not a fixed eight-year-old', () => {
    const five = PB.arcCritiqueSpec({ inputData: input() });
    expect(five).toContain('answered as a five-year-old reader');
    expect(five).not.toContain('eight-year-old');
    const nine = PB.arcCritiqueSpec({ inputData: input({ characters: [{ id: 'a', name: 'Anna', age: 9 }], mainCharacters: ['a'] }) });
    expect(nine).toContain('answered as a nine-year-old reader');
    expect(PB.buildArcCreatePrompt(input(), 18)).toContain('answered as a five-year-old reader');
  });

  it('a noSplit book gets one stay-together line, not two that disagree', () => {
    const rules = PB.buildTellingRulesSection(input());
    expect(rules).toContain('never two groups going separate ways');
    expect(rules).not.toContain('unless it has a reason to separate');
  });

  it('the topic guide reaches the arc with its use rule and without the avatar COSTUME field', () => {
    const create = PB.buildArcCreatePrompt(input(), 18);
    expect(create).toContain('# TOPIC GUIDE');
    expect(create).toContain(PB.GUIDE_USE_RULE);
    expect(create).not.toMatch(/^COSTUME:/m);
  });

  it('a view the commission describes outranks the photo-vantage rule, on every landmark consumer and the panel lens', () => {
    const b = build(input());
    for (const stage of ['create', 'panel', 'retell'] as const) {
      expect(b[stage], stage).toContain("A view the commission's own words describe is the exception");
    }
    expect(b.panel).toContain("and the commission's own words do not describe");
  });

  it('the panel reads the landmark list without the DESCRIPTION extracts; create and retell keep them', () => {
    const b = build(input());
    expect(b.panel).toContain('- Probeplatz [Square]');
    expect(b.panel).not.toContain('DESCRIPTION:');
    expect(b.create).toContain('DESCRIPTION: A hilltop square');
    expect(b.retell).toContain('DESCRIPTION: A hilltop square');
  });
});

describe('arc hints carry sentence anchors', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the parser keeps an anchor, normalised, and still reads a hint without one', () => {
    const raw = [
      'ISSUE (s14-15): a contradiction → CHANGE: swap the two searches.',
      '2. **ISSUE (S 7):** a gap → **CHANGE:** give it a cause.',
      'ISSUE: no anchor → CHANGE: still a hint.',
    ].join('\n');
    expect(PB.parseArcHints(raw).split('\n')).toEqual([
      'ISSUE (s14-15): a contradiction → CHANGE: swap the two searches.',
      'ISSUE (s7): a gap → CHANGE: give it a cause.',
      'ISSUE: no anchor → CHANGE: still a hint.',
    ]);
  });

  it('every reader of the hints is told where an anchored hint lands', () => {
    const hints = 'ISSUE (s3): a gap → CHANGE: a cause.';
    const plan = PB.buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: hints });
    const text = PB.buildStoryTextFromBeatsPrompt(input(), [], [], '1. A story.', { arcHints: hints });
    const audit = PB.buildTextAuditPrompt(input(), [], '1. A story.', { arcHints: hints });
    for (const [stage, p] of Object.entries({ plan, text, audit })) {
      expect(p, stage).toContain(PB.HINT_ANCHOR_RULE);
      expect(p, stage).toContain(hints);
    }
  });
});

describe('the arc trail stores what it claims to', () => {
  // beatsPipeline.js is never required in a unit test (it pulls the whole
  // pipeline in); the report shape is read from its source.
  const src = fs.readFileSync('server/lib/beatsPipeline.js', 'utf8');
  it('each round keeps the re-telling\'s raw reply, and the report keeps the hint pass\'s prompt and reply', () => {
    expect(src).toMatch(/retellRaw: retellRes\.text/);
    const report = src.slice(src.indexOf('arcReviewReport = {'), src.indexOf('arcReviewReport = {') + 2000);
    expect(report).toMatch(/\bhintsPrompt,/);
    expect(report).toMatch(/\bhintsRaw,/);
  });
});

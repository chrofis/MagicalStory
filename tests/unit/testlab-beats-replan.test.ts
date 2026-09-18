/**
 * THE RE-PLAN PLUMBING VERDICT — `analyzeReplanCompliance` (Test Lab stage
 * `beats_replan`, 2026-09-18).
 *
 * WHY IT EXISTS. Commits 981fcb27a + 7ed94f65c gave the re-plan a
 * `---CHANGES---` block and the plan check an `OBSTACLES` block, and made the
 * merge enforce "a change you do not declare is undone". The teeth of that rule
 * are also its hazard: if the planner emits no parseable change block, every
 * structural removal it made reads as undeclared, every one is restored, and
 * the round ships nothing — with no error and no warning. The stage measures
 * that against a live model; these tests pin the ARITHMETIC of the verdict on
 * canned responses, so the measurement itself cannot quietly rot.
 *
 * Offline and free: no model, no database, no clock. Every response below is a
 * literal string.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { analyzeReplanCompliance } = require_('../../server/lib/testlab');

// ---------------------------------------------------------------------------
// A four-page division, shaped like the motivating story
// (staging job_1789681157795_wkt20ckod): four commissioned boys and Tobias,
// the invented antagonist whose taking of the egg is the arc's obstacle.
// ---------------------------------------------------------------------------
const CAST = ['Levin', 'Julian', 'Max', 'Kiaan', 'Tobias'];

const STANDING = [
  { pageNumber: 1, planLine: 'wide — Levin and Julian at the fountain rim — they lift the lid of the tin box — the box is open' },
  { pageNumber: 2, planLine: "medium — Tobias striding up, hands red from cold — Tobias's hands close around the egg — Tobias has taken the egg" },
  { pageNumber: 3, planLine: 'close-up — Julian alone at the old stone wall — he turns the fallen branch over in his hands — the branch is ready' },
  { pageNumber: 4, planLine: 'ultra-wide — Levin, Julian, Max and Kiaan braced against the wedged stone — the stone does not move — the stone is stuck fast' },
];

// Structured exactly as beatsPipeline builds them: no `pages` field, so the page
// numbers are read off the line — which is what production does.
const FINDINGS = [
  { kind: 'counter', code: 'NO_COMMISSIONED_ON_PAGE', line: 'PLAN[NO_COMMISSIONED_ON_PAGE] page 2: a peopled page with none of the commissioned characters in frame' },
  { kind: 'check', check: 3, line: 'CHECK[3]: page 4 puts four named characters in one frame and the justification does not hold' },
];

const CHECK_RESPONSE = [
  'ROSTER 1: people = Levin, Julian; things = tin box; covers = none',
  'ROSTER 2: people = Tobias; things = egg; covers = none',
  'ROSTER 3: people = Julian; things = branch; covers = none',
  'ROSTER 4: people = Levin, Julian, Max, Kiaan; things = wedged stone; covers = none',
  '',
  'OBSTACLES 2: Tobias',
  'OBSTACLES 4: Tobias',
  '',
  '1. Page 2 shows none of the commissioned children.',
  '3. Page 4 puts four named characters in one frame.',
].join('\n');

// Page 2 gains Levin (an ADD answering a "more" finding); page 4 loses Julian
// (a REMOVAL answering a "fewer" finding). Julian keeps pages 1 and 3, so the
// two-page floor is not breached.
const PAGE_PLAN = [
  '---PAGE PLAN---',
  "Page 2: medium — Levin and Tobias at the fountain rim — Tobias's hands close around the egg while Levin watches — Tobias has the egg and Levin has seen it",
  'Page 4: ultra-wide — Levin, Max and Kiaan braced against the wedged stone — the stone does not move — the stone is stuck fast and Julian stands apart',
].join('\n');

const CHANGES = [
  '',
  '---CHANGES---',
  'Page 2: cast in Levin — PLAN[NO_COMMISSIONED_ON_PAGE] — the page held no commissioned child',
  'Page 4: cast out Julian — CHECK[3] — four names in one frame and the page was at the ceiling',
  'Changes: 2',
].join('\n');

const run = (replanText: string, checkText: string = CHECK_RESPONSE) =>
  analyzeReplanCompliance({
    replanText, checkText, standing: STANDING, findings: FINDINGS, castNames: CAST, maxCast: 3,
  });

const passed = (v: any, id: number) => v.checks.find((c: any) => c.id === id).pass;

describe('a compliant re-plan', () => {
  const v = run(PAGE_PLAN + '\n' + CHANGES);

  it('passes every plumbing check', () => {
    expect(v.failed).toEqual([]);
    expect(v.passed).toBe(9);
    expect(v.checks).toHaveLength(9);
  });

  it('keeps the one-line-one-change contract, so nothing is recorded against it', () => {
    expect(v.formatViolations).toEqual([]);
    expect(v.changeLines).toBe(2);
    expect(v.changesParsed).toBe(2);
  });

  it('declares every removal, so nothing is restored as undeclared', () => {
    expect(v.undeclaredRemovalCount).toBe(0);
    expect(v.refusals).toEqual([]);
  });

  it('is not a no-op: both changed pages reach the book', () => {
    expect(v.noOp).toBe(false);
    expect(v.changedPagesApplied).toEqual([2, 4]);
    expect(v.restoredPages).toEqual([]);
  });

  it('quotes the change block back verbatim, marker line included', () => {
    expect(v.changesBlockLines[0]).toBe('---CHANGES---');
    expect(v.changesBlockLines.join('\n')).toContain('Page 4: cast out Julian');
  });
});

describe('THE SILENT FAILURE — the same re-plan with no change block', () => {
  // Every structural change here is a removal, which is the shape that goes
  // all the way to nothing: page 2 drops Tobias, page 4 drops Julian, and with
  // no declaration neither is reviewable, so both pages are restored.
  const REMOVALS_ONLY = [
    '---PAGE PLAN---',
    'Page 2: medium — Levin and Max at the fountain rim — they lift the egg from the rim — the egg is in their hands',
    'Page 4: ultra-wide — Levin, Max and Kiaan braced against the wedged stone — the stone does not move — the stone is stuck fast',
  ].join('\n');

  it('reports the missing block rather than inferring one', () => {
    const v = run(REMOVALS_ONLY);
    expect(passed(v, 1)).toBe(false);
    expect(v.checks.find((c: any) => c.id === 1).detail).toContain('NO ---CHANGES--- block');
    expect(v.changesBlockLines).toEqual([]);
  });

  it('counts every removal as undeclared and restores it', () => {
    const v = run(REMOVALS_ONLY);
    expect(v.undeclaredRemovalCount).toBe(2);
    expect(v.undeclaredRemovals.map((l: any) => l.pageNumber).sort()).toEqual([2, 4]);
    expect(passed(v, 5)).toBe(false);
  });

  it('is the no-op the design exists to prevent — the book keeps round one', () => {
    const v = run(REMOVALS_ONLY);
    expect(v.changedPagesReturned).toEqual([2, 4]);
    expect(v.changedPagesApplied).toEqual([]);
    expect(v.restoredPages).toEqual([2, 4]);
    expect(v.noOp).toBe(true);
  });
});

describe('a change block in a shape the parser reads only partly', () => {
  it('a markdown fence around the block leaves a line nobody read', () => {
    // The marker regex still finds the block inside a fence, so check 1 passes
    // and only the stray fence line shows up — the distinction between "absent"
    // and "malformed" has to survive, because the remedies differ.
    const fenced = PAGE_PLAN + '\n\n```\n' + CHANGES.trim() + '\n```';
    const v = run(fenced);
    expect(passed(v, 1)).toBe(true);
    expect(passed(v, 2)).toBe(false);
    expect(v.checks.find((c: any) => c.id === 2).unparsedLines).toEqual(['```']);
  });

  it('a missing count line fails the count check without losing the changes', () => {
    const v = run(PAGE_PLAN + '\n' + CHANGES.replace('\nChanges: 2', ''));
    expect(v.declaredChanges).toHaveLength(2);
    expect(passed(v, 2)).toBe(false);
    expect(v.checks.find((c: any) => c.id === 2).declaredCount).toBeNull();
  });

  it('a count that disagrees with the enumeration fails on the enumeration', () => {
    const v = run(PAGE_PLAN + '\n' + CHANGES.replace('Changes: 2', 'Changes: 5'));
    const c2 = v.checks.find((c: any) => c.id === 2);
    expect(c2.pass).toBe(false);
    expect(c2.declaredCount).toBe(5);
    expect(c2.counted).toBe(2);
  });

  it('a verb outside the closed set is kept and reported, never dropped', () => {
    const v = run(PAGE_PLAN + '\n' + CHANGES.replace(
      'Page 4: cast out Julian — CHECK[3] — four names in one frame and the page was at the ceiling',
      'Page 4: removed Julian from the frame — CHECK[3] — four names in one frame',
    ));
    expect(passed(v, 3)).toBe(false);
    expect(v.declaredChanges.map((c: any) => c.kind)).toContain('other');
    // And because the vocabulary failed, the removal is undeclared after all.
    expect(v.undeclaredRemovalCount).toBe(1);
  });

  it('a packed line is read clause by clause, not mis-read, and recorded', () => {
    // THE FAULT THE FIRST LIVE RUN FOUND (Lab 1326, 7 of 10 lines; 1327, 1 of
    // 5). Before the split only the first verb matched and everything behind
    // the semicolons was swallowed into its subject, which `namesIn` then
    // resolved over — on one page that read a `cast in` as a `cast out` and
    // refused a correct fix. The remedy is to read it correctly AND record it.
    const v = run(PAGE_PLAN + '\n' + CHANGES.replace(
      'Page 4: cast out Julian \u2014 CHECK[3] \u2014 four names in one frame and the page was at the ceiling',
      'Page 4: cast out Julian; cast out Max \u2014 CHECK[3] \u2014 four names in one frame and the page was at the ceiling',
    ));
    expect(v.changeLines).toBe(2);
    expect(v.changesParsed).toBe(3);
    expect(v.declaredChanges.map((c: any) => c.subject)).toEqual(['Levin', 'Julian', 'Max']);
    expect(v.formatViolations.map((x: any) => x.rule)).toEqual(['packed']);
    expect(passed(v, 9)).toBe(false);
    // Read correctly means reviewed: neither removal is a silent one.
    expect(v.undeclaredRemovalCount).toBe(0);
  });

  it('a cast subject carrying prose is cut to the bare name and recorded', () => {
    const v = run(PAGE_PLAN + '\n' + CHANGES.replace(
      'Page 4: cast out Julian \u2014 CHECK[3]',
      "Page 4: cast out Julian standing at the end of Max's line \u2014 CHECK[3]",
    ));
    expect(v.declaredChanges.find((c: any) => c.page === 4).subject).toBe('Julian');
    expect(v.formatViolations.map((x: any) => x.rule)).toEqual(['cast_prose']);
    expect(passed(v, 9)).toBe(false);
  });

  it('a line with no finding tag fails the tag check', () => {
    const v = run(PAGE_PLAN + '\n' + CHANGES.replace(
      'Page 2: cast in Levin — PLAN[NO_COMMISSIONED_ON_PAGE] — the page held no commissioned child',
      'Page 2: cast in Levin — because the page needed a child',
    ));
    expect(passed(v, 4)).toBe(false);
    expect(v.checks.find((c: any) => c.id === 4).untagged).toHaveLength(1);
  });

  it('a page number outside the division fails the page-number rule', () => {
    const v = run(PAGE_PLAN + '\nPage 9: wide — Levin alone on the square — he looks back — the square is empty\n' + CHANGES);
    expect(passed(v, 6)).toBe(false);
    expect(v.checks.find((c: any) => c.id === 6).outsidePlan).toEqual([9]);
  });
});

describe('the plan check half of the plumbing', () => {
  it('reads OBSTACLES lines as data beside the roster', () => {
    const v = run(PAGE_PLAN + '\n' + CHANGES);
    expect(v.obstaclesLines).toEqual(['OBSTACLES 2: Tobias', 'OBSTACLES 4: Tobias']);
    expect(passed(v, 7)).toBe(true);
    expect(passed(v, 8)).toBe(true);
  });

  it('a check that emits no OBSTACLES line fails both obstacle checks', () => {
    const noObstacles = CHECK_RESPONSE.split('\n').filter(l => !l.startsWith('OBSTACLES')).join('\n');
    const v = run(PAGE_PLAN + '\n' + CHANGES, noObstacles);
    expect(passed(v, 7)).toBe(false);
    expect(passed(v, 8)).toBe(false);
  });

  it('an obstacle-holder a change declares out is refused and the page restored', () => {
    // Page 2's obstacle is Tobias, by the check's own line. A round that
    // declares him out is judged on that declared evidence, not on prose.
    const dropObstacle = [
      '---PAGE PLAN---',
      'Page 2: medium — Levin and Max at the fountain rim — they lift the egg from the rim — the egg is in their hands',
      '',
      '---CHANGES---',
      'Page 2: cast out Tobias — PLAN[NO_COMMISSIONED_ON_PAGE] — the page needed commissioned children',
      'Changes: 1',
    ].join('\n');
    const v = run(dropObstacle);
    expect(v.refusals.map((r: any) => r.rule)).toEqual(['obstacle']);
    expect(v.changedPagesApplied).toEqual([]);
    expect(v.noOp).toBe(true);
  });
});

describe('the round-level guards the merge applies after the review', () => {
  it('two pages with the same plan line discard the round, declarations and all', () => {
    // Page 4 comes back as a verbatim copy of page 1 — the corruption that cost
    // job_1788903616404_iqvhj4l8m its climax. Both removals are properly
    // declared and the review allows both, so it is the duplicate guard alone
    // that saves the book.
    const duplicated = [
      '---PAGE PLAN---',
      'Page 4: wide — Levin and Julian at the fountain rim — they lift the lid of the tin box — the box is open',
      '',
      '---CHANGES---',
      'Page 4: cast out Max — CHECK[3] — four names in one frame',
      'Page 4: cast out Kiaan — CHECK[3] — four names in one frame',
      'Changes: 2',
    ].join('\n');
    const v = run(duplicated);
    expect(v.refusals).toEqual([]);
    expect(v.undeclaredRemovalCount).toBe(0);
    expect(v.discardReason).toContain('identical plan line');
    expect(v.noOp).toBe(true);
  });
});

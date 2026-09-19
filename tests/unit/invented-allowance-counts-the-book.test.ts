import { describe, it, expect } from 'vitest';

const { runPlanCounters } = require('../../server/lib/planCounters');

// One page per figure so the roster reports each as a PERSON in frame.
const plan = (rows: Array<[number, string]>) => rows.map(([n, who]) => ({
  pageNumber: n, planLine: `medium — ${who} — ${who.split(',')[0].trim()} reaches for the lamp — the lamp is lifted`,
}));
const roster = (rows: Array<[number, string[]]>) =>
  new Map(rows.map(([n, people]) => [n, { people, things: [], covers: [] }]));

const run = (pages: any, r: any, declaredInvented: string[] | null, inventedAllowance: number | null) =>
  runPlanCounters({
    pages, roster: r, commissionedNames: ['Levin'], placeNames: [],
    declaredInvented, inventedAllowance, maxCharactersPerScene: 6,
  });

const codes = (res: any) => (res.findings || []).map((f: any) => f.code);
const lineFor = (res: any, code: string) =>
  (res.findings || []).map((f: any, i: number) => (f.code === code ? res.lines[i] : null)).find(Boolean) || '';

/**
 * The allowance compared `declared.length` alone, so an arc that under-declared
 * had its allowance checked against its own understatement and always passed.
 * job_1788903616404_iqvhj4l8m shipped four invented figures on an allowance of
 * two exactly this way; job_1789759147125_p08djwhbl declared NONE while its
 * story turns on an invented raven — the antagonist — plus a baker.
 */
describe('the invented allowance is checked against what the book has', () => {
  const pages = plan([[1, 'Levin'], [2, 'raven'], [3, 'baker'], [4, 'tinker']]);
  const r = roster([[1, ['Levin']], [2, ['raven']], [3, ['baker']], [4, ['tinker']]]);

  it('an arc that declares NONE while the plan names three is over an allowance of two', () => {
    const res = run(pages, r, [], 2);
    expect(codes(res)).toContain('ARC_INVENTED_UNDECLARED');
    expect(codes(res)).toContain('ARC_INVENTED_OVER_ALLOWANCE');
    const line = lineFor(res, 'ARC_INVENTED_OVER_ALLOWANCE');
    expect(line).toContain('the book carries 3 invented figures');
    expect(line).toContain('the arc did not name');
  });

  it('honest declaration over the allowance still reports, as it always did', () => {
    const res = run(pages, r, ['raven', 'baker', 'tinker'], 2);
    expect(codes(res)).toContain('ARC_INVENTED_OVER_ALLOWANCE');
    expect(codes(res)).not.toContain('ARC_INVENTED_UNDECLARED');
  });

  it('under-declared but WITHIN the allowance is undeclared only, never over', () => {
    const two = plan([[1, 'Levin'], [2, 'raven'], [3, 'baker']]);
    const tr = roster([[1, ['Levin']], [2, ['raven']], [3, ['baker']]]);
    const res = run(two, tr, [], 2);
    expect(codes(res)).toContain('ARC_INVENTED_UNDECLARED');
    expect(codes(res)).not.toContain('ARC_INVENTED_OVER_ALLOWANCE');
  });

  it('an honest arc inside its allowance reports neither', () => {
    const two = plan([[1, 'Levin'], [2, 'raven']]);
    const tr = roster([[1, ['Levin']], [2, ['raven']]]);
    const res = run(two, tr, ['raven'], 2);
    expect(codes(res)).not.toContain('ARC_INVENTED_UNDECLARED');
    expect(codes(res)).not.toContain('ARC_INVENTED_OVER_ALLOWANCE');
  });

  it('no allowance recorded means no allowance finding', () => {
    const res = run(pages, r, [], null);
    expect(codes(res)).not.toContain('ARC_INVENTED_OVER_ALLOWANCE');
  });
});

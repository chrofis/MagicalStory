import { describe, it, expect } from 'vitest';

const { semanticFindings } = require('../../server/lib/repairLogic');

// `semanticResult` exposes the judge's findings under two names, `issues` and
// `semanticIssues`. Every reader used `a || b` — and an empty-but-present array
// is TRUTHY, so `issues: []` short-circuits and the findings in `semanticIssues`
// are never seen. A reader written as `a?.length || b?.length` falls through
// correctly, because 0 is falsy.
//
// That split is why a page could be ROUTED to repair and then found to have
// nothing to repair. decideRepairMethod counted with `.length` and saw the
// findings; inpaintPage took the arrays and saw none, returning "no issues to
// fix" — with no error, so the round recorded only "inpaint produced no result".
//
// Measured over 3669 stored semanticResult objects on staging: `issues` is
// populated ZERO times, `semanticIssues` 2348 times, and the two are never both
// populated — so preferring the non-empty list is behaviour-preserving at every
// call site. 674 of 1094 pages (61.6%) carried findings only the legacy field
// held; on 116 of them the page had no quality findings either, so repair could
// see nothing at all, and 39 of those shipped scoring below 70.
//
// These pin the resolver's contract, not any field's name.

const finding = (type: string) => ({ type, severity: 'MAJOR', description: type + ' is wrong' });

describe('semanticFindings — one resolver for the judge\'s two field names', () => {
  it('reads the legacy field when the primary one is an EMPTY array', () => {
    // The whole bug in one case: [] is truthy, so `a || b` returned [].
    const sem = { issues: [], semanticIssues: [finding('emotion'), finding('missing_element')] };
    expect(semanticFindings(sem)).toHaveLength(2);
  });

  it('reads the primary field when it carries findings', () => {
    const sem = { issues: [finding('emotion')], semanticIssues: [] };
    expect(semanticFindings(sem)).toHaveLength(1);
  });

  it('prefers the primary field when both carry findings', () => {
    const sem = { issues: [finding('a')], semanticIssues: [finding('b'), finding('c')] };
    expect(semanticFindings(sem)).toHaveLength(1);
    expect(semanticFindings(sem)[0].type).toBe('a');
  });

  it('returns an empty array when neither carries anything', () => {
    expect(semanticFindings({ issues: [], semanticIssues: [] })).toEqual([]);
    expect(semanticFindings({})).toEqual([]);
  });

  it('never throws on a missing or malformed result', () => {
    for (const junk of [null, undefined, 0, 'x', { issues: 'nope' }, { semanticIssues: 7 }]) {
      expect(Array.isArray(semanticFindings(junk as never))).toBe(true);
      expect(semanticFindings(junk as never)).toHaveLength(0);
    }
  });

  it('agrees with a length-based count — the asymmetry that caused this', () => {
    // The router counted correctly by accident (`a?.length || b?.length`, 0 is
    // falsy); the executor took the arrays and did not. Both now go through here.
    const sem = { issues: [], semanticIssues: [finding('emotion'), finding('scale'), finding('setting')] };
    const legacyRouterCount = (sem.issues?.length || sem.semanticIssues?.length || 0);
    expect(semanticFindings(sem).length).toBe(legacyRouterCount);
    expect(semanticFindings(sem).length).toBe(3);
  });

  it('returns the array itself, not a copy that drops fields', () => {
    const issues = [finding('emotion')];
    const sem = { issues: [], semanticIssues: issues };
    expect(semanticFindings(sem)[0]).toBe(issues[0]);
  });
});

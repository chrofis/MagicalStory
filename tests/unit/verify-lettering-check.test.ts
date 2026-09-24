/**
 * verify-checks.js letteringFindings — reads the stored `letteringInventory`
 * (what the undeclared-lettering check compared, per version) and decides the
 * `lettering-check-findings` registry entry automatically. Before the record
 * existed, a run with zero lettering-check findings could not be told from a
 * run where the check never ran.
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checks } = require('../../scripts/admin/verify-checks.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkUndeclaredLettering, letteringRecord } = require('../../server/lib/letteringCheck.js');

const item = (text: string, placement: string, spelling: string, surface = 'a wall') => ({ text, surface, position: 'left', placement, spelling });

/** A version exactly as the pipeline stores it: the record + the check's own findings. */
function version(lettering: any[], declared: string[] = [], extraFindings: any[] = []) {
  return {
    letteringInventory: letteringRecord({ lettering, declared }),
    fixableIssues: [...checkUndeclaredLettering({ lettering, declared }), ...extraFindings],
  };
}
const run = (...vs: any[]) => ({ data: { sceneImages: [{ pageNumber: 6, imageVersions: vs }] } });

describe('letteringFindings', () => {
  it('not covered when no version stored the record (check never ran / old run)', () => {
    const r = checks.letteringFindings(run({ fixableIssues: [] }));
    expect(r.covered).toBe(false);
  });

  it('covered pass when the inventory saw no writing — told apart from "never ran"', () => {
    const r = checks.letteringFindings(run(version([])));
    expect(r.covered).toBe(true);
    expect(r.pass).toBe(true);
  });

  it('pass when every undeclared overlay / misspelled / misplaced item has its finding and a fitting sign has none', () => {
    const r = checks.letteringFindings(run(version([
      item('TENSE BUT QUIET STANDOFF', 'overlay', 'correct', 'white label'),
      item('BAKRY', 'fits', 'misspelled', 'shop sign'),
      item('REX', 'misplaced', 'correct', 'the dog'),
      item('xq~k', 'misplaced', 'scribble'),
      item('TAXI', 'fits', 'correct', 'car roof'),
      item('ABC', 'overlay', 'correct'),
    ], ['ABC'])));
    expect(r.covered).toBe(true);
    expect(r.pass).toBe(true);
  });

  it('fails when a required finding is missing from the stored version', () => {
    const v = version([item('TENSE BUT QUIET STANDOFF', 'overlay', 'correct')]);
    v.fixableIssues = [];
    const r = checks.letteringFindings(run(v));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/TENSE BUT QUIET STANDOFF/);
  });

  it('fails when a fits + correct sign was charged', () => {
    const v = version([item('TAXI', 'fits', 'correct', 'car roof')], [], [
      { type: 'rendered_text', severity: 'CRITICAL', source: 'lettering-check', description: 'Lettering "TAXI" is painted on something that would not carry it.' },
    ]);
    const r = checks.letteringFindings(run(v));
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/fits\+correct/);
  });

  it('a declared string needs no finding', () => {
    const r = checks.letteringFindings(run(version([item('A B C', 'misplaced', 'correct', 'wooden blocks')], ['ABC'])));
    expect(r.pass).toBe(true);
  });
});

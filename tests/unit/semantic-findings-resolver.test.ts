import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const { semanticFindings } = require('../../server/lib/repairLogic');

// ONE FIELD (owner, 2026-09-20: "unify this, delete the other variables").
//
// `semanticResult` is produced by sceneValidator.evaluateSemanticFidelity, which
// returns {score, verdict, semanticIssues, usage}. It has NEVER emitted an
// `issues` field. Five readers guarded for one anyway — and because an
// empty-but-present array is TRUTHY, `a || b` written in that order returned the
// empty one and the findings were never seen, while `a?.length || b?.length`
// fell through correctly because 0 is falsy.
//
// That split is why a page could be ROUTED to repair and then found to have
// nothing to repair: decideRepairMethod counted with `.length` and saw the
// findings; inpaintPage took the arrays and saw none, returning "no issues to
// fix" with no error — so the round could only report "inpaint produced no
// result", naming a component that had never been called.
//
// Measured before the change: over 3669 stored semanticResult objects, `issues`
// was populated ZERO times and `semanticIssues` 2348; 674 of 1094 pages (61.6%)
// carried findings only through the field the executor did not read.
//
// `semanticResult.issues` is now deleted everywhere, server and client. These
// pin that there is exactly one field, and that this accessor is the only place
// that knows its name.

const finding = (type: string) => ({ type, severity: 'MAJOR', description: type + ' is wrong' });
const SRC = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

describe('semanticFindings — the one accessor for the judge\'s findings', () => {
  it('returns the findings', () => {
    expect(semanticFindings({ semanticIssues: [finding('emotion'), finding('scale')] })).toHaveLength(2);
  });

  it('returns an empty array when there are none', () => {
    expect(semanticFindings({ semanticIssues: [] })).toEqual([]);
    expect(semanticFindings({})).toEqual([]);
  });

  it('ignores a phantom `issues` field entirely', () => {
    // The deleted name must not come back through the accessor either: a stray
    // `issues` on some caller's object is not the judge's output.
    const sem = { issues: [finding('a'), finding('b')], semanticIssues: [finding('real')] };
    expect(semanticFindings(sem)).toHaveLength(1);
    expect(semanticFindings(sem)[0].type).toBe('real');
    expect(semanticFindings({ issues: [finding('a')] })).toEqual([]);
  });

  it('never throws on a missing or malformed result', () => {
    for (const junk of [null, undefined, 0, 'x', { semanticIssues: 'nope' }, { semanticIssues: 7 }]) {
      expect(Array.isArray(semanticFindings(junk as never))).toBe(true);
      expect(semanticFindings(junk as never)).toHaveLength(0);
    }
  });

  it('returns the array itself, not a copy that drops fields', () => {
    const issues = [finding('emotion')];
    expect(semanticFindings({ semanticIssues: issues })[0]).toBe(issues[0]);
  });
});

describe('the deleted field is gone from every reader', () => {
  const FILES = [
    'server/lib/repairLogic.js',
    'server/lib/images.js',
    'server/lib/repairPipeline.js',
    'server/lib/scoring.js',
    'server/lib/feedbackConsolidator.js',
    'server/routes/regeneration.js',
    'client/src/hooks/useRepairWorkflow.ts',
  ];

  it('no file reads or writes semanticResult.issues', () => {
    for (const f of FILES) {
      const src = SRC(f);
      expect(src, f).not.toMatch(/semanticResult\?\.issues/);
      expect(src, f).not.toMatch(/semanticResult\.issues/);
    }
  });

  it('every repair reader that had the two-field fallback now calls the accessor', () => {
    // Scoped to the repair path, where the bug lived. The eval pipeline BUILDS
    // semanticResult and the UI DISPLAYS it; both name the field directly and
    // should — an accessor cannot reach the client, and the producer owns the
    // shape.
    for (const f of ['server/lib/images.js', 'server/lib/repairPipeline.js',
      'server/lib/feedbackConsolidator.js', 'server/routes/regeneration.js']) {
      expect(SRC(f), f).toMatch(/semanticFindings\(/);
    }
  });

  it('the accessor is the only place in repairLogic that names the field', () => {
    const src = SRC('server/lib/repairLogic.js');
    expect(src.split('semanticResult?.semanticIssues').length - 1).toBe(1);
  });
});

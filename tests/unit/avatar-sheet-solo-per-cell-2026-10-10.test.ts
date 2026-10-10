// Extra people are an enum answer per cell (prompts/sheet-row-cells-eval.txt `others`), computed into the solo axis.
// docs/decisions.md 2026-10-10. Regression: Julian job_1791531449494_o0kaatvmq scored solo 9 over two painted-in adults.
import { describe, it, expect } from 'vitest';
const sheetMod: any = require('../../server/lib/character2x4Sheet.js');
const { mergeRowObservations, applyStyledSheetConsistencyAxes, scoreStyleReport } = sheetMod._internal;
import fs from 'fs';
import path from 'path';

const row = (others: string[]) => ({ report: { cells: Object.fromEntries(others.map((o, i) => [`cell${i + 1}`, { medium: 'illustrated', hair: 'match', person: 'same', others: o }])) } });
const base = () => ({ solo: { score: 9 }, background: { score: 9 }, identityScore: 9, styleScore: 9, layoutScore: 9, cleanScore: 9, bodyFaceScore: 9, ageScore: 9, garmentScore: 9, soloScore: 9, backgroundScore: 9 });

describe('per-cell others -> solo axis', () => {
  it('any cell with another person fails solo even when the whole-sheet judge said 9', () => {
    const r: any = mergeRowObservations(base(), row(['none', 'present', 'none', 'none']), row(['none', 'none', 'none', 'present']));
    applyStyledSheetConsistencyAxes(r);
    expect(r.soloScore).toBe(1);
    expect(r.failureReasons.join(' ')).toMatch(/solo: cell2, cell8/);
    expect(scoreStyleReport(r).finalScore).toBe(1);
  });
  it('all cells none leaves the whole-sheet solo score alone', () => {
    const r: any = mergeRowObservations(base(), row(['none', 'none', 'none', 'none']), row(['none', 'none', 'none', 'none']));
    applyStyledSheetConsistencyAxes(r);
    expect(r.soloScore).toBe(9);
  });
  it('the whole-sheet score still counts when lower', () => {
    const b: any = base(); b.soloScore = 2;
    const r: any = mergeRowObservations(b, row(['none', 'none', 'none', 'none']), row(['none', 'none', 'none', 'none']));
    applyStyledSheetConsistencyAxes(r);
    expect(r.soloScore).toBe(2);
  });
  it('the row prompt asks for the enum', () => {
    expect(fs.readFileSync(path.join(__dirname, '../../prompts/sheet-row-cells-eval.txt'), 'utf8')).toMatch(/"others": "<none\|present>"/);
  });
});

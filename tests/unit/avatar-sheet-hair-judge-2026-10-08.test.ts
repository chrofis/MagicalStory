/**
 * Fiona rerun job_1791450210539_nwi88y9lr (2026-10-08): the styled-row hair judge returned 'differs' for all 8 cells of
 * Fiona's sheet on both attempts, and the verdict could not be reproduced from the stored sheet and the stored hair
 * string (12 offline repeats, 0 of 96 cells). The stored record held only the per-cell words, so nobody could read WHAT the
 * judge saw. The rows' own reasons (hair colour, down / up / ponytail / hidden, the parting seen) now ride with the
 * verdict in `report.hair.reason`.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');
const sheetMod = require('../../server/lib/character2x4Sheet');
const { mergeRowObservations } = sheetMod._internal;

beforeAll(async () => { await loadPromptTemplates(); });

const cells = (v: string) => Object.fromEntries([1, 2, 3, 4].map(k => [`cell${k}`, { medium: 'illustrated', hair: v, person: 'same' }]));

describe('the hair verdict carries the judge\'s own reading', () => {
  it('both rows\' reasons are kept on report.hair next to the per-cell words', () => {
    const top = { report: { cells: cells('match'), letteringSeen: false, letteringQuoted: 'none', reason: 'cell1: light brown; down; parting not seen; no glasses; illustrated' } };
    const bottom = { report: { cells: cells('differs'), letteringSeen: false, letteringQuoted: 'none', reason: 'cell5: light brown; ponytail; parting not seen; no glasses; illustrated' } };
    const r = mergeRowObservations({}, top, bottom);
    expect(r.hair.perCell.cell1).toBe('match');
    expect(r.hair.perCell.cell5).toBe('differs');
    expect(r.hair.reason).toContain('heads: cell1: light brown; down');
    expect(r.hair.reason).toContain('bodies: cell5: light brown; ponytail');
  });

  it('a row that gave no reason adds none, and the perCell words stay', () => {
    const r = mergeRowObservations({}, { report: { cells: cells('match') } }, { report: { cells: cells('match') } });
    expect(r.hair.reason).toBeUndefined();
    expect(Object.keys(r.hair.perCell)).toHaveLength(8);
  });

  it('the row-cells judge asks for the hair style and the parting it saw in each cell\'s reason, after the verdicts', () => {
    const t = String(PROMPT_TEMPLATES.sheetRowCellsEval);
    expect(t).toMatch(/hair down, up, in a ponytail or hidden/);
    expect(t).toMatch(/parting centre, side or none, never which side/);
    // the reason follows the cells in the JSON shape, so it can never steer the per-cell answers
    expect(t.indexOf('"cells"')).toBeLessThan(t.indexOf('"reason"'));
  });
});

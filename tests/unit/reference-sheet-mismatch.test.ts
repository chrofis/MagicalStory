/**
 * The three reference-sheet faults measured in staging story
 * job_1789147573901_m3uam0nxi (2026-09-11):
 *
 *  1. `vb_sheet_layout_mismatch` three times in one run (9 cells for 3
 *     requested, 2 for 3, 6 for 2). On the 2-for-3 sheet the detector merged
 *     three stacked panels into one "cell" and the identification call named
 *     it for a single element, so the stored reference for that entry showed a
 *     signpost, a cave wall and a boulder at once.
 *  2. `vb_state_cells_rerender` / `vb_state_cells_still_bad` with a WORD-FOR-
 *     WORD identical reason — the re-render was never told what failed.
 *  3. Both state cells of a creature entry drew four children and a dog,
 *     because its description named them to convey the creature's size.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const { rejectMultiPanelAssignments } = require('../../server/lib/sheetGrid');
const { buildReferenceSheetPrompt } = require('../../server/lib/referenceSheets');
const prompts = require('../../server/services/prompts');

beforeAll(async () => { await prompts.loadPromptTemplates(); });

describe('grid mismatch — a merged cell yields no reference', () => {
  it('drops the element whose cell holds several panels (2 cells drawn for 3 elements)', () => {
    // Cell A merged three stacked panels; cell B is the blank margin column.
    const { map, dropped } = rejectMultiPanelAssignments([0, null, null], [3, 1]);
    expect(map).toEqual([null, null, null]);
    expect(dropped).toEqual([{ element: 0, cell: 0, panels: 3 }]);
  });

  it('keeps single-panel cells when the model drew MORE cells than asked (9 for 3)', () => {
    const map = [4, 0, 8];
    const { map: safe, dropped } = rejectMultiPanelAssignments(map, new Array(9).fill(1));
    expect(safe).toEqual(map);
    expect(dropped).toEqual([]);
  });

  it('drops only the untrustworthy assignment (6 cells drawn for 2 elements)', () => {
    const { map, dropped } = rejectMultiPanelAssignments([1, 4], [1, 2, 1, 1, 1, 1]);
    expect(map).toEqual([null, 4]);
    expect(dropped.map(d => d.element)).toEqual([0]);
  });

  it('never invents a drop for an unmatched element', () => {
    const { map, dropped } = rejectMultiPanelAssignments([null, 2], [1, 1, 1]);
    expect(map).toEqual([null, 2]);
    expect(dropped).toEqual([]);
  });
});

describe('re-render carries the gate reason', () => {
  const el = [{ id: 'ART001', name: 'Prop', type: 'artifact', description: 'a small wooden box' }];

  it('quotes the judge reason it was given', () => {
    const reason = 'The object in the second image is a darker shade than in the first';
    const prompt = buildReferenceSheetPrompt(el, 'watercolor', null, reason);
    expect(prompt).toContain(reason);
    expect(prompt).toMatch(/PREVIOUS ATTEMPT REJECTED/);
  });

  it('says nothing about a previous attempt on a first render', () => {
    const prompt = buildReferenceSheetPrompt(el, 'watercolor', null);
    expect(prompt).not.toMatch(/PREVIOUS ATTEMPT/i);
  });
});

describe('cell prompt bans scale props', () => {
  it('instructs that only the element itself is drawn', () => {
    const prompt = buildReferenceSheetPrompt(
      [{ id: 'CHR001', name: 'Creature', type: 'animal', description: 'a winged creature' }],
      'watercolor',
      null,
    );
    expect(prompt).toMatch(/Only the element itself is drawn/);
    expect(prompt).toMatch(/size or scale is never drawn/);
  });
});

// Regression: staging job_1789147573901_m3uam0nxi, Lab experiments 1189/1190.
// A cell rendered the everyday object the entry's bare geometry describes
// rather than the object the entry names.
describe('cell prompt requires the drawing to read as the named element', () => {
  it('binds every cell to its own identity, not to a lookalike', () => {
    const prompt = buildReferenceSheetPrompt(
      [{ id: 'ART001', name: 'a hand tool', type: 'hand tool', description: 'a short shaft with a flat head' }],
      'watercolor',
      null,
    );
    expect(prompt).toMatch(/Each cell reads as the element it is named as/);
    expect(prompt).toMatch(/also fit a commoner everyday object, the cell shows the named one/);
  });

  it('does not re-add drawing the thing a description compares the element to', () => {
    const prompt = buildReferenceSheetPrompt(
      [{ id: 'ART001', name: 'a piece of tableware', type: 'tableware', description: 'a shallow round dish' }],
      'watercolor',
      null,
    );
    expect(prompt).toMatch(/size or scale is never drawn/);
    expect(prompt).not.toMatch(/draw the thing it is compared to/i);
  });
});

/**
 * Owner call 2026-10-24: a Visual Bible sheet that draws an element's STATE cells renders on
 * MODEL_DEFAULTS.vbStateCellModel (Grok 2: 5/5 state sheets vs Grok 1 3/5). Every other batch keeps the caller's
 * override. The mark is structural (cells minted by expandElementStateCells carry `stateName`).
 */
import { describe, it, expect } from 'vitest';

const RS = require('../../server/lib/referenceSheets');
const { MODEL_DEFAULTS } = require('../../server/config/models');

const stated = {
  id: 'ART001', name: 'old gate', type: 'artifact', description: 'a wooden gate with a latch',
  states: [
    { id: 'ART001.1', name: 'intact', delta: 'plain latch', description: 'a wooden gate with a plain latch', removed: [], pages: [1] },
    { id: 'ART001.2', name: 'broken', delta: 'snapped latch', description: 'a wooden gate with a snapped latch', removed: ['the latch'], pages: [2] },
  ],
};
const plain = (id: string, name: string) => ({ id, name, type: 'artifact', description: 'a lamp' });

describe('reference sheet batch model', () => {
  it('config key is Grok 2', () => {
    expect(MODEL_DEFAULTS.vbStateCellModel).toBe('grok-imagine-2');
  });
  it('a state batch picks vbStateCellModel, even over an override', () => {
    const cells = RS.expandElementStateCells(stated);
    expect(RS.isStateCellBatch(cells)).toBe(true);
    expect(RS.referenceSheetBatchModel(cells, null)).toBe(MODEL_DEFAULTS.vbStateCellModel);
    expect(RS.referenceSheetBatchModel(cells, 'grok-imagine')).toBe(MODEL_DEFAULTS.vbStateCellModel);
  });
  it('a plain batch keeps the override / default', () => {
    const batch = [plain('ART002', 'lamp'), plain('ART003', 'cup')];
    expect(RS.isStateCellBatch(batch)).toBe(false);
    expect(RS.referenceSheetBatchModel(batch, null)).toBeNull();
    expect(RS.referenceSheetBatchModel(batch, 'grok-imagine')).toBe('grok-imagine');
  });
  it('a text cell keeps the text tier', () => {
    expect(RS.referenceSheetBatchModel([{ ...plain('ART004', 'sign'), text: 'OPEN' }], null)).toBe(MODEL_DEFAULTS.vbTextCellModel);
  });
  it('batching never mixes a state object with unrelated elements', () => {
    const batches = RS.buildReferenceSheetBatches([stated, plain('ART002', 'lamp'), plain('ART003', 'cup')], {});
    const stateBatches = batches.filter((b: any[]) => RS.isStateCellBatch(b));
    expect(stateBatches).toHaveLength(1);
    expect(stateBatches[0].every((c: any) => String(c.id).startsWith('ART001.'))).toBe(true);
    expect(batches.filter((b: any[]) => !RS.isStateCellBatch(b)).flat().some((c: any) => c.stateName)).toBe(false);
  });
});

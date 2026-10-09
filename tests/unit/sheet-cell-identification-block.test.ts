/**
 * Staging job_1791560888615_uaivmr21o (Lina): the cell-identification call
 * failed 4 times with "reply contained no JSON object". The real reply was
 * HTTP 200 + promptFeedback.blockReason PROHIBITED_CONTENT (0 output tokens):
 * Gemini's minor-safety filter fires on a child's age wording together with a
 * full wardrobe paragraph. Re-run on the stored sheet: the full description
 * blocked 5/5, the same line with ONE garment passed 5/5.
 *  - the element line sent for a character carries one garment, not the wardrobe
 *  - a blocked reply is reported as a block, with its literal reason
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import sharp from 'sharp';

const { sheetCellIdentityLine, identifySheetCellsImpl } = require('../../server/lib/referenceSheets');
const prompts = require('../../server/services/prompts');

beforeAll(async () => { await prompts.loadPromptTemplates(); });
afterEach(() => { vi.unstubAllGlobals(); });

const LINA = 'a girl of about five. small, slim child, a head shorter than Serafin. hair: light brown, in two short pigtails tied with red hair bands. round face, brown eyes, a few freckles on the nose. Signature: two short pigtails with red hair bands. Clothing: mustard-yellow knitted cardigan, dark green trousers, small red rubber boots';

describe('sheetCellIdentityLine', () => {
  it('names a character by identity plus ONE garment', () => {
    const line = sheetCellIdentityLine({ description: LINA });
    expect(line).toContain('two short pigtails');
    expect(line).toContain('Wearing: mustard-yellow knitted cardigan');
    expect(line).not.toContain('trousers');
    expect(line).not.toContain('rubber boots');
    expect(line).not.toMatch(/Clothing:/);
  });
  it('leaves a non-character description and an unnamed element alone', () => {
    expect(sheetCellIdentityLine({ description: 'a grey cloth belt with a red thread' })).toBe('a grey cloth belt with a red thread');
    expect(sheetCellIdentityLine({ name: 'Anchor' })).toBe('Anchor');
    expect(sheetCellIdentityLine({}, 2)).toBe('element 3');
  });
});

describe('identifySheetCellsImpl: a blocked prompt', () => {
  it('throws the literal block reason, not "no JSON object"', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const img = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ccc' } }).png().toBuffer();
    vi.stubGlobal('fetch', async () => ({
      ok: true, status: 200,
      json: async () => ({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 532, totalTokenCount: 532 } }),
    }));
    const cells = [{ index: 0, row: 0, col: 0, left: 0, top: 0, width: 64, height: 64 }];
    await expect(identifySheetCellsImpl(img, cells, [{ description: LINA }])).rejects.toThrow(/PROHIBITED_CONTENT/);
  });
});

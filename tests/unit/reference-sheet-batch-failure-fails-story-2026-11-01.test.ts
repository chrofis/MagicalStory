import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const sharp: any = nodeRequire('sharp');
const images: any = nodeRequire('../../server/lib/images.js');
const rs: any = nodeRequire('../../server/lib/referenceSheets.js');

// Prod job_1793561351885_kkg5gxkbj: a reference-sheet batch failed, the catch only counted
// failed++ and the pipeline never read it, so an invented character was drawn from words alone.
// Owner 2026-11-01: re-render each element SOLO once, then fail the story loudly.
async function png() {
  const buf = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toBuffer();
  return 'data:image/png;base64,' + buf.toString('base64');
}
const bible = (pagesB: number[] = [2]) => ({
  secondaryCharacters: [
    { id: 'CHR001', name: 'Nerina', description: 'a small mermaid', appearsInPages: [1, 2] },
    { id: 'CHR002', name: 'Otto', description: 'an old fisherman', appearsInPages: pagesB },
  ],
  artifacts: [], animals: [], vehicles: [], locations: [],
});
const run = (vb: any) => rs.generateReferenceSheet(vb, 'watercolor', { minAppearances: 2, characterMinAppearances: 1, maxPerBatch: 4, renderGate: false });
const errorEvents: any[] = [];
const genLog = { error: (...a: any[]) => errorEvents.push(a), warn: vi.fn(), info: vi.fn() };

beforeEach(() => { errorEvents.length = 0; });

describe('a batch that throws is re-rendered per element, solo', () => {
  it('batch fails, solo renders succeed: every element gets its reference', async () => {
    const img = await png();
    let call = 0;
    const spy = vi.spyOn(images, 'callGeminiAPIForImage').mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error('content moderated');
      return { imageData: img };
    });
    const vb = bible();
    const res = await run(vb);
    spy.mockRestore();
    expect(call).toBe(3); // 1 batch + one solo per element
    expect(res.failed).toBe(0);
    expect(res.generated).toBe(2);
    expect(() => rs.assertReferenceSheetComplete(res, genLog)).not.toThrow();
  });

  it('batch fails and solo fails for a page-bound element: the story fails with the error event', async () => {
    const spy = vi.spyOn(images, 'callGeminiAPIForImage').mockImplementation(async () => { throw new Error('refused'); });
    const res = await run(bible());
    spy.mockRestore();
    expect(res.failed).toBe(2);
    expect(() => rs.assertReferenceSheetComplete(res, genLog)).toThrow(rs.MissingReferenceSheetError);
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0][0]).toBe('vb_sheet_no_reference_fatal');
    expect(errorEvents[0][1]).toContain('CHR001');
    expect(errorEvents[0][1]).toContain('CHR002');
  });
});

describe('assertReferenceSheetComplete', () => {
  it('an element on no page does not fail the story', () => {
    const res = { generated: 1, failed: 1, elements: [{ id: 'A', name: 'A', success: true, pages: [1] }, { id: 'B', name: 'B', success: false, pages: [] }] };
    expect(() => rs.assertReferenceSheetComplete(res, genLog)).not.toThrow();
    expect(errorEvents.length).toBe(0);
  });
  it('a rejected generation promise is a failure, not {generated:0, failed:0}', async () => {
    const settled = await rs.settleReferenceSheet(Promise.reject(new Error('boom')));
    expect(settled.fatalError).toBe('boom');
    expect(() => rs.assertReferenceSheetComplete(settled, genLog)).toThrow(rs.MissingReferenceSheetError);
    expect(errorEvents[0][0]).toBe('vb_sheet_failed');
  });
  it('a clean result passes', async () => {
    const settled = await rs.settleReferenceSheet(Promise.resolve({ generated: 0, failed: 0, elements: [] }));
    expect(() => rs.assertReferenceSheetComplete(settled, genLog)).not.toThrow();
  });
});

describe('the pipeline join (trial and full share it)', () => {
  it('asserts the result and no longer swallows a rejection into zeros', () => {
    const fs = nodeRequire('node:fs');
    const pipe = fs.readFileSync(nodeRequire('node:path').join(__dirname, '../../storyJobPipeline.js'), 'utf8');
    expect(pipe).toMatch(/const refResult = await referenceSheetPromise;\s*[\s\S]{0,300}assertReferenceSheetComplete\(refResult, genLog\)/);
    expect(pipe).not.toMatch(/return \{ generated: 0, failed: 0, elements: \[\] \};\s*\}\);/);
    expect(pipe).toContain("settleReferenceSheet(trialReferenceSheetPromise, 'TRIAL')");
    expect(pipe).toContain("settleReferenceSheet(referenceSheetPromise, 'UNIFIED')");
  });
});

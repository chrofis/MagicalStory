import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
// @ts-expect-error - JS module without types
import { measureChange, isNoop, pasteBackOutside, targetBoxesForFixes } from '../../server/lib/inpaintTarget.js';

const S = 256;
async function img(paint: (x: number, y: number) => [number, number, number]) {
  const buf = Buffer.alloc(S * S * 3);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const [r, g, b] = paint(x, y); const i = (y * S + x) * 3; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; }
  const j = await sharp(buf, { raw: { width: S, height: S, channels: 3 } }).png().toBuffer();
  return `data:image/png;base64,${j.toString('base64')}`;
}
const base = (x: number, y: number): [number, number, number] => [(x * 255) / S | 0, (y * 255) / S | 0, 120];
const BOX = [0.3, 0.3, 0.6, 0.6];  // ymin xmin ymax xmax

describe('inpaintTarget', () => {
  it('a whole-frame edit with a changed target is not a no-op; the collateral outside is measured', async () => {
    const before = await img(base);
    // edit: target square recoloured, plus collateral stripe far outside
    const after = await img((x, y) => (x > 90 && x < 150 && y > 90 && y < 150) ? [255, 0, 0] : (x > 200 ? [0, 255, 0] : base(x, y)));
    const m = await measureChange(before, after, [BOX]);
    expect(isNoop(m)).toBe(false);
    expect(m.outsideChangedCells).toBeGreaterThan(0);
  });
  it('an edit that left the target untouched is a no-op even if the rest of the frame moved', async () => {
    const before = await img(base);
    const after = await img((x, y) => (x > 200 ? [0, 255, 0] : base(x, y)));
    expect(isNoop(await measureChange(before, after, [BOX]))).toBe(true);
  });
  it('paste-back restores the original outside the box and keeps the edit inside it', async () => {
    const before = await img(base);
    const after = await img((x, y) => (x > 90 && x < 150 && y > 90 && y < 150) ? [255, 0, 0] : (x > 200 ? [0, 255, 0] : base(x, y)));
    const pasted = await pasteBackOutside(before, after, [BOX]);
    expect(pasted).toBeTruthy();
    const m = await measureChange(before, pasted, [BOX]);
    expect(m.outsideChangedCells).toBe(0);
    expect(m.insideChangedCells).toBeGreaterThan(0);
  });
  it('refuses to overlay a frame of a different shape', async () => {
    const before = await img(base);
    const wide = await sharp(Buffer.alloc(S * 128 * 3, 200), { raw: { width: S, height: 128, channels: 3 } }).png().toBuffer();
    expect(await pasteBackOutside(before, `data:image/png;base64,${wide.toString('base64')}`, [BOX])).toBeNull();
  });
  it('boxes: every fix must be addressable and no scene-wide fix may ride along', () => {
    const figures = [{ name: 'Mia', bodyBox: BOX }, { name: 'Noa', bodyBox: [0.1, 0.1, 0.2, 0.2] }];
    expect(targetBoxesForFixes({ fixes: [{ characterName: 'Mia' }], hasSceneFix: false, figures })).toEqual([BOX]);
    expect(targetBoxesForFixes({ fixes: [{ characterName: 'Mia' }], hasSceneFix: true, figures })).toBeNull();
    expect(targetBoxesForFixes({ fixes: [{ characterName: 'Mia' }, { characterName: 'Ghost' }], hasSceneFix: false, figures })).toBeNull();
    expect(targetBoxesForFixes({ fixes: [], hasSceneFix: false, figures })).toBeNull();
  });
});

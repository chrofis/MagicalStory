/**
 * The garment recolour must never move skin (Fiona rerun, staging job_1791450210539_nwi88y9lr
 * p16): a sleeveless top's detector mask took the figure's arms and neck, the "garment" mean was
 * skin, and a cream->white fix hue-shifted bare skin by deltaE 22.4 over 16,369 px. 87% of the
 * pixels it moved were within deltaE 18 of the figure's own skin.
 */
import { describe, it, expect } from 'vitest';

const gcf = require('../../server/lib/garmentColourFix');

const W = 40, H = 40;
function crop(fill: (x: number, y: number) => [number, number, number]) {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = fill(x, y);
    const i = (y * W + x) * 3; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
  }
  return raw;
}
const SKIN: [number, number, number] = [222, 170, 140];
const CREAM: [number, number, number] = [245, 236, 205];
const { _rgbToLab } = require('../../server/lib/imageCompositing');
const lab = (c: number[]) => { const l = _rgbToLab(c[0], c[1], c[2]); return { L: l[0], a: l[1], b: l[2] }; };

describe('removeSkinFromMask', () => {
  it('removes skin-coloured pixels and keeps garment pixels', () => {
    // left half skin (arms), right half cream (the garment)
    const raw = crop((x) => (x < 20 ? SKIN : CREAM));
    const alpha = Buffer.alloc(W * H, 255);
    const r = gcf.removeSkinFromMask(alpha, raw, lab(SKIN), gcf.DEFAULTS.selectSkinMargin);
    expect(r.total).toBe(W * H);
    expect(r.removed).toBe(W * H / 2);
    expect(r.share).toBeCloseTo(0.5);
    expect(r.alpha[0]).toBe(0);
    expect(r.alpha[W - 1]).toBe(255);
    expect(alpha[0]).toBe(255); // input not mutated
  });

  it('a mask that is mostly skin exceeds the refusal share', () => {
    const raw = crop((x) => (x < 34 ? SKIN : CREAM)); // 85% skin, as measured on the p16 recolour
    const r = gcf.removeSkinFromMask(Buffer.alloc(W * H, 255), raw, lab(SKIN), gcf.DEFAULTS.selectSkinMargin);
    expect(r.share).toBeGreaterThan(gcf.DEFAULTS.maxSkinShare);
  });

  it('a clean garment mask is untouched', () => {
    const raw = crop(() => CREAM);
    const r = gcf.removeSkinFromMask(Buffer.alloc(W * H, 255), raw, lab(SKIN), gcf.DEFAULTS.selectSkinMargin);
    expect(r.removed).toBe(0);
    expect(r.share).toBe(0);
  });

  it('ignores pixels outside the mask', () => {
    const raw = crop(() => SKIN);
    const r = gcf.removeSkinFromMask(Buffer.alloc(W * H, 0), raw, lab(SKIN), 18);
    expect(r.total).toBe(0);
    expect(r.share).toBe(0);
  });
});

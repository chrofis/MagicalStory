import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// CJS registry, like the other server-side unit tests: sceneComposite pulls
// sharp and the Grok client through plain require().
const require_ = createRequire(import.meta.url);
const { _internal } = require_('../../server/lib/sceneComposite');
const { buildInPlaceRenderPrompt, matchRenderedFigureBox, dilateMask, placeholderResidueFromRaw } = _internal;

/**
 * figureMethod 'inPlace' (owner's design 2026-09-10): one Grok edit per figure
 * on the ORIGINAL plate, then a DINO+SAM cut-out matched to the silhouette box.
 * These cover the two pure pieces: the prompt and the box match.
 */
describe('buildInPlaceRenderPrompt', () => {
  const cast = { name: 'Mara', colorName: 'red', action: 'kneeling by the stream', looksAt: 'Tobi' };

  it('names the colour, the character, the action and the gaze target', () => {
    const p = buildInPlaceRenderPrompt(cast);
    expect(p).toContain('flat red silhouette placeholder');
    expect(p).toContain('reference sheet of Mara');
    expect(p).toContain('Replace the red silhouette with Mara');
    expect(p).toContain('kneeling by the stream');
    expect(p).toContain('looking at Tobi');
  });

  it('keeps the rest of the plate, including the other silhouettes', () => {
    const p = buildInPlaceRenderPrompt(cast);
    expect(p).toContain('Everything else in Image 1 stays exactly as it is, including the other coloured silhouettes.');
    expect(p).toContain('Same art style as Image 1.');
  });

  it('omits the pose sentence when there is no action and no gaze target', () => {
    const p = buildInPlaceRenderPrompt({ name: 'Mara', colorName: 'blue' });
    expect(p).not.toContain('The figure is');
    expect(p).toContain('Replace the blue silhouette with Mara');
  });

  it('scrubs Visual-Bible ids out of the action / gaze clauses', () => {
    const p = buildInPlaceRenderPrompt({ name: 'Mara', colorName: 'red', action: 'holding ART001.1', looksAt: 'CHR002' });
    expect(p).not.toContain('ART001');
    expect(p).not.toContain('CHR002');
    expect(p).not.toMatch(/\b(?:CHR|ANI|ART|LOC|VEH|CLO)\d+/);
  });
});

describe('buildInPlaceRenderPrompt refMode', () => {
  const cast = { name: 'Mara', colorName: 'red' };

  it("'sheet' (default) names a grid of views", () => {
    const p = buildInPlaceRenderPrompt(cast);
    expect(p).toContain('reference sheet of Mara: a grid of views');
    expect(buildInPlaceRenderPrompt(cast, null, { refMode: 'sheet' })).toBe(p);
  });

  it("'cell' names one reference picture and pins the facing to the silhouette", () => {
    const p = buildInPlaceRenderPrompt(cast, null, { refMode: 'cell' });
    expect(p).toContain('Image 2 is one reference picture of Mara on a plain background');
    expect(p).toContain('the silhouette, not Image 2, decides which way the figure faces');
    expect(p).not.toContain('grid of views');
    // The rest of the contract is unchanged.
    expect(p).toContain('Replace the red silhouette with Mara from Image 2');
    expect(p).toContain('Everything else in Image 1 stays exactly as it is, including the other coloured silhouettes.');
  });
});

describe('matchRenderedFigureBox', () => {
  const sil = { x: 100, y: 100, width: 100, height: 200 };

  it('picks the person box with the highest IoU against the (expanded) silhouette box', () => {
    const boxes = [
      { box: [500, 500, 560, 620], score: 0.9 },   // elsewhere
      { box: [95, 90, 210, 310], score: 0.8 },     // the rendered figure, slightly larger
      { box: [0, 0, 400, 400], score: 0.7 },       // huge, low IoU
    ];
    const m = matchRenderedFigureBox(boxes, sil);
    expect(m).not.toBeNull();
    expect(m!.index).toBe(1);
    expect(m!.box).toEqual({ x: 95, y: 90, width: 115, height: 220 });
    expect(m!.iou).toBeGreaterThan(0.5);
  });

  it('accepts plain [x0,y0,x1,y1] arrays too', () => {
    const m = matchRenderedFigureBox([[100, 100, 200, 300]], sil);
    expect(m!.index).toBe(0);
  });

  it('returns null when nothing reaches the IoU floor', () => {
    expect(matchRenderedFigureBox([{ box: [600, 600, 700, 800] }], sil)).toBeNull();
    expect(matchRenderedFigureBox([], sil)).toBeNull();
    expect(matchRenderedFigureBox([{ box: [100, 100, 200, 300] }], null as any)).toBeNull();
  });

  it('honours a custom floor', () => {
    const weak = [{ box: [170, 100, 270, 300] }];  // ~20% overlap
    expect(matchRenderedFigureBox(weak, sil)).toBeNull();
    expect(matchRenderedFigureBox(weak, sil, { minIou: 0.1 })).not.toBeNull();
  });
});

describe('dilateMask', () => {
  it('grows a single pixel into a (2r+1) square, clipped at the edges', () => {
    const W = 5, H = 5;
    const m = new Uint8Array(W * H); m[2 * W + 2] = 1;
    const d = dilateMask(m, W, H, 1);
    let n = 0; for (const v of d) n += v;
    expect(n).toBe(9);
    const e = new Uint8Array(W * H); e[0] = 1;
    let n2 = 0; for (const v of dilateMask(e, W, H, 1)) n2 += v;
    expect(n2).toBe(4);
  });
});

/**
 * Placeholder residue (Lab exp 1152): a render that left the silhouette
 * untouched, or merely re-tinted it, must not pass as a figure.
 */
describe('placeholderResidueFromRaw', () => {
  const W = 20, H = 20;
  const mask = new Uint8Array(W * H);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) mask[y * W + x] = 1;
  const fill = (r: number, g: number, b: number) => {
    const buf = Buffer.alloc(W * H * 3);
    for (let k = 0; k < W * H; k++) { buf[k * 3] = r; buf[k * 3 + 1] = g; buf[k * 3 + 2] = b; }
    return buf;
  };
  const plate = fill(230, 0, 0);   // saturated red silhouette everywhere

  it('an untouched render is 100% unchanged and 100% flat saturated', () => {
    const r = placeholderResidueFromRaw(plate, Buffer.from(plate), mask, W, H);
    expect(r.unchanged).toBe(1);
    expect(r.flatSaturated).toBe(1);
  });

  it('a re-tint (red to teal) is changed but still a flat saturated fill', () => {
    const r = placeholderResidueFromRaw(plate, fill(0, 150, 150), mask, W, H);
    expect(r.unchanged).toBe(0);
    expect(r.flatSaturated).toBe(1);
  });

  it('a textured, desaturated render is neither', () => {
    const render = Buffer.alloc(W * H * 3);
    for (let k = 0; k < W * H; k++) { const v = 80 + ((k * 37) % 90); render[k * 3] = v; render[k * 3 + 1] = v - 20; render[k * 3 + 2] = v - 30; }
    const r = placeholderResidueFromRaw(plate, render, mask, W, H);
    expect(r.unchanged).toBe(0);
    expect(r.flatSaturated).toBe(0);
  });

  it('only the silhouette mask is measured; an empty mask yields zeros', () => {
    const r = placeholderResidueFromRaw(plate, plate, new Uint8Array(W * H), W, H);
    expect(r.unchanged).toBe(0);
    expect(r.flatSaturated).toBe(0);
  });

  it('marks the leftover placeholder pixels: untouched ones, and flat ones still in the placeholder hue', () => {
    // Render: the top half of the silhouette becomes a textured, desaturated figure;
    // the bottom half stays the plate's red (uncovered placeholder).
    const render = Buffer.from(plate);
    for (let y = 5; y < 10; y++) for (let x = 5; x < 15; x++) { const k = y * W + x; const v = 90 + ((k * 31) % 60); render[k * 3] = v; render[k * 3 + 1] = v - 10; render[k * 3 + 2] = v - 25; }
    const r = placeholderResidueFromRaw(plate, render, mask, W, H, { hue: 0 });
    expect(r.unchanged).toBeCloseTo(0.5, 1);
    let marked = 0, markedTop = 0;
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) if (r.residueMask[y * W + x]) { marked++; if (y < 10) markedTop++; }
    expect(marked).toBe(50);
    expect(markedTop).toBe(0);
    // A flat fill in a DIFFERENT hue (teal over red) is not marked as leftover red.
    const teal = placeholderResidueFromRaw(plate, fill(0, 150, 150), mask, W, H, { hue: 0 });
    expect(teal.flatSaturated).toBe(1);
    expect(Array.from(teal.residueMask).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

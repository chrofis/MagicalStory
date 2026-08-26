import { describe, it, expect } from 'vitest';

// The bug this file locks down: the painted-title judge was shown a crop taken
// from the FLAT lockup's ink bounds (minx..maxx), then asked whether the MODEL'S
// painting reads correctly inside it. Those are different geometries by design —
// the repaint exists to produce bolder, wider, hand-lettered forms, which is why
// coverage/spill are diagnostics and not gates.
//
// Measured on production story job_1787689073034_1v6ew0y1kae
// ("Feurio und die vier Buben"): the flat lockup spanned x 0.045-0.521 while the
// painted title spanned x 0.234-0.762. The old crop cut 21% of the page width of
// correct lettering, the judge was shown "Feurio / die vi / Bube", and it
// truthfully answered 'The word "und" is missing.' A perfect painted title was
// discarded for the flat overlay.
//
// Replaying the real verifyTitleRender on the shipped painting confirmed both
// sides: full-width band -> {matches: true}; narrow flat-lockup crop ->
// {matches: false, 'The word "und" is missing...'}.

// @ts-expect-error - JS module without types
import { titleEvalCropRect } from '../../server/lib/coverTitlePaint.js';

// The real cover: 1280 wide, 4:5 page, title band from the typography spec.
const W = 1280;
const H = 1600;
const bandY0 = Math.floor(0.045 * H);   // typography.rect.y0
const bandY1 = Math.ceil(0.285 * H);    // typography.rect.y1

describe('titleEvalCropRect', () => {
  it('spans the full cover width, so a paint wider than the flat lockup is still judged', () => {
    const box = titleEvalCropRect({ W, H, bandY0, bandY1 });
    expect(box.left).toBe(0);
    expect(box.width).toBe(W);
  });

  it('includes the painted extent that the old flat-lockup crop cut off', () => {
    const box = titleEvalCropRect({ W, H, bandY0, bandY1 });
    // Where the painting actually ended on the shipped cover.
    const paintedRightPx = Math.round(0.762 * W);
    expect(box.left + box.width).toBeGreaterThan(paintedRightPx);

    // The crop that shipped, rebuilt from the flat lockup's bounds, would not
    // have reached it — this is the regression, stated as an inequality.
    const pad = Math.round(H * 0.03);
    const oldLeft = Math.max(0, Math.round(0.045 * W) - pad);
    const oldRight = Math.min(W, Math.round(0.521 * W) + pad);
    expect(oldRight).toBeLessThan(paintedRightPx);
    expect(box.left).toBeLessThanOrEqual(oldLeft);
  });

  it('keeps the vertical band the model was given, padded by 3% of page height', () => {
    const box = titleEvalCropRect({ W, H, bandY0, bandY1 });
    const pad = Math.round(H * 0.03);
    expect(box.top).toBe(bandY0 - pad);
    expect(box.top + box.height - 1).toBe(bandY1 + pad);
  });

  it('clamps to the page when the band sits against an edge', () => {
    const box = titleEvalCropRect({ W, H, bandY0: 0, bandY1: H - 1 });
    expect(box.top).toBe(0);
    expect(box.top + box.height).toBeLessThanOrEqual(H);
  });

  it('tolerates an inverted band rather than producing a negative height', () => {
    const box = titleEvalCropRect({ W, H, bandY0: 500, bandY1: 100 });
    expect(box.height).toBeGreaterThan(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.top + box.height).toBeLessThanOrEqual(H);
  });
});

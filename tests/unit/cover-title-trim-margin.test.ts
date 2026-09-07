import { describe, it, expect } from 'vitest';

// Two staging trials baked the front-cover title to the very last pixel column
// of the canvas (job_1788763045123_z8so79ngb: ink 19→863 of 864, right margin
// 0px; job_1788802404497_i1mm4yn6h: ink 47→861, right margin 2px). pdf.js adds
// a 3mm bleed per side for Gelato and the printer trims it — ~18px on that
// raster — so both books lose their final letter. The fix is a stated margin,
// expressed as a fraction of canvas width because the raster varies by format.
//
// Two things must hold together, and this file locks both:
//   1. the TITLE block carries the margin constraint, and
//   2. it still sits at the ABSOLUTE END of the prompt — tail placement is what
//      protects it from shrinkPromptForModel, which preserves everything from
//      '**ART STYLE' onward verbatim. A title moved earlier was silently
//      deleted on an over-cap prompt (job_1788551692337_bc479p945 shipped a
//      titleless cover).

// @ts-expect-error - JS module without types
import { buildCoverPrompt } from '../../server/lib/promptBuilders.js';

const TITLES = [
  'Emmas Blumengeheimnis',
  'Emma und das vergessene Geschenk',
  'Der allerlängste Titel den ein Bilderbuch je getragen hat',
];

function frontPrompt(title: string): string {
  return buildCoverPrompt('front', {
    sceneDescription: 'The main character stands in a meadow of wildflowers.',
    inputData: { artStyle: 'watercolor', language: 'de' },
    characters: [{ name: 'Emma' }],
    options: { bakeTitle: title },
  });
}

describe('baked cover title: trim-safe margin', () => {
  it('states the margin as a fraction of canvas width, not pixels', () => {
    for (const t of TITLES) {
      const p = frontPrompt(t);
      expect(p, t).toContain('8% of the canvas width');
      expect(p, t).toContain('left and right edges');
      // Pixels would be wrong for any other book format.
      expect(p, t).not.toMatch(/\b\d+\s?px\b/);
    }
  });

  it('tells a long title to break onto more lines instead of reaching the edge', () => {
    const p = frontPrompt(TITLES[2]);
    expect(p).toContain('breaks onto more lines');
  });

  it('keeps the existing title constraints', () => {
    const p = frontPrompt(TITLES[0]);
    expect(p).toContain('upper third of the canvas');
    expect(p).toContain('three-dimensional letters');
    expect(p).toContain('never a standard computer font');
    expect(p).toContain('only text in the image');
    expect(p).toContain('never in a band, strip or caption area');
  });

  it('leaves the TITLE block at the absolute end of the prompt', () => {
    for (const t of TITLES) {
      const p = frontPrompt(t).trimEnd();
      const idx = p.indexOf('**TITLE:**');
      expect(idx, t).toBeGreaterThan(-1);
      // Nothing may follow the title block — the margin clause is its last
      // sentence, so it is the tail of the whole prompt.
      expect(p.endsWith('rather than reaching that margin.'), t).toBe(true);
      // And the quoted title itself is inside that trailing block.
      expect(p.slice(idx), t).toContain(`"${t}"`);
    }
  });

  it('adds no title block — and no margin clause — to back or initial covers', () => {
    for (const key of ['back', 'initialPage']) {
      const p = buildCoverPrompt(key, {
        sceneDescription: 'A quiet meadow at dusk.',
        inputData: { artStyle: 'watercolor', language: 'de' },
        characters: [{ name: 'Emma' }],
        options: { bakeTitle: TITLES[0] },
      });
      expect(p, key).not.toContain('**TITLE:**');
      expect(p, key).not.toContain('8% of the canvas width');
    }
  });
});

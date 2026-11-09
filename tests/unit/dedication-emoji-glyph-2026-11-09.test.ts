/**
 * An emoji in the dedication printed as an empty box (prod job_1794231161354_l3n2o3afm,
 * 2026-11-09: the dedication ended in a red heart). The cover renderer loads only the
 * bundled fonts (loadSystemFonts: false) and none of the lettering fonts has emoji glyphs,
 * so resvg drew the missing-glyph box. A bundled emoji font gives every lettering font a
 * fallback for those characters.
 *
 * Measured by comparing against a private-use character no font carries: that one always
 * renders as the missing-glyph box, so an emoji that renders identically is a box too.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const { _internals, DEDICATION_FONTS } = nodeRequire('../../server/lib/coverTypography.js');

const MISSING = '';

function glyphPng(ch: string, family: string): Buffer {
  const g = `<text x="20" y="150" font-family="${family}" font-size="140" fill="#000">${ch}</text>`;
  return _internals.renderSvg(g, 200, 200);
}

describe('dedication emoji', () => {
  for (const family of DEDICATION_FONTS) {
    it(`a heart emoji is drawn as a heart, not the missing-glyph box, in ${family}`, () => {
      const box = glyphPng(MISSING, family);
      expect(glyphPng('❤️', family).equals(box)).toBe(false);
      expect(glyphPng('\u{1F60A}', family).equals(box)).toBe(false);
    });
  }
  it('ordinary letters still use the lettering font, not the emoji font', () => {
    const fam = DEDICATION_FONTS[0];
    expect(glyphPng('a', fam).equals(glyphPng('a', 'Noto Emoji'))).toBe(false);
  });
});

/**
 * The printed single layout renders strip text through generateTextOverlay (the one
 * text-on-picture renderer), into the filled strip, not with a PDFKit text pass.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const sharp = cjs('sharp');
const { generateTextOverlay } = cjs('../../server/lib/textOverlayRenderer.js');
const { buildFilledPageBackground } = cjs('../../server/lib/pageFill.js');

describe('strip text via generateTextOverlay', () => {
  it('puts glyphs inside an explicit zonePolygon below the picture, nothing above it', async () => {
    const W = 850, H = 1100, IH = 800;
    const pic = await sharp({ create: { width: 600, height: 700, channels: 3, background: '#7a9a60' } }).png().toBuffer();
    const { buffer } = await buildFilledPageBackground({ imageBuffer: pic, pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH });
    const text = 'Der kleine Fuchs ging durch den Wald und suchte seinen Freund, den Hasen.';
    const { overlayImage } = await generateTextOverlay(buffer, text, 'bottom-full', {
      pageNumber: 1, languageLevel: 'standard', fontSize: 24,
      zonePolygon: [[0, IH], [W, IH], [W, H], [0, H]],
    });
    const { data, info } = await sharp(overlayImage).ensureAlpha().extractChannel('alpha').raw().toBuffer({ resolveWithObject: true });
    let inStrip = 0, inPicture = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] > 32) { if (y >= IH) inStrip++; else inPicture++; }
    }
    expect(inStrip).toBeGreaterThan(500);
    expect(inPicture).toBe(0);
  });
});

/**
 * Test script for textOverlayRenderer.js — text overlay rendering.
 *
 * Usage: node tests/manual/test-text-overlay-render.js [image] [position]
 *
 * Defaults:
 *   image:    tests/fixtures/page9_test.jpg
 *   position: bottom-left
 *
 * Outputs:
 *   tests/manual/test-output/overlay-{position}.png       (transparent overlay)
 *   tests/manual/test-output/composited-{position}.jpg    (image + overlay)
 */

const fs = require('fs');
const path = require('path');
const { renderTextOverlay, generateTextOverlay } = require('../../server/lib/textOverlayRenderer');

const SAMPLE_TEXT = 'Lukas rannte durch den alten Wald, vorbei an den großen Eichen und den bunten Blumen. ' +
  'Sein kleiner Hund Bello lief fröhlich neben ihm her. ' +
  '„Schau mal, Bello!", rief Lukas und zeigte auf einen glitzernden Bach.';

const POSITIONS = ['top-left', 'top-right', 'top-full', 'bottom-left', 'bottom-right', 'bottom-full'];

async function main() {
  const imagePath = process.argv[2] || path.join(__dirname, '..', 'fixtures', 'page9_test.jpg');
  const position = process.argv[3] || null;

  if (!fs.existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`);
    process.exit(1);
  }

  const outputDir = path.join(__dirname, 'test-output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const imageBuffer = fs.readFileSync(imagePath);
  console.log(`Image: ${imagePath} (${(imageBuffer.length / 1024).toFixed(0)} KB)\n`);

  const positions = position ? [position] : POSITIONS;

  for (const pos of positions) {
    console.log(`=== Position: ${pos} ===`);
    const start = Date.now();

    const result = await generateTextOverlay(imageBuffer, SAMPLE_TEXT, pos);
    const elapsed = Date.now() - start;

    // Save overlay PNG
    const overlayPath = path.join(outputDir, `overlay-${pos}.png`);
    fs.writeFileSync(overlayPath, result.overlayImage);
    console.log(`  Overlay:      ${overlayPath} (${(result.overlayImage.length / 1024).toFixed(0)} KB)`);

    // Save composited JPEG
    const compositedPath = path.join(outputDir, `composited-${pos}.jpg`);
    fs.writeFileSync(compositedPath, result.compositedImage);
    console.log(`  Composited:   ${compositedPath} (${(result.compositedImage.length / 1024).toFixed(0)} KB)`);

    // Report polygon info
    if (result.polygon) {
      console.log(`  Polygon:      ${result.polygon.length} vertices`);
      console.log(`  Area:         ${(result.calmRegion.areaFraction * 100).toFixed(1)}%`);
    } else {
      console.log('  Polygon:      null (rectangular fallback)');
    }

    console.log(`  Time:         ${elapsed}ms\n`);
  }

  console.log('Done. Check test-output/ for results.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

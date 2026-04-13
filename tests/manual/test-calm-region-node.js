/**
 * Test script for calmRegion.js — calm region detection module.
 *
 * Usage: node tests/manual/test-calm-region-node.js [image-path] [position]
 *
 * Defaults:
 *   image-path: tests/fixtures/page9_test.jpg
 *   position:   top-left (runs all positions if omitted)
 */

const fs = require('fs');
const path = require('path');
const { detectCalmRegion } = require('../../server/lib/calmRegion');

const POSITIONS = ['top-left', 'top-right', 'top-full', 'bottom-left', 'bottom-right', 'bottom-full'];

async function main() {
  const imagePath = process.argv[2] || path.join(__dirname, '..', 'fixtures', 'page9_test.jpg');
  const position = process.argv[3] || null;

  if (!fs.existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`);
    process.exit(1);
  }

  const imageBuffer = fs.readFileSync(imagePath);
  console.log(`Image: ${imagePath} (${(imageBuffer.length / 1024).toFixed(0)} KB)\n`);

  const positions = position ? [position] : POSITIONS;

  for (const pos of positions) {
    console.log(`=== Position: ${pos} ===`);
    const start = Date.now();
    const result = await detectCalmRegion(imageBuffer, pos);
    const elapsed = Date.now() - start;

    if (result) {
      console.log(`  Vertices:      ${result.polygon.length}`);
      console.log(`  Area fraction: ${(result.areaFraction * 100).toFixed(1)}%`);
      console.log(`  Bounds:        x=${result.bounds.x} y=${result.bounds.y} w=${result.bounds.w} h=${result.bounds.h}`);
      console.log(`  Polygon (px):  ${JSON.stringify(result.polygon)}`);
      console.log(`  Polygon (%):   ${JSON.stringify(result.polygonPercent)}`);
    } else {
      console.log('  No calm region found');
    }
    console.log(`  Time: ${elapsed}ms\n`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

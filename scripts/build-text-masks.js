/**
 * Generate pre-built text area masks for empty scene generation.
 *
 * The mask is passed as a reference image to Grok/Gemini:
 * - BLACK area = reserved text zone (~20% of frame) where white story text overlays
 * - WHITE area = rest of the scene (~80%)
 *
 * Uses soft Gaussian-blurred edges so there's no hard rectangle boundary.
 * The model is told to treat the black region as a POSITION hint only — render
 * that area as a natural, saturated, high-contrast surface for white text, not
 * as a literal black box.
 *
 * Run: node scripts/build-text-masks.js
 * Output: assets/masks/text-mask-{position}-{size}.png
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const WIDTH = 768;
const HEIGHT = 1024;
const OUT_DIR = path.join(__dirname, '..', 'assets', 'masks');

const POSITIONS = ['top-full', 'top-left', 'top-right', 'bottom-full', 'bottom-left', 'bottom-right'];
const SIZES = { small: 0.10, medium: 0.25, large: 0.40 };

fs.mkdirSync(OUT_DIR, { recursive: true });

// Build the SVG shape (black fill, white background) for a given position and
// area. Black = reserved text zone (where story text will be placed — image
// models should paint this dark because white glyphs render on top).
// Full positions = horizontal strip. Corners = right triangle with its right
// angle at the corner of the frame and its hypotenuse pointing toward the
// scene center. Triangles match area to the rectangle version but leave more
// usable space for characters near the frame edge opposite the corner.
function getShapeSvg(position, areaPct) {
  const isFull = position.includes('full');
  const isTop = position.startsWith('top');
  const isLeft = position.includes('left');

  if (isFull) {
    const rectH = Math.round(HEIGHT * areaPct);
    const rectY = isTop ? 0 : HEIGHT - rectH;
    return `<rect x="0" y="${rectY}" width="${WIDTH}" height="${rectH}" fill="black"/>`;
  }

  // Right triangle for corners. Leg length = sqrt(2 * areaPct) so the white
  // area = areaPct × frame (same as the old rectangle). Legs are longer than
  // the old rectangle legs but the triangle is half the rectangle's area.
  const scale = Math.sqrt(2 * areaPct);
  const legW = Math.round(WIDTH * scale);
  const legH = Math.round(HEIGHT * scale);
  const cx = isLeft ? 0 : WIDTH;
  const cy = isTop ? 0 : HEIGHT;
  const ax = isLeft ? legW : WIDTH - legW;   // along the top/bottom edge
  const ay = cy;                              // stays on the corner's row
  const bx = cx;                              // stays on the corner's column
  const by = isTop ? legH : HEIGHT - legH;    // along the left/right edge
  return `<polygon points="${cx},${cy} ${ax},${ay} ${bx},${by}" fill="black"/>`;
}

// Build a single mask using an SVG shape, then Gaussian blur for soft edges
async function buildMask(position, sizeName, outPath) {
  const areaPct = SIZES[sizeName];
  const shapeSvg = getShapeSvg(position, areaPct);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="white"/>
  ${shapeSvg}
</svg>`;

  // Blur radius scales with frame size (~4% of smaller dimension = ~31px for 768x1024).
  // Tested heavier blur (80px) — corners then read as "matte frame" and the model
  // paints a black border around the scene. 31px is the sweet spot.
  const blurSigma = Math.max(20, Math.round(Math.min(WIDTH, HEIGHT) * 0.04));

  await sharp(Buffer.from(svg))
    .blur(blurSigma)
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  const shape = position.includes('full') ? 'strip' : 'triangle';
  console.log(`✓ ${path.basename(outPath)}  ${shape} ${(areaPct * 100).toFixed(0)}% area  blur ${blurSigma}px`);
}

async function main() {
  console.log(`Building ${POSITIONS.length * Object.keys(SIZES).length} masks at ${WIDTH}×${HEIGHT}...`);
  console.log(`Output: ${OUT_DIR}\n`);

  for (const position of POSITIONS) {
    for (const sizeName of Object.keys(SIZES)) {
      const outPath = path.join(OUT_DIR, `text-mask-${position}-${sizeName}.png`);
      await buildMask(position, sizeName, outPath);
    }
  }

  console.log(`\n✓ All masks built in ${OUT_DIR}`);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});

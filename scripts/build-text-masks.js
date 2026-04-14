/**
 * Generate pre-built text area masks for empty scene generation.
 *
 * The mask is passed as a reference image to Grok/Gemini:
 * - WHITE area = where story text will be placed (keep calm, light, minimal detail)
 * - BLACK area = where the scene can have full detail
 *
 * Uses soft Gaussian-blurred edges so there's no hard rectangle boundary.
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

// Compute rectangle coordinates for a given position and area fraction
function getRect(position, areaPct) {
  const isFull = position.includes('full');
  const isTop = position.startsWith('top');
  const isLeft = position.includes('left');

  let rectW, rectH, rectX, rectY;

  if (isFull) {
    // Horizontal strip: full width, area% tall
    rectW = WIDTH;
    rectH = Math.round(HEIGHT * areaPct);
    rectX = 0;
    rectY = isTop ? 0 : HEIGHT - rectH;
  } else {
    // Corner: sqrt(area%) on each dimension (same aspect as frame)
    const scale = Math.sqrt(areaPct);
    rectW = Math.round(WIDTH * scale);
    rectH = Math.round(HEIGHT * scale);
    rectX = isLeft ? 0 : WIDTH - rectW;
    rectY = isTop ? 0 : HEIGHT - rectH;
  }

  return { rectX, rectY, rectW, rectH };
}

// Build a single mask using an SVG rectangle, then Gaussian blur for soft edges
async function buildMask(position, sizeName, outPath) {
  const areaPct = SIZES[sizeName];
  const { rectX, rectY, rectW, rectH } = getRect(position, areaPct);

  // SVG: black background, white rectangle at the target position
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="black"/>
  <rect x="${rectX}" y="${rectY}" width="${rectW}" height="${rectH}" fill="white"/>
</svg>`;

  // Blur radius scales with frame size (~4% of smaller dimension = ~31px for 768x1024).
  // Tested heavier blur (80px) — corners then read as "matte frame" and the model
  // paints a black border around the scene. 31px is the sweet spot.
  const blurSigma = Math.max(20, Math.round(Math.min(WIDTH, HEIGHT) * 0.04));

  await sharp(Buffer.from(svg))
    .blur(blurSigma)
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  console.log(`✓ ${path.basename(outPath)}  rect ${rectX},${rectY} ${rectW}×${rectH}  blur ${blurSigma}px`);
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

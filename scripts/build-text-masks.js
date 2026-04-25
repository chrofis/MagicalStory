/**
 * Generate pre-built text area masks for empty scene generation.
 *
 * The mask is passed as a reference image to Grok/Gemini:
 * - DARKER GRAY area = reserved text zone (~20% of frame) where white story text overlays
 * - LIGHTER GRAY area = rest of the scene (~80%)
 *
 * Tested previously with pure black + pure white. Grok mimicked the high
 * contrast literally — copied black regions as dark voids and the mask label
 * as visible text. Soft mid-grey on light-grey gives Grok a positional nudge
 * without an "anchor colour" to copy. Heavy Gaussian blur removes any edge
 * the model could read as a scene element.
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

// Mid-grey background, dark-grey region. Neither end is pure black or pure
// white — Grok stops trying to copy "black voids" and "white fills" as scene
// elements when there are no extreme anchor colours.
const BG_GREY = '#C8C8C8';      // 200/255 — light mid-grey
const ZONE_GREY = '#646464';    // 100/255 — darker grey, ~40% darker than BG

// Build the SVG shape (dark-grey fill, light-grey background) for a given
// position and area. Full positions = horizontal strip. Corners = right
// triangle with its right angle at the corner of the frame and its hypotenuse
// pointing toward the scene center.
function getShapeSvg(position, areaPct) {
  const isFull = position.includes('full');
  const isTop = position.startsWith('top');
  const isLeft = position.includes('left');

  if (isFull) {
    const rectH = Math.round(HEIGHT * areaPct);
    const rectY = isTop ? 0 : HEIGHT - rectH;
    return `<rect x="0" y="${rectY}" width="${WIDTH}" height="${rectH}" fill="${ZONE_GREY}"/>`;
  }

  const scale = Math.sqrt(2 * areaPct);
  const legW = Math.round(WIDTH * scale);
  const legH = Math.round(HEIGHT * scale);
  const cx = isLeft ? 0 : WIDTH;
  const cy = isTop ? 0 : HEIGHT;
  const ax = isLeft ? legW : WIDTH - legW;
  const ay = cy;
  const bx = cx;
  const by = isTop ? legH : HEIGHT - legH;
  return `<polygon points="${cx},${cy} ${ax},${ay} ${bx},${by}" fill="${ZONE_GREY}"/>`;
}

// Build a single mask using an SVG shape, then heavy Gaussian blur for very
// soft edges. Heavier blur than before (was 4% / 31px, now 8% / 62px) so the
// transition between the two greys is gradual enough that Grok reads it as
// "atmospheric variation" rather than a hard region boundary.
async function buildMask(position, sizeName, outPath) {
  const areaPct = SIZES[sizeName];
  const shapeSvg = getShapeSvg(position, areaPct);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG_GREY}"/>
  ${shapeSvg}
</svg>`;

  const blurSigma = Math.max(40, Math.round(Math.min(WIDTH, HEIGHT) * 0.08));

  await sharp(Buffer.from(svg))
    .blur(blurSigma)
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  const shape = position.includes('full') ? 'strip' : 'triangle';
  console.log(`✓ ${path.basename(outPath)}  ${shape} ${(areaPct * 100).toFixed(0)}% area  blur ${blurSigma}px  grey ${BG_GREY}→${ZONE_GREY}`);
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

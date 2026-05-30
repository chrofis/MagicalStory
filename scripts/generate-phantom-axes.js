/**
 * Generate phantom variants with RGB axis-gizmo overlays on the face region.
 *
 * Background: the existing phantom has eye dots + mouth line baked in by the
 * generation prompt. Grok copies whatever it sees in the head region, so
 * those features leak into the rendered character even with the source face
 * photo provided. Smooth/featureless heads don't help — Grok then renders
 * smooth/featureless faces.
 *
 * Approach: keep the existing phantom body (proportions + pose are good)
 * and OVERLAY a 3-axis RGB gizmo on the face region of each cell. The gizmo
 * is unmistakably non-anatomical — Grok reads it as "directional marker,
 * not a face" — but still communicates head orientation through the gizmo's
 * own rotation.
 *
 * The 2×4 phantom layout (1408×768 per the generator):
 *   ┌────┬────┬────┬────┐   ← top row: head-only cells, 4 angles
 *   │ H  │ H  │ H  │ H  │     col 0 front, col 1 3/4, col 2 profile, col 3 back
 *   ├────┼────┼────┼────┤
 *   │ B  │ B  │ B  │ B  │   ← bottom row: full-body cells, same angles
 *   └────┴────┴────┴────┘     face is at TOP of each body cell
 *
 * Outputs `phantom-watercolor-{tier}-axes.png` next to the originals so the
 * user can inspect before swapping loadPhantom() to use them.
 *
 * Usage:
 *   node scripts/generate-phantom-axes.js
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.resolve(__dirname, '..', 'server', 'assets');
const TIERS = ['toddler', 'child', 'teen', 'adult'];
const ANGLES = ['front', 'quarter', 'profile', 'back'];

// Approximate face-region within a cell as a fraction of cell width/height.
// Top row = head-only cells: face occupies most of the cell. Bottom row =
// body cell with the head at the top.
const FACE_RECT = {
  top:    { wFrac: 0.45, hFrac: 0.55, cx: 0.50, cy: 0.42 },
  bottom: { wFrac: 0.18, hFrac: 0.10, cx: 0.50, cy: 0.10 },
};

// Build one axis line with arrowhead. Direction is a 2D vector in screen
// space (positive y = down in SVG). Foreshortening / dashed is the
// caller's choice via the optional opts.
function axisLine(dx, dy, color, opts = {}) {
  const len = Math.hypot(dx, dy);
  if (len < 1) {
    // Axis points straight at/away from viewer — render as a dot.
    return `<circle cx="0" cy="0" r="${opts.away ? 5 : 8}" fill="${color}" ${opts.away ? 'opacity="0.5"' : ''}/>`;
  }
  const ux = dx / len, uy = dy / len;
  // Stem ends short of the tip so the bold arrowhead can sit prominently.
  // Arrowhead is a longer/wider triangle than before — reads as an arrow
  // shape at a glance rather than "line with a notch on the end".
  const HEAD_LEN = 16;
  const HEAD_HALF_WIDTH = 9;
  const stemEndX = dx - ux * HEAD_LEN * 0.6;
  const stemEndY = dy - uy * HEAD_LEN * 0.6;
  const baseX = dx - ux * HEAD_LEN, baseY = dy - uy * HEAD_LEN;
  const perpX = -uy * HEAD_HALF_WIDTH, perpY = ux * HEAD_HALF_WIDTH;
  const dash = opts.dashed ? `stroke-dasharray="3,3"` : '';
  return `
    <line x1="0" y1="0" x2="${stemEndX.toFixed(1)}" y2="${stemEndY.toFixed(1)}" stroke="${color}" stroke-width="7" stroke-linecap="round" ${dash}/>
    <polygon points="${(baseX + perpX).toFixed(1)},${(baseY + perpY).toFixed(1)} ${dx.toFixed(1)},${dy.toFixed(1)} ${(baseX - perpX).toFixed(1)},${(baseY - perpY).toFixed(1)}" fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>`;
}

// Per-angle gizmos following the user-specified directions:
//   0°   front:    red→right,    green→up, blue→dot at viewer
//   45°  quarter:  red→up-right, green→up, blue→down-right
//   90°  profile:  red→hidden,   green→up, blue→right (horizontal)
//   135° back:     red→up-left,  green→up, blue→down-left  (mirror of 45°)
//
// SVG y-axis is inverted (positive = down).
function gizmoSvg(angle) {
  const RED   = '#cc2222';
  const GREEN = '#22aa44';
  const BLUE  = '#2266dd';
  // Y axis is always up (head doesn't tilt around Z/X for these views).
  const yUp = axisLine(0, -32, GREEN);

  let xPart = '', zPart = '';
  // Diagonal length so down-right at 45° feels the same magnitude as
  // straight-right at 0°. cos(45°) = ~0.707; use 22 ≈ 30 × 0.707.
  const diag = 22;

  switch (angle) {
    case 'front':   // 0°
      xPart = axisLine(30, 0, RED);
      zPart = axisLine(0, 0, BLUE);                  // dot — toward viewer
      break;
    case 'quarter': // 45°
      xPart = axisLine( diag, -diag, RED);            // up-right
      zPart = axisLine( diag,  diag, BLUE);           // down-right
      break;
    case 'profile': // 90°
      xPart = axisLine(0, 0, RED, { away: true });    // X perpendicular → faded dot
      zPart = axisLine(30, 0, BLUE);                  // right (horizontal)
      break;
    case 'back':    // 135° — past profile, looking at back-3/4
      xPart = axisLine(-diag, -diag, RED);            // up-left (mirror of 45°'s up-right)
      zPart = axisLine( diag, -diag, BLUE);           // up-right (Z continues rotating past horizontal)
      break;
  }

  return `<svg width="100" height="100" viewBox="-50 -50 100 100" xmlns="http://www.w3.org/2000/svg">
    <circle cx="0" cy="0" r="46" fill="#ffffff" stroke="#888" stroke-width="2"/>
    ${zPart}
    ${xPart}
    ${yUp}
    <circle cx="0" cy="0" r="4" fill="#222"/>
  </svg>`;
}

async function svgToPng(svg, width, height) {
  return sharp(Buffer.from(svg)).resize(width, height).png().toBuffer();
}

async function processPhantom(tier) {
  const inPath = path.join(ASSETS_DIR, `phantom-watercolor-${tier}.png`);
  const outPath = path.join(ASSETS_DIR, `phantom-watercolor-${tier}-axes.png`);
  if (!fs.existsSync(inPath)) {
    console.error(`Skip ${tier}: ${inPath} missing`);
    return;
  }

  const base = sharp(inPath);
  const meta = await base.metadata();
  const w = meta.width;
  const h = meta.height;
  const colW = Math.floor(w / 4);
  const rowH = Math.floor(h / 2);

  const composites = [];
  for (let col = 0; col < 4; col++) {
    const angle = ANGLES[col];
    const svg = gizmoSvg(angle);

    // Top row cell — head-only
    {
      const rect = FACE_RECT.top;
      const fw = Math.floor(colW * rect.wFrac);
      const fh = Math.floor(rowH * rect.hFrac);
      const cx = col * colW + Math.floor(colW * rect.cx);
      const cy = 0 + Math.floor(rowH * rect.cy);
      const left = Math.max(0, cx - Math.floor(fw / 2));
      const top = Math.max(0, cy - Math.floor(fh / 2));
      const png = await svgToPng(svg, fw, fh);
      composites.push({ input: png, left, top });
    }

    // Bottom row cell — full body, face at top
    {
      const rect = FACE_RECT.bottom;
      const fw = Math.floor(colW * rect.wFrac);
      const fh = Math.floor(rowH * rect.hFrac);
      const cx = col * colW + Math.floor(colW * rect.cx);
      const cy = rowH + Math.floor(rowH * rect.cy);
      const left = Math.max(0, cx - Math.floor(fw / 2));
      const top = Math.max(0, cy - Math.floor(fh / 2));
      const png = await svgToPng(svg, fw, fh);
      composites.push({ input: png, left, top });
    }
  }

  await sharp(inPath).composite(composites).png().toFile(outPath);
  console.log(`  ✓ ${tier}: wrote ${path.basename(outPath)}`);
}

(async () => {
  console.log(`Generating axis-gizmo phantom variants in ${ASSETS_DIR}\n`);
  for (const tier of TIERS) {
    await processPhantom(tier);
  }
  // Also process the default phantom for completeness.
  if (fs.existsSync(path.join(ASSETS_DIR, 'phantom-watercolor.png'))) {
    const base = sharp(path.join(ASSETS_DIR, 'phantom-watercolor.png'));
    const meta = await base.metadata();
    const colW = Math.floor(meta.width / 4);
    const rowH = Math.floor(meta.height / 2);
    const composites = [];
    for (let col = 0; col < 4; col++) {
      const svg = gizmoSvg(ANGLES[col]);
      const t = FACE_RECT.top;
      const b = FACE_RECT.bottom;
      const tfw = Math.floor(colW * t.wFrac), tfh = Math.floor(rowH * t.hFrac);
      const bfw = Math.floor(colW * b.wFrac), bfh = Math.floor(rowH * b.hFrac);
      composites.push({ input: await svgToPng(svg, tfw, tfh), left: col * colW + Math.floor(colW * t.cx) - Math.floor(tfw / 2), top: Math.floor(rowH * t.cy) - Math.floor(tfh / 2) });
      composites.push({ input: await svgToPng(svg, bfw, bfh), left: col * colW + Math.floor(colW * b.cx) - Math.floor(bfw / 2), top: rowH + Math.floor(rowH * b.cy) - Math.floor(bfh / 2) });
    }
    await sharp(path.join(ASSETS_DIR, 'phantom-watercolor.png')).composite(composites).png().toFile(path.join(ASSETS_DIR, 'phantom-watercolor-axes.png'));
    console.log(`  ✓ default: wrote phantom-watercolor-axes.png`);
  }
  console.log(`\nDone. Inspect the new -axes.png files in ${ASSETS_DIR}.\nIf they look right, switch loadPhantom() in server/lib/character2x4Sheet.js to load the -axes variants.`);
})();

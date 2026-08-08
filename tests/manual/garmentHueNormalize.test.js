/**
 * Unit tests for the retained garment colour SAMPLER
 * (server/lib/garmentHueNormalize.js).
 *
 * The hue-normalization PASS this file used to test was retired on 2026-08-08 in
 * favour of server/lib/garmentColourFix.js — see that module's header for why.
 * What remains is the colour maths its successors share: the skin/grey rejection
 * and the chroma-weighted hue clustering. The cases kept are the ones that
 * caught real bugs on real sheets:
 *   - a garment-dominated avatar sheet must keep its chroma (a gray-world "cast"
 *     discount on such a sheet cancelled the very signal being read)
 *   - a two-garment character must yield BOTH garments as separate clusters
 *   - hair must not outrank the garment once the sheet is cropped to the torso
 *
 * Run: node tests/manual/garmentHueNormalize.test.js
 */
const sharp = require('sharp');
const G = require('../../server/lib/garmentHueNormalize');
const { _rgbToLab } = require('../../server/lib/images');

const DEG = 180 / Math.PI;
let passed = 0, failed = 0;
const check = (d, c, extra) => c
  ? (passed++, console.log(`  ok  ${d}`))
  : (failed++, console.log(`FAIL  ${d}${extra ? '  — ' + extra : ''}`));
const hueOf = (rgb) => { const l = _rgbToLab(rgb[0], rgb[1], rgb[2]); return Math.atan2(l[2], l[1]) * DEG; };
const angDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

const RED = [210, 30, 40];
const BLUE = [40, 70, 180];
const SKIN = [232, 188, 158];
const HAIR = [150, 60, 25];   // auburn: saturated, so NOT rejected as grey

const W = 60, N = W * 60;
function canvas(bg) {
  const b = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) { b[i * 3] = bg[0]; b[i * 3 + 1] = bg[1]; b[i * 3 + 2] = bg[2]; }
  return b;
}
function rect(buf, x0, y0, x1, y1, rgb) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x; buf[i * 3] = rgb[0]; buf[i * 3 + 1] = rgb[1]; buf[i * 3 + 2] = rgb[2];
  }
}

(async () => {
  console.log('\nTEST 1 — isGarmentPixel rejects skin and grey, keeps garments');
  check('vivid red is a garment', G.isGarmentPixel(RED[0], RED[1], RED[2]));
  check('vivid blue is a garment', G.isGarmentPixel(BLUE[0], BLUE[1], BLUE[2]));
  check('skin is rejected', !G.isGarmentPixel(SKIN[0], SKIN[1], SKIN[2]));
  check('mid grey is rejected', !G.isGarmentPixel(150, 150, 150));
  check('neutral white is rejected', !G.isGarmentPixel(250, 250, 250));
  // The grey cut is on SATURATION, not lightness: rgb(248,248,246) computes to
  // s=0.124, just over the 0.12 floor, so a barely-tinted near-white still
  // counts as a garment. That is why the avatar sampler crops to the torso
  // band and the page sampler works inside a segmentation mask — neither may
  // rely on this classifier alone to exclude a pale background.
  check('a barely-tinted near-white is NOT excluded by this classifier',
    G.isGarmentPixel(248, 248, 246));

  // Read in ABSOLUTE space (cast {0,0}). Discounting a gray-world mean here is
  // exactly what cancelled the signal on real avatar sheets.
  console.log('\nTEST 2 — a garment-dominated sheet keeps its chroma');
  const sheet = canvas([250, 250, 250]);
  rect(sheet, 6, 6, 54, 50, RED);
  const cl = G.sampleGarmentClusters(sheet, N, null, { a: 0, b: 0 }, {}, 3);
  check('a cluster is found', cl.length >= 1);
  check('chroma clears the floor', cl[0].chroma >= G.DEFAULTS.chromaMin,
    `chroma=${cl[0] && cl[0].chroma.toFixed(1)}`);
  check('hue is the garment hue', angDist(cl[0].hueRad * DEG, hueOf(RED)) < 8,
    `got ${(cl[0].hueRad * DEG).toFixed(1)}deg`);
  check('cluster carries a mean L*', cl[0].L > 0 && cl[0].L < 100, `L=${cl[0].L}`);

  console.log('\nTEST 3 — a two-garment character yields both as clusters');
  const two = canvas([250, 250, 250]);
  rect(two, 6, 4, 54, 26, RED);    // top
  rect(two, 6, 28, 54, 54, BLUE);  // trousers
  const cl2 = G.sampleGarmentClusters(two, N, null, { a: 0, b: 0 }, {}, 3);
  check('two clusters found', cl2.length >= 2, `got ${cl2.length}`);
  const hues = cl2.map(c => c.hueRad * DEG);
  check('red is among them', hues.some(h => angDist(h, hueOf(RED)) < 12),
    JSON.stringify(hues.map(h => +h.toFixed(0))));
  check('blue is among them', hues.some(h => angDist(h, hueOf(BLUE)) < 12),
    JSON.stringify(hues.map(h => +h.toFixed(0))));

  console.log('\nTEST 4 — the torso band excludes the head, so hair cannot win');
  const rows = 80;
  const sheetBuf = Buffer.alloc(W * rows * 3, 250);
  const put = (x0, y0, x1, y1, rgb) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * W + x; sheetBuf[i * 3] = rgb[0]; sheetBuf[i * 3 + 1] = rgb[1]; sheetBuf[i * 3 + 2] = rgb[2];
    }
  };
  put(4, 2, 56, 34, HAIR);        // head row — plenty of hair
  put(4, 36, 56, 38, [0, 0, 0]);  // row divider
  put(4, 52, 56, 70, RED);        // body row torso — the garment
  const png = await sharp(sheetBuf, { raw: { width: W, height: rows, channels: 3 } }).png().toBuffer();
  const band = await G._internal.avatarTorsoBand(png, W, rows);
  check('band starts below the head row', band.top > 38, `top=${band.top}`);
  const { data, info } = await sharp(png).extract(band).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bandCl = G.sampleGarmentClusters(data, info.width * info.height, null, { a: 0, b: 0 }, {}, 3);
  check('a cluster is found in the band', bandCl.length >= 1);
  check('it is the GARMENT, not the hair',
    angDist(bandCl[0].hueRad * DEG, hueOf(RED)) < angDist(bandCl[0].hueRad * DEG, hueOf(HAIR)),
    `got ${(bandCl[0].hueRad * DEG).toFixed(1)}deg, garment ${hueOf(RED).toFixed(1)}deg, hair ${hueOf(HAIR).toFixed(1)}deg`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

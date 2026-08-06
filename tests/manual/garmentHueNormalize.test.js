/**
 * Deterministic colour-math unit tests for the lighting-aware garment hue
 * normalization pass (server/lib/garmentHueNormalize.js).
 *
 * garmentHueNormalize.js requires `sharp` and `./images` (both pull native
 * `sharp`, unavailable locally). Following the vm/Module-stub pattern of
 * tests/manual/test-images-dispatch-core.js, we intercept Module._load so:
 *   - `sharp`            → a stub (the PURE core never calls it)
 *   - `./images`         → the REAL _rgbToLab/_labToRgb, sliced out of images.js
 *   - `../utils/logger`  → no-op
 * Then we exercise the deterministic core on SYNTHETIC pixel buffers. No image
 * decode, no network, no model calls.
 *
 * Run: node tests/manual/garmentHueNormalize.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const Module = require('module');

// ── Slice the LAB block out of images.js and run it in a tiny sandbox so the
//    test uses the PRODUCTION conversion (never a copy that can drift). ────────
// Normalize CRLF → LF: on a Windows checkout with core.autocrlf=true the file on
// disk has CRLF line endings, so the multi-line needles below (written with \n)
// would never match and every run would die in sliceBetween.
const IMAGES_SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/images.js'), 'utf8').replace(/\r\n/g, '\n');
function sliceBetween(src, startNeedle, endNeedleAfter) {
  const s = src.indexOf(startNeedle);
  assert(s !== -1, `slice: cannot find "${startNeedle}"`);
  const e = src.indexOf(endNeedleAfter, s);
  assert(e !== -1, `slice: cannot find "${endNeedleAfter}"`);
  return src.slice(s, e + endNeedleAfter.length);
}
// From the `const _LAB_Xn` line through the end of `_labToRgb`'s return.
const labBlock = sliceBetween(
  IMAGES_SRC,
  'const _LAB_Xn',
  'return [_linearToSrgb(3.2406 * X - 1.5372 * Y - 0.4986 * Z), _linearToSrgb(-0.9689 * X + 1.8758 * Y + 0.0415 * Z), _linearToSrgb(0.0557 * X - 0.2040 * Y + 1.0570 * Z)];\n}'
);
const labSandbox = { Math, module: {}, exports: {} };
vm.runInNewContext(labBlock + '\nmodule.exports = { _rgbToLab, _labToRgb };', labSandbox);
const { _rgbToLab, _labToRgb } = labSandbox.module.exports;

// ── Module._load interception ─────────────────────────────────────────────────
const imagesStub = { _rgbToLab, _labToRgb };
const sharpStub = function () { throw new Error('sharp stub — pure core must not call sharp'); };
const loggerStub = new Proxy({}, { get: () => () => {} });
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === 'sharp') return sharpStub;
  if (request === './images' && parent && /garmentHueNormalize\.js$/.test(parent.filename)) return imagesStub;
  if (request === '../utils/logger') return loggerStub;
  return origLoad.apply(this, arguments);
};
const G = require('../../server/lib/garmentHueNormalize');
Module._load = origLoad;

// ── synthetic-buffer helpers ─────────────────────────────────────────────────
const W = 40, H = 40, N = W * H;
function blank(rgb) {
  const buf = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) { buf[i * 3] = rgb[0]; buf[i * 3 + 1] = rgb[1]; buf[i * 3 + 2] = rgb[2]; }
  return buf;
}
function fillRect(buf, x0, y0, x1, y1, rgb) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x; buf[i * 3] = rgb[0]; buf[i * 3 + 1] = rgb[1]; buf[i * 3 + 2] = rgb[2];
  }
}
function rectMask(x0, y0, x1, y1) {
  const m = Buffer.alloc(N);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 255;
  return m;
}
// Apply a uniform LAB (a,b) cast to EVERY pixel — simulates global illumination.
function castAll(buf, da, db) {
  const out = Buffer.from(buf);
  for (let i = 0; i < N; i++) {
    const lab = _rgbToLab(buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]);
    const rgb = _labToRgb(lab[0], lab[1] + da, lab[2] + db);
    out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
  }
  return out;
}
function hueDeg(r, g, b) { const l = _rgbToLab(r, g, b); return Math.atan2(l[2], l[1]) * 180 / Math.PI; }
function Lof(r, g, b) { return _rgbToLab(r, g, b)[0]; }
function chromaOf(r, g, b) { const l = _rgbToLab(r, g, b); return Math.hypot(l[1], l[2]); }
function angDist(a, b) { let d = Math.abs(a - b) % 360; if (d > 180) d = 360 - d; return d; }

// colours (LAB hues verified with the real conversion: avatar red 33°, vivid
// orange 59°, dark orange 59°, blue -65°. All garments are VIVID (HSL sat > .65)
// so the skin filter — which excludes tan/skin-toned garments by design — does
// not reject them. skin/hair/grey are excluded by the HSL classifier.).
const RED = [210, 30, 40];        // avatar garment (canonical), hue 33°
const ORANGE = [235, 120, 20];    // drifted page garment, hue 59° (~26° off red)
const DARK_ORANGE = [110, 55, 12];// drifted dim garment (low L*), hue 59°
const BLUE = [40, 70, 180];       // a second garment (trousers), hue −65°
const SKIN = [232, 188, 158];
const HAIR = [60, 55, 50];        // low-sat → grey/excluded
const BG = [140, 140, 140];

let passed = 0, failed = 0;
function check(desc, cond, extra) {
  if (cond) { passed++; console.log(`  ok  ${desc}`); }
  else { failed++; console.log(`FAIL  ${desc}${extra ? '  — ' + extra : ''}`); }
}

// Build an avatar buffer: figure mask = garment only (clean canonical sample).
function avatarBuf(garment) {
  const buf = blank(BG);
  fillRect(buf, 14, 12, 26, 30, garment);
  return { raw: buf, n: N, mask: null }; // whole-image sampler; garment dominates chroma
}

// ── TEST 1 — hue fixed (orange → red under neutral light) ────────────────────
(function testHueFix() {
  console.log('\nTEST 1 — intrinsic hue drift IS corrected (orange→red, neutral light)');
  const page = blank(BG);
  fillRect(page, 12, 15, 28, 30, ORANGE);      // garment
  const mask = rectMask(12, 15, 28, 30);
  const av = avatarBuf(RED);
  const res = G.normalizeGarmentRaw({ pageRaw: page, n: N, pageMask: mask, avatarRaw: av.raw, avatarN: av.n, avatarMask: av.mask });
  check('applied', res.applied === true, res.reason);
  check('rotation is toward avatar (negative, orange→red)', res.rotationDeg < 0, `rot=${res.rotationDeg}`);
  // Sample a corrected garment pixel and confirm its hue moved toward red(33°).
  const i = (22 * W + 20);
  const before = hueDeg(ORANGE[0], ORANGE[1], ORANGE[2]);
  const after = hueDeg(res.correctedRaw[i * 3], res.correctedRaw[i * 3 + 1], res.correctedRaw[i * 3 + 2]);
  const avHue = hueDeg(RED[0], RED[1], RED[2]);
  check('corrected hue closer to avatar than before',
    angDist(after, avHue) < angDist(before, avHue), `before=${before.toFixed(1)} after=${after.toFixed(1)} avatar=${avHue.toFixed(1)}`);
})();

// ── TEST 2 — no-op when already correct ──────────────────────────────────────
(function testNoOp() {
  console.log('\nTEST 2 — already-correct garment is a NO-OP (below threshold)');
  const page = blank(BG);
  fillRect(page, 12, 15, 28, 30, RED);
  const mask = rectMask(12, 15, 28, 30);
  const av = avatarBuf(RED);
  const res = G.normalizeGarmentRaw({ pageRaw: page, n: N, pageMask: mask, avatarRaw: av.raw, avatarN: av.n, avatarMask: av.mask });
  check('not applied', res.applied === false, res.reason);
  check('reason is below-threshold', /below threshold/.test(res.reason), res.reason);
  check('correctedRaw === input (untouched)', res.correctedRaw === page);
})();

// ── TEST 3 — illumination discount (global warm cast is NOT corrected) ────────
(function testIlluminationDiscount() {
  console.log('\nTEST 3 — global sunset cast is NOT corrected (day/night logic)');
  // Page garment is the CORRECT red, but a warm cast is applied to the WHOLE
  // page (garment AND background). Undiscounted, the garment reads orange; the
  // gray-world estimate recovers the cast; discounted, it is red again → no-op.
  const T3RED = [175, 95, 90];         // a muted red, intrinsic hue ~29° (≈ avatar)
  let page = blank(BG);
  fillRect(page, 16, 16, 24, 28, T3RED); // smaller garment so bg dominates the cast estimate
  page = castAll(page, 8, 26);         // global warm illumination (verified: raw garment reads ~47°)
  const mask = rectMask(16, 16, 24, 28);
  const av = avatarBuf(RED);           // avatar under neutral light
  const res = G.normalizeGarmentRaw({ pageRaw: page, n: N, pageMask: mask, avatarRaw: av.raw, avatarN: av.n, avatarMask: av.mask });
  // Prove the cast really made the raw garment LOOK drifted (so the no-op is due
  // to the discount, not to an absence of apparent drift).
  const gi = (20 * W + 22);
  const rawGarmentHue = hueDeg(page[gi * 3], page[gi * 3 + 1], page[gi * 3 + 2]);
  const avHue = hueDeg(RED[0], RED[1], RED[2]);
  check('raw (undiscounted) garment looks drifted by the cast', angDist(rawGarmentHue, avHue) > 12,
    `rawHue=${rawGarmentHue.toFixed(1)} avatar=${avHue.toFixed(1)} dist=${angDist(rawGarmentHue, avHue).toFixed(1)}`);
  check('NOT applied (global cast discounted)', res.applied === false, res.reason);
  check('correctedRaw untouched', res.correctedRaw === page);
})();

// ── TEST 4 — lightness preserved (a dark night garment stays dark) ───────────
(function testLightnessPreserved() {
  console.log('\nTEST 4 — lightness preserved: a DARK garment stays dark (night)');
  const page = blank(BG);
  fillRect(page, 12, 15, 28, 30, DARK_ORANGE); // dim, drifted
  const mask = rectMask(12, 15, 28, 30);
  const av = avatarBuf(RED);                    // bright avatar red
  const res = G.normalizeGarmentRaw({ pageRaw: page, n: N, pageMask: mask, avatarRaw: av.raw, avatarN: av.n, avatarMask: av.mask });
  check('applied (hue drift present)', res.applied === true, res.reason);
  // Per-pixel: L* preserved within 8-bit quantization; chroma preserved (rotation
  // about origin is norm-preserving). Night must NOT be brightened to the avatar.
  let maxdL = 0, maxdC = 0, changed = 0, sumL = 0, cnt = 0;
  for (let y = 15; y < 30; y++) for (let x = 12; x < 28; x++) {
    const i = y * W + x;
    const b0 = [page[i * 3], page[i * 3 + 1], page[i * 3 + 2]];
    const b1 = [res.correctedRaw[i * 3], res.correctedRaw[i * 3 + 1], res.correctedRaw[i * 3 + 2]];
    if (b0[0] !== b1[0] || b0[1] !== b1[1] || b0[2] !== b1[2]) changed++;
    maxdL = Math.max(maxdL, Math.abs(Lof(...b0) - Lof(...b1)));
    maxdC = Math.max(maxdC, Math.abs(chromaOf(...b0) - chromaOf(...b1)));
    sumL += Lof(...b1); cnt++;
  }
  const meanL = sumL / cnt;
  const avatarL = Lof(RED[0], RED[1], RED[2]); // ~44.7
  check('some garment pixels changed', changed > 40, `changed=${changed}`);
  check('L* preserved per-pixel (≤2, quantization only)', maxdL <= 2.0, `maxΔL=${maxdL.toFixed(2)}`);
  check('chroma preserved per-pixel (≤2)', maxdC <= 2.0, `maxΔC=${maxdC.toFixed(2)}`);
  check('garment STILL dark — not brightened toward avatar', meanL < avatarL - 8, `meanL=${meanL.toFixed(1)} avatarL=${avatarL.toFixed(1)}`);
})();

// ── TEST 5 — mask containment (only the drifted garment changes) ─────────────
(function testContainment() {
  console.log('\nTEST 5 — mask containment: bg / skin / hair / other-garment untouched');
  const page = blank(BG);
  fillRect(page, 12, 8, 28, 11, HAIR);    // hair (low-sat → excluded)
  fillRect(page, 12, 11, 28, 15, SKIN);   // skin (excluded by HSL)
  fillRect(page, 12, 15, 28, 27, ORANGE); // JACKET — drifted, dominant
  fillRect(page, 12, 27, 28, 32, BLUE);   // TROUSERS — different hue, out of window
  const mask = rectMask(12, 8, 28, 32);   // figure silhouette covers all of it
  const av = avatarBuf(RED);
  const res = G.normalizeGarmentRaw({ pageRaw: page, n: N, pageMask: mask, avatarRaw: av.raw, avatarN: av.n, avatarMask: av.mask });
  check('applied', res.applied === true, res.reason);
  const unchanged = (i) => page[i * 3] === res.correctedRaw[i * 3] && page[i * 3 + 1] === res.correctedRaw[i * 3 + 1] && page[i * 3 + 2] === res.correctedRaw[i * 3 + 2];
  // background (outside mask)
  let bgOk = true; for (let x = 0; x < 8; x++) if (!unchanged(20 * W + x)) bgOk = false;
  check('background (outside mask) untouched', bgOk);
  // hair, skin
  let hairOk = true; for (let x = 13; x < 27; x++) if (!unchanged(9 * W + x)) hairOk = false;
  let skinOk = true; for (let x = 13; x < 27; x++) if (!unchanged(13 * W + x)) skinOk = false;
  check('hair pixels untouched', hairOk);
  check('skin pixels untouched', skinOk);
  // blue trousers (different hue, outside the selection window)
  let blueOk = true; for (let x = 13; x < 27; x++) if (!unchanged(29 * W + x)) blueOk = false;
  check('other-colour garment (blue) untouched', blueOk);
  // jacket DID change
  let jacketChanged = 0; for (let x = 13; x < 27; x++) if (!unchanged(20 * W + x)) jacketChanged++;
  check('drifted jacket pixels changed', jacketChanged > 5, `changed=${jacketChanged}`);
})();

// ── TEST 6 — large-drift skip (garment-type error territory) ─────────────────
(function testLargeDriftSkip() {
  console.log('\nTEST 6 — very large hue drift is SKIPPED (deferred to eval/repair)');
  const page = blank(BG);
  fillRect(page, 12, 15, 28, 30, BLUE); // blue garment
  const mask = rectMask(12, 15, 28, 30);
  const av = avatarBuf(RED);            // avatar red — ~97° away
  const res = G.normalizeGarmentRaw({ pageRaw: page, n: N, pageMask: mask, avatarRaw: av.raw, avatarN: av.n, avatarMask: av.mask });
  check('not applied', res.applied === false, res.reason);
  check('reason is drift-too-large', /too large/.test(res.reason), res.reason);
  check('correctedRaw untouched', res.correctedRaw === page);
})();

// ── TEST 7 — grey/near-neutral garment skipped (ill-defined hue) ─────────────
(function testGreyGarment() {
  console.log('\nTEST 7 — a near-neutral garment (no reliable hue) is skipped');
  const page = blank(BG);
  fillRect(page, 12, 15, 28, 30, [150, 150, 150]); // grey garment (excluded)
  const mask = rectMask(12, 15, 28, 30);
  const av = avatarBuf(RED);
  const res = G.normalizeGarmentRaw({ pageRaw: page, n: N, pageMask: mask, avatarRaw: av.raw, avatarN: av.n, avatarMask: av.mask });
  check('not applied (no garment hue to align)', res.applied === false, res.reason);
})();

// ── TEST 8 — REGRESSION: a garment-dominated avatar sheet keeps its chroma ────
// A styled avatar sheet is a tight crop of one figure on a plain background, so
// a gray-world mean over it is mostly the GARMENT, not illumination. Discounting
// that mean cancels the signal: measured on a real sheet, a pink top gave cast
// (6.9, 3.6), chroma collapsed 27.2 → 6.5 (under the min of 8 → "low chroma"
// skip) and the hue flipped ~162° (→ bogus "drift too large"). The avatar side
// must therefore be read in ABSOLUTE LAB space, with no cast discount.
(function testAvatarSheetNotSelfDiscounted() {
  console.log('\nTEST 8 — garment-dominated avatar sheet is NOT self-discounted');
  // Avatar sheet where the garment covers most of the frame (the real case).
  const av = blank([250, 250, 250]);            // near-white sheet background
  fillRect(av, 4, 4, 36, 34, RED);              // garment dominates the sheet
  const clusters = G.sampleGarmentClusters(av, N, null, { a: 0, b: 0 }, {}, 3);
  check('avatar cluster found', clusters.length >= 1);
  check('avatar chroma survives (>= chromaMin)', clusters[0].chroma >= G.DEFAULTS.chromaMin,
    `chroma=${clusters[0] && clusters[0].chroma.toFixed(1)}`);
  check('avatar hue is the true garment hue (~red 33°)',
    angDist(clusters[0].hueRad * 180 / Math.PI, hueDeg(RED[0], RED[1], RED[2])) < 8,
    `got ${(clusters[0].hueRad * 180 / Math.PI).toFixed(1)}°`);
  // End-to-end: a drifted page garment against this sheet must still correct.
  const page = blank(BG);
  fillRect(page, 12, 15, 28, 30, ORANGE);
  const res = G.normalizeGarmentRaw({ pageRaw: page, n: N, pageMask: rectMask(12, 15, 28, 30), avatarRaw: av, avatarN: N, avatarMask: null });
  check('drift IS corrected against a garment-dominated sheet', res.applied === true, res.reason);
})();

// ── TEST 9 — REGRESSION: two-garment character matches the RIGHT cluster ──────
// Characters usually wear two coloured garments (top + trousers). The page mask
// and the avatar sheet can each be dominated by a DIFFERENT one, so comparing
// dominant-to-dominant invents a near-180° drift. The page cluster must be
// matched to the NEAREST avatar cluster instead.
(function testTwoGarmentClusterMatch() {
  console.log('\nTEST 9 — two-garment character matches the nearest avatar cluster');
  // Avatar sheet: BLUE trousers dominate by area, RED top is the smaller region.
  const av = blank([250, 250, 250]);
  fillRect(av, 4, 20, 36, 38, BLUE);   // trousers — larger
  fillRect(av, 12, 4, 28, 18, RED);    // top — smaller
  const clusters = G.sampleGarmentClusters(av, N, null, { a: 0, b: 0 }, {}, 3);
  check('both avatar garments are found as clusters', clusters.length >= 2, `got ${clusters.length}`);
  // Page shows only the TOP (torso mask), drifted orange. Dominant avatar cluster
  // is BLUE (~-65°), which is ~124° from orange → would be "drift too large".
  const page = blank(BG);
  fillRect(page, 12, 15, 28, 30, ORANGE);
  const res = G.normalizeGarmentRaw({ pageRaw: page, n: N, pageMask: rectMask(12, 15, 28, 30), avatarRaw: av, avatarN: N, avatarMask: null });
  check('corrected against the RED cluster, not the dominant BLUE one', res.applied === true, res.reason);
  check('target hue is the red top, not the blue trousers',
    angDist(res.avatarHueDeg, hueDeg(RED[0], RED[1], RED[2])) < 12, `avatarHueDeg=${res.avatarHueDeg}`);
})();

// ── TEST 10 — REGRESSION: background-masked cast still discounts illumination ─
// The scene cast must come from the page BACKGROUND (outside every figure). A
// figure that fills much of the frame otherwise lands its own garment colour in
// the "illumination" mean. Discounting must still work through that mask.
(function testBackgroundCastMask() {
  console.log('\nTEST 10 — cast from background mask still discounts a global tint');
  const page = blank(BG);
  fillRect(page, 6, 6, 34, 34, RED);            // figure fills most of the frame
  const figMask = rectMask(6, 6, 34, 34);
  const castMask = Buffer.alloc(N, 255);
  for (let i = 0; i < N; i++) if (figMask[i] > 128) castMask[i] = 0; // background only
  const lit = castAll(page, 12, 14);             // strong global sunset cast
  const av = avatarBuf(RED);
  const res = G.normalizeGarmentRaw({ pageRaw: lit, n: N, pageMask: figMask, castMask, avatarRaw: av.raw, avatarN: av.n, avatarMask: av.mask });
  check('global cast is NOT mistaken for garment drift', res.applied === false, res.reason);
  check('correctedRaw untouched', res.correctedRaw === lit);
})();

// ── TEST 11 — torso fallback box geometry ────────────────────────────────────
(function testTorsoBox() {
  console.log('\nTEST 11 — torsoBoxFromBody trims head, legs and side background');
  const [ymin, xmin, ymax, xmax] = G.torsoBoxFromBody([0, 0, 1, 1]);
  check('starts below the head', ymin > 0.1, `ymin=${ymin}`);
  check('ends above the legs', ymax < 0.7, `ymax=${ymax}`);
  check('inset horizontally on both sides', xmin > 0.1 && xmax < 0.9, `x=${xmin}..${xmax}`);
  check('non-degenerate', ymax > ymin && xmax > xmin);
  check('a non-box passes through unchanged', G.torsoBoxFromBody(null) === null);
})();

// ── TEST 12 — REGRESSION: measure in the torso band, APPLY to the whole figure ─
// The sampling mask and the application mask must NOT be the same buffer. A
// full-length dress reads its hue from the bodice but has to rotate all the way
// down; rotating only the sampling rectangle left a hard horizontal seam across
// the skirt (observed on real pages — the recoloured region was literally the
// torso rectangle). Which pixels move is decided by the hue window, not by the
// extent of the sampling mask.
(function testSampleMaskVsApplyMask() {
  console.log('\nTEST 12 — hue is sampled in the torso band but applied to the whole garment');
  const page = blank(BG);
  // A "dress": one continuous garment from y=10 (bodice) to y=36 (hem).
  fillRect(page, 12, 10, 28, 36, ORANGE);
  const figure = rectMask(10, 8, 30, 38);                 // whole figure
  const torso = rectMask(12, 12, 28, 22);                 // bodice only
  const av = avatarBuf(RED);
  const res = G.normalizeGarmentRaw({
    pageRaw: page, n: N, pageMask: figure, sampleMask: torso,
    avatarRaw: av.raw, avatarN: av.n, avatarMask: av.mask,
  });
  check('applied', res.applied === true, res.reason);
  const changedAt = (x, y) => {
    const i = y * W + x;
    return res.correctedRaw[i * 3] !== page[i * 3] || res.correctedRaw[i * 3 + 1] !== page[i * 3 + 1] || res.correctedRaw[i * 3 + 2] !== page[i * 3 + 2];
  };
  check('bodice (inside the sampling band) is corrected', changedAt(20, 16));
  check('HEM (far below the sampling band) is corrected too — no seam', changedAt(20, 33));
  check('mid-skirt is corrected', changedAt(20, 27));
  // Nothing outside the figure mask may move.
  check('background outside the figure mask untouched', !changedAt(2, 2) && !changedAt(38, 38));
  // And the whole garment must land on ONE hue — no two-tone split.
  const hAt = (x, y) => { const i = y * W + x; return hueDeg(res.correctedRaw[i * 3], res.correctedRaw[i * 3 + 1], res.correctedRaw[i * 3 + 2]); };
  check('bodice and hem end on the SAME hue (single-tone garment)', angDist(hAt(20, 16), hAt(20, 33)) < 3,
    `bodice ${hAt(20, 16).toFixed(1)}° vs hem ${hAt(20, 33).toFixed(1)}°`);
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

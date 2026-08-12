/**
 * The observed colour is an INPUT, not just a log line (owner, 2026-08-12).
 *
 * The entity check emits `observedColour` ("purple") next to `expectedColour`
 * ("blue") on every garment_colour finding, so the repair knows what colour the
 * garment IS before it moves a pixel. Two consumers:
 *   1. point prompts — SAM gets fg points on purple and bg points on everything
 *      far from it, which is the only way to say "the robe, not the map it is
 *      behind"; a box cannot express that (job_1786484554633_crojok432 p3);
 *   2. a verification gate — if the finished mask is not the reported colour,
 *      the mask is not the garment and nothing is repainted.
 *
 * Measured p3 values used below (Lab 533-537, replayed against v0):
 *   robe  mask L 77.0 chroma 16.2 hue  +82.5  -> the cream map    (must REFUSE)
 *   shoes mask L 66.6 chroma 13.8 hue  +68.4  -> map + background (must REFUSE)
 *   hat   mask L 41.7 chroma 17.0 hue  -28.6  -> the actual hat   (must PASS)
 *
 * Run: node tests/manual/garmentObservedColour.test.js
 */
const assert = require('assert');
const {
  resolveColourName, maskMatchesObservedColour, deriveColourPoints, DEFAULTS, COLOUR_REFS,
} = require('../../server/lib/garmentColourFix');

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
};
const cfg = DEFAULTS;
// The measured mask means from p3, as L*a*b*.
const fromPolar = (L, chroma, hueDeg) => ({
  L, a: chroma * Math.cos(hueDeg * Math.PI / 180), b: chroma * Math.sin(hueDeg * Math.PI / 180),
});

// ── Colour word resolution ──────────────────────────────────────────────────
t('plain colour words resolve', () => {
  for (const w of ['purple', 'blue', 'green', 'red', 'grey', 'black']) {
    assert.ok(resolveColourName(w), `${w} must resolve`);
    assert.strictEqual(resolveColourName(w).name, w);
  }
});

t('compound words take the first known term', () => {
  assert.strictEqual(resolveColourName('dark brown/black').name, 'brown');
  assert.strictEqual(resolveColourName('yellow/gold').name, 'yellow');
  assert.strictEqual(resolveColourName('black/brown').name, 'black');
});

t('modifiers are skipped, not treated as colours', () => {
  assert.strictEqual(resolveColourName('deep purple').name, 'purple');
  assert.strictEqual(resolveColourName('pale blue').name, 'blue');
  assert.strictEqual(resolveColourName('very dark green').name, 'green');
});

t('case and punctuation are tolerated', () => {
  assert.strictEqual(resolveColourName('  Purple. ').name, 'purple');
  assert.strictEqual(resolveColourName('GREY').name, 'grey');
});

t('an unresolvable word REFUSES rather than guessing', () => {
  for (const w of ['chartreuse-ish', 'wizardy', '', null, undefined, 'dark']) {
    assert.strictEqual(resolveColourName(w), null, `${JSON.stringify(w)} must not resolve`);
  }
});

t('grey and gray are the same colour', () => {
  assert.deepStrictEqual(COLOUR_REFS.grey, COLOUR_REFS.gray);
});

// ── The gate on the measured p3 masks ───────────────────────────────────────
t('p3 robe: the cream map is REFUSED against "purple"', () => {
  const v = maskMatchesObservedColour(fromPolar(77.0, 16.2, 82.5), resolveColourName('purple'), cfg);
  assert.strictEqual(v.ok, false);
  assert.ok(/not the garment|near-neutral/.test(v.reason), v.reason);
});

t('p3 shoes: map + background is REFUSED against "dark brown/black"', () => {
  const v = maskMatchesObservedColour(fromPolar(66.6, 13.8, 68.4), resolveColourName('dark brown/black'), cfg);
  assert.strictEqual(v.ok, false);
});

t('p3 hat: the real hat PASSES against "purple"', () => {
  const v = maskMatchesObservedColour(fromPolar(41.7, 17.0, -28.6), resolveColourName('purple'), cfg);
  assert.strictEqual(v.ok, true, v.reason);
  assert.ok(v.hueDelta < cfg.observedMaxHueDeg, `hue delta ${v.hueDelta}`);
});

t('a genuinely purple robe PASSES (the case that must keep working)', () => {
  // Noah's robe as rendered on p4/p5: chroma ~38, hue ~-50.
  const v = maskMatchesObservedColour(fromPolar(29.2, 38.6, -50.0), resolveColourName('purple'), cfg);
  assert.strictEqual(v.ok, true, v.reason);
});

t('no observed colour → gate is inert, never blocks', () => {
  const v = maskMatchesObservedColour(fromPolar(77, 16, 82), null, cfg);
  assert.strictEqual(v.ok, true);
});

// ── Achromatic references are judged on lightness, not hue ──────────────────
t('"black" rejects a saturated mask', () => {
  const v = maskMatchesObservedColour(fromPolar(30, 40, -50), resolveColourName('black'), cfg);
  assert.strictEqual(v.ok, false);
  assert.ok(/saturated/.test(v.reason), v.reason);
});

t('"black" accepts a dark neutral mask', () => {
  assert.strictEqual(maskMatchesObservedColour(fromPolar(18, 4, 0), resolveColourName('black'), cfg).ok, true);
});

t('"grey" rejects a mask that is far too light', () => {
  const v = maskMatchesObservedColour(fromPolar(95, 3, 0), resolveColourName('grey'), cfg);
  assert.strictEqual(v.ok, false);
  assert.ok(/lightness/.test(v.reason), v.reason);
});

t('Hans\'s grey robe is not rejected for being unsaturated', () => {
  // The reason the "most saturated cluster" heuristic was rejected: a real
  // garment can legitimately be neutral.
  assert.strictEqual(maskMatchesObservedColour(fromPolar(49, 3, 170), resolveColourName('grey'), cfg).ok, true);
});

t('a chromatic reference rejects a near-neutral mask', () => {
  const v = maskMatchesObservedColour(fromPolar(50, 4, -50), resolveColourName('green'), cfg);
  assert.strictEqual(v.ok, false);
  assert.ok(/near-neutral/.test(v.reason), v.reason);
});

t('opposite hues are rejected — purple mask against a green report', () => {
  assert.strictEqual(
    maskMatchesObservedColour(fromPolar(35, 35, -50), resolveColourName('green'), cfg).ok, false);
});

// ── Point derivation ────────────────────────────────────────────────────────
// A synthetic crop: left half purple (the garment), right half cream (the map).
const CW = 80, CH = 80;
const buildCrop = () => {
  const buf = Buffer.alloc(CW * CH * 3);
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const i = (y * CW + x) * 3;
      const purple = x < CW / 2;
      buf[i] = purple ? 110 : 238;
      buf[i + 1] = purple ? 70 : 226;
      buf[i + 2] = purple ? 150 : 198;
    }
  }
  return buf;
};

t('foreground points land on the garment, background on the map', () => {
  const pts = deriveColourPoints(buildCrop(), CW, CH, [0, 0, CW, CH], resolveColourName('purple'), cfg);
  assert.ok(pts.fg > 0, 'must find foreground points');
  assert.ok(pts.bg > 0, 'must find background points');
  const labels = pts.labels;
  pts.points.forEach(([x], i) => {
    if (labels[i] === 1) assert.ok(x < CW / 2, `fg point at x=${x} is on the map side`);
    else assert.ok(x >= CW / 2, `bg point at x=${x} is on the garment side`);
  });
});

t('point counts stay within the configured caps', () => {
  const pts = deriveColourPoints(buildCrop(), CW, CH, [0, 0, CW, CH], resolveColourName('purple'), cfg);
  assert.ok(pts.fg <= cfg.maxFgPoints, `${pts.fg} > ${cfg.maxFgPoints}`);
  assert.ok(pts.bg <= cfg.maxBgPoints, `${pts.bg} > ${cfg.maxBgPoints}`);
  assert.strictEqual(pts.points.length, pts.labels.length);
});

t('labels are only 1 or 0', () => {
  const pts = deriveColourPoints(buildCrop(), CW, CH, [0, 0, CW, CH], resolveColourName('purple'), cfg);
  for (const l of pts.labels) assert.ok(l === 1 || l === 0, `bad label ${l}`);
});

t('no garment colour anywhere → NO points, rather than bg-only steering', () => {
  // Asking for green in a purple/cream crop: SAM must be left with the box
  // alone rather than pushed away from everything.
  const pts = deriveColourPoints(buildCrop(), CW, CH, [0, 0, CW, CH], resolveColourName('green'), cfg);
  assert.strictEqual(pts.points, null);
  assert.strictEqual(pts.fg, 0);
});

t('no observed colour → no points', () => {
  const pts = deriveColourPoints(buildCrop(), CW, CH, [0, 0, CW, CH], null, cfg);
  assert.strictEqual(pts.points, null);
});

t('a degenerate box yields no points', () => {
  const pts = deriveColourPoints(buildCrop(), CW, CH, [10, 10, 12, 12], resolveColourName('purple'), cfg);
  assert.strictEqual(pts.points, null);
});

t('points stay inside the crop bounds', () => {
  const pts = deriveColourPoints(buildCrop(), CW, CH, [-20, -20, CW + 50, CH + 50], resolveColourName('purple'), cfg);
  for (const [x, y] of (pts.points || [])) {
    assert.ok(x >= 0 && x < CW && y >= 0 && y < CH, `point ${x},${y} out of bounds`);
  }
});

console.log(`${pass} passed`);

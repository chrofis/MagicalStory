/**
 * A figure standing IN FRONT of another must not become its silhouette
 * (owner, 2026-08-15).
 *
 * job_1786780194082_s980g4s9a p-2: Daniel crouches directly behind Emma, so the
 * DINO person box drawn for him encloses her — 98.8% of her box lies inside
 * his. MobileSAM, prompted with that box and nothing else, returned EMMA.
 * Every Stage-2 gate passed (inside the box, one connected component, 69.9%
 * coverage), so Daniel's entity cutout shipped as his head on her red top and
 * orange shorts. The judge then correctly reported "top is red, should be
 * yellow" and the garment recolour repainted 20,972 px of Emma's CORRECT red
 * shirt to yellow, plus 12,510 px of her orange shorts to grey.
 *
 * The fix resolves the smallest box first and erases that figure's pixels from
 * the image before asking SAM for the figure behind it.
 *
 * Run: node tests/manual/frontFigureErase.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  _boxAreaPx, _boxContainment, _unionDilated,
  SAM_FRONT_CONTAINMENT, SAM_FRONT_MAX_AREA, SAM_FRONT_DILATE_PX, SAM_FRONT_MIN_REMAINDER,
} = require('../../server/lib/figureDetection');

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
};

// The real boxes from that page, in page pixels [x0,y0,x1,y1].
const BOX = {
  Emma:   [124, 438, 326, 1178],
  Noah:   [288, 458, 503, 1191],
  Daniel: [124, 344, 396, 1169],
  Sarah:  [403, 414, 611, 1122],
  Hans:   [510, 199, 768, 1117],
};
const isInFront = (inner, outer) =>
  _boxAreaPx(inner) < SAM_FRONT_MAX_AREA * _boxAreaPx(outer)
  && _boxContainment(inner, outer) >= SAM_FRONT_CONTAINMENT;

// ── The page that caused it ─────────────────────────────────────────────────
t('Emma is recognised as standing in front of Daniel', () => {
  const c = _boxContainment(BOX.Emma, BOX.Daniel);
  assert.ok(c > 0.98, `expected near-total containment, got ${c.toFixed(3)}`);
  assert.ok(isInFront(BOX.Emma, BOX.Daniel), 'Emma must be erased before Daniel is masked');
});

t('and Daniel is NOT treated as standing in front of Emma', () => {
  assert.ok(!isInFront(BOX.Daniel, BOX.Emma), 'containment is asymmetric — the bigger box never hides behind the smaller');
});

t('nobody else on that page triggers an erase', () => {
  const pairs = [];
  for (const [a, ba] of Object.entries(BOX)) {
    for (const [b, bb] of Object.entries(BOX)) {
      if (a !== b && isInFront(ba, bb)) pairs.push(`${a}->${b}`);
    }
  }
  assert.deepStrictEqual(pairs, ['Emma->Daniel'], `unexpected pairs: ${pairs.join(', ')}`);
});

t('Daniel is masked after Emma — smallest box first', () => {
  const names = Object.keys(BOX);
  const order = names.slice().sort((a, b) => _boxAreaPx(BOX[a]) - _boxAreaPx(BOX[b])).map(n => n);
  assert.ok(order.indexOf('Emma') < order.indexOf('Daniel'),
    `Emma must resolve first, order was ${order.join(' < ')}`);
});

// ── The containment rule in isolation ───────────────────────────────────────
t('side-by-side figures never trigger it', () => {
  assert.ok(!isInFront([0, 0, 100, 400], [100, 0, 200, 400]), 'no overlap at all');
  assert.ok(!isInFront([80, 0, 180, 400], [100, 0, 200, 400]), 'a 20% shoulder overlap is not "in front"');
});

t('a barely-overlapping child is not erased from a parent', () => {
  // 70% inside is below the floor — leave it alone rather than cut a real
  // figure's silhouette on a guess.
  const inner = [100, 0, 200, 100];      // area 10000
  const outer = [130, 0, 400, 100];      // overlap x 130..200 = 70%
  assert.strictEqual(+_boxContainment(inner, outer).toFixed(2), 0.70);
  assert.ok(!isInFront(inner, outer));
});

t('the same figure detected twice is not treated as its own occluder', () => {
  const a = [100, 100, 300, 800];
  const b = [102, 104, 298, 795];   // same person, 1px jitter — fully contained
  assert.ok(_boxContainment(b, a) > 0.98, 'it IS contained');
  assert.ok(!isInFront(b, a), 'but it is not smaller enough to be a separate figure in front');
});

t('a degenerate box yields 0, never NaN', () => {
  assert.strictEqual(_boxContainment([10, 10, 10, 10], [0, 0, 100, 100]), 0);
  assert.strictEqual(_boxAreaPx([50, 50, 10, 10]), 0, 'inverted box has no area');
});

// ── The erase mask ──────────────────────────────────────────────────────────
const mk = (W, H, set) => {
  const alpha = new Uint8Array(W * H);
  for (const [x, y] of set) alpha[y * W + x] = 1;
  return { alpha, width: W, height: H };
};

t('the union covers every input silhouette', () => {
  const u = _unionDilated([mk(20, 20, [[5, 5]]), mk(20, 20, [[15, 15]])], 20, 20, 0);
  assert.strictEqual(u[5 * 20 + 5], 1);
  assert.strictEqual(u[15 * 20 + 15], 1);
  assert.strictEqual(u[0], 0, 'nothing else is set');
});

t('dilation grows the rim by exactly the radius, in both axes', () => {
  const r = SAM_FRONT_DILATE_PX;
  const u = _unionDilated([mk(40, 40, [[20, 20]])], 40, 40, r);
  assert.strictEqual(u[20 * 40 + (20 + r)], 1, 'right edge grown');
  assert.strictEqual(u[20 * 40 + (20 - r)], 1, 'left edge grown');
  assert.strictEqual(u[(20 + r) * 40 + 20], 1, 'bottom edge grown');
  assert.strictEqual(u[(20 - r) * 40 + 20], 1, 'top edge grown');
  assert.strictEqual(u[20 * 40 + (20 + r + 1)], 0, 'and no further');
});

t('dilation does not wrap around a row edge', () => {
  // A silhouette touching the left border must not bleed onto the right border
  // of the row above — the classic flat-array off-by-W bug.
  const u = _unionDilated([mk(30, 30, [[0, 10]])], 30, 30, 3);
  assert.strictEqual(u[9 * 30 + 29], 0, 'wrapped onto the previous row');
  assert.strictEqual(u[10 * 30 + 29], 0, 'wrapped onto its own row');
});

t('an empty input yields an empty union, not a crash', () => {
  const u = _unionDilated([], 10, 10, 3);
  assert.strictEqual(u.reduce((s, v) => s + v, 0), 0);
});

// ── The remainder floor ─────────────────────────────────────────────────────
t('the occluded remainder is allowed to be far smaller than a normal mask', () => {
  const { _cleanMaskAndCheck } = require('../../server/lib/figureDetection');
  assert.ok(typeof _cleanMaskAndCheck === 'function');
  assert.ok(SAM_FRONT_MIN_REMAINDER < 0.25,
    'must sit below SAM_MIN_BOX_COVERAGE — a head above a child is a legitimate 3% of the box');
  assert.ok(SAM_FRONT_MIN_REMAINDER > 0, 'but an empty mask is still rejected');
});

// ── Wiring ──────────────────────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'lib', 'figureDetection.js'), 'utf8');

t('SAM is called with the ERASED image, not the original', () => {
  assert.ok(/_mobilesamMaskFull\(samInput, box, W, H\)/.test(SRC),
    'the mask call must take the erased input');
  assert.ok(/samInput = await _erasePixels\(imageDataUri, erased, W, H\)/.test(SRC));
});

t('figures are masked smallest-box-first', () => {
  assert.ok(/sort\(\(a, b\) => _boxAreaPx\(boxesPx\[a\]\) - _boxAreaPx\(boxesPx\[b\]\)\)/.test(SRC),
    'the box order must be by ascending area');
  assert.ok(/out\[bi\] = \{ box, mask, keptBox, coverage, verdict/.test(SRC),
    'results must be written back by ORIGINAL index — a sorted push would silently reorder every figure downstream');
});

// ── BOTH detection paths, not just DINO ─────────────────────────────────────
t('there is exactly ONE box→mask loop, shared by both paths', () => {
  // The page that caused this bug ran through the GEMINI second-opinion path
  // (`detectionBackend: gemini-second-opinion`, dino 4 < gemini 5), whose masks
  // are attached by attachSamMasksToFigures — a second loop that had its own
  // copy of the SAM call. A fix in the DINO Stage 2 alone would never have
  // fired on the page it was written for.
  const calls = SRC.match(/_mobilesamMaskFull\(/g) || [];
  assert.strictEqual(calls.length, 2,
    `expected one definition + one call site, found ${calls.length} — a third means a path bypasses the shared masker`);
  const shared = SRC.match(/_maskBoxesFrontFirst\(/g) || [];
  assert.strictEqual(shared.length, 3, 'one definition + two call sites (DINO Stage 2, attachSamMasksToFigures)');
});

t('the Gemini second-opinion path uses it', () => {
  const fn = SRC.slice(SRC.indexOf('async function attachSamMasksToFigures'));
  const body = fn.slice(0, fn.indexOf('\nasync function ', 10));
  assert.ok(/_maskBoxesFrontFirst\(imageDataUri, boxesPx, W, H, pageLabel\)/.test(body),
    'attachSamMasksToFigures must mask through the shared front-first masker');
  assert.ok(!/_mobilesamMaskFull\(/.test(body),
    'and must not call SAM directly any more');
});

t('the DINO path uses it', () => {
  assert.ok(/_maskBoxesFrontFirst\(imageDataUri, persons\.map\(p => p\.box\), W, H, pageLabel\)/.test(SRC));
});

t('erased pixels are subtracted from whatever SAM returns', () => {
  assert.ok(/if \(erased\[k\] && rawMask\.alpha\[k\]\) \{ rawMask\.alpha\[k\] = 0/.test(SRC),
    'the white hole must not be able to come back as the figure');
  assert.ok(/rawMask\.pngBuf = await _maskToPng\(rawMask\)/.test(SRC),
    'a mutated mask must refresh the PNG the cutout strip reads');
});

t('the relaxed floor applies ONLY when something was erased', () => {
  assert.ok(/erased \? \{ minCoverage: SAM_FRONT_MIN_REMAINDER \} : \{\}/.test(SRC),
    'an ordinary figure keeps the stale-embedding fragment guard');
});

t('the verdict says an erase happened, so a lab run can see it', () => {
  assert.ok(/mask-ok-front-figure-erased/.test(SRC));
});

console.log(`${pass} passed`);

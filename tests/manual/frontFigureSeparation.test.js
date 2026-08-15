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
 * ROOT CAUSE (measured locally, $0): Emma's own box-only SAM mask covers 97% of
 * DANIEL'S head zone - her silhouette swallowed the man behind her. So the
 * existing carve-out (subtract her mask from his) deleted HIS OWN head, and
 * erasing her pixels to white before his SAM call painted his face out too.
 *
 * The fix tells SAM which figure it is looking at: a POSITIVE point on the
 * target's own face plus a NEGATIVE point on every other face inside the same
 * box (leak 97% -> 5.6%), then subtracts the front figure's dilated mask and
 * drops the seam fringe. Both halves are required: the point alone leaves her
 * legs in his mask, the subtraction alone eats his head.
 *
 * Run: node tests/manual/frontFigureErase.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  _boxAreaPx, _boxContainment, _unionDilated, _dropSmallComponents, _assignFacesToBoxes,
  SAM_FRONT_CONTAINMENT, SAM_FRONT_MAX_AREA, SAM_FRONT_DILATE_PX, SAM_FRONT_MIN_REMAINDER,
  SAM_SPECKLE_MIN_PX, SAM_FACE_CONTAINMENT,
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
  assert.ok(isInFront(BOX.Emma, BOX.Daniel), 'Emma must be subtracted from Daniel, and negative-pointed in his SAM call');
});

t('and Daniel is NOT treated as standing in front of Emma', () => {
  assert.ok(!isInFront(BOX.Daniel, BOX.Emma), 'containment is asymmetric — the bigger box never hides behind the smaller');
});

t('nobody else on that page triggers a subtraction', () => {
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

t('a barely-overlapping child is not carved out of a parent', () => {
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

// ── The subtraction mask ────────────────────────────────────────────────────
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

t('SAM is told WHICH figure in the box is the target', () => {
  // The measured root cause: Emma's box-only mask covered 97% of Daniel's head
  // zone, so the carve-out deleted his own face and the erase painted it white.
  // A positive point on the target's face plus a negative on every other face
  // inside the same box drops that leak to 5.6%.
  assert.ok(/points\.push\(_boxCentre\(own\)\); labels\.push\(1\)/.test(SRC),
    'the target must get a POSITIVE point on its own face');
  assert.ok(/points\.push\(c\); labels\.push\(0\)/.test(SRC),
    'every other face inside the box must get a NEGATIVE point');
  assert.ok(/_mobilesamMaskFull\(imageDataUri, box, W, H,\s*\n\s*points\.length \? points : null/.test(SRC),
    'the points must actually reach the SAM call');
});

t('the analyzer contract is honoured: points + point_labels', () => {
  assert.ok(/point_labels: labels/.test(SRC),
    'the endpoint reads `point_labels`, not `labels`');
  assert.ok(/\{ image: imageDataUri, box: boxPx \}\)/.test(SRC),
    'a figure with no face still sends a plain box call');
});

t('the front figure is still SUBTRACTED - the point alone is not enough', () => {
  // Measured: with the negative point but no subtraction, Daniel's mask still
  // contained Emma's legs and her white sandal.
  assert.ok(/const front = _unionDilated\(inFront\.map\(d => d\.mask\), W, H, SAM_FRONT_DILATE_PX\)/.test(SRC));
  assert.ok(/if \(front\[k\]\) rawMask\.alpha\[k\] = 0/.test(SRC));
  assert.ok(/_dropSmallComponents\(rawMask\.alpha, W, H, SAM_SPECKLE_MIN_PX\)/.test(SRC),
    'and the seam fringe must be dropped');
});

t('the white erase is gone', () => {
  assert.ok(!/_erasePixels/.test(SRC),
    'erasing the front figure to white lost the face - it must not come back');
});

t('the relaxed floor applies ONLY when a figure was carved out', () => {
  assert.ok(/carved \? \{ minCoverage: SAM_FRONT_MIN_REMAINDER \} : \{\}/.test(SRC),
    'an ordinary figure keeps the stale-embedding fragment guard');
});

t('the verdicts say what happened, so a lab run can see it', () => {
  assert.ok(/mask-ok-front-figure-removed/.test(SRC));
  assert.ok(/mask-ok-face-separated/.test(SRC));
});

t('figures are masked smallest-box-first', () => {
  assert.ok(/sort\(\(a, b\) => _boxAreaPx\(boxesPx\[a\]\) - _boxAreaPx\(boxesPx\[b\]\)\)/.test(SRC),
    'the box order must be by ascending area');
  assert.ok(/out\[bi\] = \{ box, mask, keptBox, coverage, verdict/.test(SRC),
    'results must be written back by ORIGINAL index - a sorted push would silently reorder every figure downstream');
});

// -- BOTH detection paths, not just DINO --------------------------------------
t('there is exactly ONE box->mask loop, shared by both paths', () => {
  // The page that caused this bug ran through the GEMINI second-opinion path
  // (detectionBackend: gemini-second-opinion, dino 4 < gemini 5), whose masks
  // are attached by attachSamMasksToFigures - a second loop that had its own
  // copy of the SAM call. A fix in the DINO Stage 2 alone would never have
  // fired on the page it was written for.
  const calls = SRC.match(/_mobilesamMaskFull\(/g) || [];
  assert.strictEqual(calls.length, 2,
    'expected one definition + one call site, found ' + calls.length);
  const shared = SRC.match(/_maskBoxesFrontFirst\(/g) || [];
  assert.strictEqual(shared.length, 3,
    'one definition + two call sites (DINO Stage 2, attachSamMasksToFigures)');
});

t('the Gemini second-opinion path uses it, WITH face boxes', () => {
  const fn = SRC.slice(SRC.indexOf('async function attachSamMasksToFigures'));
  const body = fn.slice(0, fn.indexOf('\nasync function ', 10));
  assert.ok(/_maskBoxesFrontFirst\(imageDataUri, boxesPx, W, H, pageLabel, faceBoxesPx\)/.test(body),
    'it must pass the figures own faceBoxes - without them there are no points and the bug returns');
  assert.ok(!/_mobilesamMaskFull\(/.test(body), 'and must not call SAM directly any more');
});

t('the DINO path uses it, with the Stage-1b face boxes', () => {
  assert.ok(/_maskBoxesFrontFirst\(imageDataUri, persons\.map\(p => p\.box\), W, H, pageLabel,\s*\n\s*faces\.map\(f => f\.box\)\)/.test(SRC));
});

// -- Face -> box assignment ---------------------------------------------------
const E_FACE = [142, 438, 326, 746];
const D_FACE = [212, 344, 396, 651];

t('a face inside BOTH boxes belongs to the smaller one', () => {
  const r = _assignFacesToBoxes([BOX.Emma, BOX.Daniel], [E_FACE, D_FACE]);
  assert.deepStrictEqual(r[0], E_FACE, 'Emma keeps her own face');
  assert.deepStrictEqual(r[1], D_FACE, 'Daniel gets the face that is only in his box');
});

t('a box with no face resolves to null, never to a neighbour face', () => {
  const r = _assignFacesToBoxes([BOX.Hans, BOX.Emma], [E_FACE]);
  assert.strictEqual(r[0], null, 'Hans has no face in this input');
  assert.deepStrictEqual(r[1], E_FACE);
});

t('one face is never assigned to two boxes', () => {
  const r = _assignFacesToBoxes([BOX.Emma, BOX.Daniel], [E_FACE]);
  assert.strictEqual(r.filter(Boolean).length, 1);
});

t('a face outside every box is dropped', () => {
  assert.deepStrictEqual(_assignFacesToBoxes([BOX.Emma], [[700, 100, 760, 160]]), [null]);
});

t('junk input is ignored, never throws', () => {
  assert.deepStrictEqual(_assignFacesToBoxes([BOX.Emma], [null, 'x', [1, 2]]), [null]);
  assert.deepStrictEqual(_assignFacesToBoxes([BOX.Emma], null), [null]);
});

// -- Speckle cleanup ----------------------------------------------------------
t('the seam fringe is dropped and the figure is kept whole', () => {
  const W = 200, H = 200;
  const a = new Uint8Array(W * H);
  for (let y = 20; y < 120; y++) for (let x = 20; x < 120; x++) a[y * W + x] = 1;  // 10,000px figure
  for (let i = 0; i < 40; i++) a[(150 + (i % 5)) * W + 150 + i] = 1;               // scattered fringe
  const kept = _dropSmallComponents(a, W, H, SAM_SPECKLE_MIN_PX);
  assert.strictEqual(kept, 10000, 'the figure survives whole');
  assert.strictEqual(a[155 * W + 155], 0, 'the fringe is gone');
});

t('a mask made only of fringe collapses to nothing', () => {
  const W = 60, H = 60;
  const a = new Uint8Array(W * H);
  for (let i = 0; i < 30; i++) a[(i * 2) * W + i] = 1;
  assert.strictEqual(_dropSmallComponents(a, W, H, SAM_SPECKLE_MIN_PX), 0);
});

t('the floors cannot eat a real occluded remainder', () => {
  // Daniel's real remainder measured 25,524px; the floor is two orders below.
  assert.ok(SAM_SPECKLE_MIN_PX < 1000, 'floor ' + SAM_SPECKLE_MIN_PX + ' is too aggressive');
  assert.ok(SAM_FACE_CONTAINMENT > 0.5 && SAM_FACE_CONTAINMENT <= 1);
});

// -- NMS must not delete the figure standing behind ---------------------------
t('the occluded figure survives NMS on the real page', () => {
  // Daniel vs Emma is IoU 0.653 against a 0.5 threshold, and the ONLY pair on
  // that page over it. Plain NMS deletes whichever scored lower - always the
  // half-hidden one - which is why DINO returned 4 persons for 5 expected, the
  // undercount handed the page to Gemini, and Gemini's oversized Daniel box
  // started the Emma-repaint failure.
  const iou = (a, b) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const i = ix * iy;
    return i / (_boxAreaPx(a) + _boxAreaPx(b) - i);
  };
  const v = iou(BOX.Daniel, BOX.Emma);
  assert.ok(v > 0.5, `plain NMS would suppress: IoU ${v.toFixed(3)}`);
  const ratio = Math.min(_boxAreaPx(BOX.Emma), _boxAreaPx(BOX.Daniel))
    / Math.max(_boxAreaPx(BOX.Emma), _boxAreaPx(BOX.Daniel));
  assert.ok(ratio < 0.70, `but the sizes differ too much to be one person: ${ratio.toFixed(2)}`);
});

t('NMS keeps a genuinely duplicated detection suppressed', () => {
  // Same person twice: high IoU AND similar size -> still one figure.
  const a = [100, 100, 300, 800];
  const b = [104, 106, 296, 792];
  const ratio = Math.min(_boxAreaPx(a), _boxAreaPx(b)) / Math.max(_boxAreaPx(a), _boxAreaPx(b));
  assert.ok(ratio >= 0.70, `a duplicate must stay a duplicate, ratio ${ratio.toFixed(2)}`);
});

t('the size guard is wired for PERSONS and not for faces', () => {
  assert.ok(/const GDINO_NMS_SIZE_RATIO = 0\.70/.test(SRC));
  assert.ok(/_collectNmsBoxes\(det\.figures\[0\], GDINO_PERSON_NMS_IOU, \{ keepOccluded: true \}\)/.test(SRC),
    'person NMS must keep the occluded figure');
  assert.ok(/_collectNmsBoxes\(fdet\.figures\[0\], GDINO_FACE_NMS_IOU\)/.test(SRC),
    'face NMS keeps plain IoU - two face boxes of different sizes on one spot ARE a duplicate');
  assert.ok(/keepOccluded \? _sameFigureSize|!keepOccluded \|\| _sameFigureSize/.test(SRC),
    'the guard must only apply when opted in');
});

console.log(pass + ' passed');

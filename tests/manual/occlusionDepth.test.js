/**
 * Occlusion is resolved JOINTLY, by depth (owner, 2026-08-15).
 *
 * job_1786780194082_s980g4s9a p-2: Daniel crouches behind Emma. His person box
 * encloses hers (98.8%), MobileSAM prompted with that box returned EMMA, and the
 * garment recolour then repainted 20,972 px of Emma's CORRECT red shirt to
 * yellow plus 12,510 px of her orange shorts to grey.
 *
 * Measured root cause, local replay ($0): Emma's own box-only mask covers 97% of
 * DANIEL'S head zone - her silhouette swallowed the man behind her. So
 * subtracting her from him deleted HIS OWN head, and erasing her to white before
 * his SAM call painted his face out. Both "obvious" fixes destroyed him.
 *
 * What ships instead:
 *   1. SAM is told which figure it is looking at - POSITIVE on that figure's own
 *      face, NEGATIVE on every other face inside the same box (leak 97% -> 5.6%).
 *   2. Depth from geometry: lower box bottom = nearer the camera.
 *   3. Winner-take-all - each pixel goes to the frontmost claimant. No dilation,
 *      so no seam fringe and no speckle filter to clean one up.
 *   4. A mask is accepted on containing its OWN FACE, not on filling its box:
 *      the old 0.25 coverage floor threw away Daniel's real mask at 0.228 and
 *      left him with no cut-out at all.
 *
 * Run: node tests/manual/occlusionDepth.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  _boxAreaPx, _boxContainment, _assignFacesToBoxes, _garmentColourWords, NEUTRAL_COLOURS,
  _personBoxFromFace,
  SAM_FACE_CONTAINMENT, SAM_FACE_IN_MASK, SAM_FRONT_CONTAINMENT, SAM_GROUND_TIE_PX,
} = require('../../server/lib/figureDetection');

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
};

// The real boxes from that page, page pixels [x0,y0,x1,y1].
const BOX = {
  Emma:   [124, 438, 326, 1178],
  Noah:   [288, 458, 503, 1191],
  Daniel: [124, 344, 396, 1169],
  Sarah:  [403, 414, 611, 1122],
  Hans:   [510, 199, 768, 1117],
};
const E_FACE = [142, 438, 326, 746];
const D_FACE = [212, 344, 396, 651];

// The shipped comparator, mirrored.
const depthOrder = (names) => names.slice().sort((a, b) => {
  const ba = BOX[a][3], bb = BOX[b][3];
  if (Math.abs(ba - bb) > SAM_GROUND_TIE_PX) return bb - ba;
  const aInB = _boxContainment(BOX[a], BOX[b]);
  const bInA = _boxContainment(BOX[b], BOX[a]);
  if (aInB >= SAM_FRONT_CONTAINMENT && aInB > bInA) return -1;
  if (bInA >= SAM_FRONT_CONTAINMENT && bInA > aInB) return 1;
  return _boxAreaPx(BOX[a]) - _boxAreaPx(BOX[b]);
});

// ── Depth on the page that caused it ────────────────────────────────────────
t('depth order front-to-back matches the scene', () => {
  assert.deepStrictEqual(depthOrder(Object.keys(BOX)),
    ['Noah', 'Emma', 'Daniel', 'Sarah', 'Hans']);
});

t('BOTH Emma and Noah are in front of Daniel', () => {
  // This is the whole point. The old containment test caught only Emma (Noah
  // overlaps him ~50%), which is exactly why Noah's blue SANDAL leaked into
  // Daniel's cut-out.
  const o = depthOrder(Object.keys(BOX));
  assert.ok(o.indexOf('Emma') < o.indexOf('Daniel'), 'Emma must win contested pixels');
  assert.ok(o.indexOf('Noah') < o.indexOf('Daniel'), 'Noah must win contested pixels');
});

t('the old mask-AREA rule would have got it backwards', () => {
  // Measured masks: Daniel 32,358 px, Noah 73,000 px. "Smaller mask is in front"
  // puts Daniel in front of Noah - wrong, and it is why the carve-out could not
  // remove Noah's sandal from Daniel.
  const danielMask = 32358, noahMask = 73000;
  assert.ok(danielMask < noahMask, 'the occluded figure has the SMALLER mask');
  const o = depthOrder(Object.keys(BOX));
  assert.ok(o.indexOf('Noah') < o.indexOf('Daniel'), 'yet depth correctly puts Noah in front');
});

t('containment breaks a tie when two boxes end at the same height', () => {
  const outer = [100, 100, 400, 900];
  const inner = [150, 300, 350, 900 - Math.floor(SAM_GROUND_TIE_PX / 2)];
  assert.ok(Math.abs(outer[3] - inner[3]) <= SAM_GROUND_TIE_PX, 'same height by the rule');
  assert.ok(_boxContainment(inner, outer) >= SAM_FRONT_CONTAINMENT, 'inner is contained');
  const order = [outer, inner].slice().sort((a, b) => {
    if (Math.abs(a[3] - b[3]) > SAM_GROUND_TIE_PX) return b[3] - a[3];
    const aInB = _boxContainment(a, b), bInA = _boxContainment(b, a);
    if (aInB >= SAM_FRONT_CONTAINMENT && aInB > bInA) return -1;
    if (bInA >= SAM_FRONT_CONTAINMENT && bInA > aInB) return 1;
    return _boxAreaPx(a) - _boxAreaPx(b);
  });
  assert.deepStrictEqual(order[0], inner, 'the contained box is the one in front');
});

t('a figure standing further back never steals from one in front', () => {
  const o = depthOrder(Object.keys(BOX));
  assert.ok(o.indexOf('Daniel') < o.indexOf('Hans'), 'Daniel is in front of Hans');
  assert.ok(o.indexOf('Sarah') < o.indexOf('Hans'));
});

// ── Face → box assignment ───────────────────────────────────────────────────
t('a face inside BOTH boxes belongs to the smaller one', () => {
  const r = _assignFacesToBoxes([BOX.Emma, BOX.Daniel], [E_FACE, D_FACE]);
  assert.deepStrictEqual(r[0], E_FACE, 'Emma keeps her own face');
  assert.deepStrictEqual(r[1], D_FACE, 'Daniel gets the face only in his box');
});

t('a box with no face resolves to null, never to a neighbour face', () => {
  const r = _assignFacesToBoxes([BOX.Hans, BOX.Emma], [E_FACE]);
  assert.strictEqual(r[0], null);
  assert.deepStrictEqual(r[1], E_FACE);
});

t('one face is never assigned to two boxes', () => {
  assert.strictEqual(_assignFacesToBoxes([BOX.Emma, BOX.Daniel], [E_FACE]).filter(Boolean).length, 1);
});

t('a face outside every box is dropped, junk never throws', () => {
  assert.deepStrictEqual(_assignFacesToBoxes([BOX.Emma], [[700, 100, 760, 160]]), [null]);
  assert.deepStrictEqual(_assignFacesToBoxes([BOX.Emma], [null, 'x', [1, 2]]), [null]);
  assert.deepStrictEqual(_assignFacesToBoxes([BOX.Emma], null), [null]);
});

// ── Thresholds ──────────────────────────────────────────────────────────────
t('the face-in-mask floor admits a heavily occluded figure', () => {
  // Daniel's real mask was rejected at box-coverage 0.228 by the old 0.25 floor.
  // The new test asks a different question and admits him.
  assert.ok(SAM_FACE_IN_MASK > 0, 'an empty mask is still rejected');
  assert.ok(SAM_FACE_IN_MASK <= 0.25, `${SAM_FACE_IN_MASK} would reject a half-hidden head`);
  assert.ok(SAM_FACE_CONTAINMENT > 0.5 && SAM_FACE_CONTAINMENT <= 1);
  assert.ok(SAM_GROUND_TIE_PX > 0 && SAM_GROUND_TIE_PX < 60, 'ground tie must be a few px, not a band');
});

// ── Wiring ──────────────────────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'lib', 'figureDetection.js'), 'utf8');

t('SAM is told WHICH figure in the box is the target', () => {
  assert.ok(/points\.push\(_boxCentre\(own\)\); labels\.push\(1\)/.test(SRC), 'positive on its own face');
  assert.ok(/points\.push\(c\); labels\.push\(0\)/.test(SRC), 'negative on every other face in the box');
  assert.ok(/point_labels: labels/.test(SRC), 'the endpoint reads `point_labels`');
});

t('there is exactly ONE box->mask loop, shared by both paths', () => {
  // The failing page ran through the GEMINI second-opinion path, so a fix in
  // DINO Stage 2 alone would never have fired on it.
  assert.strictEqual((SRC.match(/_mobilesamMaskFull\(/g) || []).length, 2,
    'one definition + one call site');
  assert.strictEqual((SRC.match(/_maskBoxesFrontFirst\(/g) || []).length, 3,
    'one definition + two call sites');
  assert.ok(/_maskBoxesFrontFirst\(imageDataUri, boxesPx, W, H, pageLabel, faceBoxesPx,/.test(SRC),
    'the Gemini path must pass faceBoxes — without them there are no points');
});

t('winner-take-all replaces pairwise subtraction', () => {
  assert.ok(/const owner = new Int32Array\(W \* H\)/.test(SRC), 'one owner per pixel');
  assert.ok(/if \(o\) \{ alpha\[k\] = 0;/.test(SRC), 'a claimed pixel is taken from the figure behind');
  assert.ok(!/_unionDilated/.test(SRC), 'no dilation — it was the source of the seam fringe');
  assert.ok(!/_dropSmallComponents/.test(SRC), 'and therefore no speckle filter is needed');
});

t('both old carve-outs are gone', () => {
  assert.ok(!/Occlusion carve-out/.test(SRC), 'the smaller-mask-wins rule must not survive');
  assert.ok(!/small\.area >= big\.area/.test(SRC), 'nor its area comparison');
});

t('acceptance is by FACE, not by box coverage', () => {
  assert.ok(/faceCover >= SAM_FACE_IN_MASK/.test(SRC));
  assert.ok(/rejected-not-its-face/.test(SRC));
  assert.ok(/minCoverage: 0/.test(SRC), 'the box-coverage floor must be disabled in this path');
});

t('the free occlusion facts are stamped on every figure', () => {
  for (const field of ['occluded', 'occludedByIdx', 'pxLostToFront', 'maskPx']) {
    assert.ok(new RegExp(field).test(SRC), `${field} must be emitted`);
  }
  assert.ok(/f\.occludedBy = \(m\.occludedByIdx \|\| \[\]\)\.map\(k => figures\[k\]\?\.name\)/.test(SRC),
    'the Gemini path knows the names, so it must stamp them');
});

t('the verdicts say what happened, so a lab run can see it', () => {
  for (const v of ['mask-ok-occluded', 'mask-ok-face-separated', 'rejected-fully-occluded', 'rejected-not-its-face']) {
    assert.ok(SRC.includes(v), `${v} missing`);
  }
});

// The real stored detection for that page: FIVE faces, FOUR persons.
const DINO_FACES = [
  { box: [266, 414, 338, 518], score: 0.528 },   // Daniel - UNPAIRED, highest score on the page
  { box: [463, 462, 532, 561], score: 0.520 },   // Sarah
  { box: [595, 280, 667, 382], score: 0.509 },   // Hans
  { box: [377, 532, 447, 619], score: 0.479 },   // Noah
  { box: [199, 498, 272, 590], score: 0.471 },   // Emma
];
const DINO_PERSONS = [
  [543, 268, 772, 1040], [315, 502, 508, 1112], [132, 468, 326, 1096], [430, 439, 612, 1043],
];
const isUnpaired = (face) => !DINO_PERSONS.some(p => _boxContainment(face, p) >= SAM_FACE_CONTAINMENT);


// -- NMS is NOT what loses an occluded figure (guard reverted) ---------------
t('DINO never proposed a box for the occluded figure at all', () => {
  // A size-ratio guard was added on the theory that NMS suppressed a Daniel
  // candidate (his box vs Emma's is IoU 0.653 against a 0.5 threshold). The
  // stored diag disproved it: the "person" query returned FOUR boxes and not
  // one of them claims his FACE. There was nothing to suppress - the theory was
  // arithmetic about a candidate that never existed.
  const danielFace = [266, 414, 338, 518];
  for (const p of DINO_PERSONS) {
    assert.ok(_boxContainment(danielFace, p) < SAM_FACE_CONTAINMENT,
      `person box ${JSON.stringify(p)} must not claim Daniel's face`);
  }
  // The one box that overlaps his column is EMMA's - she stands in front of
  // him - and it is hers because it holds her face, not his.
  const emma = [132, 468, 326, 1096];
  assert.ok(_boxContainment([199, 498, 272, 590], emma) > 0.99, "it holds Emma's face");
});

t('what the guard actually admitted was a duplicate of Sarah', () => {
  // The raw box it let through, [302,405,621,1119], CONTAINS Sarah's whole box
  // [395,407,618,1118] - the classic duplicate NMS exists to kill. It survived
  // on an area ratio of 0.696 against the 0.70 floor, four thousandths under,
  // and the identity pass then had to name it, calling it "Daniel".
  const phantom = [302, 405, 621, 1119], sarah = [395, 407, 618, 1118];
  assert.ok(_boxContainment(sarah, phantom) > 0.99, 'Sarah sits entirely inside it');
  const ratio = _boxAreaPx(sarah) / _boxAreaPx(phantom);
  assert.ok(ratio > 0.69 && ratio < 0.70, `ratio ${ratio.toFixed(3)} slipped under a 0.70 floor`);
});


// -- Garment seed points ------------------------------------------------------
// A single face point UNDER-SEGMENTS a multi-garment figure: SAM reads blouse,
// skirt and skin as separate objects. Measured on this page:
//   Sarah  face only 38,107px -> + blouse dot 73,828px  (+94%)
//   Noah   face only 73,113px -> + garment dots 80,761px
// For scale, Emma (a small child) masks at 91,886px, so Sarah the adult at 38k
// was missing half of herself. The "striping" in her cut-out was these holes.
t('the top and bottom colour are read from the identity line', () => {
  const cases = [
    ['Wearing: A red short-sleeve swim shirt, orange swim shorts, white sandals', 'red', 'orange'],
    ['Wearing: yellow short-sleeve linen shirt, grey chino shorts, brown sandals', 'yellow', 'grey'],
    ['Wearing: white short-sleeve cotton blouse, purple linen shorts', 'white', 'purple'],
    ['Wearing: blue short-sleeve swim shirt, green swim shorts, blue sandals', 'blue', 'green'],
    ['Wearing: light-grey short-sleeve polo shirt, beige linen trousers', 'grey', 'beige'],
  ];
  for (const [text, top, bottom] of cases) {
    assert.deepStrictEqual(_garmentColourWords(text), { top, bottom }, text);
  }
});

t('no clothing info yields no seeds, never a guess', () => {
  assert.deepStrictEqual(_garmentColourWords('preschooler girl, brown wavy hair'), { top: null, bottom: null });
  assert.deepStrictEqual(_garmentColourWords(''), { top: null, bottom: null });
  assert.deepStrictEqual(_garmentColourWords(null), { top: null, bottom: null });
});

t('shoes and sandals are never mistaken for a garment', () => {
  // "white sandals" must not become the top colour.
  assert.strictEqual(_garmentColourWords('Wearing: red shirt, white sandals').top, 'red');
  assert.strictEqual(_garmentColourWords('Wearing: red shirt, white sandals').bottom, null);
});

t('a neutral BOTTOM is skipped - it is the colour of the ground', () => {
  // Daniel's grey shorts are 134px visible; the grey pavement blob below him is
  // 33,578px and wins every ranking. Tops are exempt: Sarah's WHITE blouse is
  // the single biggest win of this feature.
  for (const c of ['grey', 'gray', 'white', 'black', 'beige', 'khaki', 'tan', 'cream', 'ivory', 'silver']) {
    assert.ok(NEUTRAL_COLOURS.has(c), `${c} must count as neutral`);
  }
  for (const c of ['red', 'orange', 'purple', 'green', 'blue', 'yellow']) {
    assert.ok(!NEUTRAL_COLOURS.has(c), `${c} must NOT be treated as neutral`);
  }
});

t('the seeds are wired into the masker and both call sites', () => {
  assert.ok(/_garmentColourWords\(descriptions\[i\]\)/.test(SRC), 'the masker must read the identity line');
  assert.ok(/if \(bottom && topY !== null && !NEUTRAL_COLOURS\.has\(bottom\)\)/.test(SRC),
    'a bottom seed needs a top to order against, and must not be neutral');
  assert.ok(/_colourSeedPoints\(rgb, W, H, box, top, headRef\)/.test(SRC),
    'the top is searched BELOW the head reference');
  assert.ok(/_colourSeedPoints\(rgb, W, H, box, bottom, topY\)/.test(SRC),
    'the bottom is searched BELOW the top - a constraint, not a filter');
  assert.ok(/expectedCharacters\.map\(c => \(typeof c === 'object' \? c\.description : ''\)/.test(SRC),
    'the DINO path must pass descriptions');
  assert.ok(/figures\.map\(f => f\.description \|\| f\.clothing \|\| ''\)/.test(SRC),
    'the Gemini path must pass descriptions');
});

// -- A cover gets the same clothing info as a page ----------------------------
t('the cover detector builds a real identity line, like every page path', () => {
  // coverIterate sent `description: c.description || ''` and a character object
  // has no `description` key, so every cover figure reached the detector as a
  // bare name - no garment colours, so no seeds, so Sarah's cover cut-out came
  // back full of holes. The three PAGE paths were fixed earlier; this one was
  // missed. The data was always there: coverHints[hintKey].characterClothing is
  // the cover's own category map, exactly analogous to a page's perCharClothing.
  const cov = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'lib', 'coverIterate.js'), 'utf8');
  assert.ok(!/expectedCharacters: \(selectedCoverCharacters \|\| \[\]\)\.map\(c => \(\{[\s\S]{0,120}c\.description \|\| ''/.test(cov),
    'the cover must not send a bare description any more');
  assert.ok(/const coverClothingByName = hintCharClothing \|\| \{\}/.test(cov),
    'the cover must use its own characterClothing map');
  assert.ok(/buildClothingDescription\(\s*c, category, artStyleId, storyData\.clothingRequirements/.test(cov),
    'and resolve it through clothingRequirements, the canonical source');
  assert.ok(/getStoryHelpers\(\)\.buildCastIdentityDescription\(c, clothingText\)/.test(cov),
    'then build the same identity line the pages build');
});

// -- A face with no person box is a missing figure ---------------------------
t('exactly one of the five faces is unpaired, and it is Daniel', () => {
  const unpaired = DINO_FACES.filter(f => isUnpaired(f.box));
  assert.strictEqual(unpaired.length, 1, 'four faces have a person box, one does not');
  assert.deepStrictEqual(unpaired[0].box, [266, 414, 338, 518]);
});

t('the unpaired face scored HIGHEST of all five', () => {
  // Face detection never had trouble with him - only the "person" query did.
  const top = DINO_FACES.slice().sort((a, b) => b.score - a.score)[0];
  assert.deepStrictEqual(top.box, [266, 414, 338, 518], 'Daniel outscores Hans standing in full view');
});

t('the synthesised person box reproduces the Gemini box result', () => {
  const box = _personBoxFromFace([266, 414, 338, 518], 864, 1222);
  assert.deepStrictEqual(box, [122, 388, 482, 1194]);   // w=5.0
  // Measured with SAM: this box + face points -> 29,744px, against 30,464px
  // from the Gemini second-opinion box. Within 2.4%.
  const gemini = [124, 344, 396, 1169];
  const iou = (() => {
    const ix = Math.max(0, Math.min(box[2], gemini[2]) - Math.max(box[0], gemini[0]));
    const iy = Math.max(0, Math.min(box[3], gemini[3]) - Math.max(box[1], gemini[1]));
    const i = ix * iy;
    return i / (_boxAreaPx(box) + _boxAreaPx(gemini) - i);
  })();
  assert.ok(iou > 0.6, `synthesised box should resemble the Gemini one, IoU ${iou.toFixed(2)}`);
});

t('it CONTAINS the figure rather than hugging it', () => {
  // The box need not be tight: SAM gets the face as a positive and every other
  // face as a negative, and the depth pass reclaims what belongs to the front.
  // Tighter variants measured far worse: w4.0/h5.0 -> 12,304px, w2.5/h4.0 -> 13,159px.
  const box = _personBoxFromFace([266, 414, 338, 518], 864, 1222);
  assert.ok(box[3] - box[1] > 700, 'must reach down to the feet');
  assert.ok(box[2] - box[0] >= 5 * 72 - 2, 'must be five face widths wide — narrower loses the occluded garment');
});

t('a face box is clamped to the page and junk yields null', () => {
  const b = _personBoxFromFace([10, 10, 60, 70], 200, 300);
  assert.ok(b[0] >= 0 && b[1] >= 0 && b[2] <= 200 && b[3] <= 300, JSON.stringify(b));
  assert.strictEqual(_personBoxFromFace([50, 50, 50, 50], 864, 1222), null, 'zero-size face');
  assert.strictEqual(_personBoxFromFace([90, 90, 10, 10], 864, 1222), null, 'inverted face');
});

t('recovery is wired before masking, and the NMS guard is gone', () => {
  assert.ok(/persons\.push\(\{ box, score: f\.score, fromFace: true \}\)/.test(SRC),
    'an unpaired face must append a person BEFORE Stage 2 masking');
  assert.ok(/if \(persons\.some\(p => _boxContainment\(f\.box, p\.box\) >= SAM_FACE_CONTAINMENT\)\) continue/.test(SRC),
    'a face already claimed by a person box is not re-added');
  assert.ok(!/GDINO_NMS_SIZE_RATIO|_sameFigureSize|keepOccluded/.test(SRC),
    'the NMS size guard was reverted - it fixed a candidate that never existed');
});

t('the DINO path copies the occlusion facts onto the FIGURE, not just the det', () => {
  // They were computed on the det and never copied, so the Lab (and anything
  // else downstream) saw null for all of them and a run could only be judged by
  // eye off the cut-out strip. Cost three separate conclusions in one day.
  const push = SRC.slice(SRC.indexOf('figures.push({'), SRC.indexOf('masks.push(d.mask?.pngBuf'));
  for (const f of ['maskPx:', 'pxLostToFront:', 'occluded:', 'occludedBy:', 'garmentSeeds:']) {
    assert.ok(push.includes(f), `figures.push must carry ${f}`);
  }
  assert.ok(/occludedBy: \(d\.occludedByIdx \|\| \[\]\)\.map\(k => nameByDet\.get\(k\)\)/.test(push),
    'occluder INDICES must be resolved to names for the figure');
});

// -- A face-recovered figure has no ground cue -------------------------------
t('a recovered figure sorts BEHIND every real person box', () => {
  // Its box is synthesised as faceBottom + 6.5 face-heights, which overshoots
  // and clamps to the page edge — so the plain "lower bottom = nearer" rule
  // ranks it in FRONT of everyone, the exact opposite of the truth. Measured on
  // exp #711: Daniel's clamped bottom 1222 beat Noah 1184 and Emma 1180, and he
  // took 3,087px off Emma. DINO missed him as a person BECAUSE he is occluded.
  const daniel = _personBoxFromFace([211, 380, 361, 602], 864, 1222);
  assert.strictEqual(daniel[3], 1222, 'the synthesised bottom does clamp to the page');
  const realBottoms = [BOX.Noah[3], BOX.Emma[3], BOX.Sarah[3], BOX.Hans[3]];
  assert.ok(realBottoms.every(b => b < daniel[3]),
    'and it beats every real box on the naive rule — which is why the flag exists');
});

t('the flag is the PRIMARY depth key, ahead of the ground rule', () => {
  // NB \s* not \n\s* — the source is CRLF, so a bare \n anchor never matches.
  assert.ok(/const fa = fromFaceFlags\?\.\[a\] \? 1 : 0, fb = fromFaceFlags\?\.\[b\] \? 1 : 0;\s*if \(fa !== fb\) return fa - fb;/.test(SRC),
    'recovered figures must sort behind before box bottoms are even compared');
  assert.ok(/persons\.map\(p => !!p\.fromFace\)/.test(SRC), 'the DINO path must pass the flags');
});

t('two recovered figures are ordered by face height in frame', () => {
  // Higher face = further away, for figures standing on a common ground plane.
  assert.ok(/return yb - ya;/.test(SRC), 'tie-break among recovered figures');
});

// -- A figure's own face box is reserved -------------------------------------
t("a pixel in exactly one figure's face box is reserved for it", () => {
  // Depth alone lets the figure in front eat into the head of the figure
  // behind, and the face is the one loss that actually costs something: it
  // identifies the figure, anchors its SAM prompt and drives the identity pass.
  assert.ok(/const reserved = new Int32Array\(W \* H\)/.test(SRC));
  assert.ok(/reserved\[k\] = reserved\[k\] === 0 \? i \+ 1 : -1/.test(SRC),
    'a pixel in two face boxes is contested (-1), not owned');
  assert.ok(/if \(r > 0 && r !== i \+ 1\) \{ alpha\[k\] = 0; protectedPx\+\+; continue; \}/.test(SRC),
    'a figure in front must not claim another figure\u2019s face pixels');
});

t('contested face pixels fall back to the depth rule', () => {
  // Where two face boxes overlap there is no clear owner, so -1 means "no
  // reservation" and the normal front-most-wins comparison decides.
  assert.ok(/const r = reserved\[k\];/.test(SRC));
  assert.ok(/r > 0 &&/.test(SRC), 'only a POSITIVE reservation blocks a claim; -1 does not');
});

console.log(pass + ' passed');

/**
 * Mask modes for the page side (owner, 2026-08-13).
 *
 * Four ways to choose which pixels move, compared head-to-head in the Lab:
 *   dino-sam         text -> box -> silhouette (the original)
 *   dino-sam-points  the same, steered by colour point prompts
 *   colour           pixels that ARE the reported bad colour, no detector
 *   intersect        dino-sam AND colour
 *
 * Plus a vision-model check on the marked pixels, orthogonal to all four.
 *
 * The synthetic figure below reproduces the shape of
 * job_1786571353564_0sgrd0f4g p4: a head with hair the same warm hue as the
 * garment, skin that a global HSL rule would confuse with a gold garment, and
 * the garment itself lower down.
 *
 * Run: node tests/manual/garmentMaskModes.test.js
 */
const assert = require('assert');
const BODY_WORDS = ['head', 'chest', 'arms', 'torso', 'legs', 'waist', 'feet', 'shoulders', 'ankles'];
const {
  selectBadColourPixels, figureSkinLab, GARMENT_REGION, resolveColourName, DEFAULTS,
} = require('../../server/lib/garmentColourFix');

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
};

// ── A synthetic figure crop ────────────────────────────────────────────────
// 100 x 200. Rows 0-60 head: hair (warm yellow) with a face (skin) inside it.
// Rows 60-120 torso: skin. Rows 90-200: the garment (yellow).
const CW = 100, CH = 200;
const FACE = [35, 15, 65, 55];   // x0,y0,x1,y1 in crop coords
const px = { hair: [190, 160, 60], skin: [225, 175, 140], garment: [225, 205, 70], water: [120, 130, 135] };
function buildCrop() {
  const b = Buffer.alloc(CW * CH * 3);
  const put = (i, c) => { b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; };
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const i = (y * CW + x) * 3;
      if (x < 20 || x > 80) put(i, px.water);
      else if (y < 60) put(i, (x >= FACE[0] && x < FACE[2] && y >= FACE[1] && y < FACE[3]) ? px.skin : px.hair);
      else if (y < 90) put(i, px.skin);
      else put(i, px.garment);
    }
  }
  return b;
}
const crop = buildCrop();
const cfg = DEFAULTS;
const yellow = resolveColourName('yellow');
const count = (alpha, pred) => {
  let n = 0;
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) if (alpha[y * CW + x] && pred(x, y)) n++;
  return n;
};
const inHair = (x, y) => y < 60 && !(x >= FACE[0] && x < FACE[2] && y >= FACE[1] && y < FACE[3]) && x >= 20 && x <= 80;
const inGarment = (_x, y) => y >= 90;
const inWater = (x) => x < 20 || x > 80;

// ── Skin sampling ──────────────────────────────────────────────────────────
t('skin is sampled from the figure\'s own face', () => {
  const skin = figureSkinLab(crop, CW, CH, FACE);
  assert.ok(skin, 'must return a sample');
  assert.ok(skin.samples > 40, `only ${skin.samples} samples`);
  // Skin here is a warm mid-light tone; the garment is lighter and more chromatic.
  assert.ok(skin.L > 60 && skin.L < 90, `skin L ${skin.L}`);
});

t('no face box → no skin sample (never guess)', () => {
  assert.strictEqual(figureSkinLab(crop, CW, CH, null), null);
});

// ── Colour selection ───────────────────────────────────────────────────────
t('selects the garment', () => {
  const r = selectBadColourPixels(crop, CW, CH, { ref: yellow, cfg, garmentKey: 'skirt', faceBoxCrop: FACE });
  assert.ok(r.count > 500, `only ${r.count} px selected`);
  assert.ok(count(r.alpha, inGarment) / r.count > 0.9, 'most selected pixels must be the garment');
});

t('does NOT select hair, even though hair shares the hue', () => {
  const r = selectBadColourPixels(crop, CW, CH, { ref: yellow, cfg, garmentKey: 'skirt', faceBoxCrop: FACE });
  assert.strictEqual(count(r.alpha, inHair), 0, 'hair must be fenced off by the head zone');
});

t('does NOT select skin', () => {
  const r = selectBadColourPixels(crop, CW, CH, { ref: yellow, cfg, garmentKey: 'dress', faceBoxCrop: FACE });
  const skinRows = count(r.alpha, (x, y) => y >= 60 && y < 90 && x >= 20 && x <= 80);
  assert.ok(skinRows < 60, `${skinRows} skin pixels selected`);
});

t('does NOT select the background', () => {
  const r = selectBadColourPixels(crop, CW, CH, { ref: yellow, cfg, garmentKey: 'dress', faceBoxCrop: FACE });
  assert.strictEqual(count(r.alpha, (x) => inWater(x)), 0);
});

t('the region prior confines the selection', () => {
  const shoes = selectBadColourPixels(crop, CW, CH, { ref: yellow, cfg, garmentKey: 'shoes', faceBoxCrop: FACE });
  const dress = selectBadColourPixels(crop, CW, CH, { ref: yellow, cfg, garmentKey: 'dress', faceBoxCrop: FACE });
  assert.ok(shoes.count < dress.count, 'shoes must select less than a dress');
  const [r0] = GARMENT_REGION.shoes;
  assert.strictEqual(count(shoes.alpha, (_x, y) => y < r0 * CH), 0, 'nothing above the shoes band');
});

t('hat inverts the head zone instead of excluding it', () => {
  // The hair IS the only warm thing in the head zone here, so `hat` must select
  // it and `skirt` must not — the same pixels, opposite verdicts.
  const hat = selectBadColourPixels(crop, CW, CH, { ref: yellow, cfg, garmentKey: 'hat', faceBoxCrop: FACE });
  assert.ok(count(hat.alpha, inHair) > 0, 'hat must be allowed to select in the head zone');
  assert.strictEqual(count(hat.alpha, inGarment), 0, 'hat must not reach the lower body');
});

t('hat with no face box selects nothing rather than guessing', () => {
  const r = selectBadColourPixels(crop, CW, CH, { ref: yellow, cfg, garmentKey: 'hat', faceBoxCrop: null });
  assert.strictEqual(r.count, 0);
});

t('a colour that is not present selects nothing', () => {
  const r = selectBadColourPixels(crop, CW, CH,
    { ref: resolveColourName('blue'), cfg, garmentKey: 'dress', faceBoxCrop: FACE });
  assert.strictEqual(r.count, 0);
});

t('no resolvable colour REFUSES with a reason', () => {
  const r = selectBadColourPixels(crop, CW, CH, { ref: null, cfg, garmentKey: 'dress', faceBoxCrop: FACE });
  assert.strictEqual(r.count, 0);
  assert.ok(/no resolvable observed colour/.test(r.reason), r.reason);
});

// ── Wiring ─────────────────────────────────────────────────────────────────
t('every enum value has a body region', () => {
  const { GARMENT_VALUES } = require('../../server/lib/garmentColourFix');
  for (const v of GARMENT_VALUES) assert.ok(GARMENT_REGION[v], `${v} has no region`);
});

t('regions are ordered and inside [0,1]', () => {
  for (const [k, [a, b]] of Object.entries(GARMENT_REGION)) {
    assert.ok(a >= 0 && b <= 1 && a < b, `${k} region [${a},${b}] is invalid`);
  }
});

t('production default is the measured winner — box-first, no paid verification', () => {
  // Lab 583-586: multi-phrase queries find a usable box, colour points stop SAM
  // picking the wrong object inside it. All four known-bad cases land on the
  // garment. The DINO box stays the primary method, per the owner's rule.
  assert.strictEqual(DEFAULTS.maskMode, 'dino-sam-points');
  assert.strictEqual(DEFAULTS.queryMode, 'multi');
  assert.strictEqual(DEFAULTS.verifyMask, 'off', 'the paid vision check stays opt-in');
});

t('all four modes are documented in the config comment', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../server/lib/garmentColourFix.js'), 'utf8');
  for (const m of ['dino-sam', 'dino-sam-points', 'colour', 'intersect']) {
    assert.ok(src.includes(`'${m}'`), `${m} not referenced`);
  }
  assert.ok(/askIsThisTheGarment/.test(src), 'the vision check must exist');
});

// ── Connected components + derived boxes (owner, 2026-08-13) ───────────────
const { keepConnectedComponents, maskBoundingBox } = require('../../server/lib/garmentColourFix');

t('speckle is dropped, the garment survives', () => {
  // One 40x40 blob (1600 px) plus four 2x2 specks, like the eye glints and
  // arm flecks the colour match picked up on the mermaid.
  const a = Buffer.alloc(CW * CH);
  for (let y = 100; y < 140; y++) for (let x = 30; x < 70; x++) a[y * CW + x] = 255;
  for (const [sx, sy] of [[5, 5], [90, 5], [5, 190], [90, 190]]) {
    for (let y = sy; y < sy + 2; y++) for (let x = sx; x < sx + 2; x++) a[y * CW + x] = 255;
  }
  const r = keepConnectedComponents(a, CW, CH, cfg);
  assert.strictEqual(r.components, 5, 'five regions before filtering');
  assert.strictEqual(r.count, 1600, 'only the blob survives');
  assert.strictEqual(r.kept, 1);
});

t('a pair of shoes (two blobs) both survive', () => {
  const a = Buffer.alloc(CW * CH);
  for (let y = 150; y < 180; y++) {
    for (let x = 20; x < 45; x++) a[y * CW + x] = 255;
    for (let x = 55; x < 80; x++) a[y * CW + x] = 255;
  }
  const r = keepConnectedComponents(a, CW, CH, cfg);
  assert.strictEqual(r.kept, 2, 'keepComponents allows a pair');
  assert.strictEqual(r.count, 30 * 25 * 2);
});

t('diagonal neighbours count as connected', () => {
  const a = Buffer.alloc(CW * CH);
  // A true 1px-wide diagonal: each pixel touches the next only at a corner, so
  // 4-connectivity would split it into 60 pieces and 8-connectivity keeps it whole.
  for (let k = 0; k < 60; k++) a[(20 + k) * CW + (10 + k)] = 255;
  const r = keepConnectedComponents(a, CW, CH, { ...cfg, minComponentPx: 10 });
  assert.strictEqual(r.components, 1, `a diagonal streak split into ${r.components} pieces`);
  assert.strictEqual(r.count, 60);
});

t('everything-is-speckle returns nothing rather than a bad mask', () => {
  const a = Buffer.alloc(CW * CH);
  for (const [sx, sy] of [[5, 5], [90, 5], [50, 100]]) {
    for (let y = sy; y < sy + 3; y++) for (let x = sx; x < sx + 3; x++) a[y * CW + x] = 255;
  }
  assert.strictEqual(keepConnectedComponents(a, CW, CH, cfg).count, 0);
});

t('bounding box is tight, and padding stays in bounds', () => {
  const a = Buffer.alloc(CW * CH);
  for (let y = 50; y < 60; y++) for (let x = 20; x < 30; x++) a[y * CW + x] = 255;
  assert.deepStrictEqual(maskBoundingBox(a, CW, CH, 0), [20, 50, 30, 60]);
  // Padding clamps at the crop edge: x0/y0 floor at 0, x1 caps at CW, and y1 is
  // 60+1+100 = 161 -> under CH, so it is NOT stretched to the full height.
  assert.deepStrictEqual(maskBoundingBox(a, CW, CH, 100), [0, 0, CW, 160]);
});

t('an empty mask has no bounding box', () => {
  assert.strictEqual(maskBoundingBox(Buffer.alloc(CW * CH), CW, CH, 0), null);
});

t('the two new modes are wired and do not need the detector for selection', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../server/lib/garmentColourFix.js'), 'utf8');
  assert.ok(src.includes("'highlight-dino'"), 'highlight-dino missing');
  assert.ok(src.includes("'colour-box-sam'"), 'colour-box-sam missing');
  assert.ok(/needsDetector = mode === 'dino-sam' \|\| mode === 'dino-sam-points' \|\| mode === 'intersect'/.test(src),
    'the new modes must not run the plain detector path');
  // SAM must run on the ORIGINAL crop, never on the painted one.
  assert.ok(/SAM runs on the ORIGINAL crop/.test(src), 'the highlight must not reach SAM');
});

t('every enum value offers the three phrasing forms, in ladder order', () => {
  const { GARMENT_ENUM, GARMENT_VALUES } = require('../../server/lib/garmentColourFix');
  // Order IS the design: anatomical leads because it passed the size guard on
  // every measured case, so escalation usually stops after one detector pass.
  for (const v of GARMENT_VALUES) {
    const q = GARMENT_ENUM[v].queries;
    assert.strictEqual(q.length, 3, `${v} should offer 3 phrasings`);
    assert.ok(BODY_WORDS.some(w => q[0].includes(w)),
      `${v}: the first should be anatomical, got "${q[0]}"`);
    assert.ok(/worn by the person/.test(q[1]), `${v}: the second should be the plain form`);
    assert.ok(!q[2].includes(' '), `${v}: the third should be the bare noun, got "${q[2]}"`);
    assert.strictEqual(new Set(q).size, 3, `${v}: phrasings must be distinct`);
  }
});

// ── Escalation ladder (owner, 2026-08-14) ─────────────────────────────────
t('the anatomical phrasing is asked FIRST for every value', () => {
  const { GARMENT_ENUM, GARMENT_VALUES } = require('../../server/lib/garmentColourFix');
  // A garment NOUN has no referent when that garment is not in the picture; a
  // BODY LOCATION always does. Measured: "the shirt worn by the person" 82% of
  // the crop, "the top worn on the chest" 3%. So the body-anchored form leads.
  for (const v of GARMENT_VALUES) {
    const first = GARMENT_ENUM[v].queries[0];
    assert.ok(BODY_WORDS.some(w => first.includes(w)),
      `${v}: first phrasing "${first}" names no body part`);
  }
});

t('the bare noun is last, not first', () => {
  const { GARMENT_ENUM, GARMENT_VALUES } = require('../../server/lib/garmentColourFix');
  for (const v of GARMENT_VALUES) {
    const q = GARMENT_ENUM[v].queries;
    assert.ok(!q[q.length - 1].includes(' '), `${v}: last phrasing should be the bare noun`);
  }
});

t('detection escalates one phrasing at a time and stops at the first hit', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../server/lib/garmentColourFix.js'), 'utf8');
  // One prompt per request — escalation is impossible if all three are batched.
  assert.ok(/prompts: \[\{ name: 'q', text \}\]/.test(src), 'must ask one phrasing per request');
  assert.ok(/for \(const text of queries\)/.test(src), 'must loop the phrasings in order');
  assert.ok(/return \{ pick: t, tried, escalations: tried\.length - 1 \}/.test(src),
    'must return as soon as a plausible box is found');
  assert.ok(!/queries\.map\(\(text, i\) => \(\{ name: `q\$\{i\}`/.test(src),
    'the old fan-out form must be gone');
});

t('an anatomical phrase spans the garment\'s FULL extent, not a sub-region', () => {
  const { GARMENT_ENUM } = require('../../server/lib/garmentColourFix');
  // Measured: "the fabric covering the torso" for `dress` returned a 58% box
  // holding only the upper robe (48,329px vs the 72,170px the plain form
  // reached), so the lower robe would keep its old colour. A dress runs
  // shoulders to ankles and the phrase has to say so.
  const dress = GARMENT_ENUM.dress.queries[0];
  assert.ok(/shoulders/.test(dress) && /ankles/.test(dress),
    `dress must span its full extent, got "${dress}"`);
  // A full-length garment cannot be described by a single body landmark.
  assert.ok(!/^the fabric covering the torso$/.test(dress));
});

console.log(`${pass} passed (incl. escalation + extent)`);

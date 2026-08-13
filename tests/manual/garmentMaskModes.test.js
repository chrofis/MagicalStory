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

t('production default is unchanged — dino-sam, no paid verification', () => {
  assert.strictEqual(DEFAULTS.maskMode, 'dino-sam');
  assert.strictEqual(DEFAULTS.verifyMask, 'off');
});

t('all four modes are documented in the config comment', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../server/lib/garmentColourFix.js'), 'utf8');
  for (const m of ['dino-sam', 'dino-sam-points', 'colour', 'intersect']) {
    assert.ok(src.includes(`'${m}'`), `${m} not referenced`);
  }
  assert.ok(/askIsThisTheGarment/.test(src), 'the vision check must exist');
});

console.log(`${pass} passed`);

// tests/manual/faceRepair-geometry.test.js
// Plain node + assert. Covers the DETERMINISTIC pieces of the unified
// face-repair spine (server/lib/faceRepair.js): the region resolver's crop
// math (box vs cutout), bbox→region round-trips, a mask-coverage assertion,
// and the legacy-flags→axes / issue→axes mappings (every one of the 5 old
// methods maps to the expected triple).
//
// Run: node tests/manual/faceRepair-geometry.test.js
//
// These are pure-geometry / pure-mapping checks — no sharp, no network, no SAM.
// computePresetAlignedExtract is stubbed via a require intercept so the cutout
// branch is exercised without pulling in the whole images.js graph.

const assert = require('assert');
const Module = require('module');

// --- Stub computePresetAlignedExtract ---------------------------------------
// resolveRegion lazy-requires('./imageCompositing') only in the cutout branch.
// Intercept that require so we don't load the module (and its native deps) for
// a geometry test. The stub reproduces a simple "bbox + pad, snapped to bounds"
// extract — enough to assert the boxInCrop round-trip.
const path = require('path');
// computePresetAlignedExtract lives in imageCompositing.js — it moved out of
// images.js with the rest of the mask/edit cluster. Stubbing the old module
// silently did nothing: the REAL extract ran, returned the real preset for a
// 1000x1500 scene (9:20, a valid Grok preset), and the assertion below compared
// it to the stub's declared 2:3. Keep this path pointed at the module
// resolveRegion actually requires.
const imagesPath = path.resolve(__dirname, '../../server/lib/imageCompositing.js');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = (() => { try { return Module._resolveFilename(request, parent); } catch { return null; } })();
  if (resolved === imagesPath) {
    return {
      computePresetAlignedExtract({ pixelLeft, pixelTop, pixelWidth, pixelHeight, padFactor, sceneWidth, sceneHeight }) {
        const padX = Math.round(pixelWidth * padFactor);
        const padY = Math.round(pixelHeight * padFactor);
        const left = Math.max(0, pixelLeft - padX);
        const top = Math.max(0, pixelTop - padY);
        const right = Math.min(sceneWidth, pixelLeft + pixelWidth + padX);
        const bottom = Math.min(sceneHeight, pixelTop + pixelHeight + padY);
        return { left, top, width: right - left, height: bottom - top, preset: '2:3' };
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const {
  resolveRegion, repairDescriptor, legacyMethodAlias, resolveRepairAxes, legacyFlagsToAxes, applyGeometryGuards,
} = require('../../server/lib/faceRepair.js');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('faceRepair geometry + axis-mapping tests\n');

// ===========================================================================
console.log('region resolver — faceOnly (square crop centred on head)');
// ===========================================================================
const W = 1000, H = 1500;
ok('face crop is square (1:1) and floors at 384', () => {
  const faceBbox = [0.40, 0.45, 0.50, 0.55]; // tiny head → floor kicks in
  const r = resolveRegion({ regionSource: 'cutout', faceOnly: true, faceBbox, bodyBbox: null, sceneWidth: W, sceneHeight: H });
  assert.strictEqual(r.crop.w, r.crop.h, 'crop must be square');
  assert.strictEqual(r.aspect, '1:1');
  assert.ok(r.crop.w >= 384, `side ${r.crop.w} should be >= 384 floor`);
});

ok('face crop stays inside the image bounds', () => {
  const faceBbox = [0.02, 0.90, 0.10, 0.99]; // head near the top-right corner
  const r = resolveRegion({ regionSource: 'cutout', faceOnly: true, faceBbox, bodyBbox: null, sceneWidth: W, sceneHeight: H });
  assert.ok(r.crop.x >= 0 && r.crop.y >= 0, 'crop origin non-negative');
  assert.ok(r.crop.x + r.crop.w <= W, `crop right ${r.crop.x + r.crop.w} <= ${W}`);
  assert.ok(r.crop.y + r.crop.h <= H, `crop bottom ${r.crop.y + r.crop.h} <= ${H}`);
});

ok('faceClip bottom-only clip cuts at the face-box bottom', () => {
  const faceBbox = [0.40, 0.45, 0.50, 0.55];
  const r = resolveRegion({ regionSource: 'cutout', faceOnly: true, faceBbox, bodyBbox: null, sceneWidth: W, sceneHeight: H });
  assert.strictEqual(r.faceClip[0], 0);
  assert.strictEqual(r.faceClip[1], 0);
  assert.strictEqual(r.faceClip[2], r.crop.w, 'faceClip full width');
  const expectedBottom = Math.min(r.crop.h, Math.round(faceBbox[2] * H) - r.crop.y);
  assert.strictEqual(r.faceClip[3], expectedBottom, 'faceClip bottom = face-box bottom in crop');
});

// ===========================================================================
console.log('\nregion resolver — bbox→boxInCrop round-trip');
// ===========================================================================
ok('face boxInCrop maps back to the original page pixels', () => {
  const faceBbox = [0.30, 0.40, 0.42, 0.52];
  const r = resolveRegion({ regionSource: 'cutout', faceOnly: true, faceBbox, bodyBbox: null, sceneWidth: W, sceneHeight: H });
  // boxInCrop + crop offset should recover the page-pixel face box (± rounding).
  const backLeft = r.boxInCrop[0] + r.crop.x;
  const backTop = r.boxInCrop[1] + r.crop.y;
  assert.ok(Math.abs(backLeft - Math.round(faceBbox[1] * W)) <= 1, `left round-trip (${backLeft} vs ${Math.round(faceBbox[1] * W)})`);
  assert.ok(Math.abs(backTop - Math.round(faceBbox[0] * H)) <= 1, `top round-trip (${backTop} vs ${Math.round(faceBbox[0] * H)})`);
});

ok('body BOX mode: crop = bbox + 10% pad, boxInCrop recovers the bbox', () => {
  const bodyBbox = [0.30, 0.30, 0.70, 0.60]; // ymin,xmin,ymax,xmax
  const r = resolveRegion({ regionSource: 'box', faceOnly: false, faceBbox: null, bodyBbox, sceneWidth: W, sceneHeight: H });
  // boxInCrop back to page pixels ≈ bbox pixels.
  const bl = r.boxInCrop[0] + r.crop.x, bt = r.boxInCrop[1] + r.crop.y;
  assert.ok(Math.abs(bl - Math.round(bodyBbox[1] * W)) <= 1, 'box left round-trip');
  assert.ok(Math.abs(bt - Math.round(bodyBbox[0] * H)) <= 1, 'box top round-trip');
  // Crop is padded => strictly larger than the bbox on at least one side.
  assert.ok(r.crop.w > (bodyBbox[3] - bodyBbox[1]) * W, 'box crop wider than bbox');
  assert.strictEqual(r.aspect, null, 'box mode has no forced aspect');
});

ok('body CUTOUT mode: preset-aligned extract, boxInCrop recovers the bbox', () => {
  const bodyBbox = [0.25, 0.20, 0.85, 0.55];
  const r = resolveRegion({ regionSource: 'cutout', faceOnly: false, faceBbox: null, bodyBbox, sceneWidth: W, sceneHeight: H });
  const bl = r.boxInCrop[0] + r.crop.x, bt = r.boxInCrop[1] + r.crop.y;
  assert.ok(Math.abs(bl - Math.floor(bodyBbox[1] * W)) <= 1, 'cutout box left round-trip');
  assert.ok(Math.abs(bt - Math.floor(bodyBbox[0] * H)) <= 1, 'cutout box top round-trip');
  assert.strictEqual(r.aspect, '2:3', 'cutout aspect from preset extract (stub)');
});

ok('box vs cutout produce DIFFERENT crops for the same body bbox', () => {
  const bodyBbox = [0.30, 0.30, 0.70, 0.60];
  const box = resolveRegion({ regionSource: 'box', faceOnly: false, faceBbox: null, bodyBbox, sceneWidth: W, sceneHeight: H });
  const cut = resolveRegion({ regionSource: 'cutout', faceOnly: false, faceBbox: null, bodyBbox, sceneWidth: W, sceneHeight: H });
  assert.notDeepStrictEqual(
    [box.crop.x, box.crop.y, box.crop.w, box.crop.h],
    [cut.crop.x, cut.crop.y, cut.crop.w, cut.crop.h],
    'box (10% pad) and cutout (40% preset) crop geometry must differ');
});

// ===========================================================================
console.log('\nmask-coverage assertion (the coverage gate math)');
// ===========================================================================
// The whiteout builder throws when the SAM head silhouette covers < 40 px.
// Reproduce the exact predicate here on a synthetic mask buffer.
function coverageOf(hard) { let c = 0; for (let i = 0; i < hard.length; i++) if (hard[i]) c++; return c; }
ok('coverage gate: < 40 opaque px is rejected, >= 40 accepted', () => {
  const cw = 100, ch = 100;
  const tiny = Buffer.alloc(cw * ch); for (let i = 0; i < 39; i++) tiny[i] = 255;
  const enough = Buffer.alloc(cw * ch); for (let i = 0; i < 200; i++) enough[i] = 255;
  assert.ok(coverageOf(tiny) < 40, 'tiny mask below threshold');
  assert.ok(coverageOf(enough) >= 40, 'enough mask above threshold');
});

ok('coverage counts only opaque (>0) bytes', () => {
  const buf = Buffer.from([0, 255, 0, 128, 0, 255, 1, 0]);
  assert.strictEqual(coverageOf(buf), 4, 'four non-zero bytes counted');
});

// ===========================================================================
console.log('\ndescriptor + legacy-alias');
// ===========================================================================
ok('descriptor format model:region:treatment:face|body', () => {
  assert.strictEqual(repairDescriptor({ model: 'grok', regionSource: 'cutout', treatment: 'whiteout', faceOnly: true }), 'grok:cutout:whiteout:face');
  assert.strictEqual(repairDescriptor({ model: 'qwen', regionSource: 'box', treatment: 'crosshatch', faceOnly: false }), 'qwen:box:crosshatch:body');
});
ok('legacy alias maps treatment→old method name', () => {
  assert.strictEqual(legacyMethodAlias({ regionSource: 'cutout', treatment: 'whiteout', faceOnly: true }), 'grok_face_insert');
  assert.strictEqual(legacyMethodAlias({ regionSource: 'box', treatment: 'blur', faceOnly: true }), 'grok_blended');
  assert.strictEqual(legacyMethodAlias({ regionSource: 'cutout', treatment: 'crosshatch', faceOnly: false }), 'grok_cutout');
  assert.strictEqual(legacyMethodAlias({ regionSource: 'box', treatment: 'crosshatch', faceOnly: false }), 'grok_inpaint');
});

// ===========================================================================
console.log('\nlegacy-flags → axes (every one of the 5 old methods → its triple)');
// ===========================================================================
ok('grok_face_insert: whiteoutTarget face + faceBbox → cutout+whiteout+face', () => {
  assert.deepStrictEqual(
    legacyFlagsToAxes({ whiteoutTarget: 'face', hasFaceBbox: true }),
    { regionSource: 'cutout', treatment: 'whiteout', model: 'grok', faceOnly: true });
});
ok('grok_blended (face): useBlended + face target (no faceBbox) → box+blur+face', () => {
  assert.deepStrictEqual(
    legacyFlagsToAxes({ useBlended: true, whiteoutTarget: 'face', hasFaceBbox: false }),
    { regionSource: 'box', treatment: 'blur', model: 'grok', faceOnly: true });
});
ok('grok_blended (body): useBlended + body target → box+blur+body', () => {
  assert.deepStrictEqual(
    legacyFlagsToAxes({ useBlended: true, whiteoutTarget: 'body' }),
    { regionSource: 'box', treatment: 'blur', model: 'grok', faceOnly: false });
});
ok('grok_cutout: useCutout → cutout+crosshatch+body', () => {
  assert.deepStrictEqual(
    legacyFlagsToAxes({ useCutout: true, whiteoutTarget: 'body' }),
    { regionSource: 'cutout', treatment: 'crosshatch', model: 'grok', faceOnly: false });
});
ok('grok_inpaint: useFullScene → box+crosshatch+body', () => {
  assert.deepStrictEqual(
    legacyFlagsToAxes({ useFullScene: true, whiteoutTarget: 'body' }),
    { regionSource: 'box', treatment: 'crosshatch', model: 'grok', faceOnly: false });
});
ok('grok_blackout (deprecated): no flags, body default → gated box+crosshatch+body', () => {
  assert.deepStrictEqual(
    legacyFlagsToAxes({ whiteoutTarget: 'body' }),
    { regionSource: 'box', treatment: 'crosshatch', model: 'grok', faceOnly: false });
});

// ===========================================================================
console.log('\nissue → axes (resolveRepairAxes central rule)');
// ===========================================================================
ok('face issue + faceBbox → whiteout+cutout+face', () => {
  assert.deepStrictEqual(
    resolveRepairAxes('the face and hair look wrong', { hasFaceBbox: true }),
    { regionSource: 'cutout', treatment: 'whiteout', model: 'grok', faceOnly: true });
});
ok('face issue but NO faceBbox → body path (crosshatch)', () => {
  assert.deepStrictEqual(
    resolveRepairAxes('the face looks wrong', { hasFaceBbox: false }),
    { regionSource: 'box', treatment: 'crosshatch', model: 'grok', faceOnly: false });
});
ok('face + clothing issue → body path (clothing pulls it to body)', () => {
  assert.deepStrictEqual(
    resolveRepairAxes('wrong face and wrong jacket color', { hasFaceBbox: true }),
    { regionSource: 'box', treatment: 'crosshatch', model: 'grok', faceOnly: false });
});
ok('pure clothing issue → body path', () => {
  assert.deepStrictEqual(
    resolveRepairAxes('the dress is the wrong color', { hasFaceBbox: true }),
    { regionSource: 'box', treatment: 'crosshatch', model: 'grok', faceOnly: false });
});
ok('forceTarget body overrides a face issue', () => {
  assert.deepStrictEqual(
    resolveRepairAxes('face wrong', { hasFaceBbox: true, forceTarget: 'body' }),
    { regionSource: 'box', treatment: 'crosshatch', model: 'grok', faceOnly: false });
});
ok('model axis threads through (qwen)', () => {
  assert.strictEqual(resolveRepairAxes('face wrong', { hasFaceBbox: true, model: 'qwen' }).model, 'qwen');
});

// ===========================================================================
console.log('\ngeometry guards (degenerate-cutout, large-face-box)');
// ===========================================================================
ok('degenerate cutout (bbox >50% area) downgrades cutout→box', () => {
  const axes = { model: 'grok', regionSource: 'cutout', treatment: 'crosshatch', faceOnly: false };
  const g = applyGeometryGuards(axes, { bodyBbox: [0.05, 0.05, 0.95, 0.95] }); // ~81% area
  assert.strictEqual(g.regionSource, 'box');
  assert.strictEqual(g._guard, 'degenerate-cutout→box');
});
ok('degenerate cutout (bbox >85% wide) downgrades cutout→box', () => {
  const g = applyGeometryGuards({ model: 'grok', regionSource: 'cutout', treatment: 'crosshatch', faceOnly: false }, { bodyBbox: [0.4, 0.02, 0.6, 0.90] });
  assert.strictEqual(g.regionSource, 'box');
});
ok('normal cutout bbox is left alone', () => {
  const g = applyGeometryGuards({ model: 'grok', regionSource: 'cutout', treatment: 'crosshatch', faceOnly: false }, { bodyBbox: [0.3, 0.3, 0.6, 0.5] });
  assert.strictEqual(g.regionSource, 'cutout');
  assert.strictEqual(g._guard, undefined);
});
ok('large face box (>=60% of body) downgrades blur+face → body crosshatch', () => {
  const faceBbox = [0.30, 0.30, 0.60, 0.60]; // 0.3*0.3 = 0.09 area
  const bodyBbox = [0.28, 0.28, 0.64, 0.64]; // 0.36*0.36 = 0.1296 → ratio ~0.69
  const g = applyGeometryGuards({ model: 'grok', regionSource: 'box', treatment: 'blur', faceOnly: true }, { faceBbox, bodyBbox });
  assert.strictEqual(g.treatment, 'crosshatch');
  assert.strictEqual(g.faceOnly, false);
  assert.strictEqual(g.regionSource, 'box');
});
ok('large-face-box guard does NOT touch whiteout (face-insert)', () => {
  const faceBbox = [0.30, 0.30, 0.60, 0.60];
  const bodyBbox = [0.28, 0.28, 0.64, 0.64];
  const g = applyGeometryGuards({ model: 'grok', regionSource: 'cutout', treatment: 'whiteout', faceOnly: true }, { faceBbox, bodyBbox });
  assert.strictEqual(g.treatment, 'whiteout', 'whiteout face-insert stays');
  assert.strictEqual(g.faceOnly, true);
});
ok('small face box leaves blur+face alone', () => {
  const faceBbox = [0.30, 0.40, 0.36, 0.46]; // small
  const bodyBbox = [0.30, 0.35, 0.85, 0.60]; // tall body
  const g = applyGeometryGuards({ model: 'grok', regionSource: 'box', treatment: 'blur', faceOnly: true }, { faceBbox, bodyBbox });
  assert.strictEqual(g.treatment, 'blur');
  assert.strictEqual(g.faceOnly, true);
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
if (!process.exitCode) console.log('ALL PASS');

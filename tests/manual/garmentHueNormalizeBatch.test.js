/**
 * Deterministic unit tests for the full-chain batch driver
 * normalizeGarmentHueBatch (server/lib/garmentHueNormalize.js).
 *
 * The batch driver orchestrates the per-page normalizeGarmentHue across a set of
 * image entries, reusing each entry's already-computed detection (never forcing
 * a detect), applying corrected bytes back, and re-stamping sourceImageFp. This
 * test STUBS the per-page normalizeGarmentHue (so no colour math / sharp runs)
 * and a fake imageFingerprint, then asserts the driver's orchestration contract:
 *   (a) skips entries without a detection / without figures (no forced detect),
 *   (b) calls the per-(page,figure) resolver for eligible entries,
 *   (c) re-stamps detection.sourceImageFp ONLY on changed entries,
 *   (d) honours the enable flag (enabled:false → total no-op),
 *   (e) aggregates pagesChanged / figuresApplied counts correctly.
 *
 * garmentHueNormalize.js requires `sharp` + `./images` (both pull native
 * `sharp`, unavailable locally). Same Module._load stub pattern as
 * tests/manual/garmentHueNormalize.test.js.
 *
 * Run: node tests/manual/garmentHueNormalizeBatch.test.js
 */
const assert = require('assert');
const Module = require('module');

// ── Module._load interception: stub native/heavy deps so the module loads ─────
const sharpStub = function () { throw new Error('sharp stub — batch driver must not call sharp'); };
const imagesStub = { imageFingerprint: () => 'SHOULD_BE_OVERRIDDEN' };
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

let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed++; }

// ── Test harness: a controllable stub for the per-page normalizeGarmentHue ────
// The batch driver calls module.exports.normalizeGarmentHue, so overwriting the
// export intercepts it. The stub is scripted per-page via `plan`.
function withStub(plan, fn) {
  const orig = G.normalizeGarmentHue;
  const calls = [];
  G.normalizeGarmentHue = async (imageData, detection, resolveAvatar, options) => {
    // Exercise the resolver the way the real function would (per figure), so the
    // test can assert the resolver is wired through.
    const figures = detection?.figures || [];
    for (const fig of figures) { await resolveAvatar(fig); }
    calls.push({ imageData, figuresCount: figures.length, logLabel: options?.logLabel });
    const page = detection?.__page;
    const p = plan[page] || { changed: false };
    return {
      changed: !!p.changed,
      correctedImageData: p.changed ? p.corrected : imageData,
      perFigure: p.perFigure || figures.map(() => ({ applied: !!p.changed })),
    };
  };
  return Promise.resolve(fn(calls)).finally(() => { G.normalizeGarmentHue = orig; });
}

const det = (page, nFigures) => ({
  __page: page,
  figures: Array.from({ length: nFigures }, (_, i) => ({ name: `Char${i}`, bodyBox: [0, 0, 1, 1] })),
});

(async () => {
  // ── (a) skips entries without a detection or without figures ────────────────
  await withStub({}, async (calls) => {
    const images = [
      { pageNumber: 1, imageData: 'img1', bboxDetection: null },              // no detection
      { pageNumber: 2, imageData: 'img2', bboxDetection: { figures: [] } },   // zero figures
      { pageNumber: 3, imageData: null, bboxDetection: det(3, 1) },           // no image data
    ];
    const resolverPages = [];
    const res = await G.normalizeGarmentHueBatch(images, {
      resolveAvatarForPage: async (page) => { resolverPages.push(page); return null; },
      getDetection: (img) => img.bboxDetection,
      imageFingerprint: () => 'fp',
    });
    ok(calls.length === 0, '(a) normalizeGarmentHue never called for ineligible entries');
    ok(resolverPages.length === 0, '(a) resolver never called for ineligible entries');
    ok(res.pagesChanged === 0 && res.figuresApplied === 0, '(a) zero counts when nothing eligible');
  });

  // ── (b) calls the per-(page,figure) resolver for eligible entries ───────────
  await withStub({ 5: { changed: false } }, async () => {
    const seen = [];
    await G.normalizeGarmentHueBatch(
      [{ pageNumber: 5, imageData: 'img5', bboxDetection: det(5, 2) }],
      {
        resolveAvatarForPage: async (page, fig) => { seen.push([page, fig.name]); return null; },
        getDetection: (img) => img.bboxDetection,
        imageFingerprint: () => 'fp',
      }
    );
    ok(seen.length === 2, '(b) resolver called once per figure');
    ok(seen.every(([p]) => p === 5), '(b) resolver receives the entry page number');
    ok(seen[0][1] === 'Char0' && seen[1][1] === 'Char1', '(b) resolver receives each figure');
  });

  // ── (c) re-stamps sourceImageFp ONLY on changed entries + writes bytes back ──
  await withStub({ 7: { changed: true, corrected: 'CORRECTED7' }, 8: { changed: false } }, async () => {
    const imgChanged = { pageNumber: 7, imageData: 'img7', bboxDetection: det(7, 1) };
    const imgUnchanged = { pageNumber: 8, imageData: 'img8', bboxDetection: det(8, 1) };
    await G.normalizeGarmentHueBatch([imgChanged, imgUnchanged], {
      resolveAvatarForPage: async () => 'avatar-uri',
      getDetection: (img) => img.bboxDetection,
      imageFingerprint: (data) => `FP(${data})`,
    });
    ok(imgChanged.imageData === 'CORRECTED7', '(c) corrected bytes written back on change');
    ok(imgChanged.bboxDetection.sourceImageFp === 'FP(CORRECTED7)', '(c) sourceImageFp re-stamped from corrected bytes');
    ok(imgUnchanged.imageData === 'img8', '(c) unchanged entry keeps its bytes');
    ok(imgUnchanged.bboxDetection.sourceImageFp === undefined, '(c) no re-stamp on unchanged entry');
  });

  // ── (c2) graceful degradation when no fingerprinter is INJECTED ─────────────
  // With no injected fp the driver falls back to lazily requiring
  // ./images.imageFingerprint, wrapped in try/catch. Whether that lazy require
  // succeeds is environment-dependent (it pulls native sharp, which is present
  // on a dev box and absent in some CI images), so the contract under test is
  // the part that must hold EITHER WAY: bytes are still written back, there is
  // no crash, and if a fingerprint does get stamped it is derived from the
  // CORRECTED bytes — never left stale on the pre-correction image.
  await withStub({ 9: { changed: true, corrected: 'CORRECTED9' } }, async () => {
    const img = { pageNumber: 9, imageData: 'img9', bboxDetection: det(9, 1) };
    await G.normalizeGarmentHueBatch([img], {
      resolveAvatarForPage: async () => 'a',
      getDetection: (i) => i.bboxDetection,
      imageFingerprint: null,
    });
    ok(img.imageData === 'CORRECTED9', '(c2) bytes still written back without injected fp');
    const stamped = img.bboxDetection.sourceImageFp;
    ok(stamped === undefined || typeof stamped === 'string',
      '(c2) no crash when no fp is injected');
    if (typeof stamped === 'string') {
      const { imageFingerprint } = require('../../server/lib/images');
      ok(stamped === imageFingerprint('CORRECTED9'),
        '(c2) any stamped fp is derived from the CORRECTED bytes, never stale');
    }
  });

  // ── (d) honours the enable flag → total no-op ───────────────────────────────
  await withStub({ 1: { changed: true, corrected: 'X' } }, async (calls) => {
    const img = { pageNumber: 1, imageData: 'img1', bboxDetection: det(1, 1) };
    let resolverCalled = false;
    const res = await G.normalizeGarmentHueBatch([img], {
      enabled: false,
      resolveAvatarForPage: async () => { resolverCalled = true; return 'a'; },
      getDetection: (i) => i.bboxDetection,
      imageFingerprint: () => 'fp',
    });
    ok(calls.length === 0, '(d) normalizeGarmentHue not called when disabled');
    ok(resolverCalled === false, '(d) resolver not called when disabled');
    ok(img.imageData === 'img1', '(d) image untouched when disabled');
    ok(res.pagesChanged === 0 && res.figuresApplied === 0 && res.perImage.length === 0, '(d) empty result when disabled');
  });

  // ── (e) aggregates pagesChanged / figuresApplied across the batch ───────────
  await withStub({
    1: { changed: true, corrected: 'C1', perFigure: [{ applied: true }, { applied: true }] },   // 2 figs applied
    2: { changed: false, perFigure: [{ applied: false }] },                                      // no change
    3: { changed: true, corrected: 'C3', perFigure: [{ applied: true }] },                       // 1 fig applied
  }, async () => {
    const images = [
      { pageNumber: 1, imageData: 'i1', bboxDetection: det(1, 2) },
      { pageNumber: 2, imageData: 'i2', bboxDetection: det(2, 1) },
      { pageNumber: 3, imageData: 'i3', bboxDetection: det(3, 1) },
    ];
    const res = await G.normalizeGarmentHueBatch(images, {
      resolveAvatarForPage: async () => 'a',
      getDetection: (i) => i.bboxDetection,
      imageFingerprint: () => 'fp',
    });
    ok(res.pagesChanged === 2, '(e) pagesChanged counts only changed pages');
    ok(res.figuresApplied === 3, '(e) figuresApplied sums applied figures across pages');
    ok(res.perImage.length === 3, '(e) perImage has one entry per eligible image');
    const p1 = res.perImage.find(p => p.pageNumber === 1);
    ok(p1.changed === true && p1.figuresApplied === 2, '(e) per-image detail correct');
  });

  // ── (f) empty / malformed inputs are safe no-ops ────────────────────────────
  await withStub({}, async () => {
    for (const bad of [undefined, null, [], 'nope']) {
      const res = await G.normalizeGarmentHueBatch(bad, { resolveAvatarForPage: async () => null });
      ok(res.pagesChanged === 0 && res.perImage.length === 0, '(f) safe no-op on bad images arg');
    }
    const res2 = await G.normalizeGarmentHueBatch([{ pageNumber: 1, imageData: 'x', bboxDetection: det(1, 1) }], {
      resolveAvatarForPage: 'not-a-function',
    });
    ok(res2.pagesChanged === 0, '(f) safe no-op when resolver is not a function');
  });

  console.log(`\n✅ normalizeGarmentHueBatch: ${passed} assertions passed`);
})().catch((err) => { console.error('❌ FAIL:', err.message); process.exit(1); });

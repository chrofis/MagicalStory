/**
 * Unit test for the style-repair path (roadmap Pt 10) — deterministic pieces
 * only, no live image/vision APIs. Covers:
 *   1. planStyleRepair outlier-selection + target-reference resolution
 *   2. resolveStyleRepairModelId gemini/grok mapping + invalid guard
 *   3. repairPageStyle per-model dispatch (stubbed edit + gate) — asserts the
 *      right production model id is chosen and the gate runs on the OWN output.
 *
 * Run: node tests/manual/test-style-repair.js
 */

const assert = require('assert');
const {
  planStyleRepair,
  repairPageStyle,
  resolveStyleRepairModelId,
  STYLE_REPAIR_MODEL_IDS,
} = require('../../server/lib/styleRepair');

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }

// Fake story: pages 1-5 each have an image; page 4 is the style outlier.
const img = (p) => `data:image/jpeg;base64,PAGE${p}`;
const storyData = {
  artStyle: 'watercolor',
  sceneImages: [1, 2, 3, 4, 5].map(p => ({ pageNumber: p, imageData: img(p) })),
};

// checkStoryStyleConsistency-shaped detection: dominant cluster 1,2,3,5; anchor 2; outlier page 4.
const detection = {
  verdict: 'mixed',
  dominantCluster: [1, 2, 3, 5],
  anchorPage: 2,
  outliers: [{ page: 4, severity: 'major', differences: ['flat vector vs watercolor', 'harder line'] }],
  reasoning: 'page 4 diverges',
};

// ── 1. planStyleRepair ──────────────────────────────────────────────
{
  const plan = planStyleRepair(detection, storyData);
  assert.strictEqual(plan.targets.length, 1, 'exactly one repair target');
  assert.strictEqual(plan.targets[0].page, 4, 'planner picks the outlier page 4');
  assert.strictEqual(plan.anchorPage, 2, 'anchor resolves to page 2');
  assert.strictEqual(plan.targets[0].targetRefPage, 2, 'target ref is the anchor page');
  assert.strictEqual(plan.targets[0].targetRefImage, img(2), 'target ref image is anchor page 2 pixels');
  assert.strictEqual(plan.targets[0].image, img(4), 'source image is the outlier page 4 pixels');
  assert.strictEqual(plan.targets[0].severity, 'major', 'severity carried through');
  ok('planStyleRepair selects outlier page 4 with anchor-page-2 reference');
}

// Covers are repair TARGETS (owner directive 2026-07-31 — covers = pages).
// The anchor still falls back to a real story page (covers never anchor).
{
  const storyWithCovers = {
    ...storyData,
    coverImages: {
      frontCover: { imageData: 'data:image/jpeg;base64,FRONT' },
      initialPage: { imageData: 'data:image/jpeg;base64,INITIAL' },
      backCover: { imageData: 'data:image/jpeg;base64,BACK' },
    },
  };
  const det2 = {
    dominantCluster: [1, 2, 3],
    anchorPage: -1, // cover as anchor → not a usable page ref, must fall back
    outliers: [
      { page: -1, severity: 'moderate', differences: ['palette shift'] },
      { page: -3, severity: 'major' },
      { page: 3, severity: 'major' },
    ],
  };
  const plan = planStyleRepair(det2, storyWithCovers);
  assert.strictEqual(plan.anchorPage, 1, 'anchor falls back to first dominant-cluster PAGE with an image (covers never anchor)');
  assert.deepStrictEqual(plan.targets.map(t => t.page), [-1, -3, 3], 'front cover, back cover AND page 3 are all repair targets');
  const front = plan.targets.find(t => t.page === -1);
  assert.strictEqual(front.image, 'data:image/jpeg;base64,FRONT', 'front-cover target uses the cover pixels');
  assert.strictEqual(front.targetRefPage, 1, 'cover repaints toward the page anchor');
  assert.strictEqual(plan.skipped.length, 0, 'nothing skipped when all outliers have images');
  ok('planStyleRepair repairs cover outliers like pages (owner: covers = pages)');
}

// A cover outlier with NO stored cover image is skipped (not a crash).
{
  const det2b = {
    dominantCluster: [1, 2],
    anchorPage: 1,
    outliers: [{ page: -2, severity: 'minor' }],
  };
  const plan = planStyleRepair(det2b, storyData); // storyData has no coverImages
  assert.strictEqual(plan.targets.length, 0, 'no target for an image-less cover');
  assert.ok(plan.skipped.some(s => s.page === -2 && /cover/.test(s.reason)), 'image-less cover outlier recorded as skipped');
  ok('planStyleRepair skips cover outliers with no stored image');
}

// Outlier with no stored image is skipped.
{
  const det3 = { dominantCluster: [1, 2], anchorPage: 1, outliers: [{ page: 99, severity: 'major' }] };
  const plan = planStyleRepair(det3, storyData);
  assert.strictEqual(plan.targets.length, 0, 'no target when outlier page has no image');
  assert.ok(plan.skipped.some(s => s.page === 99), 'missing-image outlier recorded as skipped');
  ok('planStyleRepair skips outliers with no stored image');
}

// ── 2. resolveStyleRepairModelId ────────────────────────────────────
{
  assert.strictEqual(resolveStyleRepairModelId('gemini'), 'gemini-2.5-flash-image');
  assert.strictEqual(resolveStyleRepairModelId('grok'), 'grok-imagine');
  assert.throws(() => resolveStyleRepairModelId('dalle'), /must be 'gemini' or 'grok'/);
  assert.strictEqual(STYLE_REPAIR_MODEL_IDS.gemini, 'gemini-2.5-flash-image');
  assert.strictEqual(STYLE_REPAIR_MODEL_IDS.grok, 'grok-imagine');
  ok('resolveStyleRepairModelId maps gemini/grok and rejects unknown');
}

// ── 3. repairPageStyle per-model dispatch (stubbed) ─────────────────
// Both branches are injectable: grok via editFn, gemini via repaintFn. Before
// repaintFn existed this whole section died on "GEMINI_API_KEY missing" at the
// first gemini dispatch, so its assertions had gone stale unnoticed — they
// still demanded the target-style REFERENCE the repaint stopped sending when it
// went prompt-only on 2026-08-09.
const noRefsExpected = [];
// EVERY case must stub this. `repairPageStyle` still measures beforeStyleMatch
// through the real checkStyleMatch when it is not injected — three cases below
// left it out and the "unit" test sat on live Gemini calls with fake base64.
const stubMatch = async () => ({ sameStyle: false, styleA: 'watercolor', styleB: 'photo' });

async function testDispatch(model, expectedModelId) {
  const calls = [];
  const editFn = async (imageData, instruction, modelId, refs, artStyle, aspect) => {
    calls.push({ imageData, modelId, refs, artStyle });
    return { imageData: `data:image/jpeg;base64,REPAINTED_BY_${modelId}`, usage: { model: modelId } };
  };
  const repaintFn = async (prompt, pageImage, { refImages } = {}) => {
    calls.push({ imageData: pageImage, modelId: 'gemini-2.5-flash-image', refs: refImages, artStyle: 'watercolor' });
    return { imageData: 'data:image/jpeg;base64,REPAINTED_BY_gemini-2.5-flash-image', usage: {} };
  };
  // Comparative gate: closer to the target style, nothing else changed.
  const compareFn = async () => ({ better: 'after', changed: [], reason: 'painted faces' });

  const out = await repairPageStyle(img(4), img(2), {
    model, artStyle: 'watercolor', editFn, repaintFn, compareFn, styleMatchFn: stubMatch,
  });

  // One edit call routed to the right production model id.
  assert.strictEqual(calls.length, 1, `${model}: exactly one edit dispatch`);
  assert.strictEqual(calls[0].modelId, expectedModelId, `${model}: dispatches to ${expectedModelId}`);
  assert.strictEqual(calls[0].imageData, img(4), `${model}: source is the outlier page`);
  // PROMPT-ONLY by default (2026-08-09): no reference image is attached unless
  // the caller passes character style sheets explicitly.
  assert.deepStrictEqual(calls[0].refs, noRefsExpected, `${model}: repaint is prompt-only by default`);
  assert.strictEqual(out.passedGate, true, `${model}: comparative gate passed`);
  assert.strictEqual(out.styleComparison.better, 'after', `${model}: verdict recorded`);
  assert.strictEqual(out.modelId, expectedModelId);
  assert.ok(out.imageData.includes(expectedModelId), `${model}: returns the repaint`);
}

// The gate's whole purpose: a repaint only replaces the page when it WINS.
// 'before' and 'same' both keep the original — a no-op repaint must never
// displace anything, and a partial fix must never be discarded for not being
// perfect (prod job_1787514321173_gvs2ojo4o0n lost 6 of 11 repaints that way,
// shipping a fully photographic page).
async function testGateVerdict(better, expectedPass, label, changed = []) {
  const editFn = async () => ({ imageData: 'data:image/jpeg;base64,CANDIDATE', usage: {} });
  const compareFn = async () => ({ better, changed, reason: 'stub' });
  const out = await repairPageStyle(img(4), img(2), { model: 'grok', editFn, compareFn, styleMatchFn: stubMatch });
  assert.strictEqual(out.passedGate, expectedPass, label);
  assert.strictEqual(out.styleComparison.better, better);
  assert.deepStrictEqual(out.styleComparison.changed, changed);
}

// Character style sheets reach the generator when the caller supplies them.
async function testRefSheetsThreaded() {
  const seen = [];
  const repaintFn = async (prompt, pageImage, { refImages } = {}) => {
    seen.push(...refImages);
    return { imageData: 'data:image/jpeg;base64,REPAINTED', usage: {} };
  };
  await repairPageStyle(img(4), img(2), {
    model: 'gemini', artStyle: 'watercolor', repaintFn, styleMatchFn: stubMatch,
    compareFn: async () => ({ better: 'after', changed: [], reason: 'stub' }),
    refImages: ['data:image/jpeg;base64,SHEET_A', 'data:image/jpeg;base64,SHEET_B'],
  });
  assert.deepStrictEqual(seen, ['data:image/jpeg;base64,SHEET_A', 'data:image/jpeg;base64,SHEET_B'],
    'character style sheets are threaded to the repaint');
  ok('repairPageStyle threads opt-in character style sheets to the generator');
}

// A gate that cannot run must not veto a repaint — it returns ungated (null),
// and the caller decides. Regression guard: passedGate===false is "rejected",
// null is "unknown", and conflating them silently drops every repaint whenever
// the vision API is down.
async function testGateUnavailable() {
  const editFn = async () => ({ imageData: 'data:image/jpeg;base64,CANDIDATE', usage: {} });
  const compareFn = async () => { throw new Error('vision API down'); };
  const out = await repairPageStyle(img(4), img(2), { model: 'grok', editFn, compareFn, styleMatchFn: stubMatch });
  assert.strictEqual(out.passedGate, null, 'gate failure leaves passedGate null, not false');
  assert.strictEqual(out.styleComparison, null);
  ok('repairPageStyle returns ungated (null) when the gate is unavailable');
}

(async () => {
  console.log('style-repair unit tests:');
  await testDispatch('gemini', 'gemini-2.5-flash-image');
  await testDispatch('grok', 'grok-imagine');
  ok('repairPageStyle routes gemini→gemini-2.5-flash-image and grok→grok-imagine, prompt-only, comparative gate');
  await testGateVerdict('after', true, 'a repaint that is closer wins');
  await testGateVerdict('before', false, 'a repaint that is further away is rejected');
  await testGateVerdict('same', false, 'a repaint that changed nothing does not displace the original');
  ok('repairPageStyle gate accepts only a repaint that beats the original');
  // The staging p1 case: style improved AND the costume was rewritten. Style
  // alone must not buy a content change.
  await testGateVerdict('after', false, 'a closer repaint that altered content is still rejected',
    ["the woman's green tricorn hat is now a red headscarf"]);
  ok('repairPageStyle gate vetoes a content change even when the style improved');
  await testRefSheetsThreaded();
  await testGateUnavailable();
  console.log(`\nAll ${passed} style-repair assertions passed.`);
  // Explicit exit: the gemini branch lazily requires images.js, whose
  // module-scope init keeps the event loop alive, so a passing run would hang
  // forever. Only the FAILING path used to exit, which is why nobody noticed.
  process.exit(0);
})().catch(err => { console.error('\n✗ FAILED:', err.message); process.exit(1); });

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
async function testDispatch(model, expectedModelId) {
  const calls = [];
  const editFn = async (imageData, instruction, modelId, refs, artStyle, aspect) => {
    calls.push({ imageData, modelId, refs, artStyle });
    return { imageData: `data:image/jpeg;base64,REPAINTED_BY_${modelId}`, usage: { model: modelId } };
  };
  // Gate: report the repaint as same-style as the target.
  const styleMatchFn = async (a, b) => ({ sameStyle: true, styleA: 'watercolor', styleB: 'watercolor' });

  const out = await repairPageStyle(img(4), img(2), { model, artStyle: 'watercolor', editFn, styleMatchFn });

  // One edit call routed to the right production model id.
  assert.strictEqual(calls.length, 1, `${model}: exactly one edit dispatch`);
  assert.strictEqual(calls[0].modelId, expectedModelId, `${model}: dispatches to ${expectedModelId}`);
  assert.strictEqual(calls[0].imageData, img(4), `${model}: source is the outlier page`);
  assert.deepStrictEqual(calls[0].refs, [img(2)], `${model}: target-style ref attached as reference image`);
  assert.strictEqual(calls[0].artStyle, 'watercolor', `${model}: artStyle threaded through`);
  // Gate applied on the OWN output → passedGate true.
  assert.strictEqual(out.passedGate, true, `${model}: gate ran on own output and passed`);
  assert.strictEqual(out.modelId, expectedModelId);
  assert.ok(out.imageData.includes(expectedModelId), `${model}: returns the repaint`);
}

async function testGateRejects() {
  const editFn = async () => ({ imageData: 'data:image/jpeg;base64,OFFSTYLE', usage: {} });
  const styleMatchFn = async () => ({ sameStyle: false, styleA: 'watercolor', styleB: 'flat vector' });
  const out = await repairPageStyle(img(4), img(2), { model: 'grok', editFn, styleMatchFn });
  assert.strictEqual(out.passedGate, false, 'gate flags an off-style repaint as failed');
  assert.strictEqual(out.afterStyleMatch.styleB, 'flat vector');
  ok('repairPageStyle gate flags off-style repaints (passedGate=false)');
}

(async () => {
  console.log('style-repair unit tests:');
  await testDispatch('gemini', 'gemini-2.5-flash-image');
  await testDispatch('grok', 'grok-imagine');
  ok('repairPageStyle routes gemini→gemini-2.5-flash-image and grok→grok-imagine, gate on own output');
  await testGateRejects();
  console.log(`\nAll ${passed} style-repair assertions passed.`);
})().catch(err => { console.error('\n✗ FAILED:', err.message); process.exit(1); });

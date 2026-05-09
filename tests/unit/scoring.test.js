/**
 * Pure-function tests for server/lib/scoring.js. No DB, no R2.
 *
 * Run: node tests/unit/scoring.test.js
 */
const assert = require('assert');
const {
  computeFinalScore,
  buildScoreBreakdown,
  composeEvalScore,
  composeFinalScore,
  applyScoreBreakdown,
  pickBestVersionIndex,
  shouldRedo,
  SCORE_THRESHOLDS,
} = require('../../server/lib/scoring');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); fail++; }
}

console.log('computeFinalScore');
test('null/undefined → null', () => {
  assert.strictEqual(computeFinalScore(null), null);
  assert.strictEqual(computeFinalScore(undefined), null);
  assert.strictEqual(computeFinalScore({}), null);
});
test('modern shape: trusts finalScore field', () => {
  assert.strictEqual(computeFinalScore({ finalScore: 73 }), 73);
});
test('intermediate shape: evalScore − entityPenalty', () => {
  assert.strictEqual(computeFinalScore({ evalScore: 80, entityPenalty: 30 }), 50);
});
test('intermediate shape: missing entityPenalty defaults to 0', () => {
  assert.strictEqual(computeFinalScore({ evalScore: 80 }), 80);
});
test('legacy shape: score field, no entity penalty', () => {
  assert.strictEqual(computeFinalScore({ score: 65 }), 65);
});
test('legacy shape: qualityScore + entityPenalty', () => {
  assert.strictEqual(computeFinalScore({ qualityScore: 80, entityPenalty: 60 }), 20);
});
test('mixed: prefer finalScore over score/qualityScore', () => {
  assert.strictEqual(computeFinalScore({ finalScore: 70, qualityScore: 95, score: 88 }), 70);
});

console.log('\nbuildScoreBreakdown + compose helpers');
test('cover-style breakdown (visual only)', () => {
  const bd = buildScoreBreakdown({ visual: { score: 80, reasoning: 'good', issues: [] } });
  assert.strictEqual(bd.semantic, null);
  assert.strictEqual(bd.threeStage, null);
  assert.strictEqual(bd.entity.penalty, 0);
  assert.strictEqual(composeEvalScore(bd), 80);
  assert.strictEqual(composeFinalScore(bd), 80);
});
test('scene-style breakdown: min of visual/semantic/threeStage', () => {
  const bd = buildScoreBreakdown({
    visual: { score: 90 },
    semantic: { score: 70 },
    threeStage: { score: 85 },
  });
  assert.strictEqual(composeEvalScore(bd), 70);  // min wins
});
test('entity penalty subtracted from min', () => {
  const bd = buildScoreBreakdown({
    visual: { score: 90 },
    entity: { penalty: 30 },
  });
  assert.strictEqual(composeEvalScore(bd), 90);
  assert.strictEqual(composeFinalScore(bd), 60);
});
test('all-zero breakdown', () => {
  assert.strictEqual(composeEvalScore(buildScoreBreakdown({})), 0);
  assert.strictEqual(composeFinalScore(buildScoreBreakdown({})), 0);
});

console.log('\napplyScoreBreakdown');
test('stamps evalScore + entityPenalty + finalScore on version', () => {
  const v = {};
  const bd = buildScoreBreakdown({
    visual: { score: 80 },
    semantic: { score: 70 },
    entity: { penalty: 20 },
  });
  applyScoreBreakdown(v, bd);
  assert.strictEqual(v.evalScore, 70);     // min(visual, semantic)
  assert.strictEqual(v.entityPenalty, 20);
  assert.strictEqual(v.finalScore, 50);
  assert.deepStrictEqual(v.scoreBreakdown, bd);
});

console.log('\npickBestVersionIndex');
test('empty array → -1', () => {
  assert.strictEqual(pickBestVersionIndex([]), -1);
  assert.strictEqual(pickBestVersionIndex(null), -1);
});
test('all unscored → -1', () => {
  assert.strictEqual(pickBestVersionIndex([{}, {}, {}]), -1);
});
test('picks highest finalScore', () => {
  const versions = [
    { finalScore: 30 },
    { finalScore: 70 },  // ← winner
    { finalScore: 50 },
  ];
  assert.strictEqual(pickBestVersionIndex(versions), 1);
});
test('exactly the v3 cover scenario from production: q80/p60 < q50/p30 (later wins on tie)', () => {
  const versions = [
    { qualityScore: 10, finalScore: 10 },                 // v0
    { qualityScore: 50, entityPenalty: 30, finalScore: 20 },  // v1
    { qualityScore: 80, entityPenalty: 60, finalScore: 20 },  // v2 (same final as v1)
    { qualityScore: 0, entityPenalty: 60, finalScore: 0 },   // v3 (worst, was active in prod)
  ];
  // Tie-break: later wins, so v2 beats v1 on the 20-vs-20 tie. v2 = best.
  assert.strictEqual(pickBestVersionIndex(versions), 2);
});
test('un-evaluated newer version does NOT beat scored older one', () => {
  const versions = [
    { finalScore: 50 },
    {},  // un-evaluated
  ];
  assert.strictEqual(pickBestVersionIndex(versions), 0);
});

console.log('\nshouldRedo');
test('score below threshold → redo', () => {
  assert.strictEqual(shouldRedo({ finalScore: SCORE_THRESHOLDS.REDO - 1 }), true);
});
test('score at threshold → no redo', () => {
  assert.strictEqual(shouldRedo({ finalScore: SCORE_THRESHOLDS.REDO }), false);
});
test('many fixable issues → redo even at high score', () => {
  const issues = new Array(SCORE_THRESHOLDS.ISSUES).fill({ severity: 'minor' });
  assert.strictEqual(shouldRedo({ finalScore: 90, fixableIssues: issues }), true);
});
test('un-evaluated version → no redo (we don\'t know yet)', () => {
  assert.strictEqual(shouldRedo({}), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

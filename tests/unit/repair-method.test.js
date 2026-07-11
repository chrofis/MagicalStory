/**
 * Pure-function tests for decideRepairMethod (server/lib/repairLogic.js).
 * No DB, no LLM calls.
 *
 * Run: node tests/unit/repair-method.test.js
 */
const assert = require('assert');
const { decideRepairMethod } = require('../../server/lib/repairLogic');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); fail++; }
}

console.log('decideRepairMethod — catastrophic severity routing');
test('lone CATASTROPHIC issue with survivable subscores → iterate, NOT inpaint', () => {
  const decision = decideRepairMethod(3, {
    scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
    fixableIssues: [{ description: 'large garbled caption painted across the sky', severity: 'CATASTROPHIC' }],
  }, null);
  assert.strictEqual(decision.method, 'iterate', `expected iterate, got ${decision.method} (${decision.reason})`);
});
test('lowercase catastrophic severity also routes to iterate', () => {
  const decision = decideRepairMethod(3, {
    scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
    fixableIssues: [{ description: 'wrong words painted on the banner', severity: 'catastrophic' }],
  }, null);
  assert.strictEqual(decision.method, 'iterate');
});
test('catastrophic in semantic issues routes to iterate', () => {
  const decision = decideRepairMethod(3, {
    scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
    fixableIssues: [],
    semanticResult: { semanticIssues: [{ problem: 'scene fundamentally wrong', severity: 'CATASTROPHIC' }] },
  }, null);
  assert.strictEqual(decision.method, 'iterate');
});
test('catastrophic in consolidated deduped issues routes to iterate', () => {
  const decision = decideRepairMethod(3, {
    scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
    fixableIssues: [],
    consolidatedPlan: { deduped_issues: [{ description: 'story text painted into the image', severity: 'CATASTROPHIC', sources: ['quality'] }] },
  }, null);
  assert.strictEqual(decision.method, 'iterate');
});
test('CRITICAL-only issues with ok subscores keep the default inpaint route', () => {
  const decision = decideRepairMethod(3, {
    scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
    fixableIssues: [{ description: 'guard missing from the marketplace', severity: 'CRITICAL' }],
  }, null);
  assert.strictEqual(decision.method, 'inpaint');
});
test('visual score below floor still iterates (score gate unchanged)', () => {
  const decision = decideRepairMethod(3, {
    scoreBreakdown: { visual: { score: 40 }, semantic: { score: 80 } },
    fixableIssues: [{ description: 'minor wobble', severity: 'MINOR' }],
  }, null);
  assert.strictEqual(decision.method, 'iterate');
});
test('no issues at all → skip', () => {
  const decision = decideRepairMethod(3, {
    scoreBreakdown: { visual: { score: 90 }, semantic: { score: 90 } },
    fixableIssues: [],
  }, null);
  assert.strictEqual(decision.method, 'skip');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

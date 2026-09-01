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
  // Floor is REPAIR_DEFAULTS.qualityThresholdForIterate = 20 (wired
  // 2026-08-09); this test previously used 40 against the old hardcoded 50
  // and had been failing since the config was wired. finalScore below the
  // salvage floor so worthSalvaging cannot mask the gate.
  const decision = decideRepairMethod(3, {
    scoreBreakdown: { visual: { score: 15 }, semantic: { score: 80 } },
    finalScore: -5,
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

console.log('\ndecideRepairMethod — reframe (requires_regeneration) routing');
test('reframe flag with survivable subscores → iterate, NOT inpaint (overrides salvage floor)', () => {
  const decision = decideRepairMethod(3, {
    scoreBreakdown: { visual: { score: 60 }, semantic: { score: 60 } },
    finalScore: 13, // above the salvage floor — would normally stay in local repair
    fixableIssues: [{ description: 'wrong camera angle', severity: 'CRITICAL' }],
    consolidatedPlan: { scene_fix: { requires_regeneration: true, instruction: 'Change to overhead close-up view.' } },
  }, null);
  assert.strictEqual(decision.method, 'iterate', `expected iterate, got ${decision.method} (${decision.reason})`);
});
test('reframe flag false → keeps default inpaint route', () => {
  const decision = decideRepairMethod(3, {
    scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
    fixableIssues: [{ description: 'add glow to the lantern', severity: 'MODERATE' }],
    consolidatedPlan: { scene_fix: { requires_regeneration: false, instruction: 'Add glow to the lantern.' } },
  }, null);
  assert.strictEqual(decision.method, 'inpaint');
});
test('reframe gate is strict === true — a truthy string does not force iterate', () => {
  const decision = decideRepairMethod(3, {
    scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
    fixableIssues: [{ description: 'add glow to the lantern', severity: 'MODERATE' }],
    consolidatedPlan: { scene_fix: { requires_regeneration: 'yes', instruction: 'Add glow.' } },
  }, null);
  assert.strictEqual(decision.method, 'inpaint');
});

console.log('\ndecideRepairMethod — entity severity routing (owner ruling 2026-09-01: CRITICAL only, case-insensitive)');
const entityReportWith = (severity) => ({
  characters: {
    Lorena: {
      issues: [{
        id: 'i1', type: 'age_shift', severity,
        description: 'appears visibly older than the reference across pages',
        pagesToFix: [16],
      }],
    },
  },
});
const okEval = () => ({
  scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
  fixableIssues: [],
});
test('UPPERCASE CRITICAL entity issue routes to char-fix (job_1788215224103 p16 regression)', () => {
  const decision = decideRepairMethod(16, okEval(), entityReportWith('CRITICAL'));
  assert.strictEqual(decision.method, 'char-fix', `expected char-fix, got ${decision.method} (${decision.reason})`);
  assert.strictEqual(decision.charName, 'Lorena');
  assert.strictEqual(decision.severity, 'critical');
});
test('lowercase critical entity issue also routes to char-fix', () => {
  const decision = decideRepairMethod(16, okEval(), entityReportWith('critical'));
  assert.strictEqual(decision.method, 'char-fix');
});
test('MAJOR entity issue gets NO automatic repair — not char-fix (and nothing else actionable → skip)', () => {
  const decision = decideRepairMethod(16, okEval(), entityReportWith('MAJOR'));
  assert.notStrictEqual(decision.method, 'char-fix', `MAJOR must not route to char-fix (got ${decision.method})`);
  assert.strictEqual(decision.method, 'skip');
});
test('lowercase major entity issue likewise does not route to char-fix', () => {
  const decision = decideRepairMethod(16, okEval(), entityReportWith('major'));
  assert.notStrictEqual(decision.method, 'char-fix');
});
test('CRITICAL entity issue on a different page does not claim this page', () => {
  const decision = decideRepairMethod(3, okEval(), entityReportWith('CRITICAL'));
  assert.strictEqual(decision.method, 'skip');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

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


console.log('\ndecideRepairMethod — clothing vs CRITICAL severity precedence (2026-09-06)');
// Evidence: staging job_1788641639919_mpjwlzkf1 page 5 v0.
const clothingMajor = (char) => ({
  type: 'clothing', severity: 'MAJOR', character: char,
  description: 'wears a blue duffle coat instead of a blue hooded anorak',
  sources: ['compliance'],
});
const criticalAction = {
  type: 'action_interaction', severity: 'CRITICAL', sources: ['semantic'],
  description: 'holds the chestnut at his open mouth instead of pinching it between his fingers',
};
test('CRITICAL action + MAJOR clothing → inpaint, reason names the precedence', () => {
  const decision = decideRepairMethod(5, {
    scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
    fixableIssues: [],
    // The CRITICAL also lives in the semantic pool, as on the real page —
    // the inline fallback counts the evaluator pools, not the plan.
    semanticResult: { issues: [criticalAction] },
    consolidatedPlan: { deduped_issues: [criticalAction, clothingMajor('Ethan')] },
  }, null);
  assert.strictEqual(decision.method, 'inpaint', `expected inpaint, got ${decision.method} (${decision.reason})`);
  assert.ok(/outranks clothing MAJOR/.test(decision.reason), `reason must name the precedence, got: ${decision.reason}`);
});
test('MAJOR clothing alone still routes to char-fix (2026-08-09 unchanged)', () => {
  const decision = decideRepairMethod(5, {
    scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
    fixableIssues: [],
    consolidatedPlan: { deduped_issues: [clothingMajor('Ethan')] },
  }, null);
  assert.strictEqual(decision.method, 'char-fix', `expected char-fix, got ${decision.method} (${decision.reason})`);
  assert.strictEqual(decision.charName, 'Ethan');
});
test('a CRITICAL clothing/identity-typed finding cannot claim precedence', () => {
  const decision = decideRepairMethod(5, {
    scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
    fixableIssues: [],
    consolidatedPlan: {
      deduped_issues: [
        { type: 'hair', severity: 'CRITICAL', sources: ['quality'], description: 'hair is blonde, not dark brown' },
        clothingMajor('Ethan'),
      ],
    },
  }, null);
  assert.strictEqual(decision.method, 'char-fix');
});
test('CRITICAL entity + MAJOR clothing → char-fix on the entity issue, unchanged (2026-09-04)', () => {
  const decision = decideRepairMethod(16, {
    scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } },
    fixableIssues: [],
    consolidatedPlan: { deduped_issues: [clothingMajor('Lorena')] },
  }, entityReportWith('CRITICAL'));
  assert.strictEqual(decision.method, 'char-fix');
  assert.strictEqual(decision.charName, 'Lorena');
  assert.ok(/^entity critical/.test(decision.reason), `entity gate must win, got: ${decision.reason}`);
});

console.log('\nconsolidator — rule 7 scene_fix guard');
const { applyRule7SceneFixGuard } = require('../../server/lib/feedbackConsolidator');
test('clothing-typed scene_fix moves to dropped_issues and is cleared', () => {
  const plan = {
    scene_fix: { severity: 'MAJOR', types: ['clothing'], instruction: 'Replace the blue duffle coat with a blue hooded anorak.' },
    dropped_issues: [],
  };
  applyRule7SceneFixGuard(plan, 5);
  assert.strictEqual(plan.scene_fix.instruction, '');
  assert.strictEqual(plan.scene_fix.severity, 'NONE');
  assert.strictEqual(plan.dropped_issues.length, 1);
  assert.strictEqual(plan.dropped_issues[0].reason, 'requires_char_fix_not_inpaint');
});
test('a scene_fix with an inpaintable type is left alone', () => {
  const plan = {
    scene_fix: { severity: 'MODERATE', types: ['clothing', 'object_presence'], instruction: 'Add a glow to the stone.' },
    dropped_issues: [],
  };
  applyRule7SceneFixGuard(plan, 5);
  assert.strictEqual(plan.scene_fix.instruction, 'Add a glow to the stone.');
  assert.strictEqual(plan.dropped_issues.length, 0);
});
test('a scene_fix with no declared types is never guessed at from prose', () => {
  const plan = {
    scene_fix: { severity: 'MAJOR', instruction: 'Replace the blue duffle coat with a blue hooded anorak.' },
    dropped_issues: [],
  };
  applyRule7SceneFixGuard(plan, 5);
  assert.strictEqual(plan.scene_fix.instruction, 'Replace the blue duffle coat with a blue hooded anorak.');
  assert.strictEqual(plan.dropped_issues.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

// Unit tests for the eval-bucket taxonomy + multi-judge median merge.
// Pure logic, no deps — run: node tests/manual/evalBuckets.test.js
const assert = require('assert');
const {
  bucketForType, mapIssuesToBuckets, mergeJudges, bucketsToIssues, medianRank, sevRank,
} = require('../../server/lib/evalBuckets');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ✓ ${msg}`); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${a}, want ${b})`); console.log(`  ✓ ${msg}`); passed++; };

console.log('\ntype → bucket mapping');
eq(bucketForType('color'), 'clothing', 'color → clothing');
eq(bucketForType('proportion'), 'anatomy', 'proportion → anatomy');
eq(bucketForType('incomplete_figure'), 'figure_completeness', 'incomplete_figure → figure_completeness');
eq(bucketForType('interaction'), 'action_interaction', 'interaction → action_interaction');
eq(bucketForType('scale'), 'composition_textzone', 'scale → composition_textzone');
eq(bucketForType('totally_new_type'), 'other', 'unknown type → other (never dropped)');

console.log('\nmapIssuesToBuckets keeps MAX severity per bucket');
{
  const vec = mapIssuesToBuckets([
    { type: 'anatomy', severity: 'minor', description: 'slightly long arm' },
    { type: 'anatomy', severity: 'critical', description: 'third arm' },
    { type: 'color', severity: 'major', description: 'red coat should be blue' },
  ]);
  eq(vec.anatomy.severity, 'critical', 'anatomy collapses to worst instance (critical)');
  eq(vec.anatomy.count, 2, 'anatomy counted twice');
  eq(vec.clothing.severity, 'major', 'color mapped to clothing/major');
}

console.log('\nmerge = PURE MEDIAN per bucket (the locked policy)');
const V = (bucket, sev) => ({ [bucket]: { rank: sevRank(sev), severity: sev, count: 1, samples: [] } });
{
  // [critical, major, major] -> major
  const m = mergeJudges([V('anatomy', 'critical'), V('anatomy', 'major'), V('anatomy', 'major')]);
  eq(m.anatomy.severity, 'major', '[critical,major,major] → major');
  eq(m.anatomy.agreement, '2/3', '  agreement 2/3');
}
{
  // [critical, critical, major] -> critical
  const m = mergeJudges([V('anatomy', 'critical'), V('anatomy', 'critical'), V('anatomy', 'major')]);
  eq(m.anatomy.severity, 'critical', '[critical,critical,major] → critical');
}
{
  // [critical, none, none] -> dropped (median 0)
  const m = mergeJudges([V('anatomy', 'critical'), {}, {}]);
  ok(!m.anatomy, '[critical,none,none] → dropped (1-of-3 not enough)');
}
{
  // binary bucket via median: 2 of 3 see rendered_text -> flagged
  const m = mergeJudges([V('rendered_text', 'critical'), V('rendered_text', 'critical'), {}]);
  eq(m.rendered_text.severity, 'critical', 'binary 2/3 majority → flagged');
}
{
  // total split [minor, major, critical] -> median major, low confidence
  const m = mergeJudges([V('style_consistency', 'minor'), V('style_consistency', 'major'), V('style_consistency', 'critical')]);
  eq(m.style_consistency.severity, 'major', 'full split → median major');
  eq(m.style_consistency.lowConfidence, true, '  flagged lowConfidence (1/3 agreement)');
}

console.log('\nmedianRank sanity');
eq(medianRank([0, 3, 3]), 3, 'median([0,3,3]) = 3');
eq(medianRank([0, 0, 4]), 0, 'median([0,0,4]) = 0');
eq(medianRank([1, 3, 4]), 3, 'median([1,3,4]) = 3');

console.log('\nbucketsToIssues bridges back to the pipeline shape');
{
  const merged = mergeJudges([V('anatomy', 'critical'), V('anatomy', 'critical'), V('clothing', 'major')]);
  const issues = bucketsToIssues(merged);
  const anatomy = issues.find(i => i.type === 'anatomy');
  ok(anatomy && anatomy.severity === 'critical', 'emits {type, severity} scoring.js can consume');
  ok(anatomy.repair === 'regen', '  carries repair route for the router');
  ok(anatomy.owner === 'quality', '  carries owner eval for stats');
}

console.log(`\nALL PASS — ${passed} assertions\n`);

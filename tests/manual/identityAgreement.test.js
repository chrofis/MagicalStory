/**
 * Do the evaluator and the detector agree on WHO IS WHO?
 *
 * The evaluator names figures from reference photos with no stated matching
 * method and records only a box; the detector names person boxes independently,
 * from identity lines that already include clothing. On production story
 * job_1787349305313_hpv76p0rokg, 15 of 17 comparable evaluations disagreed —
 * and the disagreements were clean permutations of the SAME faces (one page
 * swaps two children outright). When that happens every per-character verdict on
 * the page is suspect: clothing and action as much as height.
 *
 * This is a diagnostic only (owner, 2026-08-22): it flags contested pages, it
 * does not drop findings or move a score.
 *
 * Run: node tests/manual/identityAgreement.test.js
 */
'use strict';
const assert = require('assert');
const { checkIdentityAgreement, describeIdentityAgreement, reconcileIdentity } = require('../../server/lib/identityAgreement');

let passed = 0;
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); console.log(`  ✓ ${m}`); passed++; };
const ok = (c, m) => { assert.ok(c, m); console.log(`  ✓ ${m}`); passed++; };

// The real p2v1 records. Evaluator boxes are [x1,y1,x2,y2]; detector [ymin,xmin,ymax,xmax].
const EV = [
  { reference: 'Julian', face_bbox: [0.13, 0.35, 0.25, 0.46] },
  { reference: 'Levin', face_bbox: [0.34, 0.43, 0.45, 0.53] },
  { reference: 'Max', face_bbox: [0.55, 0.38, 0.67, 0.49] },
  { reference: 'Kiaan', face_bbox: [0.76, 0.38, 0.88, 0.49] },
];
const DET = [
  { name: 'Julian', faceBox: [0.3515, 0.6865, 0.6015, 0.8990] },
  { name: 'Max', faceBox: [0.3307, 0.1171, 0.5807, 0.3296] },
  { name: 'Kiaan', faceBox: [0.3454, 0.5210, 0.5954, 0.7335] },
  { name: 'Levin', faceBox: [0.3884, 0.3410, 0.6384, 0.5535] },
];

console.log('\nthe production case — a three-way permutation');
{
  const r = checkIdentityAgreement(EV, DET);
  eq(r.compared, 4, 'all four figures compared');
  eq(r.agreed, 1, 'only one name agrees');
  eq(r.conflicts.length, 3, 'three identities conflict');
  eq(r.agreementRate, 0.25, 'agreement rate reported');
  ok(r.conflicts.every(c => c.centreDistance < 0.1),
     'the boxes are in the SAME place — only the names differ');
  ok(['Julian', 'Max', 'Kiaan'].every(n => r.contestedCharacters.includes(n)),
     'every contested character is named, so findings about them can be reviewed');
  ok(!r.contestedCharacters.includes('Levin'), 'the one agreed name is not contested');
}

console.log('\na non-person subject is not a conflict');
{
  // The detector only ever names PEOPLE. Forcing a creature onto the nearest
  // child invented 2 false conflicts in the first measurement of this.
  const r = checkIdentityAgreement([...EV, { reference: 'The Young Dragon', face_bbox: [0.9, 0.9, 0.95, 0.95] }], DET);
  eq(r.compared, 4, 'the creature is not compared against a child');
  ok((r.unpaired || []).includes('The Young Dragon'), 'it is reported as unpaired instead');
}

console.log('\nbodies are preferred over faces');
{
  const r = checkIdentityAgreement(
    [{ reference: 'Levin', body_bbox: [0.5, 0.1, 0.9, 0.9], face_bbox: [0.6, 0.1, 0.7, 0.2] }],
    [{ name: 'Levin', bodyBox: [0.1, 0.5, 0.9, 0.9], faceBox: [0.1, 0.6, 0.2, 0.7] }]);
  eq(r.pairedOn, 'body', 'pairs on the body, which is what carries the clothing');
  eq(r.agreed, 1, 'and agrees');
  const legacy = checkIdentityAgreement([{ reference: 'Levin', face_bbox: [0.6, 0.1, 0.7, 0.2] }],
    [{ name: 'Levin', faceBox: [0.1, 0.6, 0.2, 0.7] }]);
  eq(legacy.pairedOn, 'face', 'older records without a body box still compare, flagged as face-paired');
}

console.log('\nnothing comparable → no report, never a false alarm');
{
  eq(checkIdentityAgreement([], DET), null, 'no evaluator matches');
  eq(checkIdentityAgreement(EV, []), null, 'no detector figures');
  eq(checkIdentityAgreement(null, null), null, 'both absent');
  eq(checkIdentityAgreement([{ reference: 'Levin' }], DET), null, 'a match with no box at all');
}

console.log('\nthe summary line names the contested characters');
{
  ok(/disagree on 3\/4/.test(describeIdentityAgreement(checkIdentityAgreement(EV, DET), 'p2 ')),
     'conflict summary states the ratio');
  ok(/agree on all/.test(describeIdentityAgreement(
     checkIdentityAgreement([{ reference: 'Levin', body_bbox: [0.5, 0.1, 0.9, 0.9] }],
                            [{ name: 'Levin', bodyBox: [0.1, 0.5, 0.9, 0.9] }]))),
     'clean summary says so');
  eq(describeIdentityAgreement(null), null, 'no report → no line');
}

console.log('\nreconcile — the detector wins, and every name this evaluation wrote moves with it');
{
  // A clean two-name swap: the evaluator called the left body Levin, the
  // detector calls that same body Timo.
  const ev = {
    matches: [
      { reference: 'Levin', body_bbox: [0.05, 0.1, 0.35, 0.9] },
      { reference: 'Timo', body_bbox: [0.55, 0.1, 0.85, 0.9] },
    ],
    fixableIssues: [
      { character: 'Levin', description: "Levin's jacket is red, not blue" },
      { character: 'Timo', description: 'Timo stands beside Levin' },
    ],
  };
  const enriched = [{ character: 'Levin', description: "Levin's jacket is red" }];
  const r = reconcileIdentity(ev, [
    { name: 'Timo', bodyBox: [0.1, 0.05, 0.9, 0.35] },
    { name: 'Levin', bodyBox: [0.1, 0.55, 0.9, 0.85] },
  ], { alsoRename: [enriched] });

  eq(r.conflicts.length, 2, 'both names are contested');
  eq(ev.matches[0].reference, 'Timo', 'the match takes the detector name');
  eq(ev.matches[1].reference, 'Levin', 'simultaneously — not a cascade back onto itself');
  eq(ev.matches[0].evaluatorReference, 'Levin', 'what the evaluator said is kept for review');
  eq(ev.fixableIssues[0].character, 'Timo', 'the finding follows its figure');
  ok(/Timo's jacket is red/.test(ev.fixableIssues[0].description),
     'and so does the prose — the sentence was written by the same wrong assignment');
  ok(/Levin stands beside Timo/.test(ev.fixableIssues[1].description),
     'a sentence naming two contested characters swaps both');
  eq(ev.fixableIssues[0].identityCorrected, true, 'the correction is visible on the finding');
  eq(enriched[0].character, 'Timo', 'bbox-enriched targets are separate objects and move too');
  ok(/Timo's jacket/.test(enriched[0].description), 'including their prose');
  eq(r.renameMap.levin, 'Timo', 'the report carries the map that was applied');
}

console.log('\nreconcile — agreement changes nothing');
{
  const ev = { matches: [{ reference: 'Levin', body_bbox: [0.05, 0.1, 0.35, 0.9] }],
               fixableIssues: [{ character: 'Levin', description: "Levin's hat is missing" }] };
  const r = reconcileIdentity(ev, [{ name: 'Levin', bodyBox: [0.1, 0.05, 0.9, 0.35] }]);
  eq(r.conflicts.length, 0, 'no conflict');
  eq(ev.fixableIssues[0].character, 'Levin', 'the finding is untouched');
  eq(ev.fixableIssues[0].identityCorrected, undefined, 'and not marked as corrected');
}

console.log('\nreconcile — a conflict that is not a clean swap is flagged, never rewritten');
{
  // Two evaluator names collapse onto ONE detector name. Renaming would put the
  // same child in two places at once, so nothing is renamed.
  // Two neighbouring evaluator figures whose nearest detector body is the SAME
  // one (Mara, standing between them); the detector's own Levin and Timo are
  // across the frame.
  const ev = {
    matches: [
      { reference: 'Levin', body_bbox: [0.15, 0.40, 0.25, 0.60] },
      { reference: 'Timo', body_bbox: [0.35, 0.40, 0.45, 0.60] },
    ],
    fixableIssues: [{ character: 'Levin', description: "Levin's jacket is red" }],
  };
  const r = reconcileIdentity(ev, [
    { name: 'Mara', bodyBox: [0.40, 0.25, 0.60, 0.35] },
    { name: 'Levin', bodyBox: [0.85, 0.85, 0.95, 0.95] },
    { name: 'Timo', bodyBox: [0.00, 0.90, 0.10, 1.00] },
  ]);
  eq(r.uncorrectable, true, 'flagged as uncorrectable');
  eq(r.renamed, 0, 'nothing renamed');
  eq(ev.matches[0].reference, 'Levin', 'the evaluator name survives untouched');
  ok(/not a clean swap/.test(describeIdentityAgreement(r)), 'and the log line says why');
}

console.log('\nreconcile — prose renaming respects word boundaries');
{
  const ev = {
    matches: [{ reference: 'Tim', body_bbox: [0.05, 0.1, 0.35, 0.9] },
              { reference: 'Mara', body_bbox: [0.55, 0.1, 0.85, 0.9] }],
    fixableIssues: [{ character: 'Tim', description: 'Tim holds a timer; Timothy is absent' }],
  };
  reconcileIdentity(ev, [{ name: 'Mara', bodyBox: [0.1, 0.05, 0.9, 0.35] },
                         { name: 'Tim', bodyBox: [0.1, 0.55, 0.9, 0.85] }]);
  ok(/Mara holds a timer/.test(ev.fixableIssues[0].description), 'the standalone name is replaced');
  ok(/a timer/.test(ev.fixableIssues[0].description), 'a name inside another word is not touched');
  ok(/Timothy is absent/.test(ev.fixableIssues[0].description), 'nor a longer name that starts with it');
}

console.log(`\n✅ ALL ${passed} assertions passed (evaluator/detector identity agreement)\n`);

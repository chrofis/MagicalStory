/**
 * Identity cross-check: two independent opinions on who is who, joined by
 * geometry — plus the wiring that makes a disputed identity block a garment
 * recolour.
 *
 * WHY THIS EXISTS
 * The names on detection boxes come from the Set-of-Mark call in
 * server/lib/figureDetection.js, whose prompt forces a complete assignment
 * ("assign each character to one badge, by elimination if needed"), so it
 * cannot answer "I don't know" — only right or confidently wrong. On staging
 * story job_1786397108357_q1fjbdzbx page 14 it named the far-left man "Hans"
 * (he is Daniel, green coat) and left the real, white-haired Hans in the centre
 * as UNKNOWN; the garment recolour then repainted the wrong man's coat (-80,
 * lost pick-best, so it did not ship — by luck). The quality eval had it right
 * on the same pixels and was willing to abstain.
 *
 * The detection fixture below is the REAL stored bboxDetection.figures of that
 * page (staging DB, [ymin,xmin,ymax,xmax] normalised, verbatim). The eval side
 * uses the real verdicts (figure #1 UNMATCHED 0%, #3 → Hans 80%, Emma 90%,
 * Noah 90%, #4 UNMATCHED 0%) with face_bbox values reconstructed from those
 * same boxes in the eval's own [x1,y1,x2,y2] order and deliberately jittered,
 * because the eval's face_bbox was not persisted on that pre-898e4f2f2 story
 * and because a loose, offset LLM box is exactly what the join must survive.
 *
 * The cross-check is a pure module, so it is require()d and its real behaviour
 * exercised. The pipeline wiring is asserted at source level: require()-ing
 * repairPipeline.js initialises services and HANGS. CRLF-normalised.
 *
 * Run: node tests/manual/figureIdentityCheck.test.js
 */
'use strict';

const fs = require('fs');
const { crossCheckFigureIdentity, isIdentityDisputed, resolveIdentityTiebreak, MIN_EVAL_CONFIDENCE } =
  require('../../server/lib/figureIdentityCheck');

let passed = 0, failed = 0;
const check = (d, c, extra) => c
  ? (passed++, console.log(`  ok  ${d}`))
  : (failed++, console.log(`FAIL  ${d}${extra ? '  — ' + extra : ''}`));

const verdictOf = (res, name) => res.perFigure.find(f => f.name === name)?.verdict;

/** Detection box [ymin,xmin,ymax,xmax] → an eval-style face_bbox [x1,y1,x2,y2], jittered. */
const evalFaceBox = (det, jitter = 0.012) => {
  const [ymin, xmin, ymax, xmax] = det;
  return [xmin + jitter, ymin - jitter, xmax + jitter, ymax + jitter];
};

// ── Real page-14 detection, verbatim from the staging story ────────────────
const P14_EMMA_FACE = [0.255859375, 0.247265625, 0.505859375, 0.459765625];
const P14_SARAH_FACE = [0.14404296875, 0.62861328125, 0.39404296875, 0.84111328125];
const P14_LEFTMAN_FACE = [0.10400390625, 0.15791015625, 0.35400390625, 0.37041015625];
const P14_NOAH_FACE = [0.38623046875, 0.61689453125, 0.63623046875, 0.82939453125];
const P14_CENTRE_FACE = [0.1064453125, 0.4767578125, 0.3564453125, 0.6892578125];

const p14Detection = [
  { name: 'Emma', faceBox: P14_EMMA_FACE, bodyBox: [0.255859375, 0.2060546875, 0.94921875, 0.4873046875] },
  { name: 'UNKNOWN', faceBox: P14_SARAH_FACE, bodyBox: [0.14404296875, 0.62861328125, 0.87109375, 0.935546875] },
  { name: 'Hans', faceBox: P14_LEFTMAN_FACE, bodyBox: [0.10400390625, 0.0751953125, 0.8173828125, 0.37041015625] },
  { name: 'Noah', faceBox: P14_NOAH_FACE, bodyBox: [0.38623046875, 0.61689453125, 0.9482421875, 0.880859375] },
  { name: 'UNKNOWN', faceBox: P14_CENTRE_FACE, bodyBox: [0.1064453125, 0.474609375, 0.724609375, 0.7392578125] },
];

const p14EvalFigures = [
  { id: 1, zone: 'left-foreground', hair: 'dark brown, short, mustache', clothing: 'green coat' },
  { id: 2, zone: 'center-foreground', hair: 'brown braids', clothing: 'blue dress' },
  { id: 3, zone: 'center-foreground', hair: 'white/grey, short, mustache', clothing: 'brown waistcoat' },
  { id: 4, zone: 'right-foreground', hair: 'blonde', clothing: 'apron' },
  { id: 5, zone: 'right-foreground', hair: 'light brown, short', clothing: 'red tunic' },
];

const p14EvalMatches = [
  { figure: 1, reference: 'UNMATCHED', confidence: 0, face_bbox: evalFaceBox(P14_LEFTMAN_FACE) },
  { figure: 2, reference: 'Emma', confidence: 0.9, face_bbox: evalFaceBox(P14_EMMA_FACE) },
  { figure: 3, reference: 'Hans', confidence: 0.8, face_bbox: evalFaceBox(P14_CENTRE_FACE) },
  { figure: 4, reference: 'UNMATCHED', confidence: 0, face_bbox: evalFaceBox(P14_SARAH_FACE) },
  { figure: 5, reference: 'Noah', confidence: 0.9, face_bbox: evalFaceBox(P14_NOAH_FACE) },
];

// ── 1. Agreement ───────────────────────────────────────────────────────────
console.log('\nagreement');
{
  const res = crossCheckFigureIdentity(
    [{ name: 'Emma', faceBox: P14_EMMA_FACE, bodyBox: [0.25, 0.20, 0.95, 0.49] }],
    [{ figure: 2, reference: 'Emma', confidence: 0.9, face_bbox: evalFaceBox(P14_EMMA_FACE) }],
    p14EvalFigures,
  );
  check('both opinions name Emma → agree', verdictOf(res, 'Emma') === 'agree', JSON.stringify(res.perFigure));
  check('nothing is disputed', res.disputed.length === 0);
  check('the eval confidence is carried through', res.perFigure[0].confidence === 0.9);
  check('a loose, offset eval face box still joins (centre-containment, not IoU)',
    res.perFigure[0].evalName === 'Emma');
}

// ── 2. The real page-14 case ───────────────────────────────────────────────
console.log('\nthe page-14 case (staging job_1786397108357_q1fjbdzbx)');
{
  const res = crossCheckFigureIdentity(p14Detection, p14EvalMatches, p14EvalFigures);
  check('Emma is agreed', verdictOf(res, 'Emma') === 'agree');
  check('Noah is agreed', verdictOf(res, 'Noah') === 'agree');
  check('Hans is DISPUTED — the detection put him far left, the eval put him centre',
    verdictOf(res, 'Hans') === 'disputed', JSON.stringify(res.perFigure, null, 1));
  check('and the centre box the eval calls Hans is disputed too, not silently adopted',
    res.perFigure.filter(f => f.verdict === 'disputed').length === 2);
  check('Hans is on the disputed list', isIdentityDisputed(res, 'Hans'));
  check('the disputed list is name-case-insensitive', isIdentityDisputed(res, 'hans'));
  check('Emma is NOT blocked by a dispute about someone else', !isIdentityDisputed(res, 'Emma'));
  check('Noah is not blocked either', !isIdentityDisputed(res, 'Noah'));
  check('the reason names both placements, not just "disagreement"',
    /Hans/.test(res.perFigure.find(f => f.verdict === 'disputed').reason));
  check('exactly one row per detection figure', res.perFigure.length === p14Detection.length);
  check('the eval figure description enriches a verdict reason',
    res.perFigure.some(f => /white\/grey|dark brown/.test(f.reason)));
}

// ── 3. Head-on disagreement on the SAME box ────────────────────────────────
console.log('\nhead-on disagreement on one box');
{
  const res = crossCheckFigureIdentity(
    [{ name: 'Emma', faceBox: P14_EMMA_FACE }],
    [{ figure: 2, reference: 'Sarah', confidence: 0.85, face_bbox: evalFaceBox(P14_EMMA_FACE) }],
    [],
  );
  check('different names on the same pixels → disputed', verdictOf(res, 'Emma') === 'disputed');
  check('BOTH names are unsafe — the detection name is listed', isIdentityDisputed(res, 'Emma'));
  check('and so is the eval name', isIdentityDisputed(res, 'Sarah'));
}

// ── 4. UNMATCHED → unverified ──────────────────────────────────────────────
console.log('\nthe eval abstains');
{
  for (const token of ['UNMATCHED', 'unmatched', 'none', 'unknown', '']) {
    const res = crossCheckFigureIdentity(
      [{ name: 'Hans', faceBox: P14_LEFTMAN_FACE }],
      [{ figure: 1, reference: token, confidence: 0, face_bbox: evalFaceBox(P14_LEFTMAN_FACE) }],
      [],
    );
    check(`reference "${token}" → unverified`, verdictOf(res, 'Hans') === 'unverified');
    check(`reference "${token}" blocks nothing`, res.disputed.length === 0);
  }
}

// ── 5. Low confidence → unverified ─────────────────────────────────────────
console.log('\nlow-confidence eval naming is not evidence');
{
  const below = crossCheckFigureIdentity(
    [{ name: 'Emma', faceBox: P14_EMMA_FACE }],
    [{ figure: 2, reference: 'Sarah', confidence: MIN_EVAL_CONFIDENCE - 0.01, face_bbox: evalFaceBox(P14_EMMA_FACE) }],
    [],
  );
  check('a contradicting name below the threshold does NOT dispute',
    verdictOf(below, 'Emma') === 'unverified', JSON.stringify(below.perFigure));
  check('and blocks nothing', below.disputed.length === 0);
  check('the reason states the threshold', /threshold/.test(below.perFigure[0].reason));

  const at = crossCheckFigureIdentity(
    [{ name: 'Emma', faceBox: P14_EMMA_FACE }],
    [{ figure: 2, reference: 'Sarah', confidence: MIN_EVAL_CONFIDENCE, face_bbox: evalFaceBox(P14_EMMA_FACE) }],
    [],
  );
  check('exactly at the threshold it counts → disputed', verdictOf(at, 'Emma') === 'disputed');

  const missing = crossCheckFigureIdentity(
    [{ name: 'Emma', faceBox: P14_EMMA_FACE }],
    [{ figure: 2, reference: 'Sarah', face_bbox: evalFaceBox(P14_EMMA_FACE) }],
    [],
  );
  check('a match with no confidence field is still read as a claim',
    verdictOf(missing, 'Emma') === 'disputed');
  check('and reports confidence as null', missing.perFigure[0].confidence === null);
}

// ── 6. Detection UNKNOWN + confident eval → adopted ────────────────────────
console.log('\nadoption');
{
  const res = crossCheckFigureIdentity(
    [{ name: 'UNKNOWN', faceBox: P14_CENTRE_FACE }, { name: 'Emma', faceBox: P14_EMMA_FACE }],
    [{ figure: 3, reference: 'Hans', confidence: 0.8, face_bbox: evalFaceBox(P14_CENTRE_FACE) }],
    p14EvalFigures,
  );
  check('detection could not name it, the eval can → adopted', verdictOf(res, 'UNKNOWN') === 'adopted');
  check('adoption is not a dispute — nothing is blocked', res.disputed.length === 0);
  check('the adopted name is reported', res.perFigure[0].evalName === 'Hans');

  const shy = crossCheckFigureIdentity(
    [{ name: 'UNKNOWN', faceBox: P14_CENTRE_FACE }],
    [{ figure: 3, reference: 'Hans', confidence: 0.2, face_bbox: evalFaceBox(P14_CENTRE_FACE) }],
    [],
  );
  check('an unconfident eval name is not adopted', verdictOf(shy, 'UNKNOWN') === 'unverified');
}

// ── 7. No second opinion must never block ──────────────────────────────────
console.log('\na missing second opinion never blocks the pipeline');
{
  for (const [label, matches] of [['empty array', []], ['null', null], ['undefined', undefined]]) {
    const res = crossCheckFigureIdentity(p14Detection, matches, p14EvalFigures);
    check(`matches ${label} → every figure unverified`,
      res.perFigure.length === 5 && res.perFigure.every(f => f.verdict === 'unverified'));
    check(`matches ${label} → nothing disputed`, res.disputed.length === 0);
  }
  const noDet = crossCheckFigureIdentity(null, p14EvalMatches, p14EvalFigures);
  check('no detection figures at all → empty result, no throw',
    noDet.perFigure.length === 0 && noDet.disputed.length === 0);
  check('isIdentityDisputed tolerates junk',
    !isIdentityDisputed(null, 'Hans') && !isIdentityDisputed({ disputed: ['Hans'] }, null));
}

// ── 8. The join itself ─────────────────────────────────────────────────────
console.log('\nthe geometric join');
{
  // Detection boxes are [ymin,xmin,ymax,xmax]; eval face_bbox is [x1,y1,x2,y2].
  // Feeding the eval box in detection order must NOT join — that silent
  // axis-swap is exactly the bug this test is here to catch.
  const swapped = crossCheckFigureIdentity(
    [{ name: 'Emma', faceBox: [0.05, 0.60, 0.15, 0.75] }],
    [{ figure: 2, reference: 'Sarah', confidence: 0.9, face_bbox: [0.05, 0.60, 0.15, 0.75] }],
    [],
  );
  check('a y-major eval box does not land in an x-major detection box',
    verdictOf(swapped, 'Emma') === 'unverified');

  const far = crossCheckFigureIdentity(
    [{ name: 'Emma', faceBox: P14_EMMA_FACE }],
    [{ figure: 2, reference: 'Sarah', confidence: 0.9, face_bbox: evalFaceBox(P14_NOAH_FACE) }],
    [],
  );
  check('a face centre in nobody’s box yields no join, never a guess',
    verdictOf(far, 'Emma') === 'unverified');

  // Face centre outside the (tight) face box but inside the body box: the
  // fallback tier keeps the join instead of dropping a usable second opinion.
  const bodyOnly = crossCheckFigureIdentity(
    [{ name: 'Emma', faceBox: [0.02, 0.02, 0.06, 0.06], bodyBox: P14_EMMA_FACE }],
    [{ figure: 2, reference: 'Sarah', confidence: 0.9, face_bbox: evalFaceBox(P14_EMMA_FACE, 0) }],
    [],
  );
  check('bodyBox is the fallback join tier', verdictOf(bodyOnly, 'Emma') === 'disputed');

  // Two eval matches landing on one detection box: the confident one wins,
  // the other is simply not joined (its figure stays unverified).
  const dup = crossCheckFigureIdentity(
    [{ name: 'Emma', faceBox: P14_EMMA_FACE }],
    [
      { figure: 2, reference: 'Sarah', confidence: 0.3, face_bbox: evalFaceBox(P14_EMMA_FACE) },
      { figure: 6, reference: 'Emma', confidence: 0.95, face_bbox: evalFaceBox(P14_EMMA_FACE, 0.004) },
    ],
    [],
  );
  check('two matches on one box → the more confident one decides',
    verdictOf(dup, 'Emma') === 'agree');

  const noBox = crossCheckFigureIdentity(
    [{ name: 'Emma', faceBox: P14_EMMA_FACE }],
    [{ figure: 2, reference: 'Sarah', confidence: 0.9 }],
    [],
  );
  check('a match with no face_bbox cannot be joined → unverified',
    verdictOf(noBox, 'Emma') === 'unverified');

  const junk = crossCheckFigureIdentity(
    [{ name: 'Emma', faceBox: 'nope' }, { faceBox: P14_EMMA_FACE }],
    [{ figure: 2, reference: 'Sarah', confidence: 0.9, face_bbox: [0.1, 0.2, 'x', 0.4] }],
    [],
  );
  check('malformed boxes are ignored, not thrown on',
    junk.perFigure.length === 2 && junk.perFigure.every(f => f.verdict === 'unverified'));
  check('a nameless detection figure reads as UNKNOWN', junk.perFigure[1].name === 'UNKNOWN');
}

// ── 9. The tiebreaker is a stub, and off ───────────────────────────────────
console.log('\nthe tiebreaker is deliberately not implemented');
{
  const { MODEL_DEFAULTS } = require('../../server/config/models');
  check('MODEL_DEFAULTS.identityTiebreak exists', 'identityTiebreak' in MODEL_DEFAULTS);
  check('and defaults to false',
    process.env.IDENTITY_TIEBREAK === 'true' || MODEL_DEFAULTS.identityTiebreak === false);
  check('resolveIdentityTiebreak is exported', typeof resolveIdentityTiebreak === 'function');
}

// ── 10. The wiring (source-level: requiring repairPipeline.js hangs) ───────
console.log('\nrunGarmentRecolour refuses a disputed identity');
{
  const src = fs.readFileSync(require.resolve('../../server/lib/repairPipeline.js'), 'utf8').replace(/\r\n/g, '\n');
  const from = src.indexOf('const runGarmentRecolour = async (img, entries, roundNum) => {');
  const to = src.indexOf('const { decideRepairMethod }', from);
  check('runGarmentRecolour is where we think it is', from > 0 && to > from);
  const fn = src.slice(from, to);

  check('the cross-check module is required there',
    /require\('\.\/figureIdentityCheck'\)/.test(fn));
  check('it is fed the version’s OWN detection figures',
    /crossCheckFigureIdentity\(\s*\n\s*detection\?\.figures \|\| \[\],/.test(fn));
  check('and the version’s persisted eval matches (898e4f2f2), not a page-level copy',
    /bestEvalObj\?\.matches \?\? bestSoFar\?\.matches/.test(fn));
  check('a disputed character is skipped', /isIdentityDisputed\(identityCheck, charName\)/.test(fn));
  check('the skip is recorded on the existing audit object, like every other skip',
    /audit\.skipped = `identity disputed:/.test(fn));
  check('the full verdict list persists with it',
    /audit\.identityVerdicts = identityCheck\.perFigure/.test(fn));
  check('the skip happens BEFORE any recolour work',
    fn.indexOf('isIdentityDisputed') < fn.indexOf('fixFigureGarmentColour(before'));
  check('the tiebreaker call site exists but is flag-gated',
    /if \(MODEL_DEFAULTS\.identityTiebreak\) \{\s*\n\s*resolved = await resolveIdentityTiebreak\(/.test(fn));
  check('and is marked TODO with the intended design',
    /TODO, the intended design/.test(fn) && /left-to-right/.test(fn));
  check('unverified is never used to block anything',
    !/'unverified'/.test(fn) && !/"unverified"/.test(fn));
  check('the page-14 evidence is cited at the call site',
    /job_1786397108357_q1fjbdzbx/.test(fn));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

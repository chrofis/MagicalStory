/**
 * Unit tests for the avatar-side SELF-VERIFICATION in
 * server/lib/garmentColourFix.js: cross-panel agreement.
 *
 * The styled avatar sheet is 2x4 panels of the SAME character, so a garment is
 * on it several times. The target used to be one DINO box -> one SAM mask -> one
 * mean, with nothing to check it against — and that reading can be confidently
 * wrong. Lab exp 489: asked for the hat, the box landed on brown boots, a brown
 * target came back at DINO 0.35, and a correct cream hat was repainted brown.
 * Nothing objected. A second panel would have said cream.
 *
 * `pickAgreeingPanels` is the decision, kept pure so it is testable with no
 * detector, no segmenter and no network. These cases are the ones that matter:
 * agreement, the exp-489 disagreement, an outlier that must not poison the mean,
 * the provisional single-panel acceptance, nothing at all, and both sides of the
 * threshold.
 *
 * Run: node tests/manual/garmentPanelAgreement.test.js
 */
const {
  pickAgreeingPanels, selectDistinctBoxes, boxIoU, labDeltaE, DEFAULTS,
} = require('../../server/lib/garmentColourFix');

let passed = 0, failed = 0;
const check = (d, c, extra) => c
  ? (passed++, console.log(`  ok  ${d}`))
  : (failed++, console.log(`FAIL  ${d}${extra ? '  — ' + extra : ''}`));

// Measured-ish values: a cream hat is light and near-neutral, brown boots are
// dark and warm. These are the two readings exp 489 could have compared.
const CREAM = { L: 88, a: 2, b: 14, count: 900 };
const CREAM2 = { L: 86, a: 3, b: 16, count: 850 };
const BROWN = { L: 41, a: 12, b: 26, count: 1200 };

console.log('\nTEST 1 — two panels that agree');
{
  const r = pickAgreeingPanels([CREAM, CREAM2]);
  check('agreement is "agreed"', r.agreement === 'agreed', r.agreement);
  check('both panels counted', r.panelsMeasured === 2 && r.panelsAgreed === 2,
    `${r.panelsAgreed}/${r.panelsMeasured}`);
  check('the mean is the mean of the two', Math.abs(r.mean.L - 87) < 1e-9
    && Math.abs(r.mean.a - 2.5) < 1e-9 && Math.abs(r.mean.b - 15) < 1e-9,
    JSON.stringify(r.mean));
  check('maskPx is the pixels behind it', r.mean.count === 1750, `${r.mean.count}`);
  check('the spread is reported', r.maxPairDeltaE > 0 && r.maxPairDeltaE <= DEFAULTS.avatarAgreeDeltaE,
    `${r.maxPairDeltaE}`);
  check('no reason when nothing was refused', r.reason === null, String(r.reason));
}

console.log('\nTEST 2 — two panels that disagree (the exp-489 shape)');
{
  const r = pickAgreeingPanels([CREAM, BROWN]);
  check('agreement is "disagree"', r.agreement === 'disagree', r.agreement);
  check('NO target is returned', r.mean === null, JSON.stringify(r.mean));
  check('nothing agreed', r.panelsAgreed === 0 && r.panelsMeasured === 2,
    `${r.panelsAgreed}/${r.panelsMeasured}`);
  check('the distance is above the threshold',
    r.maxPairDeltaE > DEFAULTS.avatarAgreeDeltaE, `${r.maxPairDeltaE}`);
  // "make the reason specific, naming the conflicting readings"
  check('the reason names both readings', /L 88/.test(r.reason) && /L 41/.test(r.reason), r.reason);
  check('and the distance that split them', new RegExp(String(r.maxPairDeltaE)).test(r.reason), r.reason);
}

console.log('\nTEST 3 — three panels, two agree and one is an outlier');
{
  const r = pickAgreeingPanels([CREAM, BROWN, CREAM2]);
  check('agreement is "agreed"', r.agreement === 'agreed', r.agreement);
  check('two of three agreed', r.panelsAgreed === 2 && r.panelsMeasured === 3,
    `${r.panelsAgreed}/${r.panelsMeasured}`);
  // The whole point: the outlier must be EXCLUDED, not averaged in. A 3-way
  // mean would be L 71.7 — a cream hat dragged a third of the way to brown.
  check('the outlier is excluded, not averaged in', Math.abs(r.mean.L - 87) < 1e-9,
    `L ${r.mean.L}`);
  check('the mean is not poisoned toward brown', labDeltaE(r.mean, BROWN) > DEFAULTS.avatarAgreeDeltaE,
    `deltaE to brown ${labDeltaE(r.mean, BROWN).toFixed(1)}`);
  check('and the outlier is not in the pixel count', r.mean.count === 1750, `${r.mean.count}`);

  // The reported DINO score must belong to a panel that AGREED — crediting the
  // top candidate would advertise the confidence of the panel that was voted out.
  const scored = pickAgreeingPanels([
    { ...CREAM, score: 0.4 }, { ...BROWN, score: 0.9 }, { ...CREAM2, score: 0.5 },
  ]);
  check('the reported score comes from the agreeing panels', scored.mean.score === 0.5,
    `${scored.mean.score}`);
}

console.log('\nTEST 4 — a single panel is accepted and MARKED (provisional)');
{
  const r = pickAgreeingPanels([CREAM]);
  check('agreement is "single"', r.agreement === 'single', r.agreement);
  check('the measurement is returned, not refused', r.mean && r.mean.L === 88, JSON.stringify(r.mean));
  check('it is recorded as one panel', r.panelsMeasured === 1 && r.panelsAgreed === 1,
    `${r.panelsAgreed}/${r.panelsMeasured}`);
  check('there is no pair distance to report', r.maxPairDeltaE === null, String(r.maxPairDeltaE));
  check('the returned mean is a copy, not the caller\'s object', r.mean !== CREAM);
}

console.log('\nTEST 5 — zero panels');
{
  for (const input of [[], null, undefined, [null, { L: NaN, a: 0, b: 0 }]]) {
    const r = pickAgreeingPanels(input);
    check(`no target for ${JSON.stringify(input)}`, r.mean === null && r.agreement === 'none'
      && r.panelsMeasured === 0 && typeof r.reason === 'string', JSON.stringify(r));
  }
}

console.log('\nTEST 6 — identical means');
{
  const r = pickAgreeingPanels([{ ...CREAM }, { ...CREAM }, { ...CREAM }]);
  check('all three agree', r.agreement === 'agreed' && r.panelsAgreed === 3, `${r.panelsAgreed}`);
  check('the spread is exactly zero', r.maxPairDeltaE === 0, `${r.maxPairDeltaE}`);
  check('the mean is that colour', r.mean.L === 88 && r.mean.a === 2 && r.mean.b === 14,
    JSON.stringify(r.mean));
  check('counts still sum', r.mean.count === 2700, `${r.mean.count}`);
}

console.log('\nTEST 7 — just under and just over the threshold');
{
  const T = DEFAULTS.avatarAgreeDeltaE;
  const base = { L: 60, a: 0, b: 0, count: 500 };
  const under = { L: 60 + T - 0.5, a: 0, b: 0, count: 500 };
  const over = { L: 60 + T + 0.5, a: 0, b: 0, count: 500 };
  const exact = { L: 60 + T, a: 0, b: 0, count: 500 };

  const ru = pickAgreeingPanels([base, under]);
  check(`deltaE ${T - 0.5} (just under ${T}) agrees`, ru.agreement === 'agreed', ru.agreement);
  check('and averages both', Math.abs(ru.mean.L - (60 + (T - 0.5) / 2)) < 1e-9, `L ${ru.mean?.L}`);

  const ro = pickAgreeingPanels([base, over]);
  check(`deltaE ${T + 0.5} (just over ${T}) is refused`, ro.agreement === 'disagree' && ro.mean === null,
    ro.agreement);

  const re = pickAgreeingPanels([base, exact]);
  check(`deltaE exactly ${T} agrees (the bound is inclusive)`, re.agreement === 'agreed', re.agreement);

  // The threshold is a knob, not a constant baked into the logic.
  const loose = pickAgreeingPanels([CREAM, BROWN], { avatarAgreeDeltaE: 100 });
  check('a looser threshold changes the verdict', loose.agreement === 'agreed', loose.agreement);
}

console.log('\nTEST 8 — distinct boxes: a duplicate box is not a second opinion');
{
  const A = { box: [0, 0, 100, 100], score: 0.9 };
  const Adup = { box: [2, 2, 101, 101], score: 0.8 };   // same panel
  const B = { box: [400, 0, 500, 100], score: 0.7 };    // another panel
  const C = { box: [0, 400, 100, 500], score: 0.6 };
  const D = { box: [400, 400, 500, 500], score: 0.5 };

  check('overlapping boxes score high IoU', boxIoU(A.box, Adup.box) > 0.9,
    String(boxIoU(A.box, Adup.box)));
  check('disjoint boxes score zero', boxIoU(A.box, B.box) === 0);

  const sel = selectDistinctBoxes([Adup, A, B, C, D]);
  check('best score first', sel[0].score === 0.9, JSON.stringify(sel[0]));
  check('the duplicate is suppressed', !sel.some(s => s.box[0] === 2), JSON.stringify(sel));
  check('capped at avatarPanels', sel.length === DEFAULTS.avatarPanels, `${sel.length}`);
  check('the kept boxes are all distinct',
    sel.every((s, i) => sel.every((t, j) => i === j || boxIoU(s.box, t.box) <= DEFAULTS.avatarPanelIoU)));

  check('the page side still gets exactly one box',
    selectDistinctBoxes([A, B, C], { avatarPanels: 1 }).length === 1);
  check('garbage candidates are dropped, not thrown',
    selectDistinctBoxes([{ score: 1 }, { box: [1, 2], score: 1 }, A]).length === 1);
  check('no candidates -> no boxes', selectDistinctBoxes([]).length === 0
    && selectDistinctBoxes(null).length === 0);
}

console.log('\nTEST 9 — the refusal is NOT a confidence floor');
{
  // A confidence floor was rejected on purpose (decisions.md 2026-08-11): small
  // garments legitimately score low, the kind table that could make a floor
  // size-aware was deleted, and exp 489's wrong target scored 0.35 while wrong
  // figure namings on staging page 14 were all marked "high". Assert no such
  // floor crept in: a low-score panel that AGREES is still accepted.
  const r = pickAgreeingPanels([{ ...CREAM, score: 0.35 }, { ...CREAM2, score: 0.31 }]);
  check('low-confidence panels that agree are accepted', r.agreement === 'agreed', r.agreement);

  const src = require('fs')
    .readFileSync(require.resolve('../../server/lib/garmentColourFix.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  check('no minimum-score constant exists', !/min(Dino|Score|Confidence)\w*\s*:/i.test(src));
  check('minAvatarMaskPx is unchanged at 400', /minAvatarMaskPx: 400,/.test(src));
  check('the deleted garment-kind table stays deleted', !/garmentPrompts\s*:/.test(src));
  check('the agreement fields reach the report',
    /panelsMeasured: target\.panelsMeasured/.test(src) && /agreement: target\.agreement/.test(src));
  const lab = require('fs')
    .readFileSync(require.resolve('../../server/lib/testlab.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  check('and the Test Lab card prints them', /panels agree \(max pair/.test(lab));
  // No extra detector call: the multi-box read comes from the candidates the
  // one existing request already returned.
  check('there is still exactly one detect call on the avatar side',
    (src.match(/await detectGarmentBoxes\(/g) || []).length === 2, // one in avatarGarmentLab, one in detectGarmentBox
    String((src.match(/await detectGarmentBoxes\(/g) || []).length));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

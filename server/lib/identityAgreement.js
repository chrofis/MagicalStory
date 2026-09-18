/**
 * Do the image evaluator and the figure detector agree on WHO IS WHO?
 *
 * The evaluator names each figure it matches to a reference photo; the detector
 * names each person box independently. When the two disagree, at least one of
 * them has the wrong child — and then EVERY per-character verdict on that page
 * is suspect, not just the obvious one. Measured on production story
 * job_1787349305313_hpv76p0rokg: 15 of 17 comparable evals carried at least one
 * identity conflict, and the conflicts were clean permutations of the same
 * faces (one page swaps two children outright). One page produced eleven
 * per-character findings — clothing, action, height — with three of its four
 * names contested.
 *
 * Single-figure pages agreed 2/2. The ambiguity is specific to several
 * similar-looking children of the same age.
 *
 * `checkIdentityAgreement` only MEASURES. `reconcileIdentity` acts on the
 * measurement: where the two disagree the DETECTOR wins, because it is the side
 * that works from full-body masks and per-figure identity lines rather than from
 * a face at picture-book scale.
 *
 * WHO TO BELIEVE IS NOT WHEN TO ACT (owner, 2026-09-18 — Lab set 66, experiment
 * 1324). Ten contested shipped pages were pulled, every image downloaded and
 * judged by eye: the detector was right on 5, the evaluator on 1 — and on the
 * remaining 4 NOBODY DISAGREED. Both witnesses had named the same people, in the
 * same spelling, and the PAIRING below manufactured the conflict. On
 * job_1787867402809_z9bwoo3yp p3 all five pirates were named correctly by both
 * sides; the evaluator emitted a compressed ladder of boxes shifted right, the
 * old greedy nearest-centre rule matched every name one slot over, and the
 * resulting "clean 3-cycle" erased Fiona and put Saira on the page twice.
 *
 * So the pairing is what had to change, not the verdict. Across all 132
 * individual conflicts on staging, 36% were decided by a margin under 0.05
 * against the detector figure carrying the evaluator's OWN name (19% under
 * 0.02; shipped examples at 0.002, 0.005, 0.007). At those margins centre
 * distance is noise and the name both sides independently produced is the
 * stronger evidence — so the name is part of the cost, and the assignment is
 * one-to-one.
 */

const { log } = require('../utils/logger');


// Pair on BODIES, not faces. Identity here is carried by clothing, and clothing
// is on the body — a face box tests the weakest signal the two sides share, and
// four same-age children have near-identical faces at picture-book scale. Face
// boxes remain the fallback for records written before the evaluator emitted a
// body box.
//
// COMPARE LIKE WITH LIKE (2026-09-18 — measured). That fallback used to compare
// whatever each side happened to have: an evaluator FACE centre against a
// detector BODY centre. Those are different points on the same person — the
// head against the torso — and the gap between them is anatomy, not identity.
// Over every stored version where a face-only evaluator match has a same-named
// detector figure, the cross-channel distance has median 0.242 (staging) /
// 0.234 (prod) against a 0.15 gate: 82 of 95 and 114 of 129 same-name pairs
// were thrown out by the comparison itself, before identity was considered at
// all. Head against head brings the same pairs to median 0.064 / 0.074, in line
// with body-to-body's 0.049 / 0.047. That is what "12 of production's 20
// conflicts paired on the face box" actually was.
//
// So the weaker signal does NOT get a wider tolerance — it gets the right
// reference point. Its residual spread is barely worse than the body's (p75
// 0.111 vs 0.084) and its tail is heavy enough (p90 0.278 vs 0.132) that
// widening the gate for it would start admitting genuinely different people.

/**
 * Where a figure's face centre actually sits inside its body box: p50 of the
 * 2,976 staging + 898 prod detector figures carrying BOTH boxes is 0.207 /
 * 0.228 of the body height below its top, horizontally centred (p50 0.500 on
 * both). Only ever used to give a box with no face box a comparable head point.
 */
const HEAD_Y_FRACTION = 0.21;

/**
 * How much geometric slack the two witnesses buy by producing the SAME name.
 *
 * Anchored on the measured spread between their boxes for a person they already
 * agree on: p75 of the same-name centre distance is 0.084 (staging, n=2,121)
 * and 0.079 (prod, n=361). A name agreement is therefore worth about one
 * typical inter-witness box spread — enough to settle the near-ties that 36% of
 * conflicts turn on, and nowhere near enough to paper over a real swap, where
 * the evaluator's own name sits 0.20–0.48 away (measured on all five
 * detector-right Lab pages; the closest single case is 0.143 and its conflict
 * survives, because the rival pairing is 0.055).
 *
 * It is ALSO the gate extension, deliberately not a second knob: a pair is
 * admissible exactly when its adjusted cost does not exceed what leaving that
 * match unpaired costs, so a same-name pair reaches to
 * `maxCentreDistance + this` and a different-name pair to `maxCentreDistance`.
 */
const NAME_AGREEMENT_BONUS = 0.08;

/** Centre of an evaluator box, `[x1, y1, x2, y2]` normalised. */
function evalCentre(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 };
}

/** Centre of a detector box, `[ymin, xmin, ymax, xmax]` normalised. */
function detCentre(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  return { x: (b[1] + b[3]) / 2, y: (b[0] + b[2]) / 2 };
}

/** Head point of an evaluator box, `[x1, y1, x2, y2]` normalised. */
function evalHead(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  return { x: (b[0] + b[2]) / 2, y: b[1] + (b[3] - b[1]) * HEAD_Y_FRACTION };
}

/** Head point of a detector box, `[ymin, xmin, ymax, xmax]` normalised. */
function detHead(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  return { x: (b[1] + b[3]) / 2, y: b[0] + (b[2] - b[0]) * HEAD_Y_FRACTION };
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Distance between one evaluator match and one detector figure, on the
 * strongest channel BOTH sides have: body↔body when each has a body box,
 * head↔head otherwise. Never body↔head.
 */
function pairDistance(e, d) {
  if (e.body && d.body) return { d: distance(e.body, d.body), on: 'body' };
  if (e.head && d.head) return { d: distance(e.head, d.head), on: 'face' };
  return null;
}

/**
 * Minimum-cost assignment over a square matrix (Hungarian / Kuhn–Munkres with
 * potentials, O(n³)). Costs may be negative. Returns `assignment[row] = col`.
 *
 * Written out rather than pulled in because it IS the pairing decision and has
 * to be readable next to the cost it minimises. Verified against exhaustive
 * brute force on random matrices in the unit tests.
 */
function minCostAssignment(cost) {
  const n = cost.length;
  if (n === 0) return [];
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);      // p[col] = row currently holding it
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const assignment = new Array(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] > 0) assignment[p[j] - 1] = j - 1;
  return assignment;
}

/**
 * Which detector figure is each evaluator match talking about?
 *
 * ONE-TO-ONE, with name agreement inside the cost. The old rule let every match
 * pick its nearest figure independently, so two matches could claim the same
 * figure — one "agrees", the other becomes a conflict pointing at the name the
 * first already owns — and a uniformly shifted ladder of evaluator boxes mapped
 * every name one slot over. Both artefacts are assignment problems, so this
 * solves the assignment problem.
 *
 * Cost of putting match `i` on figure `j` = their centre distance, minus
 * NAME_AGREEMENT_BONUS when both sides produced the same name. Leaving a match
 * unpaired costs `maxCentreDistance`, the worst pairing that would still be
 * accepted — which preserves the gate's meaning (further apart than this is not
 * the same figure) and, for a same-name pair, extends its reach by exactly the
 * bonus. An unused detector figure is free: the detector routinely sees
 * background people the evaluator never matched.
 *
 * @returns {Array<{ev: Object, det: Object|null, d: number|null, on: string|null}>}
 *          one entry per evaluator match, in input order
 */
function assignFigures(evs, dets, maxCentreDistance) {
  const nE = evs.length;
  const nD = dets.length;
  const BIG = 1e6;
  // Strictly above every admissible adjusted cost, so a pair sitting exactly on
  // the gate still pairs — the boundary the greedy rule had (`> max` → unpaired).
  const UNPAIRED = maxCentreDistance + 1e-9;

  const N = nE + nD;
  const cost = Array.from({ length: N }, () => new Array(N).fill(0));
  const meta = Array.from({ length: nE }, () => new Array(nD).fill(null));
  for (let i = 0; i < nE; i++) {
    for (let j = 0; j < nD; j++) {
      const pd = pairDistance(evs[i], dets[j]);
      if (!pd) { cost[i][j] = BIG; continue; }
      const adjusted = pd.d - (evs[i].canon === dets[j].canon ? NAME_AGREEMENT_BONUS : 0);
      meta[i][j] = { d: pd.d, on: pd.on };
      cost[i][j] = adjusted <= maxCentreDistance ? adjusted : BIG;
    }
    // nE interchangeable "this match stays unpaired" columns — one per match,
    // so no match is ever forced onto a figure the gate rejected.
    for (let k = 0; k < nE; k++) cost[i][nD + k] = UNPAIRED;
  }
  // Filler rows absorb the leftovers: an unused detector figure is free, and so
  // is an unused unpaired slot.
  for (let r = nE; r < N; r++) cost[r].fill(0);

  const assignment = minCostAssignment(cost);
  return evs.map((ev, i) => {
    const j = assignment[i];
    if (j < 0 || j >= nD || cost[i][j] >= BIG) return { ev, det: null, d: null, on: null };
    return { ev, det: dets[j], d: meta[i][j].d, on: meta[i][j].on };
  });
}

/**
 * @param {Array} evalMatches   evaluator `matches[]` — { reference, face_bbox }
 * @param {Array} detFigures    detector `figures[]` — { name, faceBox }
 * @param {Object} [opts]
 *   maxCentreDistance  a pair further apart than this is not the same figure
 *                      (default 0.15 of the frame diagonal)
 * @returns {Object|null} report, or null when there is nothing comparable
 */
function checkIdentityAgreement(evalMatches, detFigures, opts = {}) {
  const { maxCentreDistance = 0.15 } = opts;
  const { canonicalName } = require('./castResolver');

  // Body first, face only as a fallback for records written before the
  // evaluator emitted a body box. Both points are kept: which one a given pair
  // is compared on depends on what the OTHER side has too (see pairDistance).
  const evs = (evalMatches || [])
    .filter(m => m && m.reference && (evalCentre(m.body_bbox) || evalCentre(m.face_bbox)))
    .map(m => ({
      name: String(m.reference),
      canon: canonicalName(m.reference),
      body: evalCentre(m.body_bbox),
      head: evalCentre(m.face_bbox) || evalHead(m.body_bbox),
      on: m.body_bbox ? 'body' : 'face',
    }));
  // The detector only ever names PEOPLE. An animal or creature the evaluator
  // matched has no counterpart, and forcing it onto the nearest child invents a
  // conflict that is not there — that artefact accounted for 2 of the conflicts
  // in the first measurement of this.
  const dets = (detFigures || [])
    .filter(f => f && f.name && f.name !== 'UNKNOWN' && (detCentre(f.bodyBox) || detCentre(f.faceBox)))
    .map(f => ({
      name: String(f.name),
      canon: canonicalName(f.name),
      body: detCentre(f.bodyBox),
      head: detCentre(f.faceBox) || detHead(f.bodyBox),
    }));

  if (evs.length === 0 || dets.length === 0) return null;

  // COMPARE: two produced name strings are compared through canonicalName,
  // never raw lower-case — a title, a short form or a differently spelled
  // diacritic otherwise reads as a conflict between the evaluator and the
  // detector when both named the same person.
  const detNames = new Set(dets.map(d => d.canon));
  // A name the detector never assigned anywhere is not a conflict — it is a
  // subject the detector cannot see (a creature, or a figure it missed). Such a
  // match is kept OUT of the assignment entirely, so it cannot occupy a figure
  // that belongs to somebody the detector did name.
  const pairable = evs.filter(e => detNames.has(e.canon));
  const agreed = [];
  const conflicts = [];
  const unpaired = evs.filter(e => !detNames.has(e.canon)).map(e => e.name);

  for (const { ev, det, d, on } of assignFigures(pairable, dets, maxCentreDistance)) {
    if (!det) { unpaired.push(ev.name); continue; }
    if (det.canon === ev.canon) agreed.push(ev.name);
    else conflicts.push({ evaluator: ev.name, detector: det.name, centreDistance: Number(d.toFixed(3)), on });
  }

  const compared = agreed.length + conflicts.length;
  if (compared === 0) return null;

  return {
    // Which box the pairing used. `face` means the evaluator record predates
    // body_bbox, and the pairing rests on the weaker signal.
    pairedOn: evs.every(e => e.on === 'body') ? 'body' : 'face',
    compared,
    agreed: agreed.length,
    // The names both sides already landed on the same figure.
    agreedNames: agreed.slice(),
    // EVERY name this evaluation currently has on a figure — agreed, contested,
    // unpaired, and the box-less matches the pairing above never looked at. A
    // rename may not target one of these unless its holder is renamed away in
    // the same pass: the name is taken, and handing it to a second figure
    // fabricates a duplicate and erases somebody (see buildRenameMap). Taken
    // from the raw matches, not from `evs`, because the rename rewrites the raw
    // matches — a holder the pairing skipped still holds its name.
    heldNames: (evalMatches || []).map(m => m && m.reference).filter(Boolean).map(String),
    conflicts,
    unpaired: unpaired.length > 0 ? unpaired : undefined,
    // The names the two sides disagree about. A per-character finding naming one
    // of these rests on a contested identity.
    contestedCharacters: [...new Set(conflicts.flatMap(c => [c.evaluator, c.detector]))],
    agreementRate: Number((agreed.length / compared).toFixed(2)),
  };
}

/** One-line summary for the run log. */
function describeIdentityAgreement(report, pageLabel = '') {
  if (!report) return null;
  if (report.conflicts.length === 0) {
    return `🪪 [IDENTITY] ${pageLabel}evaluator and detector agree on all ${report.compared} figure(s)`;
  }
  const pairs = report.conflicts.map(c => `${c.evaluator}→${c.detector}`).join(', ');
  const outcome = report.uncorrectable
    ? (report.uncorrectableReason === 'face-paired'
      ? 'paired on the face box only — measured, left as the evaluator wrote it'
      : 'not a clean swap — left as the evaluator wrote it')
    : report.renamed
      ? `detector wins, ${report.renamed} name(s) corrected`
      : 'measured only';
  return `⚠️ 🪪 [IDENTITY] ${pageLabel}evaluator and detector disagree on ${report.conflicts.length}/${report.compared}: ${pairs} — ${outcome}`;
}

/**
 * A conflict is only CORRECTABLE when the two sides swapped a set of names
 * among themselves — then the fix is one simultaneous permutation and every
 * name still lands on exactly one figure. If two evaluator names collapse onto
 * the same detector name, the evaluator saw a figure the detector did not name
 * the same way twice over, and renaming would fabricate a duplicate. Those stay
 * flagged and uncorrected.
 *
 * A name is equally taken when ANY OTHER MATCH already holds it — agreed,
 * unpaired, or box-less. A name the pairing never even reached — the detector
 * never assigned it, no admissible figure was left for it, the match carries no
 * box — is still written on a figure this map is about to rewrite. Applying such
 * a rename writes one name onto two matches and erases the other from the page,
 * and every finding about the erased character is then relabelled onto a
 * character the spec never cast in that role. Measured on staging
 * job_1789348171785_9oxos7dwv p7 (an AGREED holder) and on
 * job_1787436913379_mfedxinwqd p4 (an UNPAIRED holder, on a page where nothing
 * agreed at all): the original name vanished from `matches[]` entirely and its
 * findings shipped attributed to the wrong child.
 *
 * So the rule is one rule, not a list of holder kinds: a rename must leave every
 * name on exactly one figure. A target is available only when nobody holds it,
 * or when its holder is itself being renamed away in this same pass — which is
 * what makes a two-name swap, and any longer cycle or chain, lossless. Held
 * names are compared through `canonicalName`, the space the pairing above
 * decided agreement in, so a title or a diacritic cannot hide a duplicate.
 *
 * @param {Array} conflicts
 * @param {Array<string>} [heldNames] every name this evaluation has on a figure
 * @returns {Map<string,string>|null} lowercased evaluator name → detector name
 */
function buildRenameMap(conflicts, heldNames = []) {
  const { canonicalName } = require('./castResolver');
  const map = new Map();
  for (const c of conflicts) {
    const from = String(c.evaluator).toLowerCase();
    if (map.has(from) && map.get(from) !== c.detector) return null; // one name, two verdicts
    map.set(from, c.detector);
  }

  // The names that will still be on a figure after this map is applied. A
  // holder keyed in the map is renamed away, so it vacates its name — tested on
  // the lowercased key the rename itself uses, because a name this map will not
  // actually rewrite has not actually been vacated.
  const taken = new Set();
  for (const held of heldNames) {
    if (map.has(String(held).toLowerCase())) continue;              // renamed away
    const canon = canonicalName(held);
    if (canon) taken.add(canon);
  }
  // Each target must land on free ground — and then it occupies it, which is
  // also how two conflicts pointing at one name are refused.
  for (const to of map.values()) {
    const canon = canonicalName(to);
    if (taken.has(canon)) return null;                              // target already taken
    taken.add(canon);
  }
  return map;
}

/** Simultaneous whole-word substitution — never sequential, or A→B→C cascades. */
function renameInProse(text, map) {
  if (!text || typeof text !== 'string') return text;
  const names = [...map.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(`\\b(${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
  return text.replace(re, m => map.get(m.toLowerCase()) || m);
}

/**
 * Make the DETECTOR's identities the ones the rest of the pipeline sees.
 *
 * Every downstream consumer — repair targeting, entity consistency, the
 * per-character findings themselves — reads a NAME. Correcting `matches` alone
 * would leave a finding saying "the older boy's jacket is red" attached to the
 * younger one, so the same permutation is applied to every place this page's
 * evaluation wrote a name, prose included: those sentences were written by the
 * same mistaken assignment, so they are wrong in exactly the same way.
 *
 * @param {Object} evalLike     mutated in place — { matches, fixableIssues, fixTargets }
 * @param {Array}  detFigures   detector `figures[]`
 * @returns {Object|null} the agreement report, with `renamed` / `uncorrectable`
 */
function reconcileIdentity(evalLike, detFigures, opts = {}) {
  const report = checkIdentityAgreement(evalLike?.matches, detFigures, opts);
  if (!report || report.conflicts.length === 0) return report;

  // THE WEAK SIGNAL MEASURES; IT DOES NOT REWRITE THE PAGE (2026-09-18 —
  // measured on the pixels). A conflict paired head-to-head is one where the
  // evaluator record predates `body_bbox`, so the two sides were matched on
  // the signal that carries no clothing — and clothing is what identity here
  // is made of. Three such pages were pulled and judged against the stored
  // clothing contract (job_1787349305313_hpv76p0rokg p2, p12, p18): on ALL
  // THREE the evaluator had every child right and the DETECTOR was the wrong
  // witness — on p12, three of four. Those records come from before the SoM
  // identity chain existed, which is the same reason they have no body box.
  // Renaming on that evidence overwrites four correct labels to fix nothing.
  //
  // So the head channel earns its place in the MEASUREMENT (it is what makes
  // those pages comparable at all, and it withdrew a wrong rename on
  // job_1787423677246_r9llf5yi9 p14 where the evaluator's own name turned out
  // to be the nearest figure by 0.026 against 0.151). It does not earn a
  // rewrite. Modern records are unaffected: 2,776 of 2,882 boxed staging
  // matches carry a body box, so this is a legacy guard, not a live one.
  const weaklyPaired = report.conflicts.filter(c => c.on !== 'body');
  if (weaklyPaired.length > 0) {
    report.uncorrectable = true;
    report.uncorrectableReason = 'face-paired';
    report.renamed = 0;
    return report;
  }

  const map = buildRenameMap(report.conflicts, report.heldNames || []);
  if (!map) {
    report.uncorrectable = true;   // not a clean swap — flag it, touch nothing
    report.uncorrectableReason = 'not-a-permutation';
    report.renamed = 0;
    return report;
  }

  let renamed = 0;
  for (const m of evalLike.matches || []) {
    const to = m && m.reference && map.get(String(m.reference).toLowerCase());
    if (to) { m.evaluatorReference = m.reference; m.reference = to; renamed++; }
  }
  // `alsoRename` carries lists built from this evaluation but held outside it —
  // the bbox-enriched fix targets, which are separate objects with their own
  // copy of the character name.
  for (const list of [evalLike.fixableIssues, evalLike.fixTargets, ...(opts.alsoRename || [])]) {
    for (const f of list || []) {
      if (!f) continue;
      const to = f.character && map.get(String(f.character).toLowerCase());
      if (to) { f.evaluatorCharacter = f.character; f.character = to; f.identityCorrected = true; renamed++; }
      // Prose is rewritten whenever it names a contested character, even on a
      // finding whose own `character` agreed — one sentence can name two.
      for (const key of ['description', 'issue', 'problem', 'fix']) {
        if (typeof f[key] === 'string') f[key] = renameInProse(f[key], map);
      }
    }
  }

  report.renamed = renamed;
  report.renameMap = Object.fromEntries(map);
  return report;
}

/*
 * TWO WITNESSES FOR AN ABSENCE (owner, 2026-08-27) lived here as
 * charactersSeenByAnyWitness + dropContradictedAbsences: an after-the-fact
 * filter that deleted absence claims a witness contradicted, then rescored
 * behind them. Folded into evalPipeline.derivePresenceFinding on 2026-09-13 —
 * the two enumerations are now reconciled BEFORE a presence claim is made, and
 * a disagreement means no claim rather than a claim withdrawn.
 */

module.exports = {
  checkIdentityAgreement, describeIdentityAgreement, reconcileIdentity,
  // Exported for the unit tests: the assignment is the whole of the pairing
  // decision, and it is verified against exhaustive brute force.
  minCostAssignment, NAME_AGREEMENT_BONUS, HEAD_Y_FRACTION };

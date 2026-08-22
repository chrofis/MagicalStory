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
 */


// Pair on BODIES, not faces. Identity here is carried by clothing, and clothing
// is on the body — a face box tests the weakest signal the two sides share, and
// four same-age children have near-identical faces at picture-book scale. Face
// boxes remain the fallback for records written before the evaluator emitted a
// body box.

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

/**
 * @param {Array} evalMatches   evaluator `matches[]` — { reference, face_bbox }
 * @param {Array} detFigures    detector `figures[]` — { name, faceBox }
 * @param {Object} [opts]
 *   maxCentreDistance  a pair further apart than this is not the same face
 *                      (default 0.15 of the frame diagonal)
 * @returns {Object|null} report, or null when there is nothing comparable
 */
function checkIdentityAgreement(evalMatches, detFigures, opts = {}) {
  const { maxCentreDistance = 0.15 } = opts;

  // Body first, face only as a fallback for records written before the
  // evaluator emitted a body box.
  const evs = (evalMatches || [])
    .filter(m => m && m.reference && (evalCentre(m.body_bbox) || evalCentre(m.face_bbox)))
    .map(m => ({
      name: String(m.reference),
      c: evalCentre(m.body_bbox) || evalCentre(m.face_bbox),
      on: m.body_bbox ? 'body' : 'face',
    }));
  // The detector only ever names PEOPLE. An animal or creature the evaluator
  // matched has no counterpart, and forcing it onto the nearest child invents a
  // conflict that is not there — that artefact accounted for 2 of the conflicts
  // in the first measurement of this.
  const dets = (detFigures || [])
    .filter(f => f && f.name && f.name !== 'UNKNOWN' && (detCentre(f.bodyBox) || detCentre(f.faceBox)))
    .map(f => ({ name: String(f.name), c: detCentre(f.bodyBox) || detCentre(f.faceBox) }));

  if (evs.length === 0 || dets.length === 0) return null;

  const detNames = new Set(dets.map(d => d.name.toLowerCase()));
  const agreed = [];
  const conflicts = [];
  const unpaired = [];

  for (const e of evs) {
    // A name the detector never assigned anywhere is not a conflict — it is a
    // subject the detector cannot see (a creature, or a figure it missed).
    if (!detNames.has(e.name.toLowerCase())) { unpaired.push(e.name); continue; }
    let best = null;
    let bestDist = Infinity;
    for (const d of dets) {
      const dist = Math.hypot(e.c.x - d.c.x, e.c.y - d.c.y);
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    if (!best || bestDist > maxCentreDistance) { unpaired.push(e.name); continue; }
    if (best.name.toLowerCase() === e.name.toLowerCase()) {
      agreed.push(e.name);
    } else {
      conflicts.push({ evaluator: e.name, detector: best.name, centreDistance: Number(bestDist.toFixed(3)) });
    }
  }

  const compared = agreed.length + conflicts.length;
  if (compared === 0) return null;

  return {
    // Which box the pairing used. `face` means the evaluator record predates
    // body_bbox, and the pairing rests on the weaker signal.
    pairedOn: evs.every(e => e.on === 'body') ? 'body' : 'face',
    compared,
    agreed: agreed.length,
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
    ? 'not a clean swap — left as the evaluator wrote it'
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
 * @returns {Map<string,string>|null} lowercased evaluator name → detector name
 */
function buildRenameMap(conflicts) {
  const map = new Map();
  for (const c of conflicts) {
    const from = String(c.evaluator).toLowerCase();
    if (map.has(from) && map.get(from) !== c.detector) return null; // one name, two verdicts
    map.set(from, c.detector);
  }
  const targets = new Set([...map.values()].map(v => v.toLowerCase()));
  if (targets.size !== map.size) return null;                       // two names, one verdict
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

  const map = buildRenameMap(report.conflicts);
  if (!map) {
    report.uncorrectable = true;   // not a clean swap — flag it, touch nothing
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

module.exports = { checkIdentityAgreement, describeIdentityAgreement, reconcileIdentity };

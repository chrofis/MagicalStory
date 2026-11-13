'use strict';

/**
 * Two FREE mechanical checks on the detector's figure -> name matches (owner, 2026-11-13; docs/decisions.md
 * "Repair figure guard and duplicate-name check").
 *
 * The figure detector (bboxDetection.detectAllBoundingBoxes) names every figure it finds after one of the
 * page's expected characters (`expectedCharacters[].name`, the cast plus the Visual Bible secondaries) or
 * `UNKNOWN`. Both checks read ONLY that typed output: the figure's `name`, its box, and the detection's own
 * `expectedCharacters` list. A name is compared with the list the SAME detection run was handed (exact string
 * equality, nothing read from prose), so no resolver or matcher lives here.
 *
 *  1. repairFigureVerdict: a repaired picture whose count of cast-labelled figures is LOWER than its parent's is
 *     refused. The book review compares a repair with its parent by eye only; its BETTER verdict never saw the
 *     detector's count. Measured over 60 days of production: 21 of 194 shipped repair picks had fewer detected
 *     figures than the original.
 *  2. duplicateNameFindings: two figures matched to ONE cast name on one picture, with boxes that do not
 *     overlap, is a duplicate_character finding. A counted group (roster `count` N) is N figures by design and
 *     is skipped up to N.
 *
 * Neither check calls a model. A detection that is missing, or has no expected-character list, is "cannot
 * judge", never a pass or a failure of the picture: the callers log it.
 */

/** Names the detector uses for a figure it could not match to the expected list. */
const UNMATCHED_NAME = 'UNKNOWN';
/** Two same-name boxes overlapping by more than this share of the SMALLER box are one figure drawn twice by the detector. */
const SAME_FIGURE_OVERLAP = 0.3;
/** `derivedBy` stamp of a finding made by duplicateNameFindings; absenceCheck's cap leaves it at its severity. */
const DUPLICATE_NAME_MARKER = 'duplicate_cast_name';

function expectedNames(detection) {
  const list = Array.isArray(detection?.expectedCharacters) ? detection.expectedCharacters : [];
  const names = new Set();
  for (const c of list) {
    const n = typeof c?.name === 'string' ? c.name.trim() : '';
    if (n) names.add(n);
  }
  return names;
}

/** Figures the detector matched to a name on its own expected list. */
function castFigures(detection) {
  if (!detection || !Array.isArray(detection.figures)) return null;
  const names = expectedNames(detection);
  if (names.size === 0) return null;
  return detection.figures.filter(f => {
    const n = typeof f?.name === 'string' ? f.name.trim() : '';
    return n && n !== UNMATCHED_NAME && names.has(n);
  });
}

/**
 * @param {Map<string,number>} [allowedCounts] from allowedFigureCounts; a name allowed Infinity is an animal and is
 *   not counted: the detector often leaves an animal unlabelled, and counting it refused two 2026-11-13 replay repairs
 *   that kept every child (a hedgehog and a seagull went unlabelled).
 * @returns {{cast:number, raw:number}|null} null when the detection cannot be read as a name match
 */
function figureCounts(detection, allowedCounts = new Map()) {
  const all = castFigures(detection);
  const cast = all && all.filter(f => allowedCounts.get(f.name.trim()) !== Infinity);
  if (!cast) return null;
  return { cast: cast.length, raw: detection.figures.length };
}

/**
 * Repair figure guard.
 * @returns {{decided:boolean, refuse:boolean, parent:object|null, child:object|null, reason:string}}
 */
function repairFigureVerdict(parentDetection, childDetection, allowedCounts = new Map()) {
  const parent = figureCounts(parentDetection, allowedCounts);
  const child = figureCounts(childDetection, allowedCounts);
  if (!parent || !child) {
    return { decided: false, refuse: false, parent, child, reason: !child ? 'the repaired picture has no readable detection' : 'the parent has no readable detection' };
  }
  const refuse = child.cast < parent.cast;
  return {
    decided: true, refuse, parent, child,
    reason: refuse ? `cast-labelled figures ${parent.cast} -> ${child.cast} (all figures ${parent.raw} -> ${child.raw})` : 'no cast figure lost',
  };
}

/** A box as [x1,y1,x2,y2]; pixels or 0-1, the overlap share is scale-free as long as both boxes share units. */
function asBox(b) {
  if (!Array.isArray(b) || b.length < 4) return null;
  const [x1, y1, x2, y2] = b.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

function overlapShare(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const small = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  return small > 0 ? (w * h) / small : 1;
}

/** How many of these boxes are distinct figures (a box covered by one already counted is the same figure twice). */
function distinctBoxes(boxes) {
  const kept = [];
  for (const box of boxes) {
    if (box && kept.every(k => overlapShare(k, box) <= SAME_FIGURE_OVERLAP)) kept.push(box);
  }
  return kept.length;
}

/**
 * The detector's identity pass (figureDetection set-of-mark) can name ONE cast member on two boxes; its
 * resolver then keeps the stronger claimant and turns the other into UNKNOWN, so the final figure list never
 * repeats a name. The raw claims survive on the detection: gdinoDiag.identity.answers (badge letter -> name),
 * .badges (letter -> detIdx) and gdinoDiag.persons (detIdx -> box). Those, and a figure list that does repeat a
 * name (a backend with no such resolver), are the only inputs read here.
 */
function claimsByName(detection, names) {
  const identity = detection?.gdinoDiag?.identity;
  const persons = detection?.gdinoDiag?.persons;
  const out = new Map();
  if (!identity || !identity.answers || !Array.isArray(identity.badges) || !Array.isArray(persons)) return out;
  const canon = (s) => require('./castResolver').canonicalName(s);
  for (const b of identity.badges) {
    const raw = String(identity.answers[b.letter] || '').trim();
    if (!raw || raw.toUpperCase() === UNMATCHED_NAME) continue;
    const name = [...names].find(n => n === raw) || [...names].find(n => canon(n) === canon(raw));
    if (!name) continue;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(asBox(persons[b.detIdx]?.box));
  }
  return out;
}

/**
 * Duplicate-name check.
 * @param {object} detection a stored bboxDetection
 * @param {Map<string,number>} [groupSizes] roster name -> N for a counted group (N figures are by design)
 * @returns {Array<{name:string, figures:number, allowed:number}>} one entry per cast name drawn more often than allowed
 */
function duplicateNames(detection, groupSizes = new Map()) {
  const names = expectedNames(detection);
  if (names.size === 0 || !detection) return [];
  const boxesByName = new Map();
  for (const f of castFigures(detection) || []) {
    const n = f.name.trim();
    if (!boxesByName.has(n)) boxesByName.set(n, []);
    boxesByName.get(n).push(asBox(f.bodyBox || f.gdinoBox || f.box));
  }
  const claims = claimsByName(detection, names);
  const out = [];
  for (const name of new Set([...boxesByName.keys(), ...claims.keys()])) {
    const allowed = Math.max(1, Number(groupSizes.get(name)) || 1);
    const figures = Math.max(distinctBoxes(boxesByName.get(name) || []), distinctBoxes(claims.get(name) || []));
    if (figures > allowed) out.push({ name, figures, allowed });
  }
  return out;
}

// How many figures each expected name may have on one image, for duplicateNames.
// A counted group (roster `count` >= 2) may have N. An animal is never a duplicate
// here: animals are matched against objects, and the identity pass has put an
// animal's name on several person boxes (two unicorn pages, 2026-11-13 replay).
function allowedFigureCounts(detection, castIndex) {
  const { resolveEntity } = require('./castResolver');
  const sizes = new Map();
  for (const c of Array.isArray(detection?.expectedCharacters) ? detection.expectedCharacters : []) {
    const hit = resolveEntity(c.name, castIndex);
    if (!hit) continue;
    if (hit.kind === 'animal') { sizes.set(c.name, Infinity); continue; }
    const n = hit.entry && Number.isInteger(hit.entry.count) && hit.entry.count >= 2 ? hit.entry.count : 0;
    if (n) sizes.set(c.name, n);
  }
  return sizes;
}

module.exports = {
  UNMATCHED_NAME, SAME_FIGURE_OVERLAP, DUPLICATE_NAME_MARKER,
  figureCounts, repairFigureVerdict, duplicateNames, allowedFigureCounts,
};

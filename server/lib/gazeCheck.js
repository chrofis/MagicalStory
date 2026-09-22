/**
 * DECLARED GAZE vs OBSERVED GAZE — a comparison, not a judge.
 *
 * The brief declares where each character looks (`characters[].looksAt`). The
 * prompt-blind inventory already reports where each FIGURE looks, in its own
 * `interactions[]` — "who faces, looks at, reaches toward, holds or touches
 * whom". Both halves have always existed. Nothing compared them.
 *
 * WHY THE SIGHTED JUDGE CANNOT DO IT. The quality evaluator receives the brief
 * and the picture in one call, so its observation cannot contradict the
 * declaration — measured 2026-09-21 on job_1789853503332_riqncqg1i: asked to
 * report a `gaze` per figure it answered "down at the large warm egg" for all
 * four figures of p6, including the two it had itself recorded as `view: back`,
 * whose eyes are not in the picture. It was repeating the brief. The blind
 * describer, given the image alone, reported all four "looks toward <another
 * child>", which is what the pixels show.
 *
 * So this module takes the blind observation as the witness and the brief as
 * the claim, and reports only where they CONTRADICT.
 *
 * NARROW BY DESIGN. Under-reporting is the chosen error: a false finding buys a
 * paid repair, and a repair acting on a false finding damages a correct page
 * (measured 2026-09-20, a clothing finding that named the wrong child). Every
 * uncertainty is a skip — no observation, no figure match, eyes not visible,
 * an unresolvable label. It fires only on a confident disagreement.
 *
 * It classifies nothing from prose: the target comes from the inventory's
 * structured `to` field, and `observed` is consulted only to confirm the
 * relation is a LOOK rather than a reach or a touch.
 *
 * ONE WITNESS ONLY. A stated LOOK relation is the whole of the evidence. The
 * figure-level `facing` field is NOT a second witness — it describes the body,
 * and a body square to camera says nothing about where the eyes went (see
 * observedGaze). So a character drawn looking out of the picture instead of at
 * what the brief named goes unreported today: no field in the blind inventory
 * describes the eyes on their own.
 */

const { pairInventoryFiguresToNames } = require('./identityAgreement');
const { baseVbId } = require('./vbIdGuard');

/** The relation words that make an interactions entry a GAZE rather than contact. */
const LOOK_RELATION = /\b(?:look|looks|looking|gaze|gazes|gazing|watch|watches|watching|eyes on)\b/i;

/** The inventory's own word for "the eyes are not in the picture". */
const AWAY_FROM_VIEWER = 'away from viewer';

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** The describer's two ways of saying "I could not read the eyes". */
const UNREADABLE = new Set(['not visible', 'cannot tell', 'cannot tell at this size', 'none', 'n/a', '']);
/** The describer's phrase for the eyes meeting the camera. */
const AT_VIEWER = new Set(['at the viewer', 'the viewer', 'at viewer', 'viewer', 'at the camera']);

/**
 * What the inventory says one figure's EYES rest on.
 *
 * Reads `figures[].gaze`, the field that asks about eyes and nothing else. That
 * field is the whole witness: `interactions[]` was tried first and is weaker on
 * both sides — it is pairwise, so it cannot express "looking at an object" or
 * "looking out of the picture", and its `observed` prose mixes gaze with facing
 * and contact, so reading it means classifying prose. Measured over all 18 pages
 * of job_1789853503332_riqncqg1i, `gaze` came back on 52 of 52 figures.
 *
 * @returns {{kind:'viewer'} | {kind:'figure', label:string} | {kind:'thing', label:string} | null}
 *   null when the describer could not read the eyes, which is a SKIP.
 */
function observedGaze(inventory, figureLabel) {
  const figures = Array.isArray(inventory?.figures) ? inventory.figures : [];
  const fig = figures.find(f => norm(f?.label) === norm(figureLabel));
  const raw = norm(fig?.gaze).replace(/[.]$/, '');
  if (UNREADABLE.has(raw)) return null;
  if (AT_VIEWER.has(raw)) return { kind: 'viewer' };

  const target = raw.replace(/^(?:at|toward|towards|on)\s+/, '').trim();
  if (!target || UNREADABLE.has(target)) return null;
  // Another figure in this same picture, matched on the label the describer was
  // told to copy in full.
  const other = figures.find(f => f !== fig && norm(f?.label) === target);
  if (other) return { kind: 'figure', label: String(other.label) };
  return { kind: 'thing', label: target };
}

/**
 * True when this figure has something in a hand.
 *
 * THE ONE CONFOUND (2026-09-21). A gaze declared at an OBJECT and observed on a
 * PERSON is only a contradiction while the object is not in that person's hands
 * — eyes on the egg a child is holding are eyes on the child, to a describer
 * working from pixels, and both answers are true. Which object a figure holds
 * is structured (`items_held.left` / `.right`), so the guard reads the SHAPE of
 * the answer and never compares the two descriptions as prose: a figure holding
 * anything at all is not evidence of a misdirected gaze.
 */
function handsFull(inventory, figureLabel) {
  const fig = (Array.isArray(inventory?.figures) ? inventory.figures : [])
    .find(f => norm(f?.label) === norm(figureLabel));
  const held = fig?.items_held;
  if (!held || typeof held !== 'object') return false;
  return ['left', 'right'].some((h) => {
    const v = norm(held[h]);
    return v && v !== 'nothing' && v !== 'none' && v !== 'none visible' && v !== 'n/a';
  });
}

/** True when the inventory says this figure's eyes cannot be seen at all. */
function eyesNotVisible(inventory, figureLabel) {
  const fig = (Array.isArray(inventory?.figures) ? inventory.figures : [])
    .find(f => norm(f?.label) === norm(figureLabel));
  return !!fig && norm(fig.facing) === AWAY_FROM_VIEWER;
}

/**
 * Compare the brief's declared gaze against the blind inventory's observation.
 *
 * @param {Object}   args
 * @param {Array}    args.declared   brief characters[]: {name, looksAt}
 * @param {Object}   args.inventory  the prompt-blind inventory JSON
 * @param {Array}    args.matches    the eval's figure→character pairing, each
 *                                   entry carrying `reference` and `body_bbox`
 * @param {string[]} args.castNames  every character name in this story
 * @param {Function} [args.resolveTarget] (looksAt) => human-readable target name
 * @returns {Array} findings, each {type, severity, character, description, fix}
 */
function checkDeclaredGaze({ declared, inventory, matches, castNames, resolveTarget } = {}) {
  const chars = Array.isArray(declared) ? declared : [];
  const cast = (Array.isArray(castNames) ? castNames : []).map(norm).filter(Boolean);
  if (!chars.length || !inventory) return [];

  // figure label -> the character standing there, both normalised
  const charAt = new Map([...pairInventoryFiguresToNames(matches, inventory.figures)]
    .map(([label, name]) => [norm(label), norm(name)]));
  // and the same pairing read the other way
  const labelOf = new Map([...charAt].map(([label, name]) => [name, label]));

  const findings = [];
  for (const c of chars) {
    const name = String(c?.name || '').trim();
    const looksAt = String(c?.looksAt || '').trim();
    if (!name || !looksAt) continue;

    const label = labelOf.get(norm(name));
    if (!label) continue;                       // unmatched figure — skip
    if (eyesNotVisible(inventory, label)) continue;

    const seen = observedGaze(inventory, label);
    if (!seen) continue;                        // the witness said nothing — skip

    // `away` is a real value, not a target: the Art Director schema offers a
    // name, a Visual Bible id, or `away` for eyes that rest on nobody in the
    // frame. It still contradicts eyes on the reader — the same schema says a
    // figure never meets the reader's eye — so it is compared, but it has to
    // read as a phrase rather than be plugged in as a noun.
    const declaredAway = norm(looksAt) === 'away';
    const targetName = declaredAway ? 'away from everyone in the frame'
      : (typeof resolveTarget === 'function' ? String(resolveTarget(looksAt) || '').trim() : looksAt);
    // A finding has to SAY what the eyes were meant to be on. `looksAt`
    // holds a Visual Bible id as often as a name, and an id the bible
    // cannot name is not a sentence a repair or a reader can act on — so
    // an unresolved target is a skip, and no id ever reaches the text.
    if (!targetName || baseVbId(targetName)) continue;
    // Eyes resting on nobody can only be contradicted by eyes on the reader;
    // any other target is a thing the brief did not name, so there is nothing
    // to disagree with.
    if (declaredAway && seen.kind !== 'viewer') continue;
    const declaredIsCharacter = cast.includes(norm(targetName)) || cast.includes(norm(looksAt));

    let contradiction = null;
    if (seen.kind === 'viewer') {
      // MEASURED AND NOT FIRED (2026-09-22). `at the viewer` is the one answer
      // this describer cannot be trusted on: it writes it for any gaze running
      // out toward the camera's side of the frame, and cannot separate eyes ON
      // the reader from eyes PAST them. Twelve pages of
      // job_1789853503332_riqncqg1i were described a second time by an
      // independent reader working from the image alone: on p7 it called three
      // children `at the viewer` who are looking straight at the character the
      // brief named, and it repeated the error on p6, p8, p10 and p18. Every
      // clear false positive in the set came from this branch.
      //
      // The sibling answer — `at <another figure>` — matched that reader every
      // time, so it is the only one that fires. A page whose cast looks out of
      // the picture therefore still goes unreported: the loss is real and is
      // preferred to a MAJOR finding that buys a repair on a correct figure.
      contradiction = null;
    } else if (seen.kind === 'figure') {
      const seenCharacter = charAt.get(norm(seen.label));
      if (declaredIsCharacter) {
        // Both sides name a person, so the finding needs both names: an
        // unpaired figure might BE the declared character under another
        // description, and there is no way from here to tell.
        if (seenCharacter && seenCharacter !== norm(targetName) && seenCharacter !== norm(looksAt)) {
          contradiction = `the eyes are on ${seen.label}`;
        }
      } else if (seenCharacter && !handsFull(inventory, seen.label)) {
        // The brief sends the eyes to a THING and the witness sees them on a
        // NAMED person — and the name is what proves the two are different
        // entities. Without it this fired on p17 of job_1789853503332_riqncqg1i,
        // where the brief said `ANI001` (the story's dragon) and the describer,
        // which may not name anyone, wrote `the small green creature`: the same
        // animal under two descriptions, reported as a defect.
        contradiction = `the eyes are on ${seen.label}`;
      }
    }
    // seen.kind === 'thing': the describer names an object in its own words and
    // the brief names one in the Bible's. Comparing the two is prose matching,
    // which this module does not do — no evidence, no finding.
    if (!contradiction) continue;

    findings.push({
      type: 'action_interaction',
      severity: 'MAJOR',
      character: name,
      source: 'gaze-check',
      description: declaredAway
        ? `${name} is declared looking ${targetName}, but ${contradiction}.`
        : `${name} is declared looking at ${targetName}, but ${contradiction}.`,
      fix: declaredAway
        ? `Turn ${name}'s eyes ${targetName}.`
        : `Turn ${name}'s eyes to ${targetName}.`,
    });
  }
  return findings;
}

module.exports = {
  checkDeclaredGaze, observedGaze, eyesNotVisible, LOOK_RELATION,
};

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
 */

const { pairInventoryFiguresToNames } = require('./identityAgreement');
const { baseVbId } = require('./vbIdGuard');

/** The relation words that make an interactions entry a GAZE rather than contact. */
const LOOK_RELATION = /\b(?:look|looks|looking|gaze|gazes|gazing|watch|watches|watching|eyes on)\b/i;

/** The inventory's own word for "the eyes meet the camera". */
const TOWARD_VIEWER = 'toward viewer';
/** The inventory's own word for "the eyes are not in the picture". */
const AWAY_FROM_VIEWER = 'away from viewer';

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * What the inventory says one figure's eyes rest on.
 *
 * @returns {{kind:'figure', label:string} | {kind:'viewer'} | null}
 *   null when the inventory says nothing about this figure's gaze, which is a
 *   SKIP and never a finding.
 */
function observedGaze(inventory, figureLabel) {
  const label = norm(figureLabel);
  if (!label) return null;

  for (const it of (Array.isArray(inventory?.interactions) ? inventory.interactions : [])) {
    if (norm(it?.from) !== label) continue;
    if (!LOOK_RELATION.test(String(it?.observed || ''))) continue;
    const to = String(it?.to || '').trim();
    if (to) return { kind: 'figure', label: to };
  }

  // `facing` is the fallback witness and carries only one gaze-bearing value:
  // the eyes meeting the camera. Every other value describes the BODY, which a
  // gaze can differ from, so nothing else here is evidence either way.
  const fig = (Array.isArray(inventory?.figures) ? inventory.figures : [])
    .find(f => norm(f?.label) === label);
  if (fig && norm(fig.facing) === TOWARD_VIEWER) return { kind: 'viewer' };
  return null;
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

    const targetName = typeof resolveTarget === 'function'
      ? String(resolveTarget(looksAt) || '').trim() : looksAt;
    // A finding has to SAY what the eyes were meant to be on. `looksAt`
    // holds a Visual Bible id as often as a name, and an id the bible
    // cannot name is not a sentence a repair or a reader can act on — so
    // an unresolved target is a skip, and no id ever reaches the text.
    if (!targetName || baseVbId(targetName)) continue;
    const declaredIsCharacter = cast.includes(norm(targetName)) || cast.includes(norm(looksAt));

    let contradiction = null;
    if (seen.kind === 'viewer') {
      // The eyes meet the camera while the brief sends them somewhere else.
      contradiction = 'the eyes meet the viewer';
    } else {
      const seenCharacter = charAt.get(norm(seen.label));
      if (declaredIsCharacter) {
        // Both sides name a person, so the finding needs both names: an
        // unpaired figure might BE the declared character under another
        // description, and there is no way from here to tell.
        if (seenCharacter && seenCharacter !== norm(targetName) && seenCharacter !== norm(looksAt)) {
          contradiction = `the eyes are on ${seen.label}`;
        }
      } else if (!handsFull(inventory, seen.label)) {
        // The brief sends the eyes to a THING and the witness sees them on a
        // person. A name for that person is not needed — it would only make
        // the sentence read better, and the label already does that.
        contradiction = `the eyes are on ${seen.label}`;
      }
      // declared a thing, observed a thing: the inventory pairs figures, not
      // objects, so it cannot tell WHICH thing — no evidence, no finding.
    }
    if (!contradiction) continue;

    findings.push({
      type: 'action_interaction',
      severity: 'MAJOR',
      character: name,
      source: 'gaze-check',
      description: `${name} is declared looking at ${targetName}, but ${contradiction}.`,
      fix: `Turn ${name}'s eyes to ${targetName}.`,
    });
  }
  return findings;
}

module.exports = {
  checkDeclaredGaze, observedGaze, eyesNotVisible, LOOK_RELATION,
};

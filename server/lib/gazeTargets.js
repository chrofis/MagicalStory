/**
 * THE GAZE WORDS: the closed vocabulary of a `looksAt` that is not a character, an element or the viewer
 * (owner, 2026-10-06: Jev's choice lists should have too many options rather than too few). ONE table;
 * every list that names them reads it: the Jev choice (jevDecisions.gazeCandidates), the picture prompt's
 * eyes line (promptBuilders.looksAtPhrase), the judges' declared-interactions text
 * (promptBuilders.formatInteractionsBlock), the blend-edit prompt (sceneComposite), the Art Director's
 * field rule (promptBuilders.LOOKS_AT_FIELD_RULE) and the gaze check (gazeCheck: none of these can be
 * confirmed by the blind describer except `away`, which only eyes on the reader contradict).
 *
 * Why direction words: Jev used to be offered "the place itself" for a page's location, and
 * vbIdGuard.gazeTarget blanks a looksAt naming the place the page stands in (7 of 153 stored decisions
 * wrote no eyes line at all, e.g. ypl33 p3 Emma). A figure that looks at the surroundings looks down,
 * up, ahead or into the distance; those are the words now.
 *
 * `away` keeps its stored meaning (the picture prompt: eyes turned away from everyone in the frame, the
 * face turned from them): "into the distance" was Jev's reading of it, which never matched the picture
 * line, so the distance is its own word.
 *
 * `outside` NEVER carries a name: a character who is not in the picture is not named in the image prompt
 * (an image model draws a name it is given), the line says "someone just outside the picture".
 */

const GAZE_TARGETS = [
  { id: 'down', looking: 'looking down', jev: 'down: eyes cast down at the ground, at their own feet or lap',
    phrase: 'eyes cast down', judge: 'looks down' },
  { id: 'up', looking: 'looking up', jev: 'up: eyes raised to the sky, the ceiling or something high above them',
    phrase: 'eyes raised upward', judge: 'looks up' },
  { id: 'ahead', looking: 'looking straight ahead', jev: 'ahead: eyes straight ahead along the way they are going, on nothing in particular',
    phrase: 'eyes straight ahead along the way forward', judge: 'looks straight ahead' },
  { id: 'distance', looking: 'looking into the distance', jev: 'the distance: eyes on the far horizon or far away, on nothing in the picture',
    phrase: 'eyes on the far distance', judge: 'looks into the distance' },
  { id: 'away', looking: 'looking away from everyone in the frame', jev: 'turned away: face and eyes turned away from everyone and everything in the picture (shy, sulking, hiding, a back turned)',
    phrase: 'eyes turned away from everyone in the frame', judge: 'looks away from everyone in the frame' },
  { id: 'outside', looking: 'looking at someone just outside the picture', jev: 'someone just outside the picture, not drawn in it',
    phrase: 'eyes on someone just outside the picture', judge: 'looks at someone just outside the picture' },
  { id: 'held', looking: 'looking at what it holds', jev: 'what they hold: the thing in their own hands',
    phrase: 'eyes on what they hold in their hands', judge: 'looks at what they hold' },
];

const GAZE_TOKEN_IDS = GAZE_TARGETS.map(t => t.id);

/** The canonical word for a looksAt value that is one of the gaze words, else null. */
function gazeToken(raw) {
  const k = String(raw == null ? '' : raw).trim().toLowerCase();
  return GAZE_TOKEN_IDS.includes(k) ? k : null;
}

/** The table row of a gaze word, else null. */
function gazeTokenRow(raw) {
  const k = gazeToken(raw);
  return k ? GAZE_TARGETS.find(t => t.id === k) : null;
}

/** A pose clause for a looksAt value: "looking down", "looking at the lamp". '' when empty. */
function gazeLookingClause(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  const row = gazeTokenRow(t);
  return row ? row.looking : `looking at ${t}`;
}

/** The gaze words as a field rule lists them, for the Art Director (a figure outside Jev's roster, the backup path). */
const GAZE_TOKEN_LIST = GAZE_TOKEN_IDS.map(id => `\`${id}\``).join(', ');

module.exports = { GAZE_TARGETS, GAZE_TOKEN_IDS, GAZE_TOKEN_LIST, gazeToken, gazeTokenRow, gazeLookingClause };
